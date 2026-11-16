// tests/resend-retry.test.mjs - Resend retry helpers: cron/resend.js (EOD Worker) and
// supabase/functions/_shared/resend.ts (daily-report). Same cases for both.
// Run: node --experimental-strip-types tests/resend-retry.test.mjs   (Node 22+; fetch is mocked)
import assert from 'node:assert/strict';
import * as cron from '../cron/resend.js';
import * as edge from '../supabase/functions/_shared/resend.ts';

function mockFetch(steps) {
  const calls = [];
  const impl = async (_url, init) => {
    calls.push({ key: init.headers['Idempotency-Key'], body: String(init.body) });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === 'network') throw new TypeError('fetch failed');
    const json = step < 300 ? { id: 'email_123' } : { name: step === 429 ? 'rate_limit_exceeded' : 'validation_error', message: `status ${step}` };
    return new Response(JSON.stringify(json), { status: step });
  };
  return { calls, impl };
}
const payload = { from: 'GC Radar <reports@gershon.ai>', to: ['test@example.com'], subject: 'Radar Report', html: '<p>x</p>' };
const quiet = { warn: console.warn, error: console.error };
let passed = 0;

for (const [name, m] of [['cron/resend.js', cron], ['_shared/resend.ts', edge]]) {
  console.warn = () => {}; let logged = ''; console.error = (s) => { logged = s; };
  const waits = []; const sleep = async (ms) => { waits.push(ms); };

  // 1. 429 then 200: one logical send, two HTTP calls, same key and body.
  let f = mockFetch([429, 200]);
  let r = await m.sendResend('k', payload, { fetchImpl: f.impl, sleep });
  assert.equal(r.ok, true); assert.equal(r.id, 'email_123'); assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].key); assert.equal(f.calls[1].key, f.calls[0].key); assert.equal(f.calls[1].body, f.calls[0].body);
  assert.deepEqual(waits, [1000]); passed++;

  // 2. 400: no retry.
  f = mockFetch([400, 200]); waits.length = 0;
  r = await m.sendResend('k', payload, { fetchImpl: f.impl, sleep });
  assert.equal(r.ok, false); assert.equal(r.status, 400); assert.equal(f.calls.length, 1); assert.deepEqual(waits, []); passed++;

  // 3. network error, 503, 200 keep the caller key (radar-eod-<date>).
  f = mockFetch(['network', 503, 200]); waits.length = 0;
  r = await m.sendResend('k', payload, { fetchImpl: f.impl, sleep, idempotencyKey: 'radar-eod-2026-11-13' });
  assert.equal(r.ok, true); assert.equal(f.calls.length, 3); assert.ok(f.calls.every((c) => c.key === 'radar-eod-2026-11-13')); passed++;

  // 4. always 500: 3 retries (1s, 4s, 10s), then a logged final failure.
  f = mockFetch([500]); waits.length = 0;
  r = await m.sendResend('k', payload, { fetchImpl: f.impl, sleep, label: 'radar-daily' });
  assert.equal(r.ok, false); assert.equal(f.calls.length, 4); assert.deepEqual(waits, [1000, 4000, 10000]);
  assert.match(logged, /radar-daily: FINAL FAILURE after 4 attempt/); passed++;

  console.warn = quiet.warn; console.error = quiet.error;
}
console.log(`resend-retry: ${passed}/8 passed`);
