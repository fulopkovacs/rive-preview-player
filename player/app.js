import RiveInit from '/vendor/rive/webgl2_advanced.mjs';

// ================================================================ helpers
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const EPS = 1e-6;

const ICONS = {
  play: '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9.5-5.5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M3.5 2.5h3.2v11H3.5zM9.3 2.5h3.2v11H9.3z"/></svg>',
  vol: '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-3.5v11L5 10H2z"/><path d="M11 5.2a4 4 0 0 1 0 5.6l-.9-.9a2.7 2.7 0 0 0 0-3.8zM12.8 3.4a6.5 6.5 0 0 1 0 9.2l-.9-.9a5.2 5.2 0 0 0 0-7.4z"/></svg>',
  mute: '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-3.5v11L5 10H2z"/><path d="M10.6 5.5l1.6 1.6 1.6-1.6.9.9-1.6 1.6 1.6 1.6-.9.9-1.6-1.6-1.6 1.6-.9-.9 1.6-1.6-1.6-1.6z"/></svg>',
};

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/** 754.25 -> "12:34.250" (h:mm:ss.mmm past an hour) */
function fmtTime(t) {
  const ms = Math.round(Math.max(0, t) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return (h ? `${h}:${pad(m)}` : pad(m)) + `:${pad(s)}.${pad(r, 3)}`;
}

/** Parse "12.5", "12.5s", "500ms", "1:02.25", "0:01:02.25", "f741", "741f". Returns seconds or null. */
function parseTime(text, fps) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(?:f|frame\s*)(\d+)$/)) || (m = s.match(/^(\d+)\s*f$/))) return Number(m[1]) / fps;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*ms$/))) return Number(m[1]) / 1000;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*s?$/))) return Number(m[1]);
  if ((m = s.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/))) return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return null;
}

// ================================================================ state
const S = {
  rive: null,
  renderer: null,
  file: null,
  artboard: null,
  anim: null,
  meta: null, // from server (rive inspect); null for raw .riv
  version: -1,
  name: '',
  abName: null,
  animName: null,
  fps: 60,
  start: 0, // seconds (work area start)
  end: 1, // seconds
  t: 0,
  playing: false,
  loop: true,
  rate: 1,
  inPt: null,
  outPt: null,
  dirty: true,
  tlDirty: true,
  audioEvents: [],
  view: null, // [t0, t1] timeline zoom; null = whole range
  hoverT: null,
  scrubbing: false,
};

const hashParams = new URLSearchParams(location.hash.slice(1));
const initial = {
  at: hashParams.get('t'),
  artboard: hashParams.get('artboard'),
  animation: hashParams.get('animation'),
};
if (hashParams.get('in')) S.inPt = Number(hashParams.get('in'));
if (hashParams.get('out')) S.outPt = Number(hashParams.get('out'));
try {
  const saved = JSON.parse(localStorage.getItem('rvp:prefs') || '{}');
  if (typeof saved.loop === 'boolean') S.loop = saved.loop;
  if (typeof saved.volume === 'number') $('volume').value = saved.volume;
  if (typeof saved.muted === 'boolean') S.mutedPref = saved.muted;
} catch {}

function savePrefs() {
  try {
    localStorage.setItem('rvp:prefs', JSON.stringify({ loop: S.loop, volume: Number($('volume').value), muted: audio.muted }));
  } catch {}
}

// ================================================================ audio
const audio = {
  ctx: null,
  master: null,
  buffers: new Map(), // asset name -> AudioBuffer
  peaks: new Map(), // asset name -> Float32Array
  sources: [],
  muted: false,
  version: 0,

  ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.applyVolume();
    }
    return this.ctx;
  },

  applyVolume() {
    if (this.master) this.master.gain.value = this.muted ? 0 : Number($('volume').value);
  },

  async load(bytesByName) {
    const ctx = this.ensure();
    const buffers = new Map();
    const peaks = new Map();
    await Promise.all(
      [...bytesByName].map(async ([name, bytes]) => {
        try {
          const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          buffers.set(name, buf);
          peaks.set(name, computePeaks(buf));
        } catch (err) {
          console.warn(`could not decode audio "${name}"`, err);
        }
      }),
    );
    this.buffers = buffers;
    this.peaks = peaks;
    this.version++;
  },

  stopAll() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
      s.disconnect();
    }
    this.sources = [];
  },

  /** Schedule every audio event audible from `fromT` (timeline seconds) until `untilT`, starting at ctx time `when`. */
  schedule(fromT, untilT, when, rate) {
    this.stopAll();
    if (!this.ctx) return;
    for (const ev of S.audioEvents) {
      const buf = this.buffers.get(ev.asset);
      if (!buf || ev.time >= untilT - EPS) continue;
      let at, offset;
      if (ev.time >= fromT - EPS) {
        at = when + (ev.time - fromT) / rate;
        offset = 0;
      } else {
        offset = fromT - ev.time;
        if (offset >= buf.duration) continue;
        at = when;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const gain = this.ctx.createGain();
      gain.gain.value = ev.volume ?? 1;
      src.connect(gain).connect(this.master);
      // Cut sounds at the end of the playback range so loops stay clean.
      const maxDur = (untilT - Math.max(fromT, ev.time)) * 1; // in buffer seconds (rate cancels out)
      src.start(at, offset, Math.max(0, Math.min(buf.duration - offset, maxDur)));
      this.sources.push(src);
    }
  },
};

const PEAK_RATE = 400; // peaks per second of audio
function computePeaks(buf) {
  const n = Math.ceil(buf.duration * PEAK_RATE);
  const out = new Float32Array(n);
  const per = buf.sampleRate / PEAK_RATE;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * per);
      const b = Math.min(data.length, Math.floor((i + 1) * per));
      let m = out[i];
      for (let j = a; j < b; j++) {
        const v = data[j] < 0 ? -data[j] : data[j];
        if (v > m) m = v;
      }
      out[i] = m;
    }
  }
  return out;
}

// ================================================================ clock / transport
const clock = { anchorT: 0, anchorAt: 0, kind: 'perf' };

function clockNow(kind = clock.kind) {
  return kind === 'audio' ? audio.ctx.currentTime : performance.now() / 1000;
}

function rangeStart() {
  return S.inPt != null ? S.inPt : S.start;
}
function rangeEnd() {
  return S.outPt != null ? S.outPt : S.end;
}

