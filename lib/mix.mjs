// The audio mix set in the player: up to three tracks (volume, mute, solo) and, per sound
// effect, which track it is on and its own gain. Saved to <feedback root>/mix.json so it
// survives reloads and the MCP server can hand it to the coding agent.
//
// The player never changes the Rive project. What a sound effect plays at in the preview is
//   asset volume (from the .riv) × clip gain × track volume (0 when muted or another track is soloed)
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { feedbackRoot, feedbackTop } from './feedback.mjs';

export const MAX_TRACKS = 3;
const MAX_CLIPS = 5000;
// A clip key is a JSON tuple of artboard, animation and event names plus an index; names have
// no length limit of their own, so allow long ones (escaping included).
const MAX_KEY = 8192;
const MAX_GAIN = 1; // the player's clip volume slider runs 0–100%
const MAX_TRACK_VOLUME = 2;

const num = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const str = (v, max, dflt = null) => (typeof v === 'string' ? v.slice(0, max) : dflt);

export function defaultMix() {
  return { version: 1, tracks: [{ name: 'Track 1', volume: 1, muted: false, solo: false }], clips: {} };
}

/** Keep only values of the expected shape: the mix comes from the browser. */
export function sanitizeMix(input) {
  const out = defaultMix();
  if (!input || typeof input !== 'object') return out;
  const tracks = Array.isArray(input.tracks) ? input.tracks.slice(0, MAX_TRACKS) : [];
  if (tracks.length) {
    out.tracks = tracks.map((t, i) => ({
      name: str(t?.name, 40) || `Track ${i + 1}`,
      volume: num(t?.volume, 0, MAX_TRACK_VOLUME, 1),
      muted: t?.muted === true,
      solo: t?.solo === true,
    }));
  }
  const clips = input.clips && typeof input.clips === 'object' ? Object.entries(input.clips).slice(0, MAX_CLIPS) : [];
  for (const [key, c] of clips) {
    if (typeof key !== 'string' || key.length > MAX_KEY || !c || typeof c !== 'object') continue;
    const track = Number.isSafeInteger(c.track) ? Math.min(out.tracks.length - 1, Math.max(0, c.track)) : 0;
    const gain = num(c.gain, 0, MAX_GAIN, 1);
    if (track === 0 && gain === 1) continue; // default: nothing to keep
    out.clips[key] = {
      track,
      gain,
      // Descriptive, so the agent can tell which keyframe a clip is.
      artboard: str(c.artboard, 200),
      animation: str(c.animation, 200),
      event: str(c.event, 200),
      asset: str(c.asset, 200),
      frame: Number.isSafeInteger(c.frame) && c.frame >= 0 ? c.frame : null,
      time: num(c.time, 0, 1e7, null),
      assetVolume: num(c.assetVolume, 0, 100, null),
    };
  }
  return out;
}

const db = (g) => (g <= 0 ? '−∞ dB' : `${g >= 1 ? '+' : '−'}${Math.abs(20 * Math.log10(g)).toFixed(1)} dB`);
const pct = (g) => `${Math.round(g * 100)}%`;

/** Markdown lines describing the mix, or [] when it is all defaults. */
export function mixMarkdown(mix) {
  if (!mix) return [];
  const clips = Object.values(mix.clips || {});
  const tracksChanged = mix.tracks.length > 1 || mix.tracks.some((t) => t.volume !== 1 || t.muted || t.solo);
  if (!clips.length && !tracksChanged) return [];
  const lines = [
    '## Audio mix',
    '',
    'Set in the preview player; the Rive project is unchanged. In the preview a sound effect plays at',
    'asset volume × clip gain × track volume (0 if the track is muted or another is soloed). To keep a level, put the product in the asset `volume`',
    '(per asset) or split the sound into its own asset.',
    '',
    '| Track | Volume | State |',
    '|---|---|---|',
    ...mix.tracks.map((t, i) => `| ${i + 1}. ${t.name} | ${pct(t.volume)} (${db(t.volume)}) | ${[t.muted && 'muted', t.solo && 'solo'].filter(Boolean).join(', ') || '—'} |`),
    '',
  ];
  if (clips.length) {
    lines.push('| Sound effect | Where | Track | Clip gain | Asset volume | Plays at |', '|---|---|---|---|---|---|');
    const anySolo = mix.tracks.some((t) => t.solo);
    for (const c of clips.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))) {
      const t = mix.tracks[c.track] ?? mix.tracks[0];
      const silent = t.muted || (anySolo && !t.solo);
      const at = silent ? 0 : (c.assetVolume ?? 1) * c.gain * t.volume;
      const where = [c.animation, c.frame != null ? `frame ${c.frame}` : null].filter(Boolean).join(' · ');
      lines.push(`| ${c.event ?? '?'} (${c.asset ?? '?'}) | ${where} | ${c.track + 1}. ${t.name} | ${pct(c.gain)} (${db(c.gain)}) | ${+(c.assetVolume ?? 1).toFixed(3)} | ${at.toFixed(3)}${silent ? ' (track silent)' : ''} |`);
    }
    lines.push('');
  }
  return lines;
}

export class MixStore {
  constructor(target) {
    this.top = feedbackTop(target);
    this.file = path.join(feedbackRoot(target), 'mix.json');
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      return sanitizeMix(JSON.parse(await readFile(this.file, 'utf8')));
    } catch {
      return defaultMix();
    }
  }

  write(input) {
    const run = this.queue.then(async () => {
      const mix = sanitizeMix(input);
      await mkdir(path.dirname(this.file), { recursive: true });
      const gi = path.join(this.top, '.gitignore');
      if (!existsSync(gi)) await writeFile(gi, '*\n');
      const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify(mix, null, 2) + '\n');
      await rename(tmp, this.file);
      return mix;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
