// Regenerates lib/riv-schema.json from `rive schema`: the field type of every core property
// key (how to skip it in a .riv) and which type keys are Components (counted as artboard
// objects). Run: node scripts/gen-riv-schema.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const run = (...a) => JSON.parse(execFileSync('rive', ['schema', ...a, '--json'], { maxBuffer: 64 << 20 }).toString());
const names = run('--list');
const keys = {};
const fieldTypes = new Set();
const components = [];
const typeKeys = {};
for (const name of names) {
  const t = run(name, '--all');
  typeKeys[name] = t.typeKey;
  if (name === 'Component' || t.extends?.includes('Component')) components.push(t.typeKey);
  for (const p of t.properties) {
    fieldTypes.add(p.type);
    keys[p.key] = p.type;
  }
}
console.log([...fieldTypes].sort().join(', '));
writeFileSync(new URL('../lib/riv-schema.json', import.meta.url), JSON.stringify({ keys, components: components.sort((a, b) => a - b), typeKeys }) + '\n');
console.log(`${names.length} types, ${Object.keys(keys).length} keys`);