function anchor() {
  const ctx = audio.ctx;
  clock.kind = ctx && ctx.state === 'running' ? 'audio' : 'perf';
  const lead = clock.kind === 'audio' ? 0.04 : 0;
  clock.anchorT = S.t;
  clock.anchorAt = clockNow() + lead;
  if (clock.kind === 'audio') audio.schedule(S.t, rangeEnd(), clock.anchorAt, S.rate);
  else audio.stopAll();
}

function currentPlayTime() {
  if (clock.kind === 'perf' && audio.ctx && audio.ctx.state === 'running') {
    // Audio became available mid-play: hand the clock over to it.
    anchor();
  }
  return clock.anchorT + Math.max(0, clockNow() - clock.anchorAt) * S.rate;
}

async function play() {
  if (!S.anim) return;
  const ctx = audio.ensure();
  if (ctx.state !== 'running') {
    try {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
    } catch {}
  }
  if (S.t >= rangeEnd() - 0.5 / S.fps || S.t < rangeStart() - EPS) S.t = rangeStart();
  S.playing = true;
  anchor();
  updateTransportUI();
}

function pause() {
  if (!S.playing) return;
  S.playing = false;
  audio.stopAll();
  S.t = snap(S.t);
  S.dirty = true;
  updateTransportUI();
  writeHash();
}

function togglePlay() {
  S.playing ? pause() : play();
}

function snap(t) {
  return Math.round(t * S.fps) / S.fps;
}

function seek(t, { snapToFrame = true } = {}) {
  t = clamp(t, S.start, S.end);
  S.t = snapToFrame ? snap(t) : t;
  S.dirty = true;
  if (!S.scrubbing) followPlayhead();
  if (S.playing) anchor();
  else writeHash();
}

function frameOf(t) {
  return Math.floor(t * S.fps + EPS);
}

function stepFrames(n) {
  if (S.playing) pause();
  seek((frameOf(S.t) + n) / S.fps);
}

// ================================================================ rive
const canvas = $('canvas');

async function initRive() {
  // The npm package ships the wasm as rive.wasm, but the loader asks for webgl2_advanced.wasm.
  S.rive = await RiveInit({ locateFile: (f) => `/vendor/rive/${f === 'webgl2_advanced.wasm' ? 'rive.wasm' : f}` });
  S.renderer = S.rive.makeRenderer(canvas, true);
}

async function loadBuild(version) {
  const [metaRes, rivRes] = await Promise.all([fetch(`/meta.json?v=${version}`), fetch(`/project.riv?v=${version}`)]);
  if (!rivRes.ok) throw new Error(await rivRes.text());
  const info = await metaRes.json();
  const bytes = new Uint8Array(await rivRes.arrayBuffer());

  const audioBytes = new Map();
  const loader = new S.rive.CustomFileAssetLoader({
    loadContents: (asset, data) => {
      if (asset.isAudio) {
        // Keep the bytes for Web Audio; the runtime itself stays silent so
        // playback can be scrubbed and kept in sync with the playhead.
        if (data && data.length) audioBytes.set(asset.name, new Uint8Array(data));
        return true;
      }
      return false;
    },
  });
  const file = await S.rive.load(bytes, loader, false);

  const prev = { ab: S.abName, anim: S.animName };
  disposeInstances();
  if (S.file) S.file.delete?.();
  S.file = file;
  S.meta = info.meta;
  S.name = info.name;
  S.version = version;
  $('badge-name').textContent = info.name;
  document.title = `${info.name} — Rive Preview`;

  await audio.load(audioBytes);
  populateSelectors();

  const abName = pickArtboard(prev.ab ?? initial.artboard);
  const animName = pickAnimation(abName, prev.anim ?? initial.animation);
  selectAnimation(abName, animName, { keepTime: prev.ab != null });
}

function artboardNames() {
  if (S.meta?.artboards?.length) return S.meta.artboards.map((a) => a.name);
  const names = [];
  for (let i = 0; i < S.file.artboardCount(); i++) {
    const ab = S.file.artboardByIndex(i);
    names.push(ab.name);
    ab.delete();
  }
  return names;
}

function animationNames(abName) {
  const m = S.meta?.artboards?.find((a) => a.name === abName);
  if (m) return m.animations.map((a) => a.name);
  const ab = S.file.artboardByName(abName);
  const names = [];
  for (let i = 0; i < ab.animationCount(); i++) names.push(ab.animationByIndex(i).name);
  ab.delete();
  return names;
}

function pickArtboard(want) {
  const names = artboardNames();
  if (want && names.includes(want)) return want;
  if (S.meta?.defaultArtboard && names.includes(S.meta.defaultArtboard)) return S.meta.defaultArtboard;
  return names[0];
}

function pickAnimation(abName, want) {
  const names = animationNames(abName);
  if (want && names.includes(want)) return want;
  const m = S.meta?.artboards?.find((a) => a.name === abName);
  if (m?.defaultAnimation && names.includes(m.defaultAnimation)) return m.defaultAnimation;
  return names[0] ?? null;
}

function disposeInstances() {
  if (S.anim) S.anim.delete();
  if (S.artboard) S.artboard.delete();
  S.anim = null;
  S.artboard = null;
}

function selectAnimation(abName, animName, { keepTime = false } = {}) {
  const prevT = S.t;
  const wasPlaying = S.playing;
  if (S.playing) {
    S.playing = false;
    audio.stopAll();
  }
  disposeInstances();
  S.abName = abName;
  S.animName = animName;
  S.artboard = S.file.artboardByName(abName);

  const metaAb = S.meta?.artboards?.find((a) => a.name === abName);
  const metaAnim = metaAb?.animations.find((a) => a.name === animName);

  if (animName != null) {
    const la = S.artboard.animationByName(animName);
    S.anim = new S.rive.LinearAnimationInstance(la, S.artboard);
  }

  if (metaAnim) {
    S.fps = metaAnim.fps;
    S.start = metaAnim.startFrame / S.fps;
    S.end = metaAnim.endFrame / S.fps;
    S.audioEvents = metaAnim.audio;
  } else if (S.anim) {
    // Raw .riv: the low-level instance exposes no duration/fps, so measure it.
    S.fps = 60;
    S.start = 0;
    S.end = Math.max(1 / S.fps, Math.round(probeDuration(S.anim) * S.fps) / S.fps);
    S.audioEvents = [];
  } else {
    S.fps = 60;
    S.start = 0;
    S.end = 1;
    S.audioEvents = [];
  }
  if (S.end <= S.start) S.end = S.start + 1 / S.fps;

  if (S.inPt != null && (S.inPt < S.start || S.inPt > S.end)) S.inPt = null;
  if (S.outPt != null && (S.outPt < S.start || S.outPt > S.end)) S.outPt = null;
  if (S.view && (S.view[0] < S.start || S.view[1] > S.end)) S.view = null;

  $('sel-artboard').value = abName;
  fillAnimationSelect(abName);
  $('tc-dur').textContent = `/ ${fmtTime(S.end)}`;

  if (keepTime) S.t = clamp(prevT, S.start, S.end);
  else {
    const at = parseTime(initial.at, S.fps);
    S.t = at != null ? clamp(snap(at), S.start, S.end) : S.start;
    initial.at = null;
  }
  S.dirty = true;
  S.tlDirty = true;
  updateRangeUI();
  if (wasPlaying) play();
  else updateTransportUI();
  writeHash();
}

