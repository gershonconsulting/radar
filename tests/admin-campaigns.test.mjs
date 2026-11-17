// node tests/admin-campaigns.test.mjs
import assert from 'node:assert/strict';
import { build, statusOf, daysBetween, truthyPush } from '../functions/_lib/admin-campaigns.js';

const NOW = Date.parse('2026-11-17T14:00:00Z');
const T = (owner_key, collected_date, extra = {}) => ({ owner_key, collected_date, ...extra });

const rows = {
  users: [{ owner_key: 'xTVW0K1qKi', display_name: 'Olivier', email: 'o@x.com', status: 'active' }],
  sources: [
    { owner_key: 'xTVW0K1qKi', category: 'competitor' },
    { owner_key: 'MDJBNVGzwJ', category: 'competitor' },
    { owner_key: 'mrb4bdd3pi', category: 'partner' },
    { owner_key: 'UcDdaOGx4b', category: 'suggested' },          // suggested OFF row: not a real source
    { owner_key: 'zzTestPrio1', category: 'competitor' }
  ],
  bridges: [
    { owner_key: 'xTVW0K1qKi', active: true }, { owner_key: 'xTVW0K1qKi', active: false },
    { owner_key: 'MDJBNVGzwJ', active: true }
  ],
  targets: [
    T('xTVW0K1qKi', '2026-11-16', { grade: 'A', botdog_pushed: 'true', salesnav_listed_at: '2026-11-16T10:00:00Z' }),
    T('xTVW0K1qKi', '2026-11-01', { grade: 'C', botdog_pushed: null }),
    T('MDJBNVGzwJ', '2026-11-04', { grade: 'B', botdog_pushed: false }),
    T('mrb4bdd3pi', '2026-11-12', { grade: '?' })
  ],
  config: [
    { owner_key: 'MDJBNVGzwJ', key: 'limits_pause_until', value: '2026-11-16T13:00:00Z' },   // pause over
    { owner_key: 'MDJBNVGzwJ', key: 'limits_half_until', value: '2026-11-30T13:00:00Z' },
    { owner_key: 'rQMCgf1vcv', key: 'limits_pause_until', value: '2026-11-20T13:00:00Z' },   // still paused
    { owner_key: 'UcDdaOGx4b', key: 'preanalysis_suggestions', value: '{"status":"off"}' }
  ],
  icpRules: [{ owner_key: 'xTVW0K1qKi' }, { owner_key: 'MDJBNVGzwJ' }]
};
rows.sources.push({ owner_key: 'rQMCgf1vcv', category: 'competitor' });

const { accounts, totals, hidden_tests } = build(rows, NOW);
const by = Object.fromEntries(accounts.map(a => [a.owner_key, a]));

// Gershon: healthy, counts right, client name wins over display_name
assert.equal(by.xTVW0K1qKi.name, 'Gershon Consulting');
assert.equal(by.xTVW0K1qKi.status, 'healthy');
assert.equal(by.xTVW0K1qKi.prospects, 2);
assert.equal(by.xTVW0K1qKi.last_7_days, 1);
assert.equal(by.xTVW0K1qKi.icp_pct, 50);
assert.equal(by.xTVW0K1qKi.botdog, 1);
assert.equal(by.xTVW0K1qKi.salesnav_listed, 1);
assert.deepEqual([by.xTVW0K1qKi.active_bridges, by.xTVW0K1qKi.bridges], [1, 2]);

// Enzymicals: pause ended -> judged on age (13 days) = stalled, half speed still shown
assert.equal(by.MDJBNVGzwJ.days_since, 13);
assert.equal(by.MDJBNVGzwJ.status, 'stalled');
assert.equal(by.MDJBNVGzwJ.paused_until, null);
assert.equal(by.MDJBNVGzwJ.half_speed_until, '2026-11-30T13:00:00Z');

// Meteor: pause in the future -> paused, even with no prospects
assert.equal(by.rQMCgf1vcv.status, 'paused');

// Amphasys: 5 days -> slowing; no ICP rules -> icp_pct null
assert.equal(by.mrb4bdd3pi.status, 'slowing');
assert.equal(by.mrb4bdd3pi.icp_pct, null);

// PhiTech: only a suggested source -> not started, suggestions flagged
assert.equal(by.UcDdaOGx4b.status, 'not_started');
assert.equal(by.UcDdaOGx4b.sources, 0);
assert.equal(by.UcDdaOGx4b.suggested_sources, 1);
assert.equal(by.UcDdaOGx4b.has_suggestions, true);

// Test account hidden from totals
assert.equal(hidden_tests, 1);
assert.equal(totals.accounts, 5);
assert.equal(totals.prospects, 4);
assert.equal(totals.producing_7d, 2);
assert.deepEqual(totals.by_status, { healthy: 1, slowing: 1, stalled: 1, paused: 1, not_started: 1 });

// Sorted by prospects desc
assert.equal(accounts[0].owner_key, 'xTVW0K1qKi');

// helpers
assert.equal(daysBetween('2026-11-15', NOW), 2);
assert.equal(statusOf({ sources: 3, days_since: null }, NOW), 'stalled');
assert.equal(truthyPush('2026-11-01T00:00:00Z'), true);
assert.equal(truthyPush(''), false);
assert.equal(truthyPush('false'), false);

console.log('admin-campaigns: all tests passed');
