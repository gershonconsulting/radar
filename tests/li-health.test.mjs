// tests/li-health.test.mjs — li-health edge function (tasks #39 daily signal check and #11 weekly grade, moved into Radar).
// Run: node --experimental-strip-types tests/li-health.test.mjs   (Node 22+; no network, no Supabase, no email)
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const L = await import(path.join(root, 'supabase/functions/_shared/li-health-logic.ts'));
const R = await import(path.join(root, 'supabase/functions/li-health/report.ts'));
let passed = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; }, (e) => { console.error('FAIL', name); throw e; });

const NOW = Date.parse('2026-11-24T23:41:00Z'); // Tue 18:41 New York
const iso = (h) => new Date(NOW - h * 3600000).toISOString();
const acct = (k, status = 'open', daily_cap = 45, weekly_cap = 225, extra = {}) => ({ account_key: k, label: 'Radar user — ' + k, status, daily_cap, weekly_cap, ...extra });

// ---------------- pure: refusals ----------------
await t('countsByOwner folds statuses and ignores null', () => {
  const c = L.countsByOwner([
    { owner_key: 'A', http_status: '401', n: 2, first_ev: '2026-11-24T01:00Z', last_ev: '2026-11-24T05:00Z' },
    { owner_key: 'A', http_status: '429', n: 7, first_ev: null, last_ev: '2026-11-24T04:00Z' },
    { owner_key: 'A', http_status: null, n: 9, first_ev: null, last_ev: null },
    { owner_key: 'B', http_status: '500', n: 3, first_ev: null, last_ev: null },
  ]);
  assert.equal(c.A.n401, 2); assert.equal(c.A.n429, 7); assert.equal(c.A.last401, '2026-11-24T05:00Z'); assert.equal(c.B.n500, 3);
});
await t('owner/account key mapping', () => {
  assert.equal(L.ownerKeyOf('radar-MDJBNVGzwJ'), 'MDJBNVGzwJ');
  assert.equal(L.ownerKeyOf('olivier-primary'), 'xTVW0K1qKi');
  assert.equal(L.accountKeyOf('xTVW0K1qKi'), 'olivier-primary');
});

