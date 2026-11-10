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
//   feedback/<bundle-id>/claimed.json        { pid, token, at }   created with O_EXCL
//   feedback/<bundle-id>/claimed.json.lock   held briefly while taking over a stale claim
//
// The holder renews `at` while it delivers and removes the claim when done (only if it is still
// its own, by token). A claim whose process died, or that went CLAIM_STALE_MS without renewal
// (a hung process, or a reused pid), is stale and can be taken over. Takeover happens under the
// lock and re-checks the claim there, so two consumers can't both replace it.
const CLAIM_STALE_MS = 60000;
const CLAIM_RENEW_MS = 10000;
const LOCK_STALE_MS = 10000; // a takeover takes milliseconds; an older lock was left by a crash

function claimIsStale(file) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return !Number.isSafeInteger(c.pid) || !alive(c.pid) || !(Date.now() - c.at < CLAIM_STALE_MS);
  } catch (err) {
    if (err.code === 'ENOENT') return false; // gone: the caller may simply create it
    // Unreadable: it may be being written this instant, so go by its age.
    try {
      return Date.now() - statSync(file).mtimeMs >= CLAIM_STALE_MS;
    } catch {
      return false;
    }
  }
}

function withLock(lock, fn) {
  const take = () => writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
  try {
    take();
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
    try {
      if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
      rmSync(lock, { force: true });
      take();
    } catch {
      return false;
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function readToken(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).token;
  } catch {
    return undefined;
  }
}

/**
 * A set of claims held by this process. `take(bundle)` claims one (false if another consumer
 * holds it); `release()` drops every claim still ours. Release in a `finally`: once a bundle is
 * marked read its claim no longer matters, and if delivery failed the next consumer gets it.
 */
export class Claims {
  constructor(store) {
    this.store = store;
    this.held = new Map(); // claim file -> token
    this.timer = null;
  }

  get size() {
    return this.held.size;
  }

  take(bundle) {
    if (!/^[\w-]+$/.test(bundle.id)) return false;
    const file = path.join(this.store.sentDir, bundle.id, 'claimed.json');
    if (this.held.has(file)) return true;
    const token = randomBytes(8).toString('hex');
    const create = () => {
      try {
        writeFileSync(file, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    };
    const ok =
      create() ||
      (claimIsStale(file) &&
        withLock(`${file}.lock`, () => {
          if (existsSync(file) && !claimIsStale(file)) return false; // someone got there first
          rmSync(file, { force: true });
          return create();
        }));
    if (!ok) return false;
    this.held.set(file, token);
    if (!this.timer) {
      this.timer = setInterval(() => this.renew(), CLAIM_RENEW_MS);
      this.timer.unref();
    }
    return true;
  }

  renew() {
    for (const [file, token] of this.held) {
      if (readToken(file) !== token) {
        this.held.delete(file); // lost it (taken over after we stalled): not ours to touch
        continue;
      }
      try {
        const tmp = `${file}.${token}.tmp`;
        writeFileSync(tmp, JSON.stringify({ pid: process.pid, token, at: Date.now() }));
        renameSync(tmp, file);
      } catch {}
    }
  }

  release() {
    clearInterval(this.timer);
    this.timer = null;
    for (const [file, token] of this.held) if (readToken(file) === token) rmSync(file, { force: true });
    this.held.clear();
  }
}

/** Claim every bundle in `bundles` that no other consumer holds: { claimed, claims }. */
export function claimBundles(store, bundles) {
  const claims = new Claims(store);
  const claimed = bundles.filter((b) => claims.take(b));
  return { claimed, claims };
}
