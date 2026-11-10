// `rive-video-preview wait-feedback [project-dir | file.riv]`
//
// Blocks until the user presses "Send to agent" (or returns at once if unread feedback is
// already waiting), prints the feedback, marks it read and exits 0. Coding agents run it as a
// background command: when it exits, its output wakes the agent with the feedback, and the
// agent's session stays free while it waits. It reads bundles from disk, so the player does
// not have to be running.
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FeedbackStore, bundleMarkdown } from './feedback.mjs';
import { claimBundles, registerListener } from './listeners.mjs';

export const EXIT_TIMEOUT = 124; // like timeout(1)
const EXIT_INTERRUPTED = 130;
const POLL_MS = 2000; // fallback when file events are missed or unsupported
const SETTLE_MS = 300; // let bundles sent together all land before printing

const HELP = `usage: rive-video-preview wait-feedback [project-dir | file.riv] [options]

Wait until the user presses "Send to agent" in the player, print the feedback
(notes, timecodes, artboard/animation, image paths, audio mix), mark it read
and exit 0. Returns at once if unread feedback is already waiting. The player
does not need to be running.

Coding agents: start it as a background command after showing the player
(Claude Code: Bash with run_in_background). It exits when the user sends
feedback, which wakes you with it. Start it again after handling the feedback.

options:
  --timeout <time>   give up after this long: 90, 90s, 10m, 2h (default: never)
  --no-mark-read     leave the bundles unread
  -h, --help         show this help

exit codes:
  0    feedback printed
  1    error (bad arguments, not a Rive project, …)
  ${EXIT_TIMEOUT}  timed out with no feedback
  130  interrupted (Ctrl-C)
`;

function fail(msg) {
  console.error(`rive-video-preview wait-feedback: ${msg}\nrun with --help for usage`);
  process.exit(1);
}

function parseDuration(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) return null;
  const mult = { ms: 0.001, s: 1, m: 60, h: 3600 }[(m[2] || 's').toLowerCase()];
  const sec = Number(m[1]) * mult;
  return sec > 0 ? sec : null;
}

function parseArgs(argv) {
  const opts = { markRead: true, timeout: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    switch (flag) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--timeout': {
        const v = inline ?? argv[++i];
        if (v === undefined) fail('--timeout needs a value');
        opts.timeout = parseDuration(v);
        if (opts.timeout == null) fail(`bad --timeout ${v} (use e.g. 90, 90s, 10m, 2h)`);
        break;
      }
      case '--no-mark-read':
        opts.markRead = false;
        break;
      default:
        if (a.startsWith('-')) fail(`unknown option ${a}`);
        positional.push(a);
    }
  }
  if (positional.length > 1) fail('expected at most one project dir or .riv file');
  opts.target = path.resolve(positional[0] ?? '.');
  return opts;
}

function projectName(dir) {
  try {
    const m = readFileSync(path.join(dir, 'rive.yaml'), 'utf8').match(/^name:\s*["']?([^"'\n#]+?)["']?\s*$/m);
    if (m) return m[1];
  } catch {}
  return path.basename(dir);
}

/**
 * Resolve with the unread bundles once there are any. Watches the feedback folder and also
 * polls, since file events can be missed (or unsupported, e.g. on some network drives).
 * A bundle counts once its feedback.json exists: the store writes that file last, atomically.
 * With `claim`, bundles are claimed exclusively (see claimBundles), so concurrent waiters never
 * deliver the same one. Resolves with { bundles, claims } (release the claims when done), or
 * null on timeout/abort.
 */