// ---------------- pure: #39 classification ----------------
const base = (over = {}) => ({ nowMs: NOW, accounts: [], volume: [], refusals36h: [], refusals24h: [], refusals7d: [], lockOwners: [], silentAlerted: {}, ...over });
await t('#39: 401 on an open account -> auto-pause', () => {
  const c = L.classifyDaily(base({ accounts: [acct('radar-AAA')], volume: [{ account_key: 'radar-AAA', last_action: iso(2), v24: 30 }],
    refusals36h: [{ owner_key: 'AAA', http_status: '401', n: 3, first_ev: iso(20), last_ev: iso(3) }] }));
  assert.equal(c.toPause.length, 1); assert.equal(c.attention.length, 1); assert.equal(c.attention[0].n401_36h, 3);
});
await t('#39: 401 on a paused/restricted account -> reported, not paused again', () => {
  const c = L.classifyDaily(base({ accounts: [acct('radar-AAA', 'paused'), acct('radar-BBB', 'restricted')],
    refusals36h: [{ owner_key: 'AAA', http_status: '401', n: 1, first_ev: iso(5), last_ev: iso(5) }, { owner_key: 'BBB', http_status: '401', n: 1, first_ev: iso(5), last_ev: iso(5) }] }));
  assert.equal(c.toPause.length, 0); assert.equal(c.attention.length, 2); assert.ok(c.attention.every((a) => a.alreadyPaused));
});
await t('#39: 429 alone never pauses; alerts only at >= 10 in 24h', () => {
  const nine = L.classifyDaily(base({ accounts: [acct('radar-AAA')], volume: [{ account_key: 'radar-AAA', last_action: iso(1), v24: 10 }], refusals24h: [{ owner_key: 'AAA', http_status: '429', n: 9, first_ev: iso(5), last_ev: iso(2) }] }));
  assert.equal(nine.attention.length, 0, '9 x 429 stays quiet');
  const ten = L.classifyDaily(base({ accounts: [acct('radar-AAA')], volume: [{ account_key: 'radar-AAA', last_action: iso(1), v24: 10 }], refusals24h: [{ owner_key: 'AAA', http_status: '429', n: 10, first_ev: iso(5), last_ev: iso(2) }] }));
  assert.equal(ten.attention.length, 1); assert.equal(ten.toPause.length, 0);
});
await t('#39: silent = open + cap + active in 7d + >48 working hours quiet; known/once-alerted/weekend excluded', () => {
  const quiet = (k, lastIso, over = {}) => L.classifyDaily(base({ accounts: [acct(k)], volume: [{ account_key: k, last_action: lastIso, v24: 0 }], ...over }));
  assert.equal(quiet('radar-AAA', iso(120)).attention[0]?.silent, true, 'Thu -> Tue = 72 working hours quiet');
  assert.equal(quiet('radar-AAA', iso(30)).attention.length, 0, '30h is not silent');
  assert.equal(quiet('radar-AAA', iso(72)).attention.length, 0, 'Sat -> Tue is under 48 working hours');
  assert.equal(quiet('radar-AAA', iso(24 * 9)).attention.length, 0, 'no activity in the previous 7 days');
  assert.equal(quiet('radar-uaZAWIvJMU', iso(120)).attention.length, 0, 'known long-term silent');
  assert.equal(quiet('radar-AAA', iso(120), { silentAlerted: { 'radar-AAA': iso(120) } }).attention.length, 0, 'same silent episode already alerted');
  // Fri 18:00 ET -> Mon 18:41 ET = ~24.7 working hours, not silent
  const mon = Date.parse('2026-11-23T23:41:00Z');
  const c = L.classifyDaily({ ...base(), nowMs: mon, accounts: [acct('radar-AAA')], volume: [{ account_key: 'radar-AAA', last_action: '2026-11-20T23:00:00Z', v24: 0 }] });
  assert.equal(c.attention.length, 0, 'weekend does not count');
  const paused = L.classifyDaily(base({ accounts: [acct('radar-AAA', 'paused')], volume: [{ account_key: 'radar-AAA', last_action: iso(120), v24: 0 }] }));
  assert.equal(paused.attention.length, 0, 'paused accounts are not "silent"');
});
await t('#39: nothing found -> nothing to report', () => {
  const c = L.classifyDaily(base({ accounts: [acct('radar-AAA'), acct('x-template')], volume: [{ account_key: 'radar-AAA', last_action: iso(1), v24: 5 }] }));
  assert.equal(c.attention.length, 0); assert.equal(c.checked, 1, 'templates skipped');
});

