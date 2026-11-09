// Writes the fixture's synthetic sound effects (16-bit mono WAV). Run: node scripts/gen-fixture-sounds.mjs
import { writeFileSync } from 'node:fs';
const RATE = 22050;
function wav(name, seconds, fn) {
  const n = Math.round(seconds * RATE);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const v = Math.max(-1, Math.min(1, fn(t, seconds, noise)));
    buf.writeInt16LE(Math.round(v * 32000), 44 + i * 2);
  }
  writeFileSync(new URL(`../test-fixture-audio/${name}`, import.meta.url), buf);
}
// whoosh: band-ish noise swelling and fading
let lp = 0;
wav('whoosh.wav', 0.9, (t, d, noise) => { lp += (noise() - lp) * 0.08; return lp * 2.2 * Math.sin(Math.PI * t / d); });
// pop: short pitched blip
wav('pop.wav', 0.25, (t) => Math.sin(2 * Math.PI * (600 - 900 * t) * t) * Math.exp(-t * 18) * 0.9);
// ding: bell
wav('ding.wav', 1.4, (t) => (Math.sin(2 * Math.PI * 880 * t) * 0.6 + Math.sin(2 * Math.PI * 1760 * t) * 0.25) * Math.exp(-t * 3));