/** Step the animation until it ends (one-shot) or wraps (loop / ping-pong); returns seconds. */
function probeDuration(anim) {
  const step = 1 / 60;
  anim.time = 0;
  let prev = 0;
  for (let i = 0; i < 60 * 60 * 10; i++) {
    const keepGoing = anim.advance(step);
    const t = anim.time;
    if (t < prev - EPS) {
      // loop wraps to near 0; ping-pong turns around near the end
      return t < prev / 2 ? prev + step - t : (prev + step + t) / 2;
    }
    if (!keepGoing) return t;
    prev = t;
  }
  return prev;
}

function populateSelectors() {
  const sel = $('sel-artboard');
  const names = artboardNames();
  sel.innerHTML = names.map((n) => `<option>${escapeHtml(n)}</option>`).join('');
  sel.hidden = names.length < 2;
}

function fillAnimationSelect(abName) {
  const sel = $('sel-animation');
  const names = animationNames(abName);
  sel.innerHTML = names.map((n) => `<option>${escapeHtml(n)}</option>`).join('');
  sel.value = S.animName ?? '';
  sel.hidden = names.length < 2;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function resizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
    return true;
  }
  return false;
}

function drawStage() {
  const r = S.renderer;
  if (!r || !S.artboard) return;
  if (S.anim) {
    S.anim.time = Math.min(S.t, S.end - EPS);
    S.anim.apply(1);
  }
  S.artboard.advance(0);
  r.clear();
  r.save();
  r.align(S.rive.Fit.contain, S.rive.Alignment.center, { minX: 0, minY: 0, maxX: canvas.width, maxY: canvas.height }, S.artboard.bounds);
  S.artboard.draw(r);
  r.restore();
  r.flush();
}

// ================================================================ timeline
const tl = $('timeline');
const tlc = $('timeline-canvas');
const TL = { pad: 12, rulerH: 20, waveTop: 24, waveH: 40, evTop: 68, evH: 12 };
let waveCache = null;

function viewRange() {
  return S.view ?? [S.start, S.end];
}

function tToX(t, w) {
  const [a, b] = viewRange();
  return TL.pad + ((t - a) / (b - a)) * (w - 2 * TL.pad);
}

function xToT(x, w) {
  const [a, b] = viewRange();
  return a + ((x - TL.pad) / (w - 2 * TL.pad)) * (b - a);
}

const TICK_STEPS = [1, 2, 5, 10, 15, 30].map((f) => -f).concat([0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]);
function tickStep(pxPerSec) {
  // negative entries are frame counts
  for (const s of TICK_STEPS) {
    const sec = s < 0 ? -s / S.fps : s;
    if (sec * pxPerSec >= 72) return sec;
  }
  return 600;
}

function fmtTick(t, step) {
  if (step < 1) {
    const f = Math.round(t * S.fps);
    const secs = Math.floor(f / S.fps + EPS);
    const ff = f - Math.round(secs * S.fps);
    return ff === 0 ? fmtShort(secs) : `${fmtShort(secs)}+${ff}f`;
  }
  return fmtShort(Math.round(t));
}
function fmtShort(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${pad(s)}`;
}

function assetColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 65% 62%)`;
}

function renderWave(w, h, dpr) {
  const key = [w, h, dpr, ...viewRange(), audio.version, S.abName, S.animName, S.audioEvents.length].join('|');
  if (waveCache?.key === key) return waveCache.canvas;
  const c = waveCache?.canvas ?? document.createElement('canvas');
  c.width = w * dpr;
  c.height = h * dpr;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const mid = TL.waveTop + TL.waveH / 2;
  g.fillStyle = '#1e1e22';
  g.fillRect(TL.pad, TL.waveTop, w - 2 * TL.pad, TL.waveH);

  const events = S.audioEvents.filter((e) => audio.peaks.has(e.asset));
  if (events.length) {
    g.fillStyle = '#6f7c94';
    const x0 = TL.pad;
    const x1 = w - TL.pad;
    for (let x = x0; x < x1; x++) {
      const ta = xToT(x, w);
      const tb = xToT(x + 1, w);
      let amp = 0;
      for (const ev of events) {
        const pk = audio.peaks.get(ev.asset);
        const a = ta - ev.time;
        const b = tb - ev.time;
        const len = pk.length / PEAK_RATE;
        if (b < 0 || a > len) continue;
        const i0 = Math.max(0, Math.floor(a * PEAK_RATE));
        const i1 = Math.min(pk.length, Math.max(i0 + 1, Math.ceil(b * PEAK_RATE)));
        let m = 0;
        for (let i = i0; i < i1; i++) if (pk[i] > m) m = pk[i];
        amp += m * (ev.volume ?? 1);
      }
      if (amp > 0) {
        const hh = Math.max(0.5, Math.pow(Math.min(1, amp), 0.7) * (TL.waveH / 2 - 2));
        g.fillRect(x, mid - hh, 1, hh * 2);
      }
    }
  } else {
    g.fillStyle = '#4a4a52';
    g.font = '11px -apple-system, system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(S.meta ? 'no audio events in this animation' : 'audio timing unavailable for a raw .riv', TL.pad + 8, mid);
  }

  // event markers
  for (const ev of S.audioEvents) {
    const x = Math.round(tToX(ev.time, w)) + 0.5;
    if (x < TL.pad - 1 || x > w - TL.pad + 1) continue;
    g.fillStyle = assetColor(ev.asset);
    g.fillRect(x - 0.5, TL.evTop, 1.5, TL.evH);
    g.beginPath();
    g.arc(x, TL.evTop + 2, 2.2, 0, Math.PI * 2);
    g.fill();
  }
  waveCache = { key, canvas: c };
  return c;
}

