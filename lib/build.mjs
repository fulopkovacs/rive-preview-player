// Builds a Rive CLI project to an unsigned .riv and extracts the timeline
// metadata (artboards, animations, audio-event timing) the player needs.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function formatProblems(list) {
  return (list || [])
    .map((p) => (typeof p === 'string' ? p : p.message ? `${p.file ?? ''}${p.line ? ':' + p.line : ''} ${p.message}`.trim() : JSON.stringify(p)))
    .join('\n');
}

/** Build the project. Returns { ok, riv: Buffer, error, warnings, buildMs }. */
export async function buildProject(dir) {
  const t0 = Date.now();
  const res = await run('rive', ['.', '--once', '--format=json'], dir);
  const report = parseJson(res.stdout);
  if (!report) {
    return { ok: false, error: (res.stderr || res.stdout || `rive exited with ${res.code}`).trim() };
  }
  if (!report.success || !report.data?.riv) {
    const msg = formatProblems(report.errors) || formatProblems(report.data?.problems) || res.stderr.trim() || 'build failed';
    return { ok: false, error: msg };
  }
  const rivPath = path.resolve(dir, report.data.riv);
  const riv = await readFile(rivPath);
  return {
    ok: true,
    riv,
    rivPath,
    warnings: formatProblems(report.warnings),
    buildMs: Date.now() - t0,
  };
}

/** Run `rive inspect` and reduce it to what the player needs. */
export async function inspectProject(dir) {
  const res = await run('rive', ['inspect', '.', '--json'], dir);
  const tree = parseJson(res.stdout);
  if (!tree) return null;
  return extractMeta(tree);
}

function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (visit(node) === false) return;
  for (const key in node) {
    const v = node[key];
    if (v && typeof v === 'object') walk(v, visit);
  }
}

export function extractMeta(tree) {
  const byId = new Map();
  walk(tree, (n) => {
    if (n.type && n.id != null) byId.set(n.id, n);
  });

  const artboards = (tree.artboards || []).map((ab) => {
    const animations = [];
    const stateMachines = [];
    walk(ab.children, (n) => {
      if (n.type === 'Artboard') return false; // don't descend into other artboards
      if (n.type === 'LinearAnimation') animations.push(n);
      if (n.type === 'StateMachine') stateMachines.push(n);
    });

    // The animation the default state machine plays first is the "main" one.
    let defaultAnimationId = null;
    const sm = stateMachines.find((s) => s.id === ab.defaultStateMachineId) || stateMachines[0];
    if (sm) {
      walk(sm, (n) => {
        if (defaultAnimationId == null && n.type === 'AnimationState' && n.animationId != null) {
          defaultAnimationId = n.animationId;
        }
      });
    }

    const anims = animations.map((a) => {
      const fps = a.fps || 60;
      const audio = [];
      for (const ko of a.children || []) {
        if (ko.type !== 'KeyedObject') continue;
        const target = byId.get(ko.objectId);
        if (!target || target.type !== 'AudioEvent') continue;
        const asset = byId.get(target.assetId);
        walk(ko.children, (n) => {
          if (n.type === 'KeyFrameCallback') {
            audio.push({
              frame: n.frame,
              time: n.frame / fps,
              event: target.name,
              asset: asset?.name ?? null,
              volume: asset?.volume ?? 1,
            });
          }
        });
      }
      audio.sort((x, y) => x.time - y.time);
      const useWork = a.enableWorkArea && a.workStart !== 4294967295 && a.workEnd !== 4294967295;
      return {
        id: a.id,
        name: a.name,
        fps,
        durationFrames: a.duration,
        startFrame: useWork ? a.workStart : 0,
        endFrame: useWork ? a.workEnd : a.duration,
        loop: a.enums?.loopValue ?? a.loopValue,
        audio,
      };
    });

    const def = anims.find((a) => a.id === defaultAnimationId) || anims[0];
    return {
      name: ab.name,
      width: ab.width,
      height: ab.height,
      defaultAnimation: def?.name ?? null,
      animations: anims,
    };
  });

  const defaultArtboard = tree.defaultArtboard?.name ?? artboards[0]?.name ?? null;
  return { defaultArtboard, artboards, problems: tree.problems || [] };
}
