// functions/_lib/admin-campaigns.js (2026-11-17, app v1.19.2)
// Pure aggregation for the /admin "All campaigns" master view - no network, so it is unit-tested
// (tests/admin-campaigns.test.mjs). functions/api/admin-campaigns.js fetches the rows and calls build().
//
// One "campaign" = one Radar account (owner_key). Status rules (Olivier's admin design, 2026-11-17):
//   not_started  no source yet (suggested OFF rows do not count)
//   paused       config limits_pause_until is in the future (LinkedIn safety pause)
//   healthy      last prospect collected 0-2 days ago
//   slowing      3-9 days ago
//   stalled      10+ days ago, or sources but never collected

// Display names for the client accounts (owner_key -> client). Fallback: users.display_name / email / key.
export const CLIENT_NAMES = {
  xTVW0K1qKi: 'Gershon Consulting',
  MDJBNVGzwJ: 'Enzymicals',
  rQMCgf1vcv: 'Meteor Biotech',
  mrb4bdd3pi: 'Amphasys',
  EWbwACtRbE: 'Flying Secoya',
  HhrpkVfuao: 'Altavia North America',
  oGSazFvHRu: 'Valos',
  UcDdaOGx4b: 'PhiTech Bioinformatics',
  cjzJZHqxQy: 'MAbSilico',
  bz3NkpOfOa: 'Urban Factory'
};
// Test accounts: counted but hidden by default.
export const TEST_ACCOUNTS = new Set(['zzTestPrio1', '4wJpHXCrXl']);

const DAY = 86400000;

export function truthyPush(v) {
  if (v == null || v === false) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== 'false' && s !== '0' && s !== 'no';
}

function dayStr(v) {
  if (!v) return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

export function daysBetween(fromDay, now) {
  if (!fromDay) return null;
  const a = Date.parse(fromDay + 'T00:00:00Z');
  const t = new Date(now);
  const b = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return Math.round((b - a) / DAY);
}

export function statusOf(acc, now) {
  if (!acc.sources) return 'not_started';
  if (acc.paused_until && Date.parse(acc.paused_until) > now) return 'paused';
  if (acc.days_since == null) return 'stalled';
  if (acc.days_since <= 2) return 'healthy';
  if (acc.days_since <= 9) return 'slowing';
  return 'stalled';
}

// rows = { users, sources, bridges, targets, config, icpRules }  (arrays of plain objects)
export function build(rows, now = Date.now()) {
  const map = new Map();
  const acc = (k) => {
    if (!k) return null;
    if (!map.has(k)) map.set(k, {
      owner_key: k, name: CLIENT_NAMES[k] || null, email: null, last_login_at: null, user_status: null,
      sources: 0, suggested_sources: 0, bridges: 0, active_bridges: 0,
      prospects: 0, last_7_days: 0, icp: 0, graded: 0, botdog: 0, salesnav_listed: 0,
      last_collected: null, days_since: null, icp_rules: false,
      paused_until: null, half_speed_until: null, has_suggestions: false,
      test: TEST_ACCOUNTS.has(k)
    });
    return map.get(k);
  };
  const since7 = new Date(now - 7 * DAY).toISOString().slice(0, 10);

  for (const u of rows.users || []) {
    const a = acc(u.owner_key); if (!a) continue;
    if (!a.name) a.name = u.display_name || null;
    a.email = u.email || null;
    a.last_login_at = u.last_login_at || null;
    a.user_status = u.status || null;
  }
  for (const s of rows.sources || []) {
    const a = acc(s.owner_key); if (!a) continue;
    if (String(s.category || '').toLowerCase() === 'suggested') a.suggested_sources++; else a.sources++;
  }
  for (const b of rows.bridges || []) {
    const a = acc(b.owner_key); if (!a) continue;
    a.bridges++; if (b.active === true || b.active === 'true') a.active_bridges++;
  }
  for (const t of rows.targets || []) {
    const a = acc(t.owner_key); if (!a) continue;
    a.prospects++;
    const d = dayStr(t.collected_date);
    if (d) {
      if (d >= since7) a.last_7_days++;
      if (!a.last_collected || d > a.last_collected) a.last_collected = d;
    }
    if (t.grade === 'A' || t.grade === 'B') a.icp++;
    if (t.grade && t.grade !== '?') a.graded++;
    if (truthyPush(t.botdog_pushed)) a.botdog++;
    if (t.salesnav_listed_at) a.salesnav_listed++;
  }
  for (const c of rows.config || []) {
    const a = acc(c.owner_key); if (!a) continue;
    if (c.key === 'limits_pause_until') a.paused_until = c.value || null;
    if (c.key === 'limits_half_until') a.half_speed_until = c.value || null;
    if (c.key === 'preanalysis_suggestions' && c.value) a.has_suggestions = true;
  }
  for (const r of rows.icpRules || []) { const a = acc(r.owner_key); if (a) a.icp_rules = true; }

  const accounts = [...map.values()].map(a => {
    a.days_since = daysBetween(a.last_collected, now);
    if (a.paused_until && Date.parse(a.paused_until) <= now) a.paused_until = null;      // pause over
    if (a.half_speed_until && Date.parse(a.half_speed_until) <= now) a.half_speed_until = null;
    a.icp_pct = a.icp_rules && a.prospects ? Math.round(100 * a.icp / a.prospects) : null;
    a.status = statusOf(a, now);
    if (!a.name) a.name = a.email || a.owner_key;
    return a;
  }).sort((x, y) => y.prospects - x.prospects || x.name.localeCompare(y.name));

  const shown = accounts.filter(a => !a.test);
  const sum = (k) => shown.reduce((n, a) => n + (a[k] || 0), 0);
  const count = (s) => shown.filter(a => a.status === s).length;
  const totals = {
    accounts: shown.length,
    prospects: sum('prospects'), last_7_days: sum('last_7_days'), icp: sum('icp'),
    active_bridges: sum('active_bridges'), bridges: sum('bridges'), botdog: sum('botdog'),
    producing_7d: shown.filter(a => a.last_7_days > 0).length,
    by_status: { healthy: count('healthy'), slowing: count('slowing'), stalled: count('stalled'),
                 paused: count('paused'), not_started: count('not_started') }
  };
  totals.icp_pct = totals.prospects ? Math.round(100 * totals.icp / totals.prospects) : 0;
  return { accounts, totals, hidden_tests: accounts.length - shown.length };
}
