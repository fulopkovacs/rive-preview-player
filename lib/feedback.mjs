// Screenshots + notes taken in the player, and the feedback bundles sent to a
// coding agent. Everything lives on disk under <project>/.rive-preview/ so the
// MCP server (a separate process) and plain file-reading agents can see it:
//
//   .rive-preview/
//     .gitignore                 "*" — never committed
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

const ID_RE = /^[a-z0-9-]+$/;

export function feedbackRoot(target) {
  const base = existsSync(target) && statSync(target).isDirectory() ? target : path.dirname(target);
  return path.join(base, '.rive-preview');
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function bundleStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
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
    'exactly as the preview player drew it at that frame.',
    '',
  ];
  if (b.message) lines.push('## Overall', '', b.message.trim(), '');
  b.shots.forEach((s, i) => {
    lines.push(`## ${i + 1}. ${shotHeading(s)}`, '', `![shot ${i + 1}](${s.file})`, '', `Image: \`${s.image}\``, '', s.note?.trim() || '_(no note)_', '');
  });
  return lines.join('\n');
}

export class FeedbackStore {
  constructor(target, { project } = {}) {
    this.target = target;
    this.project = project ?? path.basename(target);
    this.root = feedbackRoot(target);
    this.draftsDir = path.join(this.root, 'drafts');
    this.sentDir = path.join(this.root, 'feedback');
  }

  async ensure() {
    await mkdir(this.draftsDir, { recursive: true });
    await mkdir(this.sentDir, { recursive: true });
    const gi = path.join(this.root, '.gitignore');
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
      time: meta.time ?? null,
      frame: meta.frame ?? null,
      fps: meta.fps ?? null,
      timecode: meta.timecode ?? '',
      artboard: meta.artboard ?? null,
      animation: meta.animation ?? null,
      width: meta.width ?? null,
      height: meta.height ?? null,
    };
    await writeFile(this.draftPng(id), png);
    await writeJsonAtomic(path.join(this.draftsDir, `${id}.json`), shot);
    return shot;
  }

  async updateDraft(id, { note }) {
    const file = path.join(this.draftsDir, `${id}.json`);
    if (!ID_RE.test(id) || !existsSync(file)) return null;
    const shot = JSON.parse(await readFile(file, 'utf8'));
    if (typeof note === 'string') shot.note = note;
    await writeJsonAtomic(file, shot);
    return shot;
  }

  async deleteDraft(id) {
    if (!ID_RE.test(id)) return false;
    await rm(path.join(this.draftsDir, `${id}.json`), { force: true });
    await rm(path.join(this.draftsDir, `${id}.png`), { force: true });
    return true;
  }

  // ------------------------------------------------------------ bundles
  /** Move every draft into a new feedback bundle. */
  async share({ message = '' } = {}) {
    const drafts = await this.listDrafts();
    if (!drafts.length) throw new Error('no screenshots to send');
    await this.ensure();
    let id = bundleStamp();
    if (existsSync(path.join(this.sentDir, id))) id += '-' + randomBytes(2).toString('hex');
    const dir = path.join(this.sentDir, id);
    await mkdir(dir, { recursive: true });

    const shots = [];
    for (const [i, d] of drafts.entries()) {
      const file = `${pad(i + 1)}${d.frame != null ? `-f${d.frame}` : ''}.png`;
      await copyFile(this.draftPng(d.id), path.join(dir, file));
      const { id: _id, ...rest } = d;
      shots.push({ index: i + 1, ...rest, file, image: path.join(dir, file) });
    }
    const bundle = {
      id,
      createdAt: new Date().toISOString(),
      project: this.project,
      target: this.target,
      message: message.trim(),
      dir,
      markdown: path.join(dir, 'feedback.md'),
      shots,
    };
    await writeFile(bundle.markdown, bundleMarkdown(bundle));
    // feedback.json last: its presence is what marks the bundle complete.
    await writeJsonAtomic(path.join(dir, 'feedback.json'), bundle);
    for (const d of drafts) await this.deleteDraft(d.id);
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