// ---------------- pure: #11 grade formula ----------------
const g0 = { status: 'open', n401_7d: 0, lock: false, n429_7d: 0, v24: 10, v7d: 50, daily_cap: 45, weekly_cap: 225, deniesCounted: 0, deniesOutsideWindow: 0, extVersion: '1.18.2', latestExt: '1.18.2', signedOut: false, staleData: false, noTelemetry: false };
await t('#11: clean account = A 100', () => { const g = L.gradeAccount(g0); assert.equal(g.score, 100); assert.equal(g.letter, 'A'); });
await t('#11: 401 -60, 429 -2 each max -30', () => {
  assert.equal(L.gradeAccount({ ...g0, n401_7d: 1 }).score, 40);
  assert.equal(L.gradeAccount({ ...g0, n429_7d: 4 }).score, 92);
  assert.equal(L.gradeAccount({ ...g0, n429_7d: 55 }).score, 70);
});
await t('#11: weekly usage bands and daily 80%', () => {
  assert.equal(L.gradeAccount({ ...g0, v7d: 240 }).score, 65);  // >100% -35
  assert.equal(L.gradeAccount({ ...g0, v7d: 190 }).score, 80);  // 84% -20
  assert.equal(L.gradeAccount({ ...g0, v7d: 140 }).score, 92);  // 62% -8
  assert.equal(L.gradeAccount({ ...g0, v24: 36 }).score, 90);   // 80% of 45 -10
});
await t('#11: denies -3 max -15; outside_window -1 max -5; ext -10; signed out -25; cap >80 -15; stale -5', () => {
  assert.equal(L.gradeAccount({ ...g0, deniesCounted: 9 }).score, 85);
  assert.equal(L.gradeAccount({ ...g0, deniesOutsideWindow: 3 }).score, 97);
  assert.equal(L.gradeAccount({ ...g0, deniesOutsideWindow: 30 }).score, 95);
  assert.equal(L.gradeAccount({ ...g0, extVersion: '1.17.0' }).score, 90);
  assert.equal(L.gradeAccount({ ...g0, signedOut: true }).score, 75);
  assert.equal(L.gradeAccount({ ...g0, daily_cap: 150, weekly_cap: 600 }).score, 85);
  assert.equal(L.gradeAccount({ ...g0, staleData: true }).score, 95);
});
await t('#11: paused capped at 60, restricted at 30', () => {
  assert.equal(L.gradeAccount({ ...g0, status: 'paused' }).score, 60);
  assert.equal(L.gradeAccount({ ...g0, status: 'paused' }).letter, 'D');
  assert.equal(L.gradeAccount({ ...g0, status: 'restricted' }).score, 30);
  assert.equal(L.gradeAccount({ ...g0, status: 'paused', n401_7d: 2 }).score, 40, 'below the cap stays');
});
await t('#11: no telemetry -> ? unless a penalty applies', () => {
  const q = L.gradeAccount({ ...g0, noTelemetry: true, v24: null, v7d: null });
  assert.equal(q.letter, '?'); assert.equal(q.score, null);
  const p = L.gradeAccount({ ...g0, noTelemetry: true, v24: null, v7d: null, signedOut: true, extVersion: '1.7.4' });
  assert.equal(p.score, 65); assert.ok(p.penalties.includes('unverified volume'));
});
await t('#11: letters, estate caps and trend', () => {
  assert.deepEqual([95, 85, 75, 55, 10, null].map(L.letterFor), ['A', 'B', 'C', 'D', 'F', '?']);
  assert.deepEqual(L.estateGrade([100, 100, 100, 40]), { score: 79, letter: 'C' }, 'one F -> at most C');
  assert.deepEqual(L.estateGrade([100, 100, 100, 40, 30]), { score: 69, letter: 'D' }, 'two F -> at most D');
  assert.deepEqual(L.estateGrade([100, 80, null]), { score: 90, letter: 'A' });
  assert.equal(L.trendOf(null, { score: 50 }), 'new');
  assert.equal(L.trendOf({ letter: 'C', score: 69 }, { score: 72 }), '▲ (last week C 69)');
  assert.equal(L.trendOf({ letter: 'C', score: 69 }, { score: 60 }), '▼ (last week C 69)');
});
await t('#11: status rule', () => {
  const s = (o) => L.statusFor({ gateReachable: true, n401_7d: 0, gateStatus: 'open', lock: false, deniesCounted: 0, v24: 5, v7d: 20, daily_cap: 45, weekly_cap: 225, n429_7d: 0, ...o });
  assert.equal(s({}), 'OK'); assert.equal(s({ n401_7d: 1 }), 'Restricted'); assert.equal(s({ gateStatus: 'paused' }), 'Degraded');
  assert.equal(s({ n429_7d: 10 }), 'Degraded'); assert.equal(s({ v7d: 180 }), 'Degraded'); assert.equal(s({ gateReachable: false }), 'Check failed');
  assert.equal(L.subjectMark([{ level: 'orange' }, { level: 'red' }]), '🔴'); assert.equal(L.subjectMark([]), '✅');
});

