// Who is waiting for feedback right now. An agent that is listening (the `wait-feedback`
// command, or the MCP tool wait_for_feedback) registers a small heartbeat file, so the player
// can tell the user whether "Send to agent" will wake the agent or needs a paste:
//
//   .rive-preview/[<name>.riv/]listeners/<pid>-<rand>.json   { pid, kind, startedAt, beat }
//
// A listener counts while its process is alive and its heartbeat is fresh. The files of a
// listener killed without cleanup are removed by the next reader.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