export function waitForBundles(store, { timeoutMs = null, signal, claim = true } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let poll = null;
    let deadline = null;
    let watcher = null;
    let checking = false;
    let again = false;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      clearTimeout(deadline);
      watcher?.close();
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(resolve, null);

    const check = async () => {
      if (checking) return void (again = true);
      checking = true;
      try {
        let pending = await store.listBundles({ pendingOnly: true });
        if (pending.length) {
          // Another bundle may be landing right now (two quick sends): give it a moment.
          await new Promise((r) => setTimeout(r, SETTLE_MS));
          pending = await store.listBundles({ pendingOnly: true });
          if (!claim) {
            if (pending.length) return finish(resolve, { bundles: pending, claims: null });
          } else {
            // Another consumer may be delivering some of these; take only the rest.
            const { claimed, claims } = claimBundles(store, pending);
            if (claimed.length) {
              if (settled) claims.release(); // timed out or aborted meanwhile
              else return finish(resolve, { bundles: claimed, claims });
            }
          }
        }
      } catch (err) {
        return finish(reject, err);
      } finally {
        checking = false;
      }
      if (again && !settled) {
        again = false;
        check();
      }
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(check, 50);
    };

    if (signal?.aborted) return finish(resolve, null);
    signal?.addEventListener('abort', onAbort);
    for (const recursive of [true, false]) {
      try {
        // Recursive, to see feedback.json land inside a new bundle folder.
        watcher = watch(store.sentDir, { recursive }, soon);
        watcher.on('error', () => {});
        break;
      } catch {}
    }
    poll = setInterval(check, POLL_MS);
    if (timeoutMs != null) deadline = setTimeout(() => finish(resolve, null), timeoutMs);
    check();
  });
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function formatBundles(bundles, { target, project, marked }) {
  const out = [
    `Rive preview feedback for ${project}: ${plural(bundles.length, 'bundle')} from the user${marked ? ' (now marked read)' : ''}.`,
    `Project: ${target}`,
    '',
  ];
  for (const b of bundles) {
    let md;
    try {
      md = await readFile(b.markdown, 'utf8');
    } catch {
      md = bundleMarkdown(b);
    }
    out.push(`======== Bundle ${b.id} ========`, `Folder: ${b.dir}`, `feedback.md: ${b.markdown}`, '', md.trimEnd(), '');
    out.push('Screenshots (open each image to see the frame):');
    for (const s of b.shots) {
      const where = [s.artboard, s.animation].filter(Boolean).join(' / ');
      const r = s.region;
      const box = r ? ` [region ${r.x}, ${r.y}, ${r.width} × ${r.height} in artboard units]` : '';
      out.push(`  ${s.index}. ${s.timecode}${where ? ` — ${where}` : ''}${box}: ${s.image}`);
    }
    out.push('');
  }
  out.push(
    'Each timecode is seconds into the animation and the frame at its fps; fix that animation at that frame unless the note says otherwise.',
    `When you have handled this, start \`rive-video-preview wait-feedback ${target}\` in the background again to hear the next round.`,
  );
  return out.join('\n') + '\n';
}

export async function runWaitFeedback(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return void process.stdout.write(HELP);
  const { target } = opts;
  if (!existsSync(target)) fail(`${target} does not exist`);
  let project;
  if (statSync(target).isDirectory()) {
    if (!existsSync(path.join(target, 'rive.yaml'))) fail(`${target} has no rive.yaml — not a Rive CLI project`);
    project = projectName(target);
  } else if (target.endsWith('.riv')) {
    project = path.basename(target, '.riv');
  } else {
    fail('expected a Rive project directory or a .riv file');
  }

  const store = new FeedbackStore(target, { project });
  await store.ensure();
  const unregister = registerListener(target, 'cli');
  const abort = new AbortController();
  let interrupted = false;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      interrupted = true;
      abort.abort();
    });
  }

  const limit = opts.timeout != null ? ` (timeout ${opts.timeout}s)` : '';
  console.error(`Waiting for the user to press "Send to agent" for ${project} (${store.sentDir})${limit}…`);
  let got;
  try {
    // --no-mark-read only peeks, so it doesn't claim the bundles away from another consumer.
    got = await waitForBundles(store, { timeoutMs: opts.timeout != null ? opts.timeout * 1000 : null, signal: abort.signal, claim: opts.markRead });
  } finally {
    unregister();
  }

  if (!got) {
    if (interrupted) {
      console.error('Stopped waiting for feedback (interrupted).');
      process.exitCode = EXIT_INTERRUPTED;
    } else {
      console.log(`No feedback arrived for ${project} within ${opts.timeout}s. Nothing was sent from the player; start the command again to keep listening.`);
      process.exitCode = EXIT_TIMEOUT;
    }
    return;
  }

  const { bundles, claims } = got;
  try {
    const text = await formatBundles(bundles, { target, project, marked: opts.markRead });
    await new Promise((resolve, reject) => process.stdout.write(text, (err) => (err ? reject(err) : resolve())));
    if (opts.markRead) {
      try {
        for (const b of bundles) await store.markConsumed(b.id, 'agent');
      } catch (err) {
        // The feedback was printed; it just may be delivered again.
        console.error(`Warning: could not mark the feedback read (${err.message}); it may be delivered again.`);
      }
    }
  } finally {
    claims?.release(); // read ones no longer need it; on failure the next consumer gets them
  }
  process.exitCode = 0;
}