// ---------------- handler-level (fake DBs, fake Resend) ----------------
function fakeDeps({ radar = {}, gate = {}, gateDown = false, radarDown = false, dry = false } = {}) {
  const calls = { radar: [], gate: [], sent: [] };
  const pick = (map, sql) => { for (const [k, v] of Object.entries(map)) if (sql === R.SQL[k]) return typeof v === 'function' ? v() : v; return []; };
  return {
    calls,
    deps: {
      now: () => NOW, dry,
      radar: async (sql, p) => { if (radarDown) throw new Error('connection refused'); calls.radar.push([sql, p]); return pick(radar, sql); },
      gate: gateDown ? null : async (sql, p) => { calls.gate.push([sql, p]); return sql === R.SQL.pause ? [{ account_key: p[0] }] : pick(gate, sql); },
      send: async (payload, key) => { calls.sent.push({ payload, key }); return { ok: true, id: 'em_1' }; },
    },
  };
}
await t('#39 handler: quiet day sends nothing', async () => {
  const f = fakeDeps({ gate: { gateAccounts39: [acct('radar-AAA')], gateVolume39: [{ account_key: 'radar-AAA', last_action: iso(1), v24: 5 }] } });
  const r = await R.runDaily(f.deps);
  assert.equal(r.sent, false); assert.equal(r.quiet, true); assert.equal(f.calls.sent.length, 0);
  assert.match(r.summary, /^1 accounts checked, no LinkedIn-side refusals, no new silent accounts$/);
});
await t('#39 handler: 401 -> pause + one email with the right sender, recipient, subject and idempotency key', async () => {
  const f = fakeDeps({
    radar: { refusals36h: [{ owner_key: 'AAA', http_status: '401', n: 2, first_ev: '2026-11-24T10:00:00Z', last_ev: '2026-11-24T12:00:00Z' }],
      refusals7d: [{ owner_key: 'AAA', http_status: '401', n: 5, first_ev: null, last_ev: '2026-11-24T12:00:00Z' }],
      loginOf: [{ owner_key: 'AAA', name: 'Jane Client', email: 'j@x.test' }] },
    gate: { gateAccounts39: [acct('radar-AAA')], gateVolume39: [{ account_key: 'radar-AAA', last_action: iso(1), v24: 30 }] },
  });
  const r = await R.runDaily(f.deps);
  assert.equal(r.sent, true); assert.deepEqual(r.paused, ['radar-AAA']);
  const pause = f.calls.gate.find(([s]) => s === R.SQL.pause);
  assert.equal(pause[1][0], 'radar-AAA');
  assert.match(pause[1][1], /^ \| 2026-11-24 auto-paused by the daily LinkedIn signal check \(task #39\): HTTP 401 from LinkedIn at 2026-11-24T12:00:00Z, 2 in the last 36h and 5 in 7d\./);
  assert.ok(!/cap/.test(R.SQL.pause.split('where')[0].replace('status', '')), 'pause SQL never touches caps');
  const m = f.calls.sent[0];
  assert.equal(m.key, 'li-daily-39-2026-11-24');
  assert.equal(m.payload.from, 'GC LinkedIn Safety <alerts@gershon.ai>');
  assert.deepEqual(m.payload.to, ['report@gershonconsulting.com']);
  assert.equal(m.payload.subject, '[39] Jane Client (radar-AAA) — HTTP 401 from LinkedIn, auto-paused');
  assert.ok(m.payload.html.includes('Task #39') && m.payload.text.includes('Task #39'));
  assert.ok(m.payload.html.includes('https://airtable.com/appFhB17PkHQDqTlh'));
});
await t('#39 handler: Radar DB unreachable must email, never stay quiet', async () => {
  const f = fakeDeps({ radarDown: true, gate: { gateAccounts39: [acct('radar-AAA')] } });
  const r = await R.runDaily(f.deps);
  assert.equal(r.sent, true); assert.match(f.calls.sent[0].payload.subject, /^\[39\] LinkedIn daily check 2026-11-24: Radar DB unreachable/);
});
await t('#39 handler: gate not configured is reported, and dry run sends/writes nothing', async () => {
  const f = fakeDeps({ gateDown: true, dry: true });
  const r = await R.runDaily(f.deps);
  assert.equal(r.dry, true); assert.equal(f.calls.sent.length, 0);
  assert.ok(r.text.includes('GATE_DB_URL is not set'));
});
await t('#11 handler: one summary email, grades, trend storage', async () => {
  const f = fakeDeps({
    gate: {
      gateAccounts11: [acct('olivier-primary', 'open', 150, 600), acct('radar-MDJ', 'paused', 45, 225, { updated_at: '2026-11-05T00:00:00Z' }), acct('radar-UAZ'), acct('x-template')],
      gateVolume11: [{ account_key: 'olivier-primary', v24: 10, v7d: 200, denies_7d: 1, last_action: iso(10) }, { account_key: 'radar-MDJ', v24: 0, v7d: 3, denies_7d: 3, last_action: iso(30) }],
      denyReasons: [{ account_key: 'olivier-primary', reason: 'outside_window', n: 1 }, { account_key: 'radar-MDJ', reason: 'account_paused', n: 3 }],
    },
    radar: {
      gateClients: [{ owner_key: 'xTVW0K1qKi', ext_version: '1.18.2' }, { owner_key: 'MDJ', ext_version: '1.17.0' }, { owner_key: 'UAZ', ext_version: '1.7.4' }],
      identities: [{ owner_key: 'xTVW0K1qKi', name: 'Olivier Attia' }, { owner_key: 'MDJ', name: 'David L' }],
      radarUsers30d: [{ owner_key: 'xTVW0K1qKi' }, { owner_key: 'MDJ' }, { owner_key: 'NOGATE' }],
      loginCheck: [{ owner_key: 'UAZ', logged_in: 'false' }],
      configGet: [{ owner_key: '_estate', value: JSON.stringify({ letter: 'C', score: 69 }) }],
    },
  });
  const r = await R.runWeekly(f.deps);
  assert.equal(r.sent, true);
  const m = f.calls.sent[0];
  assert.equal(m.key, 'li-safety-11-2026-11-24');
  assert.equal(m.payload.from, 'GC LinkedIn Safety <alerts@gershon.ai>');
  assert.deepEqual(m.payload.to, ['report@gershonconsulting.com']);
  assert.match(m.payload.subject, /^🔴 \[11\] LinkedIn Safety Nov 24: grade [A-F?] \(\d+\) [▲▼=] · \d+ red, \d+ orange · /);
  assert.ok(m.payload.html.includes('Task #11 · LinkedIn Safety') && m.payload.text.includes('Task #11'));
  assert.ok(!/LinkedIn Health|GC Health/.test(m.payload.subject + m.payload.from));
  assert.ok(m.payload.html.includes('Not in the gate') && m.payload.html.includes('NOGATE'));
  assert.ok(m.payload.text.includes('Reply: OK cap 80'), 'cap above runbook -> Olivier decision with reply line');
  // olivier-primary: weekly 200/600=33% ok, cap 150 > 80 -15, 1 outside_window -1 -> 84 B
  const html = m.payload.html;
  assert.ok(html.includes('olivier-primary'));
  const writes = f.calls.radar.filter(([s]) => s === R.SQL.configSet).map(([, p]) => p[0]);
  assert.deepEqual(writes.sort(), ['_estate', 'olivier-primary', 'radar-MDJ', 'radar-UAZ'].sort());
});
await t('#11 handler: dry run returns grades, sends and writes nothing', async () => {
  const f = fakeDeps({ dry: true, gate: { gateAccounts11: [acct('olivier-primary', 'open', 150, 600)], gateVolume11: [{ account_key: 'olivier-primary', v24: 10, v7d: 200, last_action: iso(10) }], denyReasons: [{ account_key: 'olivier-primary', reason: 'outside_window', n: 1 }] } });
  const r = await R.runWeekly(f.deps);
  assert.equal(f.calls.sent.length, 0); assert.equal(f.calls.radar.filter(([s]) => s === R.SQL.configSet).length, 0);
  assert.deepEqual(r.accounts, [{ key: 'olivier-primary', letter: 'B', score: 84, status: 'OK' }]);
});

console.log(`li-health: ${passed} tests passed`);