function drawTimeline() {
  resizeCanvas(tlc);
  const dpr = window.devicePixelRatio || 1;
  const w = tlc.clientWidth;
  const h = tlc.clientHeight;
  const g = tlc.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!S.anim && !S.artboard) return;

  const [va, vb] = viewRange();
  const pxPerSec = (w - 2 * TL.pad) / (vb - va);

  // ruler
  const step = tickStep(pxPerSec);
  const minor = step / 5 >= 1 / S.fps ? step / 5 : step;
  g.fillStyle = '#5a5a63';
  for (let t = Math.ceil(va / minor - EPS) * minor; t <= vb + EPS; t += minor) {
    const x = Math.round(tToX(t, w)) + 0.5;
    g.fillRect(x - 0.5, TL.rulerH - 5, 1, 5);
  }
  g.font = '10.5px ui-monospace, Menlo, monospace';
  g.textBaseline = 'top';
  for (let t = Math.ceil(va / step - EPS) * step; t <= vb + EPS; t += step) {
    const x = Math.round(tToX(t, w)) + 0.5;
    g.fillStyle = '#7a7a84';
    g.fillRect(x - 0.5, TL.rulerH - 10, 1, 10);
    g.fillStyle = '#9a9aa3';
    g.fillText(fmtTick(t, step), x + 4, 4);
  }

  g.drawImage(renderWave(w, h, dpr), 0, 0, w, h);

  // in/out range
  if (S.inPt != null || S.outPt != null) {
    const xa = tToX(rangeStart(), w);
    const xb = tToX(rangeEnd(), w);
    g.fillStyle = 'rgba(0,0,0,0.45)';
    if (xa > TL.pad) g.fillRect(TL.pad, TL.rulerH, xa - TL.pad, h - TL.rulerH);
    if (xb < w - TL.pad) g.fillRect(xb, TL.rulerH, w - TL.pad - xb, h - TL.rulerH);
    g.fillStyle = 'rgba(91,141,239,0.10)';
    g.fillRect(xa, TL.rulerH, xb - xa, h - TL.rulerH);
    g.fillStyle = '#5b8def';
    g.fillRect(xa, 0, xb - xa, 3);
    g.fillRect(Math.round(xa) - 1, 0, 2, h);
    g.fillRect(Math.round(xb) - 1, 0, 2, h);
  }

  // hover
  if (S.hoverT != null && !S.scrubbing) {
    const x = Math.round(tToX(S.hoverT, w)) + 0.5;
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(x - 0.5, TL.rulerH, 1, h - TL.rulerH);
    const label = `${fmtTime(snap(S.hoverT))}  f${frameOf(snap(S.hoverT))}`;
    g.font = '10.5px ui-monospace, Menlo, monospace';
    const tw = g.measureText(label).width + 10;
    const lx = clamp(x - tw / 2, 2, w - tw - 2);
    g.fillStyle = 'rgba(14,14,16,0.92)';
    g.fillRect(lx, h - 16, tw, 15);
    g.fillStyle = '#d8d8dc';
    g.textBaseline = 'middle';
    g.fillText(label, lx + 5, h - 8.5);
  }

  // playhead
  const px = Math.round(tToX(S.t, w));
  if (px >= TL.pad - 6 && px <= w - TL.pad + 6) {
    g.fillStyle = '#ff4f4f';
    g.fillRect(px - 1, 6, 2, h - 6);
    g.beginPath();
    g.moveTo(px - 6, 0);
    g.lineTo(px + 6, 0);
    g.lineTo(px + 6, 6);
    g.lineTo(px, 12);
    g.lineTo(px - 6, 6);
    g.closePath();
    g.fill();
  }

  // zoom indicator
  if (S.view) {
    const full = S.end - S.start;
    const a = (va - S.start) / full;
    const b = (vb - S.start) / full;
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(TL.pad + a * (w - 2 * TL.pad), h - 2, Math.max(4, (b - a) * (w - 2 * TL.pad)), 2);
  }
}

function followPlayhead() {
  if (!S.view) return;
  const [a, b] = S.view;
  const span = b - a;
  if (S.t > b || S.t < a) {
    let na = S.t > b ? S.t - span * 0.1 : S.t - span * 0.1;
    na = clamp(na, S.start, S.end - span);
    S.view = [na, na + span];
  }
}

function zoomAt(t, factor) {
  const [a, b] = viewRange();
  const full = S.end - S.start;
  const minSpan = Math.min(full, 12 / S.fps);
  let span = clamp((b - a) * factor, minSpan, full);
  if (span >= full - EPS) {
    S.view = null;
    return;
  }
  const r = (t - a) / (b - a);
  let na = clamp(t - r * span, S.start, S.end - span);
  S.view = [na, na + span];
}

function pan(dt) {
  if (!S.view) return;
  const span = S.view[1] - S.view[0];
  const na = clamp(S.view[0] + dt, S.start, S.end - span);
  S.view = [na, na + span];
}

let scrubWasPlaying = false;
tl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !S.anim) return;
  tl.setPointerCapture(e.pointerId);
  S.scrubbing = true;
  scrubWasPlaying = S.playing;
  if (S.playing) pause();
  seek(xToT(e.offsetX, tl.clientWidth));
});
tl.addEventListener('pointermove', (e) => {
  const t = clamp(xToT(e.offsetX, tl.clientWidth), S.start, S.end);
  S.hoverT = t;
  if (S.scrubbing) seek(t);
  S.tlDirty = true;
});
const endScrub = () => {
  if (!S.scrubbing) return;
  S.scrubbing = false;
  if (scrubWasPlaying) play();
  S.tlDirty = true;
};
tl.addEventListener('pointerup', endScrub);
tl.addEventListener('pointercancel', endScrub);
tl.addEventListener('pointerleave', () => {
  S.hoverT = null;
  S.tlDirty = true;
});
tl.addEventListener('dblclick', (e) => {
  if (e.offsetY <= TL.rulerH + 4) {
    S.view = null;
    S.tlDirty = true;
  }
});
tl.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const w = tl.clientWidth;
    const [a, b] = viewRange();
    const secPerPx = (b - a) / (w - 2 * TL.pad);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      pan((e.shiftKey ? e.deltaY || e.deltaX : e.deltaX) * secPerPx);
    } else {
      const k = e.ctrlKey ? 0.01 : 0.0025;
      zoomAt(xToT(e.offsetX, w), Math.exp(e.deltaY * k));
    }
    S.tlDirty = true;
  },
  { passive: false },
);

