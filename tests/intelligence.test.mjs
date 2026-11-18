// node tests/intelligence.test.mjs - checks the account summary the Intelligence AI reads
import assert from 'node:assert/strict';
import { summarize } from '../functions/api/intelligence.js';
const now = new Date('2026-11-17T12:00:00Z');
const s = summarize({
  sources: [{ name: 'Acme', priority: 'high', category: 'competitor', added_date: '2026-10-01', discovered: true }, { name: 'Empty Co' }],
  bridges: [{ name: 'Ann', source: 'Acme', active: true, health: 'productive' }, { name: 'Bob', source: 'Acme', active: false, health: 'filter_ignored', empty_runs: 4 }],
  targets: [
    { collected_date: '2026-11-16', grade: 'A', country: 'US', radar_person: 'Ann', botdog_pushed: true },
    { collected_date: '2026-11-01', grade: 'C', country: 'FR', radar_person: 'Ann' },
    { collected_date: '2026-09-30', grade: null, country: 'US', radar_person: 'Bob', selected: false }
  ],
  stats: [{ bridge: 'Ann', source: 'Acme', prospects: 2, icp: 1, hit_pct: 50, verdict: 'normal' }, { bridge: 'Bob', source: 'Acme', prospects: 1, icp: 0, hit_pct: 0, verdict: 'slow' }],
  activity: [{ action: 'sync_log' }, { action: 'sync_log' }], icp: 'CEOs in the US'
}, now);
assert.equal(s.totals.prospects, 3); assert.equal(s.totals.graded_prospects, 2); assert.equal(s.totals.icp_prospects_A_B, 1);
assert.equal(s.totals.icp_rate_of_graded, '50%'); assert.equal(s.totals.active_bridges, 1); assert.equal(s.totals.pushed_to_botdog, 1);
assert.equal(s.collection.new_last_7_days, 1); assert.equal(s.collection.new_last_30_days, 2); assert.equal(s.collection.new_previous_30_days, 1);
assert.equal(s.collection.last_collected_day, '2026-11-16');
assert.deepEqual(s.sources[0], { name: 'Acme', priority: 'high', category: 'competitor', added: '2026-10-01', discovered: true, bridges: 2, active: 1, prospects: 3, icp: 1 });
assert.equal(s.sources[1].bridges, 0);
assert.equal(s.unhealthy_bridges.length, 1); assert.equal(s.unhealthy_bridges[0].bridge, 'Bob');
assert.equal(s.slow_bridges[0].bridge, 'Bob'); assert.equal(s.activity_last_7_days.sync_log, 2); assert.equal(s.icp_definition, 'CEOs in the US');
assert.ok(JSON.stringify(s).length < 16000);
console.log('intelligence summary: all assertions passed');
