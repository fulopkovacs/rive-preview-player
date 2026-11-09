#!/usr/bin/env node
// rive-video-preview — a scrubbable, audio-capable preview player for Rive CLI projects.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_DIR, findRunning, stateFile } from '../lib/registry.mjs';
import { PreviewServer } from '../lib/server.mjs';

const HELP = `rive-video-preview — scrubbable video-style preview for Rive CLI projects

usage:
  rive-video-preview [project-dir | file.riv] [options]
  rive-video-preview mcp [project-dir]     run the MCP server (stdio) for coding agents

  The project dir defaults to the current directory. It builds the project with
  \`rive . --once\`, opens a player window, and rebuilds on every save. It keeps
  running until stopped (Ctrl-C or --stop). Running it again for the same
  project reuses the running player instead of starting a second one.

options:
  --at <time>          jump the player to a time: 12.5, 12.5s, 1:02.250, f741 (frame)
  --artboard <name>    artboard to show (default: the file's default)
  --animation <name>   animation to play (default: the one the state machine starts)
  --port <n>           port to serve on (default: first free from 4810)
  --no-open            don't open a window; just print the URL
  --browser            open in the default browser instead of a Chrome app window
  --no-watch           don't rebuild on file changes
  --stop               stop the player running for this project
  --status             print whether a player is running for this project
  -h, --help           show this help

player keys:
  space play/pause · ←/→ frame · shift+←/→ 1s · home/end · i/o in/out · x clear range
  c copy timecode · shift+c copy range · g go to time · l loop · m mute · f fullscreen · ? help
  s screenshot this frame · n screenshots & notes panel
  click a sound effect to set its volume · drag or ↑/↓ moves it between tracks (up to 3) · a hides tracks

feedback for agents:
  Screenshots and notes are kept in <project>/.rive-preview/. "Send to agent" writes a
  bundle to .rive-preview/feedback/<time>/ (feedback.md + PNGs) which the MCP server
  serves through get_feedback / wait_for_feedback. Register it with, e.g.:
    claude mcp add rive-preview -- rive-video-preview mcp
`;

function parseArgs(argv) {
  const opts = { open: true, watch: true, browser: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined) fail(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--at':
        opts.at = value();
        break;
      case '--artboard':
        opts.artboard = value();
        break;
      case '--animation':
        opts.animation = value();
        break;
      case '--port':
        opts.port = Number(value());
        break;
      case '--no-open':
        opts.open = false;
        break;
      case '--browser':
        opts.browser = true;
        break;
      case '--no-watch':
        opts.watch = false;
        break;
      case '--stop':
        opts.stop = true;
        break;
      case '--status':
        opts.status = true;
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

function fail(msg) {
  console.error(`rive-video-preview: ${msg}\nrun with --help for usage`);
  process.exit(1);
}

function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  for (const line of String(msg).split('\n')) console.log(`[${ts}] ${line}`);
}

async function freePort(start) {
  const net = await import('node:net');
  for (let p = start; p < start + 100; p++) {
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error('no free port found');
}

// ---------------------------------------------------------------- window
function playerUrl(port, opts) {
  const params = new URLSearchParams();
  if (opts.at) params.set('t', opts.at);
  if (opts.artboard) params.set('artboard', opts.artboard);
  if (opts.animation) params.set('animation', opts.animation);
  const hash = params.toString();
  return `http://127.0.0.1:${port}/${hash ? '#' + hash : ''}`;
}

function windowSize(meta, opts) {
  const abs = meta?.artboards || [];
  const ab = abs.find((a) => a.name === opts.artboard) || abs.find((a) => a.name === meta?.defaultArtboard) || abs[0];
  const aspect = ab && ab.width > 0 && ab.height > 0 ? ab.width / ab.height : 16 / 9;
  const chrome = 168; // timeline + controls
  let stageH = aspect < 1 ? 820 : Math.round(1120 / aspect);
  let w = Math.round(stageH * aspect);
  if (w < 720) w = 720;
  return { w, h: stageH + chrome };
}

function chromePath() {
  const candidates = [
    '/Applications/Google Chrome.app',
    path.join(os.homedir(), 'Applications/Google Chrome.app'),
    '/Applications/Chromium.app',
    '/Applications/Brave Browser.app',
    '/Applications/Microsoft Edge.app',
  ];
  return candidates.find((c) => existsSync(c));
}

function openWindow(url, size, opts) {
  const detached = { stdio: 'ignore', detached: true };
  if (process.platform === 'darwin') {
    const chrome = !opts.browser && chromePath();
    if (chrome) {
      spawn('open', ['-na', chrome, '--args', `--app=${url}`, `--window-size=${size.w},${size.h}`], detached).unref();
    } else {
      spawn('open', [url], detached).unref();
    }
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], detached).unref();
  } else {
    spawn('xdg-open', [url], detached).unref();
  }
}