// ================================================================ UI
function updateTransportUI() {
  $('btn-play').innerHTML = S.playing ? ICONS.pause : ICONS.play;
  $('btn-play').title = S.playing ? 'Pause (Space)' : 'Play (Space)';
  $('btn-loop').classList.toggle('on', S.loop);
  $('btn-mute').innerHTML = audio.muted ? ICONS.mute : ICONS.vol;
}

let lastTc = '';
function updateTimecode() {
  const shown = S.playing ? S.t : snap(S.t);
  const tc = fmtTime(shown);
  const fr = `f ${frameOf(shown)}`;
  const key = tc + fr;
  if (key === lastTc) return;
  lastTc = key;
  $('tc-time').textContent = tc;
  $('tc-frame').textContent = fr;
}

function timecodeText(t = S.t) {
  t = snap(t);
  return `${fmtTime(t)} (frame ${frameOf(t)})`;
}

function rangeText() {
  const a = snap(rangeStart());
  const b = snap(rangeEnd());
  return `${fmtTime(a)}–${fmtTime(b)} (frames ${frameOf(a)}–${frameOf(b)})`;
}

function updateRangeUI() {
  const el = $('range');
  if (S.inPt == null && S.outPt == null) {
    el.hidden = true;
  } else {
    el.hidden = false;
    el.textContent = `${fmtTime(rangeStart())} → ${fmtTime(rangeEnd())}`;
  }
  S.tlDirty = true;
  writeHash();
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`Copied  ${text}`);
  fetch('/api/log', { method: 'POST', body: JSON.stringify({ copied: text }) }).catch(() => {});
}

let toastTimer;
function toast(msg, ms = 1600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

let hashTimer;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = new URLSearchParams();
    p.set('t', snap(S.t).toFixed(3).replace(/\.?0+$/, '') || '0');
    if (S.abName && artboardNames().length > 1) p.set('artboard', S.abName);
    if (S.animName && $('sel-animation').options.length > 1) p.set('animation', S.animName);
    if (S.inPt != null) p.set('in', String(S.inPt));
    if (S.outPt != null) p.set('out', String(S.outPt));
    history.replaceState(null, '', '#' + p.toString());
  }, 150);
}

function setIn() {
  S.inPt = snap(S.t);
  if (S.outPt != null && S.outPt <= S.inPt) S.outPt = null;
  updateRangeUI();
}
function setOut() {
  S.outPt = snap(S.t);
  if (S.inPt != null && S.inPt >= S.outPt) S.inPt = null;
  updateRangeUI();
}
function clearRange() {
  S.inPt = S.outPt = null;
  updateRangeUI();
  if (S.playing) anchor();
}

function openGoto() {
  const input = $('goto');
  $('timecode').hidden = true;
  input.hidden = false;
  input.value = fmtTime(snap(S.t));
  input.focus();
  input.select();
}
function closeGoto(apply) {
  const input = $('goto');
  if (input.hidden) return;
  if (apply) {
    const t = parseTime(input.value, S.fps);
    if (t == null) {
      toast(`Can't read "${input.value}" — try 12.5, 1:02.25 or f741`, 2400);
      return;
    }
    seek(t);
  }
  input.hidden = true;
  $('timecode').hidden = false;
}
$('goto').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') closeGoto(true);
  if (e.key === 'Escape') closeGoto(false);
});
$('goto').addEventListener('blur', () => closeGoto(false));

let tcClickTimer;
$('timecode').addEventListener('click', () => {
  clearTimeout(tcClickTimer);
  tcClickTimer = setTimeout(() => copy(timecodeText()), 220);
});
$('timecode').addEventListener('dblclick', () => {
  clearTimeout(tcClickTimer);
  openGoto();
});
$('range').addEventListener('click', () => copy(rangeText()));
$('btn-play').addEventListener('click', togglePlay);
$('btn-prev').addEventListener('click', () => stepFrames(-1));
$('btn-next').addEventListener('click', () => stepFrames(1));
$('btn-loop').addEventListener('click', () => {
  S.loop = !S.loop;
  updateTransportUI();
  savePrefs();
});
$('btn-mute').addEventListener('click', toggleMute);
$('volume').addEventListener('input', () => {
  if (audio.muted && Number($('volume').value) > 0) audio.muted = false;
  audio.applyVolume();
  updateTransportUI();
  savePrefs();
});
$('sel-rate').addEventListener('change', (e) => {
  S.rate = Number(e.target.value);
  if (S.playing) anchor();
  e.target.blur();
});
$('sel-artboard').addEventListener('change', (e) => {
  selectAnimation(e.target.value, pickAnimation(e.target.value, null));
  e.target.blur();
});
$('sel-animation').addEventListener('change', (e) => {
  selectAnimation(S.abName, e.target.value);
  e.target.blur();
});
$('btn-help').addEventListener('click', () => ($('help').hidden = !$('help').hidden));
$('help').addEventListener('click', (e) => {
  if (e.target === $('help')) $('help').hidden = true;
});
canvas.addEventListener('click', togglePlay);

function toggleMute() {
  audio.muted = !audio.muted;
  audio.applyVolume();
  updateTransportUI();
  savePrefs();
}

