// tests/daily-report.test.mjs - checks daily-report v10.1 (Supabase edge function) and the Pages pieces it reads.
// Run: node --experimental-strip-types tests/daily-report.test.mjs   (Node 22+; no network, no Supabase, no email)
// Deno and fetch are stubbed; the handler is called with ?dry=1, which returns the HTML + X-Report-Subject.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'xTVW0K1qKi';

// ---- scenario (mutated per case) ----
let S;
function scenario(over = {}) {
  return {
    cfg: { latest_ext_version: '1.17.0', daily_lead_target: '20' },
    siteExt: '1.17.2',            // what /api/health returns as latest_ext (null = site down)
    day: {                        // radar_daily_stats for the reported day (shape of the 11-13 email)
      new_targets: 20, runs: 5, run_done: 3, saved: 29, best_saved: 29, found: 40, best_found: 40,
      listed: 12, ext_version: '1.17.2', by_version: [], avg7: 12, total_targets: 5384,
      bridges_never_scraped: 108, problems: [],
      by_bridge: [{ bridge: 'Veronique Denis-Pelliet', n: 11 }, { bridge: 'Bénédicte MAITRE', n: 9 }],
    },
    prev: { new_targets: 20, runs: 4 },
    date: '2026-11-13',
    byStart: {},                  // p_start ISO -> radar_daily_stats override (other days)
    ext: {},                      // v10: radar_ext_activity for the primary owner (the extension's own run log)
    ...over,
  };
}

