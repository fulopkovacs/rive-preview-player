// MCP server (stdio) that hands the player's screenshot + note bundles to a coding agent.
//
//   rive-video-preview mcp [project-dir]
//
// It reads bundles straight from <project>/.rive-preview/feedback, so it works whether or
// not the player is running; only seek_player needs a running player.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { FeedbackStore } from './feedback.mjs';
import { MixStore, mixMarkdown } from './mix.mjs';
import { registerListener } from './listeners.mjs';
import { findRunning, listRunning } from './registry.mjs';

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isProject = (dir) => existsSync(path.join(dir, 'rive.yaml'));
const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function projectName(dir) {
  try {
    const m = readFileSync(path.join(dir, 'rive.yaml'), 'utf8').match(/^name:\s*["']?([^"'\n#]+?)["']?\s*$/m);
    if (m) return m[1];
  } catch {}
  return path.basename(dir);
}

/**
 * Which project to read: the tool argument, then the dir given on the command line,
 * then a rive.yaml at or above the cwd, then one just below it, then a running player
 * (preferring one under the cwd).
 */
async function resolveTarget(arg, fallback) {
  const cwd = process.cwd();
  if (arg) return path.resolve(cwd, arg);
  if (fallback) return path.resolve(cwd, fallback);
  for (let d = cwd; ; d = path.dirname(d)) {
    if (isProject(d)) return d;
    if (path.dirname(d) === d) break;
  }
  const children = readdirSync(cwd, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => path.join(cwd, e.name))
    .filter(isProject);
  if (children.length === 1) return children[0];
  const running = await listRunning();
  const near = running.filter((r) => isInside(r.target, cwd));
  if (near.length === 1) return near[0].target;
  if (running.length === 1) return running[0].target;
  const known = [...children, ...running.map((r) => r.target)];
  throw new Error(
    `can't tell which Rive project to use from ${cwd}. Pass "project".` + (known.length ? ` Candidates: ${[...new Set(known)].join(', ')}` : ''),
  );
}

function storeFor(target) {
  const name = isDir(target) ? projectName(target) : path.basename(target, '.riv');
  return new FeedbackStore(target, { project: name });
}

/** MCP content for a list of bundles: a text summary per shot followed by its image. */
async function bundleContent(bundles, { images }) {
  const content = [];
  for (const b of bundles) {
    const head = [
      `# Feedback ${b.id} — ${b.project} (${b.shots.length} screenshot${b.shots.length === 1 ? '' : 's'}, sent ${new Date(b.createdAt).toLocaleString()})`,
      `Folder: ${b.dir}`,
      `Markdown: ${b.markdown}`,
    ];
    if (b.message) head.push('', `Overall note: ${b.message}`);
    content.push({ type: 'text', text: head.join('\n') });
    for (const s of b.shots) {
      const where = [s.artboard, s.animation].filter(Boolean).join(' / ');
      content.push({
        type: 'text',
        text: `## ${s.index}. ${s.timecode}${where ? ` — ${where}` : ''}\nImage: ${s.image}\nNote: ${s.note?.trim() || '(no note)'}`,
      });
      if (images) {
        try {
          content.push({ type: 'image', data: (await readFile(s.image)).toString('base64'), mimeType: 'image/png' });
        } catch {
          content.push({ type: 'text', text: `(image missing: ${s.image})` });
        }
      }
    }
  }
  return content;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: String(err?.message || err) }] });