window.addEventListener('keydown', (e) => {
  const tgt = e.target;
  if ((tgt instanceof HTMLInputElement && tgt.type === 'text') || tgt instanceof HTMLTextAreaElement) {
    // Typing a note: Esc leaves the field, Cmd/Ctrl+Enter finishes it (and sends from the overall note).
    if (e.key === 'Escape') tgt.blur();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && tgt instanceof HTMLTextAreaElement) {
      e.preventDefault();
      tgt.blur();
      if (tgt.id === 'share-message') shareShots();
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  let handled = true;
  switch (k) {
    case ' ':
    case 'k':
    case 'K':
      togglePlay();
      break;
    case 'ArrowLeft':
      e.shiftKey ? (pause(), seek(S.t - 1)) : stepFrames(-1);
      break;
    case 'ArrowRight':
      e.shiftKey ? (pause(), seek(S.t + 1)) : stepFrames(1);
      break;
    case ',':
      stepFrames(-1);
      break;
    case '.':
      stepFrames(1);
      break;
    case 'Home':
      seek(rangeStart());
      break;
    case 'End':
      pause();
      seek(rangeEnd());
      break;
    case 'i':
    case 'I':
      setIn();
      break;
    case 'o':
    case 'O':
      setOut();
      break;
    case 'x':
    case 'X':
      clearRange();
      break;
    case 'c':
      copy(timecodeText());
      break;
    case 'C':
      copy(S.inPt != null || S.outPt != null ? rangeText() : timecodeText());
      break;
    case 'g':
    case 'G':
      openGoto();
      break;
    case 'l':
    case 'L':
      S.loop = !S.loop;
      updateTransportUI();
      savePrefs();
      toast(S.loop ? 'Loop on' : 'Loop off', 900);
      break;
    case 'm':
    case 'M':
      toggleMute();
      toast(audio.muted ? 'Muted' : 'Sound on', 900);
      break;
    case 'f':
    case 'F':
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      break;
    case 's':
    case 'S':
      takeScreenshot();
      break;
    case 'n':
    case 'N':
      setNotesOpen(!notes.open);
      break;
    case '?':
      $('help').hidden = !$('help').hidden;
      break;
    case 'Escape':
      $('help').hidden = true;
      break;
    default:
      handled = false;
  }
  if (handled) {
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
  }
});

new ResizeObserver(() => {
  S.dirty = true;
  S.tlDirty = true;
}).observe(document.body);

// ================================================================ screenshots & notes
// Shots are kept by the server in <project>/.rive-preview/drafts until "Send to agent"
// moves them into a feedback bundle that the MCP server hands to the coding agent.
const notes = {
  shots: [],
  open: false,
  // id -> { text, rev, sentRev, savedRev }: every edit bumps rev; a note is dirty until the
  // server has its latest rev. Dirty notes are never overwritten by a refresh.
  edits: new Map(),
  timers: new Map(), // id -> debounce timer
  inflight: new Map(), // id -> promise of the last queued PATCH for that shot
  sending: false, // notes are frozen while a share is in progress
  clientId: Math.random().toString(36).slice(2),
  lastBundle: null,
  watchTimer: null,
};
const ICON_X = '<svg viewBox="0 0 16 16"><path d="M4.2 3.1 8 6.9l3.8-3.8 1.1 1.1L9.1 8l3.8 3.8-1.1 1.1L8 9.1l-3.8 3.8-1.1-1.1L6.9 8 3.1 4.2z"/></svg>';
const MAX_SHOT_EDGE = 1600;

function setNotesOpen(open) {
  notes.open = open;
  $('notes').hidden = !open;
  $('btn-notes').classList.toggle('on', open);
  S.dirty = true;
  try {
    localStorage.setItem('rvp:notes-open', open ? '1' : '0');
  } catch {}
}

/** Crop the drawn artboard out of the stage canvas (scaled to at most MAX_SHOT_EDGE). */
function cropStage() {
  const cw = canvas.width;
  const ch = canvas.height;
  const b = S.artboard.bounds;
  const aw = b.maxX - b.minX;
  const ah = b.maxY - b.minY;
  let sx = 0, sy = 0, sw = cw, sh = ch;
  if (aw > 0 && ah > 0) {
    const k = Math.min(cw / aw, ch / ah);
    sw = aw * k;
    sh = ah * k;
    sx = (cw - sw) / 2;
    sy = (ch - sh) / 2;
  }
  const k = Math.min(1, MAX_SHOT_EDGE / Math.max(sw, sh));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(sw * k));
  out.height = Math.max(1, Math.round(sh * k));
  const g = out.getContext('2d', { willReadFrequently: true });
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--stage').trim() || '#141416';
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

function looksBlank(c) {
  const g = c.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const step = Math.max(4, Math.floor(d.length / 4 / 4000) * 4);
  for (let i = 4; i < d.length; i += step) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) return false;
  return true;
}

/** Draw the current frame and grab it. Retries on the next frames in case the GL buffer was already presented. */
function captureFrame() {
  return new Promise((resolve) => {
    let tries = 0;
    const attempt = () => {
      drawStage();
      const out = cropStage();
      if (!looksBlank(out) || ++tries >= 3) resolve(out);
      else S.rive.requestAnimationFrame(attempt);
    };
    attempt();
  });
}

async function takeScreenshot() {
  if (!S.artboard) return toast('Nothing to capture yet');
  if (S.playing) pause();
  const t = snap(S.t);
  S.t = t;
  const img = await captureFrame();
  const res = await fetch('/api/shots', {
    method: 'POST',
    headers: { 'x-client': notes.clientId },
    body: JSON.stringify({
      image: img.toDataURL('image/png'),
      time: t,
      frame: frameOf(t),
      fps: S.fps,
      timecode: timecodeText(t),
      artboard: S.abName,
      animation: S.animName,
      width: img.width,
      height: img.height,
    }),
  });
  if (!res.ok) return toast(`Screenshot failed: ${await res.text()}`, 3000);
  const shot = await res.json();
  if (!notes.open) setNotesOpen(true);
  await loadShots();
  const card = $('shot-list').querySelector(`[data-id="${shot.id}"]`);
  if (card) {
    card.classList.add('fresh');
    setTimeout(() => card.classList.remove('fresh'), 1500);
    card.scrollIntoView({ block: 'nearest' });
    card.querySelector('textarea').focus();
  }
  toast(`Screenshot  ${shot.timecode} — write a note`);
}

async function loadShots() {
  try {
    const res = await fetch('/api/shots');
    notes.shots = (await res.json()).shots || [];
  } catch {
    return;
  }
  renderShots();
}

function shotWhere(s) {
  const parts = [];
  if (s.artboard && artboardNamesSafe().length > 1) parts.push(s.artboard);
  if (s.animation) parts.push(s.animation);
  return parts.join(' / ');
}
function artboardNamesSafe() {
  try {
    return S.file ? artboardNames() : [];
  } catch {
    return [];
  }
}