let handler = null;
const TEST_SECRET = 'test-daily-report-secret';
let ENV_SECRET = TEST_SECRET;   // mutated by the auth cases below
globalThis.Deno = {
  env: { get: (k) => ({ SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', DAILY_REPORT_CRON_SECRET: ENV_SECRET }[k]) },
  serve: (h) => { handler = h; },
};
const DAY_START = '2026-11-13T05:00:00.000Z';   // ET midnight, Nov 13 (EST, UTC-5)
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u === 'https://radar.gershoncrm.com/api/health') {   // v10: site domain
    if (S.siteExt === null) throw new Error('network down');
    return ok({ platform: 'radar', version: '1.18.12', latest_ext: S.siteExt, status: 'green' });
  }
  if (u.includes('api.resend.com')) throw new Error('dry run must not send email');
  assert.ok(u.startsWith('https://sb.test/rest/v1/'), 'unexpected fetch ' + u);
  const p = u.slice('https://sb.test/rest/v1/'.length);
  if (p.startsWith('users?')) return ok([{ owner_key: OWNER, email: 'report@example.test', display_name: 'Olivier Attia', is_admin: true, status: 'active' }]);
  if (p.startsWith('config?select=owner_key,key,value')) return ok(Object.entries(S.cfg).map(([key, value]) => ({ owner_key: OWNER, key, value })));
  if (p.startsWith('config?')) return ok([]);
  if (p.startsWith('activity_log?select=log:')) return ok(S.logRows || []);   // v9.5 case 12: the day's raw log
  if (p.startsWith('gate_clients?') || p.startsWith('activity_log?')) return ok([]);
  if (p === 'rpc/radar_ext_activity') return ok([S.ext || {}]);   // v10
  if (p === 'rpc/radar_daily_stats') {
    const b = JSON.parse(opts.body);
    if (b.p_start === (S.dayStart || DAY_START)) return ok(S.day);
    return ok(S.byStart[b.p_start] || S.prev);
  }
  throw new Error('unhandled ' + p);
};

const mod = await import(path.join(root, 'supabase/functions/daily-report/index.ts'));
assert.equal(typeof handler, 'function', 'Deno.serve handler registered');

async function run(over) {
  S = scenario(over);
  const res = await handler(new Request(`https://fn.test/daily-report?secret=${TEST_SECRET}&dry=1&date=${S.date}`));
  assert.equal(res.status, 200);
  return { subject: decodeURIComponent(res.headers.get('X-Report-Subject') || ''), html: await res.text() };
}

// ---- auth: secret from env, fail closed ----
{
  const req = (q) => handler(new Request(`https://fn.test/daily-report${q}`));
  assert.equal((await req(`?secret=wrong&dry=1`)).status, 401, 'wrong secret -> 401');
  assert.equal((await req(`?dry=1`)).status, 401, 'no secret -> 401');
  ENV_SECRET = undefined;
  assert.equal((await req(`?secret=${TEST_SECRET}&dry=1`)).status, 503, 'env unset -> refused (503)');
  assert.equal((await req(`?dry=1`)).status, 503, 'env unset, no secret -> refused');
  ENV_SECRET = '';
  assert.equal((await req(`?secret=&dry=1`)).status, 503, 'empty env never matches empty secret');
  ENV_SECRET = TEST_SECRET;
}

// ---- pure helpers ----
assert.equal(mod.publishedExtVersion('1.17.0', '1.17.2', '1.7.3'), '1.17.2');
assert.equal(mod.publishedExtVersion('1.17.2', null, '1.7.3'), '1.17.2');
assert.equal(mod.publishedExtVersion(undefined, 'garbage', '1.7.3'), '1.7.3');
assert.equal(mod.publishedExtVersion(' v1.18.0 ', '1.17.2'), '1.18.0');
assert.equal(mod.publishedExtVersion('1.17.10', '1.17.9'), '1.17.10', 'numeric, not string, compare');
const at = new Date('2026-11-13T05:00:00Z');
assert.equal(mod.dailyCap({ daily_lead_target: '20' }, at), 20);
assert.equal(mod.dailyCap({}, at), 10, 'extension default');
assert.equal(mod.dailyCap({ daily_lead_target: '9999' }, at), 100, 'ceiling');
assert.equal(mod.dailyCap({ daily_lead_target: '20', limits_half_until: '2026-11-30T00:00:00Z' }, at), 10);
assert.equal(mod.dailyCap({ daily_lead_target: '20', limits_pause_until: '2026-11-30T00:00:00Z' }, at), 0);
assert.equal(mod.dailyCap({ daily_lead_target: 'abc' }, at), null);
assert.equal(mod.capReached(20, 20), true);
assert.equal(mod.capReached(19, 20), false);
assert.equal(mod.capReached(5, 0), false);
assert.equal(mod.capReached(20, null), false);

// ---- 1. the 11-13 email replayed: cap explained, no false "ahead of" ----
let r = await run();
assert.equal(r.subject, 'Radar Report — November 13, 2026 — +20 new prospects (daily cap reached)');
assert.match(r.html, /That is the daily cap: the extension takes at most 20 new prospects a day/);
assert.match(r.html, /Chrome extension up to date \(v1\.17\.2\)/);
assert.doesNotMatch(r.html, /ahead of the published/);
assert.match(r.html, /daily-report v10\.1/);
assert.match(r.html, /radar\.gershoncrm\.com/);
assert.match(r.html, /New to Radar \(first seen\)/);
console.log('case 1:', r.subject);

// ---- 2. site unreachable: falls back to config (old behaviour, still correct when config is right) ----
r = await run({ siteExt: null });
assert.match(r.html, /Chrome extension v1\.17\.2 \(ahead of the published v1\.17\.0\)/);
r = await run({ siteExt: null, cfg: { latest_ext_version: '1.17.2', daily_lead_target: '20' } });
assert.match(r.html, /Chrome extension up to date \(v1\.17\.2\)/);

// ---- 3. under the cap: plain count, no cap text ----
r = await run({ day: { ...scenario().day, new_targets: 13, by_bridge: [{ bridge: 'A', n: 13 }] } });
assert.equal(r.subject, 'Radar Report — November 13, 2026 — +13 new prospects');
assert.doesNotMatch(r.html, /daily cap/);

// ---- 4. an older extension (no cap before 1.17.2): no cap text even at 20 ----
r = await run({ day: { ...scenario().day, ext_version: '1.17.0' } });
assert.equal(r.subject, 'Radar Report — November 13, 2026 — +20 new prospects');
assert.doesNotMatch(r.html, /daily cap/);

// ---- 5. a genuinely newer local build is still reported as ahead ----
r = await run({ day: { ...scenario().day, ext_version: '1.17.3' } });
assert.match(r.html, /Chrome extension v1\.17\.3 \(ahead of the published v1\.17\.2\)/);

// ---- 6. nothing ran anywhere: DID NOT RUN unchanged ----
r = await run({ day: { new_targets: 0, runs: 0, saved: 0, total_targets: 5300 } });
assert.equal(r.subject, 'Radar Report — November 13, 2026 — ⚠️ DID NOT RUN');

// ---- 7. v9.4 weekend: the real 11-14 (Sat) / 11-15 (Sun) data - no owner ran, no prospect first seen ----
assert.equal(mod.isWeekend('2026-11-14'), true);
assert.equal(mod.isWeekend('2026-11-15'), true);
assert.equal(mod.isWeekend('2026-11-13'), false);
assert.equal(mod.isWeekend('2026-11-16'), false);
const idle = { new_targets: 0, runs: 0, saved: 0, total_targets: 5384, avg7: 12, bridges_never_scraped: 108, last_run_at: '2026-11-13T19:20:24Z' };
for (const [date, start] of [['2026-11-14', '2026-11-14T05:00:00.000Z'], ['2026-11-15', '2026-11-15T05:00:00.000Z']]) {
  r = await run({ date, dayStart: start, day: idle, byStart: { '2026-11-14T05:00:00.000Z': { runs: 0 } } });
  assert.equal(r.subject, `Radar Report — ${date === '2026-11-14' ? 'November 14' : 'November 15'}, 2026 — weekend, no run (by design)`);
  assert.doesNotMatch(r.subject + r.html, /DID NOT RUN|did NOT run/);
  assert.match(r.html, /Weekend — no collection scheduled/);
  assert.match(r.html, /weekend &#8212; no run scheduled/);
  assert.doesNotMatch(r.html, /without a run/);
  assert.match(r.html, /108 active bridges have never produced a prospect/, 'dead bridges still listed');
  console.log(`case 7 ${date}:`, r.subject);
}

// ---- 8. weekend on which someone ran by hand: reported like any other day ----
r = await run({ date: '2026-11-14', dayStart: '2026-11-14T05:00:00.000Z', day: { ...scenario().day, new_targets: 7, by_bridge: [{ bridge: 'A', n: 7 }] } });
assert.equal(r.subject, 'Radar Report — November 14, 2026 — +7 new prospects');

// ---- 9. Monday after a weekend: compares with Friday as the last working day, no "days without a run" ----
r = await run({ date: '2026-11-16', dayStart: '2026-11-16T05:00:00.000Z',
  day: { ...scenario().day, new_targets: 16, by_bridge: [{ bridge: 'A', n: 16 }] },
  byStart: { '2026-11-15T05:00:00.000Z': { runs: 0 }, '2026-11-14T05:00:00.000Z': { runs: 0 }, '2026-11-13T05:00:00.000Z': { new_targets: 20, runs: 5 } } });
assert.match(r.html, /vs Fri 11-13 \(last working day\)/);
assert.doesNotMatch(r.html, /without a run/);

// ---- 10. a WEEKDAY with no run anywhere is still red ----
r = await run({ date: '2026-11-17', dayStart: '2026-11-17T05:00:00.000Z', day: idle });
assert.equal(r.subject, 'Radar Report — November 17, 2026 — ⚠️ DID NOT RUN');

// ---- 11. v9.5: the 11-24 / 11-25 emails - a normal day with only the standing dead-bridge backlog ----
// Every report for 7+ days said "needs attention" solely because of bridges_never_scraped (107), an
// all-time count that is the same whatever the day did. It must not change the verdict or the subject.
const nov25 = { ...scenario().day, new_targets: 20, runs: 3, run_done: 2, saved: 50, best_saved: 50, listed: 12,
  bridges_never_scraped: 107, problems: ['scrape:skip-not-connected — Not a 1st-degree connection'],
  by_bridge: [{ bridge: 'Mathieu Aimlon', n: 20 }] };
r = await run({ date: '2026-11-25', dayStart: '2026-11-25T05:00:00.000Z', day: nov25 });
assert.equal(r.subject, 'Radar Report — November 25, 2026 — +20 new prospects (daily cap reached)');
assert.doesNotMatch(r.subject, /needs attention/);
assert.match(r.html, /Radar did its job — 20 new prospects/);
assert.doesNotMatch(r.html, /Radar collected, but needs attention/);
assert.doesNotMatch(r.html, /❌ 107 dead bridges/);
assert.match(r.html, /Standing \(not about yesterday\): 107 active bridges have never produced a prospect/);
console.log('case 11:', r.subject);
assert.equal(mod.deadBridgesNote({ bridges_never_scraped: 0 }), null);
assert.match(mod.deadBridgesNote({ bridges_never_scraped: 1 }), /1 active bridge has never/);

// ---- 12. a real problem on the day (HTTP 429) still turns it amber and is NAMED in the subject ----
const nov25b = { ...nov25, problems: ['scrape:error — status 429 rate limited'] };
r = await run({ date: '2026-11-25', dayStart: '2026-11-25T05:00:00.000Z', day: nov25b,
  logRows: [{ log: [{ level: 'error', msg: 'scrape:error', data: { error: 'status 429 rate limited' } }] }] });
assert.equal(r.subject, 'Radar Report — November 25, 2026 — +20 new prospects (daily cap reached) · needs attention: HTTP 429 (rate limited by LinkedIn) logged 1×');
assert.match(r.html, /Radar collected, but needs attention/);
assert.match(r.html, /❌ HTTP 429/);
console.log('case 12:', r.subject);

// ---- 13. v10: bridge invitations + Chrome extension activity, invite count in the subject ----
const extDay = {
  invites_sent: 2, invites_failed: 1, invites_accepted: 1, invites_waiting: 14, invites_mode: 'on', not_connected: 9,
  invites_sent_list: [{ bridge: 'Jean Dupont', source: 'Recommended Leads' }, { bridge: 'Anne Martin', source: null }],
  invites_failed_list: [{ bridge: 'Paul Leroy', reason: 'weekly invite limit' }],
  runs_started: 3, runs_done: 2, first_at: '2026-11-25T14:00:00Z', last_at: '2026-11-25T18:30:00Z', version: '1.27.1',
  pages_read: 12, bridges_read: 6, bridges_with_leads: 4, found: 40, saved: 20, urls_resolved: 18, listed: 12,
  bridge_urls_resolved: 3, discover_sources: 2, discover_candidates: 7, gate_held: [], limits_why: null, errors: 0,
};
r = await run({ date: '2026-11-25', dayStart: '2026-11-25T05:00:00.000Z', day: nov25, ext: extDay });
assert.equal(r.subject, 'Radar Report — November 25, 2026 — +20 new prospects (daily cap reached) · 2 bridge invite(s)');
assert.doesNotMatch(r.subject, /needs attention/, 'dead bridges still do not turn v10.1 amber');
assert.match(r.html, /Bridge invitations \(connection requests\)/);
assert.match(r.html, /Jean Dupont <span style="color:#94a3b8;">\(Recommended Leads\)<\/span>/);
assert.match(r.html, /Paul Leroy <span style="color:#94a3b8;">— weekly invite limit<\/span>/);
assert.match(r.html, /What the Chrome extension did/);
assert.match(r.html, /2 finished of 3 started/);
assert.match(r.html, /v1\.27\.1/);
assert.match(r.html, /Radar did its job — 20 new prospects/);
console.log('case 13:', r.subject);

// ---- 14. v10: no extension activity, no invites - no invite tag, "no activity" line ----
r = await run({ date: '2026-11-25', dayStart: '2026-11-25T05:00:00.000Z', day: nov25, ext: {} });
assert.equal(r.subject, 'Radar Report — November 25, 2026 — +20 new prospects (daily cap reached)');
assert.match(r.html, /The extension logged no activity yesterday\./);

// ---- 15. v10: HTTP 429 + invites - the problem is named first, then the invite count ----
r = await run({ date: '2026-11-25', dayStart: '2026-11-25T05:00:00.000Z', day: nov25b, ext: extDay,
  logRows: [{ log: [{ level: 'error', msg: 'scrape:error', data: { error: 'status 429 rate limited' } }] }] });
assert.equal(r.subject, 'Radar Report — November 25, 2026 — +20 new prospects (daily cap reached) · needs attention: HTTP 429 (rate limited by LinkedIn) logged 1× · 2 bridge invite(s)');

// ---- 16. v10 pure helpers: mergeInvites across accounts ----
const merged = mod.mergeInvites([
  { owner_key: 'a', label: 'Ann', act: { invites_sent: 2, invites_mode: 'on', invites_waiting: 3, invites_sent_list: [{ bridge: 'X', source: 'S' }] } },
  { owner_key: 'b', label: 'Bob', act: { invites_sent: 1, invites_mode: 'off', invites_failed: 1, invites_failed_list: [{ bridge: 'Y', reason: 'r' }] } },
], {});
assert.equal(merged.invites_sent, 3);
assert.equal(merged.invites_waiting, 3);
assert.equal(merged.mode_text, 'Ann');
assert.deepEqual(merged.invites_sent_list, [{ bridge: 'X', source: 'S · Ann' }]);
assert.deepEqual(merged.invites_failed_list, [{ bridge: 'Y (Bob)', reason: 'r' }]);
const solo = { invites_sent: 5 };
assert.equal(mod.mergeInvites([{ owner_key: 'a', label: 'Ann' }], solo), solo, 'one account: its own numbers');

// ---- Pages side: /api/health exposes latest_ext; the middleware still raises an old LATEST_EXT_VERSION ----
const ver = await import(path.join(root, 'functions/_lib/version.js'));
const health = await import(path.join(root, 'functions/api/health.js'));
const hj = await (await health.onRequestGet({ env: {} })).json();
assert.equal(hj.latest_ext, ver.LATEST_EXT);
assert.equal(hj.version, ver.APP_VERSION);
const mw = await import(path.join(root, 'functions/_middleware.js'));
const page = "<html><head></head><body><script>const LATEST_EXT_VERSION = '1.17.0';</script><a href=\"/radar-extension-v1.17.0.zip\">x</a></body></html>";
const out = await (await mw.onRequest({
  request: new Request('https://radar.test/app.html'),
  next: async () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }),
})).text();
assert.match(out, new RegExp(`LATEST_EXT_VERSION = '${ver.LATEST_EXT.replace(/\./g, '\\.')}'`));
assert.ok(out.includes(`/radar-extension-v${ver.LATEST_EXT}.zip`));

console.log('daily-report v10.1 + /api/health latest_ext: all assertions passed');
