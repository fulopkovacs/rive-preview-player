// Screenshots + notes taken in the player, and the feedback bundles sent to a
// coding agent. Everything lives on disk under <project>/.rive-preview/ so the
// MCP server (a separate process) and plain file-reading agents can see it:
//
//   .rive-preview/
//     .gitignore                 "*" — never committed
//     [<name>.riv/]              for a bare .riv: its own subfolder, so .riv files that
//                                share a folder keep separate drafts and bundles
//     drafts/<id>.png|.json      shots not sent yet (notes still editable)
//     feedback/<bundle-id>/      one folder per "Send to agent"
//       feedback.md              human/agent-readable summary with image paths
//       feedback.json            the same, structured
//       01-f741.png …            the screenshots
//       consumed.json            written once an agent has read the bundle
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mixMarkdown, sanitizeMix } from './mix.mjs';

const ID_RE = /^[a-z0-9-]+$/;

const isDirectory = (p) => existsSync(p) && statSync(p).isDirectory();

/** The shared `.rive-preview` folder: in the project dir, or beside a bare .riv. */
export function feedbackTop(target) {
  return path.join(isDirectory(target) ? target : path.dirname(target), '.rive-preview');
}

/** Where this target's drafts and bundles live (the player and the MCP server must agree). */
export function feedbackRoot(target) {
  return isDirectory(target) ? feedbackTop(target) : path.join(feedbackTop(target), path.basename(target));
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

// Shot metadata comes from the browser: keep only values of the expected shape.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const text = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * A highlighted region, in artboard units from the artboard's top-left, plus the artboard size:
 * { x, y, width, height, artboardWidth, artboardHeight }. Anything else (or a box with no area
 * inside the artboard) becomes null. The box is clamped to the artboard.
 */
export function sanitizeRegion(r) {
  if (!r || typeof r !== 'object') return null;
  const [x, y, w, h, aw, ah] = [r.x, r.y, r.width, r.height, r.artboardWidth, r.artboardHeight].map(num);
  if ([x, y, w, h, aw, ah].some((v) => v == null) || aw <= 0 || ah <= 0 || w <= 0 || h <= 0) return null;
  const x0 = Math.min(Math.max(x, 0), aw);
  const y0 = Math.min(Math.max(y, 0), ah);
  const x1 = Math.min(Math.max(x + w, 0), aw);
  const y1 = Math.min(Math.max(y + h, 0), ah);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: round1(x0), y: round1(y0), width: round1(x1 - x0), height: round1(y1 - y0), artboardWidth: round1(aw), artboardHeight: round1(ah) };
}

/** "Region: 120, 80, 200 × 150 in artboard units (artboard 1920 × 1080)" */
export function regionLine(r) {
  if (!r) return null;
  return `Region: ${r.x}, ${r.y}, ${r.width} × ${r.height} in artboard units (x, y, width × height from the artboard's top-left; artboard ${r.artboardWidth} × ${r.artboardHeight})`;
}

/** Resolve `name` inside `dir`, refusing anything that would land outside it. */
function inside(dir, name) {
  const full = path.resolve(dir, name);
  if (path.dirname(full) !== path.resolve(dir)) throw new Error(`unsafe file name: ${name}`);
  return full;
}

function bundleStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

async function writeJsonAtomic(file, data) {
  // Unique per write, so overlapping writes of one file never share (and steal) a temp file.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, file);
}

function shotHeading(s) {
  const where = [s.artboard, s.animation].filter(Boolean).join(' / ');
  return `${s.timecode}${where ? ` — ${where}` : ''}`;
}

export function bundleMarkdown(b) {
  const lines = [
    `# Rive preview feedback — ${b.project}`,
    '',
    `Sent ${new Date(b.createdAt).toLocaleString()} · ${b.shots.length} screenshot${b.shots.length === 1 ? '' : 's'} · project: \`${b.target}\``,
    '',
    'Timecodes are seconds into the animation and the frame at its fps. Each image is the artboard',
    'exactly as the preview player drew it at that frame. A shot with a "Region" line has that box',
    'outlined (and the rest dimmed) on the image: the note is about what is inside it.',
    '',
  ];
  if (b.message) lines.push('## Overall', '', b.message.trim(), '');
  b.shots.forEach((s, i) => {
    lines.push(`## ${i + 1}. ${shotHeading(s)}`, '', `![shot ${i + 1}](${s.file})`, '', `Image: \`${s.image}\``, '');
    if (s.region) lines.push(regionLine(s.region), '');
    lines.push(s.note?.trim() || '_(no note)_', '');
  });
  lines.push(...mixMarkdown(b.mix));
  return lines.join('\n');
}

export class FeedbackStore {
  constructor(target, { project } = {}) {
    this.target = target;
    this.project = project ?? path.basename(target);
    this.top = feedbackTop(target);
    this.root = feedbackRoot(target);
    this.draftsDir = path.join(this.root, 'drafts');
    this.sentDir = path.join(this.root, 'feedback');
    this.queue = Promise.resolve();
  }