function makeCard(s) {
  const el = document.createElement('div');
  el.className = 'shot';
  el.dataset.id = s.id;
  el.innerHTML = `
    <img class="shot-img" alt="" title="Jump to this frame" draggable="false">
    <div class="shot-bar">
      <span class="shot-n"></span>
      <button class="shot-tc" title="Jump to this frame"></button>
      <span class="shot-where"></span>
      <button class="shot-del" title="Delete screenshot" aria-label="Delete screenshot">${ICON_X}</button>
    </div>
    <textarea rows="3" placeholder="What should change here?" spellcheck="true"></textarea>`;
  el.querySelector('img').src = s.url;
  el.querySelector('.shot-tc').textContent = s.timecode;
  const ta = el.querySelector('textarea');
  ta.value = s.note || '';
  ta.addEventListener('input', () => scheduleSave(s.id, ta.value));
  ta.addEventListener('blur', () => saveNote(s.id));
  const jump = () => jumpToShot(notes.shots.find((x) => x.id === s.id) || s);
  el.querySelector('img').addEventListener('click', jump);
  el.querySelector('.shot-tc').addEventListener('click', jump);
  el.querySelector('.shot-del').addEventListener('click', () => deleteShot(s.id));
  return el;
}

function renderShots() {
  const list = $('shot-list');
  const existing = new Map([...list.children].map((el) => [el.dataset.id, el]));
  notes.shots.forEach((s, i) => {
    let el = existing.get(s.id);
    existing.delete(s.id);
    if (!el) el = makeCard(s);
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] ?? null);
    el.querySelector('.shot-n').textContent = `#${i + 1}`;
    el.querySelector('.shot-where').textContent = shotWhere(s);
    const ta = el.querySelector('textarea');
    // Don't clobber what is being typed.
    if (document.activeElement !== ta && !isDirty(s.id) && ta.value !== (s.note || '')) ta.value = s.note || '';
  });
  for (const el of existing.values()) el.remove();
  for (const id of notes.edits.keys()) if (!notes.shots.some((s) => s.id === id) && !notes.inflight.has(id)) notes.edits.delete(id);
  // While sending, nothing may change: the bundle is a snapshot of these notes.
  for (const el of list.querySelectorAll('textarea, .shot-del')) el.disabled = notes.sending;
  $('share-message').disabled = notes.sending;
  const n = notes.shots.length;
  $('notes-count').textContent = n ? String(n) : '';
  $('shot-empty').hidden = n > 0;
  $('btn-share').disabled = n === 0 || notes.sending;
  $('btn-share').textContent = notes.sending ? 'Sending…' : n ? `Send ${n} screenshot${n === 1 ? '' : 's'} to agent` : 'Send to agent';
}

function jumpToShot(s) {
  if (!S.file) return;
  if ((s.artboard && s.artboard !== S.abName) || (s.animation && s.animation !== S.animName)) {
    const ab = artboardNames().includes(s.artboard) ? s.artboard : S.abName;
    const anim = animationNames(ab).includes(s.animation) ? s.animation : pickAnimation(ab, null);
    selectAnimation(ab, anim, { keepTime: true });
  }
  pause();
  seek(s.time ?? S.t);
}

const isDirty = (id) => {
  const e = notes.edits.get(id);
  return !!e && e.savedRev < e.rev;
};

function scheduleSave(id, text) {
  const e = notes.edits.get(id) ?? { text: '', rev: 0, sentRev: 0, savedRev: 0 };
  e.text = text;
  e.rev++;
  notes.edits.set(id, e);
  clearTimeout(notes.timers.get(id));
  notes.timers.set(id, setTimeout(() => saveNote(id), 400));
}

/**
 * Send a shot's latest unsent revision. Saves for one shot run one after another, so they
 * land in order; the returned promise (true = saved) covers every save queued before it.
 * A failed save only marks its own revision unsent: a newer revision, queued or saved,
 * always wins, so stale text can never be restored over newer text.
 */
function saveNote(id) {
  clearTimeout(notes.timers.get(id));
  notes.timers.delete(id);
  const e = notes.edits.get(id);
  const prev = notes.inflight.get(id) ?? Promise.resolve(true);
  if (!e || e.sentRev >= e.rev) return prev;
  const rev = e.rev;
  const text = e.text;
  e.sentRev = rev;
  const p = prev.then(async () => {
    if (e.savedRev >= rev) return true;
    try {
      const res = await fetch(`/api/shots/${id}`, { method: 'PATCH', headers: { 'x-client': notes.clientId }, body: JSON.stringify({ note: text }) });
      if (!res.ok) throw new Error(res.status === 404 ? 'not found' : await res.text());
      e.savedRev = Math.max(e.savedRev, rev);
      const shot = notes.shots.find((s) => s.id === id);
      if (shot && e.savedRev === e.rev) shot.note = e.text;
      return true;
    } catch (err) {
      if (!notes.shots.some((s) => s.id === id)) return true; // deleted meanwhile; nothing to keep
      if (e.rev === rev) e.sentRev = e.savedRev; // only the latest text needs sending again
      toast(`Could not save the note (${err.message || err}) — is rive-video-preview running?`, 3000);
      return false;
    }
  });
  notes.inflight.set(id, p);
  p.then(() => {
    if (notes.inflight.get(id) === p) notes.inflight.delete(id);
  });
  return p;
}

/** Save every dirty note and wait for queued saves. Resolves true only if every note is saved. */
async function flushSaves() {
  const ids = new Set([...notes.edits.keys(), ...notes.inflight.keys()]);
  await Promise.all([...ids].map(saveNote));
  return ![...notes.edits.keys()].some((id) => isDirty(id) && notes.shots.some((s) => s.id === id));
}

async function deleteShot(id) {
  if (notes.sending) return;
  const shot = notes.shots.find((s) => s.id === id);
  const note = notes.edits.get(id)?.text ?? shot?.note ?? '';
  if (note.trim() && !confirm('Delete this screenshot and its note?')) return;
  clearTimeout(notes.timers.get(id));
  notes.edits.delete(id);
  notes.shots = notes.shots.filter((s) => s.id !== id);
  renderShots();
  await fetch(`/api/shots/${id}`, { method: 'DELETE' }).catch(() => {});
}