export async function runMcp(argv) {
  const fallback = argv.find((a) => !a.startsWith('-'));
  const server = new McpServer(
    { name: 'rive-video-preview', version: '0.1.0' },
    {
      instructions:
        'The user reviews a Rive animation in the rive-video-preview player, takes screenshots of frames, writes a note on each, ' +
        'and presses "Send to agent". Call get_feedback to read what they sent (notes, timecodes, artboard/animation and the images). ' +
        'Call wait_for_feedback when you have asked the user to review something and want to block until they send it. ' +
        'Timecodes look like "00:12.350 (frame 741)". seek_player moves the open player to a time. ' +
        'The user can also mix the sound effects in the player (up to 3 tracks, a gain per sound effect); get_audio_mix returns those levels.',
    },
  );

  const projectArg = z.string().optional().describe('Rive project dir (or .riv file). Defaults to the project at or around the working directory.');

  server.registerTool(
    'get_feedback',
    {
      title: 'Get preview feedback',
      description:
        'Return the screenshot + note bundles the user sent from the Rive preview player that have not been read yet, with each image. ' +
        'Marks them as read unless mark_read is false.',
      inputSchema: {
        project: projectArg,
        include_read: z.boolean().optional().describe('Also return bundles already read (most recent last). Default false.'),
        limit: z.number().int().positive().optional().describe('Return at most this many of the most recent bundles. Default 5.'),
        mark_read: z.boolean().optional().describe('Default true.'),
        images: z.boolean().optional().describe('Include the PNGs as image content. Default true; false returns only file paths.'),
      },
    },
    async ({ project, include_read = false, limit = 5, mark_read = true, images = true }) => {
      try {
        const store = storeFor(await resolveTarget(project, fallback));
        const bundles = (await store.listBundles({ pendingOnly: !include_read })).slice(-limit);
        if (!bundles.length) {
          return text(
            `No ${include_read ? '' : 'unread '}feedback for ${store.project} (${store.sentDir}). ` +
              'The user sends it from the player with "Send to agent"; use wait_for_feedback to wait for it.',
          );
        }
        const content = await bundleContent(bundles, { images });
        if (mark_read) for (const b of bundles) if (!b.consumed) await store.markConsumed(b.id);
        return { content };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'wait_for_feedback',
    {
      title: 'Wait for preview feedback',
      description:
        'Block until the user presses "Send to agent" in the Rive preview player (or the timeout passes), then return the new ' +
        'feedback like get_feedback. Returns immediately if unread feedback is already waiting.',
      inputSchema: {
        project: projectArg,
        timeout_seconds: z.number().positive().max(3600).optional().describe('Default 600.'),
      },
    },
    async ({ project, timeout_seconds = 600 }, extra) => {
      let unregister = () => {};
      try {
        const target = await resolveTarget(project, fallback);
        const store = storeFor(target);
        // Lets the player tell the user that the agent is listening.
        unregister = registerListener(target, 'mcp');
        const token = extra?._meta?.progressToken;
        const started = Date.now();
        let lastPing = started;
        while (true) {
          const pending = await store.listBundles({ pendingOnly: true });
          if (pending.length) {
            const content = await bundleContent(pending, { images: true });
            for (const b of pending) await store.markConsumed(b.id);
            return { content };
          }
          const waited = (Date.now() - started) / 1000;
          if (waited >= timeout_seconds) return text(`No feedback arrived within ${timeout_seconds}s.`);
          if (extra?.signal?.aborted) return text('Cancelled.');
          // Progress pings keep clients that reset their timeout on progress from giving up.
          if (token !== undefined && Date.now() - lastPing > 10000) {
            lastPing = Date.now();
            await extra
              .sendNotification({
                method: 'notifications/progress',
                params: { progressToken: token, progress: Math.floor(waited), total: timeout_seconds, message: 'waiting for the user to send feedback' },
              })
              .catch(() => {});
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (err) {
        return fail(err);
      } finally {
        unregister();
      }
    },
  );

  server.registerTool(
    'get_audio_mix',
    {
      title: 'Get the audio mix',
      description:
        'Return the audio mix the user set in the Rive preview player: up to 3 tracks (volume, mute, solo) and, per sound effect ' +
        '(an AudioEvent keyframe), its track and gain. The player does not change the project; use this to carry the levels over ' +
        '(for example into AudioAsset volume).',
      inputSchema: { project: projectArg },
    },
    async ({ project }) => {
      try {
        const target = await resolveTarget(project, fallback);
        const store = new MixStore(target);
        const mix = await store.read();
        const md = mixMarkdown(mix);
        return {
          content: [
            { type: 'text', text: md.length ? md.join('\n') : `The audio mix for ${target} is at its defaults (one track at 100%, no sound effect adjusted).` },
            { type: 'text', text: `Raw (${store.file}):\n${JSON.stringify(mix, null, 2)}` },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'seek_player',
    {
      title: 'Move the preview playhead',
      description: 'Pause the running Rive preview player and move its playhead, e.g. to show the user the frame you changed.',
      inputSchema: {
        project: projectArg,
        time: z.string().describe('12.5, 12.5s, 1:02.250, 500ms, or a frame like f741'),
      },
    },
    async ({ project, time }) => {
      try {
        const target = await resolveTarget(project, fallback);
        const running = await findRunning(target);
        if (!running) return fail(`no player is running for ${target}. Start it with: rive-video-preview ${target}`);
        const res = await fetch(`http://127.0.0.1:${running.port}/api/seek`, { method: 'POST', body: JSON.stringify({ at: time }) });
        const { clients } = await res.json();
        return text(clients ? `Moved ${clients} player window(s) to ${time}.` : 'The player is running but no window is open.');
      } catch (err) {
        return fail(err);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