  /** Run store mutations one at a time, so a share never interleaves with a note update or delete. */
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async ensure() {
    await mkdir(this.draftsDir, { recursive: true });
    await mkdir(this.sentDir, { recursive: true });
    const gi = path.join(this.top, '.gitignore');
    if (!existsSync(gi)) await writeFile(gi, '*\n');
  }

  // ------------------------------------------------------------ drafts
  draftPng(id) {
    if (!ID_RE.test(id)) throw new Error('bad id');
    return path.join(this.draftsDir, `${id}.png`);
  }

  async listDrafts() {
    let names = [];
    try {
      names = (await readdir(this.draftsDir)).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const shots = [];
    for (const n of names) {
      try {
        shots.push(JSON.parse(await readFile(path.join(this.draftsDir, n), 'utf8')));
      } catch {}
    }
    return shots.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addDraft({ png, ...meta }) {
    await this.ensure();
    const id = Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
    const shot = {
      id,
      createdAt: new Date().toISOString(),
      note: '',
      time: num(meta.time),
      frame: count(meta.frame),
      fps: num(meta.fps),
      timecode: text(meta.timecode, 80) ?? '',
      artboard: text(meta.artboard),
      animation: text(meta.animation),
      width: count(meta.width),
      height: count(meta.height),
      region: sanitizeRegion(meta.region),
    };
    await writeFile(this.draftPng(id), png);
    await writeJsonAtomic(path.join(this.draftsDir, `${id}.json`), shot);
    return shot;
  }

  updateDraft(id, { note }) {
    return this.serial(() => this._updateDraft(id, { note }));
  }

  async _updateDraft(id, { note }) {
    const file = path.join(this.draftsDir, `${id}.json`);
    if (!ID_RE.test(id) || !existsSync(file)) return null;
    const shot = JSON.parse(await readFile(file, 'utf8'));
    if (typeof note === 'string') shot.note = note.slice(0, 20000);
    await writeJsonAtomic(file, shot);
    return shot;
  }

  deleteDraft(id) {
    return this.serial(() => this._deleteDraft(id));
  }

  async _deleteDraft(id) {
    if (!ID_RE.test(id)) return false;
    await rm(path.join(this.draftsDir, `${id}.json`), { force: true });
    await rm(path.join(this.draftsDir, `${id}.png`), { force: true });
    return true;
  }

  // ------------------------------------------------------------ bundles
  /** Move every draft into a new feedback bundle. */
  share({ message = '' } = {}) {
    return this.serial(() => this._share({ message: String(message ?? '').slice(0, 20000) }));
  }

  async _share({ message }) {
    const drafts = await this.listDrafts();
    if (!drafts.length) throw new Error('no screenshots to send');
    await this.ensure();
    let id = bundleStamp();
    if (existsSync(path.join(this.sentDir, id))) id += '-' + randomBytes(2).toString('hex');
    const dir = path.join(this.sentDir, id);
    await mkdir(dir, { recursive: true });

    const shots = [];
    for (const [i, d] of drafts.entries()) {
      const frame = count(d.frame);
      const file = `${pad(i + 1)}${frame != null ? `-f${frame}` : ''}.png`;
      await copyFile(this.draftPng(d.id), inside(dir, file));
      const { id: _id, ...rest } = d;
      shots.push({ index: i + 1, ...rest, frame, region: sanitizeRegion(d.region), file, image: path.join(dir, file) });
    }
    let mix = null;
    try {
      mix = sanitizeMix(JSON.parse(await readFile(path.join(this.root, 'mix.json'), 'utf8')));
    } catch {}
    const bundle = {
      id,
      createdAt: new Date().toISOString(),
      project: this.project,
      target: this.target,
      message: message.trim(),
      dir,
      markdown: path.join(dir, 'feedback.md'),
      shots,
      mix,
    };
    await writeFile(bundle.markdown, bundleMarkdown(bundle));
    // feedback.json last: its presence is what marks the bundle complete.
    await writeJsonAtomic(path.join(dir, 'feedback.json'), bundle);
    for (const d of drafts) await this._deleteDraft(d.id);
    return bundle;
  }

  async listBundles({ pendingOnly = false } = {}) {
    let names = [];
    try {
      names = await readdir(this.sentDir);
    } catch {
      return [];
    }
    const out = [];
    for (const n of names.sort()) {
      const dir = path.join(this.sentDir, n);
      try {
        const b = JSON.parse(await readFile(path.join(dir, 'feedback.json'), 'utf8'));
        let consumed = null;
        try {
          consumed = JSON.parse(await readFile(path.join(dir, 'consumed.json'), 'utf8'));
        } catch {}
        if (pendingOnly && consumed) continue;
        out.push({ ...b, consumed });
      } catch {}
    }
    return out;
  }

  async markConsumed(id, by = 'agent') {
    if (!/^[\w-]+$/.test(id)) return;
    const dir = path.join(this.sentDir, id);
    if (existsSync(dir)) await writeJsonAtomic(path.join(dir, 'consumed.json'), { at: new Date().toISOString(), by });
  }
}