async function shareShots() {
  if (!notes.shots.length || notes.sending) return;
  // Freeze the notes so nothing typed now is left out of the bundle and then deleted with the drafts.
  notes.sending = true;
  if (document.activeElement instanceof HTMLTextAreaElement) document.activeElement.blur();
  renderShots();
  let bundle;
  try {
    if (!(await flushSaves())) throw new Error('some notes could not be saved');
    const res = await fetch('/api/share', { method: 'POST', body: JSON.stringify({ message: $('share-message').value }) });
    bundle = await res.json();
    if (!res.ok) throw new Error(bundle.error || res.statusText);
  } catch (err) {
    toast(`Could not send: ${err.message || err}`, 3000);
    return;
  } finally {
    notes.sending = false;
    renderShots();
  }
  $('share-message').value = '';
  saveMessageDraft();
  const n = bundle.shots.length;
  const prompt = `I left feedback on the Rive animation in the preview player (${n} screenshot${n === 1 ? '' : 's'} with notes). Read it with the rive-preview MCP tool get_feedback, or from ${bundle.markdown}`;
  let copied = false;
  try {
    await navigator.clipboard.writeText(prompt);
    copied = true;
  } catch {}
  notes.lastBundle = { id: bundle.id, createdAt: bundle.createdAt, markdown: bundle.markdown, count: n, consumed: null, copied };
  renderShareStatus();
  watchBundle();
  toast(copied ? `Sent ${n} to the agent · prompt copied` : `Sent ${n} to the agent`, 2400);
  await loadShots();
}

function renderShareStatus() {
  const el = $('share-status');
  const b = notes.lastBundle;
  if (!b) return (el.innerHTML = '');
  const when = new Date(b.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const what = `${b.count} screenshot${b.count === 1 ? '' : 's'}`;
  if (b.consumed) {
    const at = new Date(b.consumed.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<span class="ok">✓ The agent read the ${what} you sent at ${when}</span> (${at})`;
  } else {
    el.innerHTML =
      `Sent ${what} at ${when} — waiting for the agent to read ${b.count === 1 ? 'it' : 'them'}. ` +
      (b.copied ? 'A prompt for it is on the clipboard. ' : '') +
      `<code>${escapeHtml(b.markdown)}</code>`;
  }
}

async function refreshShareStatus() {
  try {
    const { bundles } = await (await fetch('/api/feedback')).json();
    const latest = bundles?.[bundles.length - 1];
    if (!latest) return;
    const copied = notes.lastBundle?.id === latest.id && notes.lastBundle.copied;
    notes.lastBundle = { ...latest, copied };
    renderShareStatus();
    if (!latest.consumed) watchBundle();
  } catch {}
}

function watchBundle() {
  clearInterval(notes.watchTimer);
  const started = Date.now();
  notes.watchTimer = setInterval(async () => {
    if (!notes.lastBundle || notes.lastBundle.consumed || Date.now() - started > 60 * 60 * 1000) return clearInterval(notes.watchTimer);
    await refreshShareStatus();
  }, 2000);
}

function saveMessageDraft() {
  try {
    localStorage.setItem('rvp:share-message', $('share-message').value);
  } catch {}
}

$('btn-shot').addEventListener('click', takeScreenshot);
$('btn-notes').addEventListener('click', () => setNotesOpen(!notes.open));
$('btn-notes-close').addEventListener('click', () => setNotesOpen(false));
$('btn-share').addEventListener('click', shareShots);
$('share-message').addEventListener('input', saveMessageDraft);
try {
  $('share-message').value = localStorage.getItem('rvp:share-message') || '';
  if (localStorage.getItem('rvp:notes-open') === '1') setNotesOpen(true);
} catch {}

// ================================================================ loop
function frame() {
  if (S.playing) {
    let t = currentPlayTime();
    const end = rangeEnd();
    if (t >= end) {
      if (S.loop) {
        S.t = rangeStart();
        anchor();
        t = S.t;
      } else {
        S.t = end;
        pause();
        t = end;
      }
    }
    S.t = t;
    S.dirty = true;
    followPlayhead();
  }
  if (resizeCanvas(canvas)) S.dirty = true;
  if (S.dirty) {
    S.dirty = false;
    drawStage();
    S.tlDirty = true;
  }
  if (S.tlDirty) {
    S.tlDirty = false;
    drawTimeline();
    updateTimecode();
  }
  S.rive.requestAnimationFrame(frame);
}

// ================================================================ live reload
function setStatus(kind, text) {
  $('badge-dot').className = kind;
  $('badge-status').textContent = text;
  const badge = $('badge');
  badge.classList.add('show');
  clearTimeout(setStatus.t);
  if (kind === 'ok') setStatus.t = setTimeout(() => badge.classList.remove('show'), 1800);
}

function showError(msg) {
  const el = $('error');
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else el.hidden = true;
}

let loading = Promise.resolve();
function connect() {
  const es = new EventSource('/events');
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'building') setStatus('busy', 'rebuilding…');
    else if (msg.type === 'build') {
      if (msg.name) $('badge-name').textContent = msg.name;
      showError(msg.error ? `Build failed — showing the last good build\n\n${msg.error}` : null);
      if (msg.error) setStatus('err', 'build failed');
      if (msg.version > S.version) {
        loading = loading.then(async () => {
          if (msg.version <= S.version) return;
          try {
            await loadBuild(msg.version);
            setStatus('ok', S.version > 1 ? 'reloaded' : 'live');
          } catch (err) {
            console.error(err);
            showError(`Could not load the .riv: ${err.message || err}`);
            setStatus('err', 'load failed');
          }
        });
      } else if (!msg.error && msg.version > 0) setStatus('ok', 'up to date');
    } else if (msg.type === 'shots') {
      if (msg.from !== notes.clientId) loadShots();
      refreshShareStatus();
    } else if (msg.type === 'seek') {
      loading.then(() => {
        const t = parseTime(msg.at, S.fps);
        if (t != null) {
          pause();
          seek(t);
          toast(`Jumped to ${timecodeText()}`);
        }
      });
    }
  };
  es.onerror = () => setStatus('err', 'disconnected — is rive-video-preview running?');
  es.onopen = () => {
    loadShots();
    refreshShareStatus();
  };
}

// ================================================================ boot
(async () => {
  updateTransportUI();
  if (S.mutedPref) {
    audio.muted = true;
    updateTransportUI();
  }
  await initRive();
  connect();
  S.rive.requestAnimationFrame(frame);
})().catch((err) => {
  console.error(err);
  showError(`Player failed to start: ${err.message || err}`);
});

// Exposed for debugging / automation.
window.rvp = { S, audio, seek, play, pause, timecodeText, parseTime, takeScreenshot, notes };
