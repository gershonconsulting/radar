// tests/health-check.test.mjs - health-check v4 (Supabase edge function): the 36 h "Radar has stopped collecting"
// threshold counts WORKING hours only (Mon-Fri, America/New_York), so a normal weekend is not an outage.
// Run: node --experimental-strip-types tests/health-check.test.mjs   (Node 22+; no network, no Supabase, no email)
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'xTVW0K1qKi';
let LAST = null;          // targets.collected_date returned for the owner
let ALERT_AT = null;      // config.health_alert_at
const writes = [];
let handler = null;
globalThis.Deno = {
  env: { get: (k) => ({ SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', RESEND_API_KEY: 're_test' }[k]) },
  serve: (h) => { handler = h; },
};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
  if (u.includes('api.resend.com')) throw new Error('test must not send email');
  assert.ok(u.startsWith('https://sb.test/rest/v1/'), 'unexpected fetch ' + u);
  const p = u.slice('https://sb.test/rest/v1/'.length);
  if ((opts.method || 'GET') !== 'GET') { writes.push(p); return ok([]); }
  if (p.startsWith('users?')) return ok([{ owner_key: OWNER, email: 'report@example.test', display_name: 'Olivier', is_admin: true, status: 'active' }]);
  if (p.startsWith('bridges?') || p.startsWith('sources?')) return ok([], { 'content-range': '0-0/5' });
  if (p.startsWith('targets?')) return ok(LAST ? [{ collected_date: LAST }] : []);
  if (p.startsWith('config?key=eq.health_alert_at')) return ok(ALERT_AT ? [{ value: ALERT_AT }] : []);
  if (p.startsWith('config?')) return ok([]);
  throw new Error('unhandled ' + p);
};

const mod = await import(path.join(root, 'supabase/functions/health-check/index.ts'));
assert.equal(typeof handler, 'function', 'Deno.serve handler registered');
const T = (iso) => new Date(iso).getTime();
const wh = (a, b) => Math.round(mod.workingHoursBetween(T(a), T(b)) * 100) / 100;

// ---- pure: working hours exclude Sat/Sun in America/New_York ----
// Fri 2026-11-13 18:00 ET (23:00 UTC) -> Mon 2026-11-16 06:00 UTC (01:00 ET): 6 h Fri + 1 h Mon = 7
assert.equal(wh('2026-11-13T23:00:00Z', '2026-11-16T06:00:00Z'), 7);
assert.equal(wh('2026-11-14T15:00:00Z', '2026-11-15T15:00:00Z'), 0, 'Sat -> Sun is zero working hours');
assert.equal(wh('2026-11-17T06:00:00Z', '2026-11-18T06:00:00Z'), 24, 'a weekday is 24 h');
// Thu 2026-11-12 12:00 ET -> Tue 2026-11-17 06:00 UTC (01:00 ET): 12 + 24 (Fri) + 24 (Mon) + 1 = 61
assert.equal(wh('2026-11-12T17:00:00Z', '2026-11-17T06:00:00Z'), 61);
// DST end (Sun 2026-11-01) falls on a weekend: Fri 10-30 18:00 EDT -> Mon 11-02 01:00 EST = 7
assert.equal(wh('2026-10-30T22:00:00Z', '2026-11-02T06:00:00Z'), 7);
assert.equal(mod.workingHoursBetween(T('2026-11-16T06:00:00Z'), T('2026-11-13T23:00:00Z')), 0, 'reversed = 0');
assert.equal(mod.isStale(null, T('2026-11-16T06:00:00Z')), true, 'never collected = stale');

// ---- the required cases ----
// 1. Friday 18:00 ET last run -> Monday 06:00 UTC check = NO alert (old code: 59 h > 36 -> alerted 11-16)
assert.equal(mod.isStale('2026-11-13T23:00:00Z', T('2026-11-16T06:00:00Z')), false);
// 2. Tuesday check, last run previous Thursday = alert
assert.equal(mod.isStale('2026-11-12T17:00:00Z', T('2026-11-17T06:00:00Z')), true);
// 3. weekday gap: last run Tue 18:00 ET -> Thu 06:00 UTC = 31 working h -> no alert; Fri 06:00 UTC = 55 -> alert
assert.equal(mod.isStale('2026-11-17T23:00:00Z', T('2026-11-19T06:00:00Z')), false);
assert.equal(mod.isStale('2026-11-17T23:00:00Z', T('2026-11-20T06:00:00Z')), true);
// 4. Friday 08:30 ET last run, Monday morning still fine; whole Monday missed -> Tuesday 06:00 UTC = 40.5 -> alert
assert.equal(mod.isStale('2026-11-13T13:30:00Z', T('2026-11-16T06:00:00Z')), false);
assert.equal(mod.isStale('2026-11-13T13:30:00Z', T('2026-11-17T06:00:00Z')), true);

// ---- handler (dry run): no email, no health_alert_at write ----
async function run(now) {
  const res = await handler(new Request(`https://fn.test/health-check?secret=radar_7Kq3mZ9pX2vL8nT&dry=1&now=${now}`));
  assert.equal(res.status, 200);
  return res.json();
}
LAST = '2026-11-13T23:00:00Z';
let r = await run('2026-11-16T06:00:00Z');
assert.equal(r.dry, true); assert.equal(r.sent, 0); assert.deepEqual(r.would_send, []);
assert.deepEqual(r.skipped, ['report@example.test:healthy']);
console.log('Mon 06:00 UTC after Fri 18:00 ET capture:', JSON.stringify(r.skipped));
LAST = '2026-11-12T17:00:00Z';
r = await run('2026-11-17T06:00:00Z');
assert.equal(r.sent, 0);
assert.equal(r.would_send.length, 1);
assert.equal(r.would_send[0].working_hours, 61);
console.log('Tue 06:00 UTC after Thu capture:', JSON.stringify(r.would_send));
LAST = null;
r = await run('2026-11-17T06:00:00Z');
assert.equal(r.would_send.length, 1, 'never collected still alerts');
assert.deepEqual(writes, [], 'dry run writes nothing');
// unauthorized
const bad = await handler(new Request('https://fn.test/health-check?secret=nope&dry=1'));
assert.equal(bad.status, 401);
console.log('health-check tests: all passed');
