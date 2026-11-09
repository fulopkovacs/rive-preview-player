// HTTP server: serves the player, the latest .riv build and its metadata,
// and pushes rebuild / seek notifications over Server-Sent Events.
import http from 'node:http';
import { createReadStream, watch, existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProject, inspectProject } from './build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAYER_DIR = path.join(HERE, '..', 'player');

function riveRuntimeDir() {
  const require = createRequire(import.meta.url);
  try {
    return path.dirname(require.resolve('@rive-app/webgl2-advanced'));
  } catch {
    return path.join(HERE, '..', 'node_modules', '@rive-app', 'webgl2-advanced');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const IGNORED_DIRS = new Set(['build', 'node_modules', '.git']);
const IGNORED_EXT = new Set(['.log', '.riv', '.rev', '.png.tmp', '.swp']);

function isIgnored(rel) {
  if (!rel) return true;
  const parts = rel.split(path.sep);
  if (parts.some((p) => IGNORED_DIRS.has(p) || (p.startsWith('.') && p.length > 1))) return true;
  const base = parts[parts.length - 1];
  if (base.endsWith('~') || base.startsWith('#')) return true;
  return IGNORED_EXT.has(path.extname(base).toLowerCase());
}

function projectName(dir) {
  try {
    const m = readFileSync(path.join(dir, 'rive.yaml'), 'utf8').match(/^name:\s*["']?([^"'\n#]+?)["']?\s*$/m);
    if (m) return m[1];
  } catch {}
  return path.basename(dir);
}

export class PreviewServer {
  constructor({ target, mode, watch = true, log = console.log }) {
    this.target = target; // project dir, or a .riv file
    this.mode = mode; // 'project' | 'riv'
    this.watchEnabled = watch;
    this.log = log;
    this.clients = new Set();
    this.version = 0;
    this.riv = null;
    this.meta = null;
    this.lastError = null;
    this.building = false;
    this.pending = false;
    this.runtimeDir = riveRuntimeDir();
    this.name = mode === 'project' ? projectName(target) : path.basename(target, '.riv');
  }

  async rebuild(reason) {
    if (this.building) {
      this.pending = true;
      return;
    }
    this.building = true;
    this.broadcast({ type: 'building', reason });
    try {
      if (this.mode === 'riv') {
        this.riv = await readFile(this.target);
        this.lastError = null;
        this.version++;
        this.log(`loaded ${path.basename(this.target)} (${(this.riv.length / 1024).toFixed(0)} KB)`);
      } else {
        const res = await buildProject(this.target);
        if (!res.ok) {
          this.lastError = res.error;
          this.log(`build failed:\n${res.error}`);
        } else {
          const meta = await inspectProject(this.target);
          this.riv = res.riv;
          this.meta = meta;
          this.lastError = null;
          this.version++;
          this.log(`built ${path.basename(res.rivPath)} in ${res.buildMs}ms${reason ? ` (${reason})` : ''}`);
          if (res.warnings) this.log(`warnings:\n${res.warnings}`);
        }
      }
    } catch (err) {
      this.lastError = String(err?.stack || err);
      this.log(`build failed: ${this.lastError}`);
    } finally {
      this.building = false;
    }
    this.broadcast(this.statusMessage());
    if (this.pending) {
      this.pending = false;
      await this.rebuild('changed during build');
    }
  }

  statusMessage() {
    return { type: 'build', version: this.version, error: this.lastError, name: this.name };
  }

  broadcast(msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of this.clients) res.write(data);
  }

  startWatching() {
    if (!this.watchEnabled) return;
    let timer = null;
    let changed = new Set();
    const trigger = (rel) => {
      changed.add(rel);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...changed];
        changed = new Set();
        this.rebuild(files.slice(0, 3).join(', ') + (files.length > 3 ? ` +${files.length - 3}` : ''));
      }, 150);
    };
    if (this.mode === 'riv') {
      watch(path.dirname(this.target), (_ev, file) => {
        if (file && path.basename(file) === path.basename(this.target)) trigger(file);
      });
    } else {
      watch(this.target, { recursive: true }, (_ev, file) => {
        if (file && !isIgnored(file)) trigger(file);
      });
    }
  }

  async serveFile(res, file) {
    try {
      const st = await stat(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end('not found');
    }
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/' || p === '/index.html') return this.serveFile(res, path.join(PLAYER_DIR, 'index.html'));
    if (p === '/app.js' || p === '/style.css') return this.serveFile(res, path.join(PLAYER_DIR, p.slice(1)));
    if (p.startsWith('/vendor/rive/')) {
      const name = path.basename(p);
      if (!/^[\w.-]+\.(mjs|wasm)$/.test(name)) return res.writeHead(404).end();
      return this.serveFile(res, path.join(this.runtimeDir, name));
    }
    if (p === '/project.riv') {
      if (!this.riv) return res.writeHead(404).end('no build yet');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(this.riv);
    }
    if (p === '/meta.json') {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ name: this.name, mode: this.mode, version: this.version, error: this.lastError, meta: this.meta }));
    }
    if (p === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(this.statusMessage())}\n\n`);
      this.clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        this.clients.delete(res);
      });
      return;
    }
    if (p === '/api/ping') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ app: 'rive-video-preview', target: this.target, clients: this.clients.size, version: this.version, pid: process.pid }));
    }
    if (p === '/api/seek' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let msg = {};
        try {
          msg = JSON.parse(body || '{}');
        } catch {}
        this.broadcast({ type: 'seek', at: msg.at });
        res.writeHead(200, { 'Content-Type': MIME['.json'] }).end(JSON.stringify({ clients: this.clients.size }));
      });
      return;
    }
    if (p === '/api/log' && req.method === 'POST') {
      // The player reports copied timecodes so they also show up in the terminal.
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        try {
          const msg = JSON.parse(body);
          if (msg.copied) this.log(`copied: ${msg.copied}`);
        } catch {}
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(404).end('not found');
  }

  listen(port) {
    if (!existsSync(path.join(this.runtimeDir, 'webgl2_advanced.mjs'))) {
      throw new Error(`Rive runtime not found in ${this.runtimeDir}; run npm install in the rive-video-preview package`);
    }
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          res.writeHead(500).end(String(err));
        });
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server));
    });
  }
}
