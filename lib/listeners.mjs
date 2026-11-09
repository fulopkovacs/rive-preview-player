// Who is waiting for feedback right now. An agent that is listening (the `wait-feedback`
// command, or the MCP tool wait_for_feedback) registers a small heartbeat file, so the player
// can tell the user whether "Send to agent" will wake the agent or needs a paste:
//
//   .rive-preview/[<name>.riv/]listeners/<pid>-<rand>.json   { pid, kind, startedAt, beat }
//
// A listener counts while its process is alive and its heartbeat is fresh. The files of a
// listener killed without cleanup are removed by the next reader.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { feedbackRoot, feedbackTop } from './feedback.mjs';

const BEAT_MS = 5000;
const STALE_MS = 20000;

const listenersDir = (target) => path.join(feedbackRoot(target), 'listeners');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

/**
 * Register this process as listening for `target`'s feedback until the returned function is
 * called (also on exit). `kind` is 'cli' or 'mcp'.
 */
export function registerListener(target, kind) {
  const dir = listenersDir(target);
  const file = path.join(dir, `${process.pid}-${randomBytes(3).toString('hex')}.json`);
  const startedAt = new Date().toISOString();
  const write = () => {
    try {
      mkdirSync(dir, { recursive: true });
      const gi = path.join(feedbackTop(target), '.gitignore');
      if (!existsSync(gi)) writeFileSync(gi, '*\n');
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ pid: process.pid, kind, startedAt, beat: Date.now() }));
      renameSync(tmp, file);
    } catch {}
  };
  write();
  const timer = setInterval(write, BEAT_MS);
  timer.unref();
  let done = false;
  const unregister = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    process.off('exit', unregister);
    rmSync(file, { force: true });
  };
  process.on('exit', unregister);
  return unregister;
}

/** The live listeners for `target`: [{ pid, kind, startedAt }]. */
export function listListeners(target) {
  const dir = listenersDir(target);
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      const l = JSON.parse(readFileSync(file, 'utf8'));
      if (Number.isSafeInteger(l.pid) && alive(l.pid) && Date.now() - l.beat < STALE_MS) {
        out.push({ pid: l.pid, kind: l.kind, startedAt: l.startedAt });
        continue;
      }
    } catch {}
    rmSync(file, { force: true });
  }
  return out;
}

// ------------------------------------------------------------ claims
// Two consumers (two `wait-feedback`s, or one plus the MCP server) can see the same unread
// bundle at once. Each takes an exclusive claim on a bundle before delivering it, so only one
// of them hands it to the agent:
//
//   feedback/<bundle-id>/claimed.json   { pid, at }   created with O_EXCL
//
// A claim is released when delivery fails. One whose process died, or that is older than
// CLAIM_STALE_MS without the bundle being marked read, can be taken over.
const CLAIM_STALE_MS = 60000;

function tryClaim(dir) {
  const file = path.join(dir, 'claimed.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
    }
    let stale;
    try {
      const c = JSON.parse(readFileSync(file, 'utf8'));
      stale = !Number.isSafeInteger(c.pid) || !alive(c.pid) || Date.now() - c.at >= CLAIM_STALE_MS;
    } catch (err) {
      if (err.code === 'ENOENT') continue; // released meanwhile: try again
      // Unreadable: it may be being written this instant, so go by its age.
      try {
        stale = Date.now() - statSync(file).mtimeMs >= CLAIM_STALE_MS;
      } catch {
        continue;
      }
    }
    if (!stale) return false;
    // Take the stale claim over by renaming it away: only one consumer's rename succeeds, so
    // two of them can't both clear it and then both claim.
    try {
      const gone = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.stale`;
      renameSync(file, gone);
      rmSync(gone, { force: true });
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Claim the unread bundles no other consumer is delivering. Returns the claimed ones and a
 * `release` to call if delivering them fails (once marked read, the claim no longer matters).
 */
export function claimBundles(store, bundles) {
  const dirOf = (b) => path.join(store.sentDir, b.id);
  const claimed = bundles.filter((b) => /^[\w-]+$/.test(b.id) && tryClaim(dirOf(b)));
  const release = () => {
    for (const b of claimed) rmSync(path.join(dirOf(b), 'claimed.json'), { force: true });
  };
  return { claimed, release };
}