// ---------------------------------------------------------------- main
async function main() {
  if (process.argv[2] === 'mcp') {
    const { runMcp } = await import('../lib/mcp.mjs');
    return runMcp(process.argv.slice(3));
  }
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!existsSync(opts.target)) fail(`${opts.target} does not exist`);

  let mode;
  if (statSync(opts.target).isDirectory()) {
    if (!existsSync(path.join(opts.target, 'rive.yaml'))) fail(`${opts.target} has no rive.yaml — not a Rive CLI project`);
    mode = 'project';
  } else if (opts.target.endsWith('.riv')) {
    mode = 'riv';
  } else {
    fail('expected a Rive project directory or a .riv file');
  }

  const running = await findRunning(opts.target);

  if (opts.status) {
    console.log(running ? `running at http://127.0.0.1:${running.port}/ (pid ${running.pid}, ${running.clients} window(s) open)` : 'not running');
    return;
  }
  if (opts.stop) {
    if (!running) return console.log('not running');
    process.kill(running.pid, 'SIGTERM');
    console.log(`stopped player (pid ${running.pid})`);
    return;
  }

  if (running) {
    const url = playerUrl(running.port, opts);
    if (running.clients > 0 && opts.at) {
      await fetch(`http://127.0.0.1:${running.port}/api/seek`, { method: 'POST', body: JSON.stringify({ at: opts.at }) });
      console.log(`player already running at http://127.0.0.1:${running.port}/ — jumped to ${opts.at}`);
    } else if (running.clients > 0) {
      console.log(`player already running at http://127.0.0.1:${running.port}/ (${running.clients} window(s) open; it live-reloads on save)`);
    } else {
      if (opts.open) openWindow(url, { w: 900, h: 900 }, opts);
      console.log(`player already running; opened ${url}`);
    }
    return;
  }

  if (mode === 'project' && !spawnSyncCheck()) fail('the `rive` CLI was not found on PATH');

  const server = new PreviewServer({ target: opts.target, mode, watch: opts.watch, log });
  const port = opts.port || (await freePort(4810));
  await server.listen(port);
  mkdirSync(STATE_DIR, { recursive: true });
  const sf = stateFile(opts.target);
  writeFileSync(sf, JSON.stringify({ pid: process.pid, port, target: opts.target }));
  const cleanup = () => {
    try {
      const st = JSON.parse(readFileSync(sf, 'utf8'));
      if (st.pid === process.pid) rmSync(sf, { force: true });
    } catch {}
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

  const url = playerUrl(port, opts);
  log(`rive-video-preview: ${opts.target}`);
  await server.rebuild('initial');
  server.startWatching();
  log(`player: ${url}`);
  if (opts.open) openWindow(url, windowSize(server.meta, opts), opts);
  log(opts.watch ? 'watching for changes (Ctrl-C to stop)' : 'serving (Ctrl-C to stop)');
}

function spawnSyncCheck() {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  return dirs.some((d) => existsSync(path.join(d, process.platform === 'win32' ? 'rive.exe' : 'rive')));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
