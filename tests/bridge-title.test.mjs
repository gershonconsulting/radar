// ext 1.18.4: bridgeTitlesInPage picks the current position title, falls back to headline, stops on 429.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const src = readFileSync(new URL('../salesnav-radar-extension/sync-core.js', import.meta.url), 'utf8');
const i = src.indexOf('async function bridgeTitlesInPage(');
let d = 0, end = -1;
for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) { end = k + 1; break; } }
const responses = {
  A: { status: 200, body: { headline: 'Scientist | Genomics', positions: [{ title: 'Old job', current: false }, { title: 'Director, Spatial Biology', current: true }] } },
  B: { status: 200, body: { headline: '  VP   Translational Research  ' } },
  C: { status: 429, body: {} },
  D: { status: 200, body: { headline: 'never asked' } },
};
globalThis.document = { cookie: 'JSESSIONID="ajax:123"' };
globalThis.setTimeout = (f) => f();
globalThis.fetch = async (u) => { const k = u.match(/profileId:(\w)/)[1]; const r = responses[k]; return { status: r.status, ok: r.status === 200, text: async () => JSON.stringify(r.body) }; };
const fn = new Function('return (' + src.slice(i, end) + ')')();
const { out } = await fn(['A', 'B', 'C', 'D']);
assert.equal(out[0].title, 'Director, Spatial Biology');
assert.equal(out[1].title, 'VP Translational Research');
assert.equal(out[2].stop, true);
assert.equal(out.length, 3, 'stops after a refusal');
console.log('bridge-title: all assertions passed');
