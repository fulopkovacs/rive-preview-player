// Reads the timeline metadata the player needs straight out of a built .riv: artboards,
// animations (fps, duration, work area) and every AudioEvent keyframe with its asset and
// volume. A bare .riv has no project for `rive inspect`, so without this it gets no
// audio timing.
//
// .riv layout: "RIVE", varuint major/minor/fileId, a table of contents (property keys
// the file uses that a runtime might not know, with their field types), then a flat list
// of objects: varuint typeKey, then (varuint propertyKey, value)* terminated by key 0.
// Field types of core keys come from lib/riv-schema.json (scripts/gen-riv-schema.mjs).
import { readFileSync } from 'node:fs';

const SCHEMA = JSON.parse(readFileSync(new URL('./riv-schema.json', import.meta.url), 'utf8'));
const COMPONENTS = new Set(SCHEMA.components);
const T = SCHEMA.typeKeys;

// field kinds: 0 varuint, 1 length-prefixed bytes, 2 float32, 3 uint32 (color)
const KIND_OF = {
  Bytes: 1, String: 1, FractionalIndex: 1, 'List<Id>': 1,
  double: 2,
  Color: 3,
};
const coreKind = (k) => {
  const t = SCHEMA.keys[k];
  if (t === undefined) return undefined;
  return KIND_OF[t] ?? 0;
};

// property keys used below
const K = {
  name: 4, // Component.name
  objectId: 51, // KeyedObject
  propertyKey: 53, // KeyedProperty
  animName: 55, fps: 56, duration: 57, loop: 59, workStart: 60, workEnd: 61, enableWorkArea: 62,
  frame: 67, // KeyFrame
  assetName: 203, assetVolume: 530,
  audioAssetId: 408, // AudioEvent.assetId: index into the file's assets
  defaultStateMachineId: 236,
};
const NONE = 4294967295;

function parseObjects(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIVE') throw new Error('not a .riv file');
  let p = 4;
  const vu = () => {
    let r = 0;
    let s = 0;
    let x;
    do {
      if (p >= buf.length) throw new Error('unexpected end of file');
      x = buf[p++];
      r += (x & 0x7f) * 2 ** s;
      s += 7;
    } while (x & 0x80);
    return r;
  };
  const major = vu();
  vu(); // minor
  vu(); // fileId
  if (major !== 7) throw new Error(`unsupported .riv version ${major}`);
  const tocKeys = [];
  for (let k; (k = vu()); ) tocKeys.push(k);
  // Field types, 2 bits each, packed 4 to a uint32 (as the runtime reads them).
  const toc = new Map();
  let word = 0;
  let bit = 8;
  for (const k of tocKeys) {
    if (bit === 8) {
      word = buf.readUInt32LE(p);
      p += 4;
      bit = 0;
    }
    toc.set(k, (word >>> bit) & 3);
    bit += 2;
  }
  const objects = [];
  while (p < buf.length) {
    const type = vu();
    const props = {};
    for (let k; (k = vu()); ) {
      const kind = toc.get(k) ?? coreKind(k);
      if (kind === undefined) throw new Error(`unknown property ${k} on type ${type}`);
      if (kind === 0) props[k] = vu();
      else if (kind === 1) {
        const n = vu();
        if (k === K.name || k === K.animName || k === K.assetName) props[k] = buf.toString('utf8', p, p + n);
        p += n;
      } else if (kind === 2) {
        props[k] = buf.readFloatLE(p);
        p += 4;
      } else {
        props[k] = buf.readUInt32LE(p);
        p += 4;
      }
    }
    objects.push({ type, props });
  }
  return objects;
}

/** Same shape as build.mjs extractMeta(). Throws if the file can't be read. */
export function rivMeta(buf) {
  const objects = parseObjects(buf);
  const assets = []; // file assets in order: AudioEvent.assetId indexes this
  const artboards = [];
  let ab = null;
  let anim = null;
  let keyedTarget = null;
  let keyedIsTrigger = false;
  for (const o of objects) {
    const { type, props } = o;
    if (type === T.AudioAsset || type === T.ImageAsset || type === T.FontAsset || type === T.BlobAsset || type === T.AudioAssetClip || type === T.ScriptAsset || type === T.ShaderAsset) {
      assets.push({ type, name: props[K.assetName] ?? null, volume: props[K.assetVolume] ?? 1 });
      continue;
    }
    if (type === T.Artboard) {
      ab = { name: props[K.name] ?? `Artboard ${artboards.length + 1}`, objects: [o], animations: [] };
      artboards.push(ab);
      anim = null;
      continue;
    }
    if (!ab) continue;
    if (COMPONENTS.has(type)) {
      ab.objects.push(o);
      continue;
    }
    if (type === T.LinearAnimation) {
      anim = {
        name: props[K.animName] ?? `Animation ${ab.animations.length + 1}`,
        fps: props[K.fps] ?? 60,
        duration: props[K.duration] ?? 60,
        loop: props[K.loop] ?? 0,
        workStart: props[K.workStart] ?? NONE,
        workEnd: props[K.workEnd] ?? NONE,
        enableWorkArea: !!props[K.enableWorkArea],
        callbacks: [],
      };
      ab.animations.push(anim);
      keyedTarget = null;
      continue;
    }
    if (!anim) continue;
    if (type === T.KeyedObject) {
      keyedTarget = ab.objects[props[K.objectId] ?? -1] ?? null;
      keyedIsTrigger = false;
    } else if (type === T.KeyedProperty) {
      keyedIsTrigger = props[K.propertyKey] === 395; // Event.trigger
    } else if (type === T.KeyFrameCallback && keyedTarget?.type === T.AudioEvent && keyedIsTrigger) {
      anim.callbacks.push({ frame: props[K.frame] ?? 0, target: keyedTarget });
    } else if (type === T.StateMachine) {
      anim = null; // state machines follow the animations
    }
  }

  const out = artboards.map((a) => {
    const animations = a.animations.map((x) => {
      const audio = x.callbacks
        .map(({ frame, target }) => {
          const asset = assets[target.props[K.audioAssetId]];
          return {
            frame,
            time: frame / x.fps,
            event: target.props[K.name] ?? 'audio',
            asset: asset?.name ?? null,
            volume: asset?.volume ?? 1,
          };
        })
        .sort((p, q) => p.time - q.time);
      const useWork = x.enableWorkArea && x.workStart !== NONE && x.workEnd !== NONE;
      return {
        name: x.name,
        fps: x.fps,
        durationFrames: x.duration,
        startFrame: useWork ? x.workStart : 0,
        endFrame: useWork ? x.workEnd : x.duration,
        loop: x.loop,
        audio,
      };
    });
    return { name: a.name, defaultAnimation: animations[0]?.name ?? null, animations };
  });
  return { defaultArtboard: out[0]?.name ?? null, artboards: out, problems: [], source: 'riv' };
}
