// =============================================================
// Radar - LinkedIn action limits (1.17.2)
//
// WHY THIS FILE EXISTS (2026-11-04). David Liese's and Amos Lee's LinkedIn accounts were locked.
// Both had "daily lead target = 10" in Radar, but nothing in the extension ever read that setting.
// The real limits were 120 search pages a day and 400 Sales API profile lookups PER RUN. One big
// bridge (Mark Pitman / Todd Harris, 625 connections each) was read 25 pages deep, ~400 profiles
// were looked up, the hourly gate stopped the run mid-bridge, the bridge was not marked done, and
// the next session started it again from page 1. Three times. ~1,000 lookups in 3 hours -> 401.
//
// What is limited now is what LinkedIn actually sees: search pages, profile lookups and list
// saves - per hour, per day and per week - plus a hard cap on NEW prospects per day. Every number
// comes from the account's Radar config (config table, keys below) with these defaults.
// A big bridge is read a few pages a day and resumes where it stopped the next day.
// =============================================================

const LIMIT_DEFAULTS = {
  prospects_per_day:    10,   // config: daily_lead_target (the existing setting, now enforced)
  lookups_per_day:      25,   // Sales API profile lookups + lead-page opens + bridge URL lookups
  lookups_per_hour:     8,
  pages_per_day:        20,   // Sales Nav search result pages (prospect search + bridge discovery)
  pages_per_hour:       5,
  pages_per_bridge_day: 3,    // = 75 people a day from one bridge, resumed the next day
  list_saves_per_day:   25,   // members filed into Sales Nav lists (prospects + bridges)
  week_multiplier:      5,    // weekly cap = 5 x daily; unused budget is never carried over
  warning_hold_hours:   48,   // full stop after any LinkedIn warning (401/403/429/check page)
  new_account_days:     14    // fresh installs run at half limits for this long
};
const LIMIT_CONFIG_KEYS = {
  prospects_per_day:    'daily_lead_target',
  lookups_per_day:      'limit_lookups_per_day',
  lookups_per_hour:     'limit_lookups_per_hour',
  pages_per_day:        'limit_pages_per_day',
  pages_per_hour:       'limit_pages_per_hour',
  pages_per_bridge_day: 'limit_pages_per_bridge_day',
  list_saves_per_day:   'limit_list_saves_per_day',
  week_multiplier:      'limit_week_multiplier',
  warning_hold_hours:   'limit_warning_hold_hours'
};
// Kinds of LinkedIn action we count, and which limits apply to each.
const LIMIT_KINDS = {
  pages:     { day: 'pages_per_day',      hour: 'pages_per_hour' },
  lookups:   { day: 'lookups_per_day',    hour: 'lookups_per_hour' },
  prospects: { day: 'prospects_per_day',  hour: null },
  listSaves: { day: 'list_saves_per_day', hour: null }
};
// Never scaled below these, never above these - a typo in config must not open the floodgates.
const LIMIT_CEILINGS = { prospects_per_day: 100, lookups_per_day: 150, lookups_per_hour: 30, pages_per_day: 80, pages_per_hour: 15, pages_per_bridge_day: 10, list_saves_per_day: 150, week_multiplier: 5, warning_hold_hours: 168 };
const HOUR_MS = 3600 * 1000;
const BRIDGE_REST_DAYS = 14;       // a fully-read bridge is re-read from page 1 after this

function _num(v) { const n = Number(v); return isFinite(n) && n >= 0 ? n : null; }
function _time(v) { const t = v ? new Date(v).getTime() : NaN; return isFinite(t) ? t : 0; }

// cfg = the account's getConfig object. firstRunAt = ISO of this install's first run (fresh
// installs only). Returns the limits to apply RIGHT NOW plus why.
function effectiveLimits(cfg, nowMs, firstRunAt) {
  cfg = cfg || {};
  const now = nowMs || Date.now();
  const base = {};
  for (const k in LIMIT_DEFAULTS) {
    const ck = LIMIT_CONFIG_KEYS[k];
    const v = ck ? _num(cfg[ck]) : null;
    base[k] = (v === null || v === 0 && k !== 'prospects_per_day') ? LIMIT_DEFAULTS[k] : v;
    if (LIMIT_CEILINGS[k] != null) base[k] = Math.min(base[k], LIMIT_CEILINGS[k]);
  }
  const pauseUntil = _time(cfg.limits_pause_until);
  const halfUntil  = _time(cfg.limits_half_until);
  const first      = _time(firstRunAt);
  let scale = 1, why = 'defaults';
  if (pauseUntil > now) return { limits: base, scale: 0, paused: true, pauseUntil: new Date(pauseUntil).toISOString(), why: 'paused by Radar until ' + new Date(pauseUntil).toISOString() };
  if (halfUntil > now) { scale = 0.5; why = 'half limits until ' + new Date(halfUntil).toISOString(); }
  else if (first && now - first < base.new_account_days * 86400000) { scale = 0.5; why = 'new install - half limits for ' + base.new_account_days + ' days'; }
  const lim = Object.assign({}, base);
  if (scale !== 1) {
    ['prospects_per_day', 'lookups_per_day', 'lookups_per_hour', 'pages_per_day', 'pages_per_hour', 'list_saves_per_day']
      .forEach(k => { lim[k] = Math.max(1, Math.floor(base[k] * scale)); });
    lim.pages_per_bridge_day = Math.max(1, Math.min(base.pages_per_bridge_day, Math.ceil(base.pages_per_bridge_day * scale)));
  }
  return { limits: lim, scale: scale, paused: false, pauseUntil: null, why: why };
}

