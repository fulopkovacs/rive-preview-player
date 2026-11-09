// Registry of running players, one state file per target.
// Shared by the CLI (reuse / --stop / --status) and the MCP server (seek, project lookup).
// It lives under the home dir rather than os.tmpdir(): MCP clients start servers with a
// trimmed environment (no TMPDIR on macOS), which would point them at a different temp dir.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'rive-video-preview');
export const stateFile = (target) => path.join(STATE_DIR, createHash('sha1').update(target).digest('hex').slice(0, 16) + '.json');

async function probe(file) {
  try {
    const st = JSON.parse(readFileSync(file, 'utf8'));
    process.kill(st.pid, 0);
    const res = await fetch(`http://127.0.0.1:${st.port}/api/ping`, { signal: AbortSignal.timeout(1000) });
    const info = await res.json();
    if (info.app === 'rive-video-preview' && info.target === st.target) return { ...st, ...info };
  } catch {}
  rmSync(file, { force: true });
  return null;
}

/** The player running for `target`, or null (stale state files are removed). */
export async function findRunning(target) {
  const file = stateFile(target);
  if (!existsSync(file)) return null;
  return probe(file);
}

/** Every live player. */
export async function listRunning() {
  let names = [];
  try {
    names = readdirSync(STATE_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const found = await Promise.all(names.map((n) => probe(path.join(STATE_DIR, n))));
  return found.filter(Boolean);
}