function limitDayKey(d) { d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function limitWeekKey(d) {
  d = new Date((d || new Date()).getTime());
  const day = (d.getDay() + 6) % 7;                // Monday = 0
  d.setDate(d.getDate() - day);
  return 'W' + limitDayKey(d);
}
function emptyCounts() { return { pages: 0, lookups: 0, prospects: 0, listSaves: 0 }; }

// The ledger: what this browser has already done on LinkedIn, by day, week and last hour.
function freshLedger(st, nowMs) {
  const d = new Date(nowMs || Date.now());
  st = st && typeof st === 'object' ? st : {};
  const dk = limitDayKey(d), wk = limitWeekKey(d);
  if (st.day !== dk) { st.day = dk; st.dayCounts = emptyCounts(); }
  if (st.week !== wk) { st.week = wk; st.weekCounts = emptyCounts(); }
  st.dayCounts  = Object.assign(emptyCounts(), st.dayCounts || {});
  st.weekCounts = Object.assign(emptyCounts(), st.weekCounts || {});
  st.hour = st.hour || {};
  const cut = (nowMs || Date.now()) - HOUR_MS;
  ['pages', 'lookups'].forEach(k => { st.hour[k] = (Array.isArray(st.hour[k]) ? st.hour[k] : []).filter(t => t > cut); });
  return st;
}

// How many of `kind` may still be done right now, and when more frees up if none.
function limitRoom(st, lim, kind, nowMs) {
  const now = nowMs || Date.now();
  st = freshLedger(st, now);
  const K = LIMIT_KINDS[kind];
  const dayCap  = lim[K.day];
  const weekCap = dayCap * lim.week_multiplier;
  const dayLeft  = Math.max(0, dayCap - st.dayCounts[kind]);
  const weekLeft = Math.max(0, weekCap - st.weekCounts[kind]);
  let left = Math.min(dayLeft, weekLeft), reason = '', retryMs = 0;
  if (weekLeft <= 0) reason = kind + '_week_cap';
  else if (dayLeft <= 0) reason = kind + '_day_cap';
  if (K.hour && left > 0) {
    const used = st.hour[kind].length;
    const hourLeft = Math.max(0, lim[K.hour] - used);
    if (hourLeft <= 0) {
      reason = kind + '_hour_cap';
      const oldest = Math.min.apply(null, st.hour[kind]);
      retryMs = Math.max(60 * 1000, oldest + HOUR_MS - now);
    }
    left = Math.min(left, hourLeft);
  }
  return { left: left, reason: left > 0 ? '' : reason, retryMs: retryMs };
}

function limitSpend(st, kind, n, nowMs) {
  const now = nowMs || Date.now();
  st = freshLedger(st, now);
  n = Math.max(0, n || 0);
  st.dayCounts[kind] += n;
  st.weekCounts[kind] += n;
  if (LIMIT_KINDS[kind].hour) for (let i = 0; i < n; i++) st.hour[kind].push(now);
  return st;
}

// Per-bridge reading position, so a big bridge is read a few pages a day and resumed next day.
//   cursor = { next: <page to read next>, day: <local day>, pagesToday: n, restUntil: ISO|null }
function bridgeAllowance(cursor, lim, nowMs, maxPages) {
  const now = nowMs || Date.now();
  const c = Object.assign({ next: 1, day: '', pagesToday: 0, restUntil: null }, cursor || {});
  if (_time(c.restUntil) > now) return { start: c.next, pages: 0, reason: 'bridge_resting', cursor: c };
  if (c.restUntil) { c.restUntil = null; c.next = 1; }
  const dk = limitDayKey(new Date(now));
  if (c.day !== dk) { c.day = dk; c.pagesToday = 0; }
  const left = Math.max(0, lim.pages_per_bridge_day - c.pagesToday);
  const pages = Math.max(0, Math.min(left, (maxPages || 25) - c.next + 1));
  return { start: Math.max(1, c.next), pages: pages, reason: pages ? '' : 'bridge_day_cap', cursor: c };
}
// Call after each page read. `full` = the page came back with a full 25 results.
function bridgeAdvance(cursor, nowMs, full, maxPages) {
  const now = nowMs || Date.now();
  const c = Object.assign({ next: 1, day: limitDayKey(new Date(now)), pagesToday: 0, restUntil: null }, cursor || {});
  c.pagesToday += 1;
  c.next += 1;
  if (!full || c.next > (maxPages || 25)) {
    // Whole network read: rest the bridge, then start over from page 1 to catch new connections.
    c.next = 1;
    c.restUntil = new Date(now + BRIDGE_REST_DAYS * 86400000).toISOString();
  }
  return c;
}

// Split a page of results into: already-known people, new people we may take today, and new
// people over today's cap (kept locally and taken first tomorrow - no page is read twice for them).
function splitNewProspects(leads, known, room) {
  const seen = new Set();
  const out = { known: [], accepted: [], overflow: [] };
  for (const l of (leads || [])) {
    if (!l || !l.lead_id || seen.has(l.lead_id)) continue;
    seen.add(l.lead_id);
    if (known && known.has(l.lead_id)) out.known.push(l);
    else if (out.accepted.length < Math.max(0, room || 0)) out.accepted.push(l);
    else out.overflow.push(l);
  }
  return out;
}

// LinkedIn warning signals: any of these stops EVERYTHING for warning_hold_hours.
function isLinkedInWarningStatus(status) { return status === 401 || status === 403 || status === 429 || status === 999; }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LIMIT_DEFAULTS, LIMIT_CONFIG_KEYS, effectiveLimits, freshLedger, limitRoom, limitSpend, bridgeAllowance, bridgeAdvance, splitNewProspects, limitDayKey, limitWeekKey, isLinkedInWarningStatus, BRIDGE_REST_DAYS };
}
