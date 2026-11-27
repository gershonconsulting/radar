// Radar — daily-report edge function (v10.1)
// ONE email per day, per user, describing YESTERDAY (America/New_York day).
// Triggered by pg_cron: POST { secret } (or GET ?secret=). verify_jwt=false.
// Optional overrides for testing: ?date=YYYY-MM-DD (the ET day to report on), ?to=email, ?dry=1
// Full version history (v4..v9.5) is in the git history of the repo copy (supabase/functions/daily-report/index.ts, e.g. commit 5c74b9c).
// v10 (2026-11-26) — Olivier: "Daily I need a report from radar about: the number of invitations
//  sent to bridges for connection, new prospects collected and anything that was done during the
//  chrome extension work." New SQL fn radar_ext_activity(owner,start,end) reads the extension's own
//  run log (de-duplicated on ts+msg+bridge) and the email gains: a "Bridge invitations" section
//  (sent, to whom, from which source, failed + why, accepted, still waiting, invites ON/OFF), a
//  "What the Chrome extension did" section (runs, pages read, bridges read, prospects found/saved,
//  URLs resolved, Sales Nav list filings, discovery, gate holds, errors), invites per account in the
//  "All accounts" table, and the invite count in the subject line.
// v10.1 (2026-11-27) — live v10 (deployed 11-27 00:03 UTC from a chat) + the repo's v9.5 dead-bridge
//  calibration (PR #57): the all-time `bridges_never_scraped` count is a standing backlog, so it no longer
//  turns the verdict amber or adds "needs attention" to the subject; it stays listed (no cross) under
//  "Needs attention" as a standing item. HTTP 429 / 401 in the day's log still turn it amber and are named
//  in the subject. Every v10 feature (bridge invitations, extension activity, invite count) is unchanged.
import { sendResend } from '../_shared/resend.ts';

const REPORT_VERSION = 'v10.1';
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Auth secret comes from the Supabase function secret DAILY_REPORT_CRON_SECRET (same naming as
// li-health's LI_HEALTH_CRON_SECRET). Read per request; if it is unset every request is refused (fail closed).
const CRON_SECRET_ENV = 'DAILY_REPORT_CRON_SECRET';
const GLOBAL_OWNER_KEY = 'xTVW0K1qKi';
const TZ = 'America/New_York';
const APP_URL = 'https://radar.gershoncrm.com/app.html';
const FALLBACK_LATEST_EXT = '1.7.3';   // also "the first build that reports its version" (extVerdict)
const SITE_HEALTH_URL = 'https://radar.gershoncrm.com/api/health';   // { latest_ext } = the build the site serves
const SENT_KEY = 'daily_report_sent_for';
const FROM = 'GC Radar <radar@gershon.ai>';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const enc = encodeURIComponent;
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function sb(path: string, opts: { method?: string; body?: unknown; prefer?: string } = {}): Promise<any> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`sb ${res.status} ${path}: ${txt.slice(0, 200)}`);
  try { return txt ? JSON.parse(txt) : null; } catch { return txt; }
}

/* ---------- timezone helpers (report on the user's ET day, not a UTC day) ---------- */
function etYmd(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function tzOffsetMs(d: Date): number {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asUTC - d.getTime();
}
function etMidnightUtc(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  return new Date(guess.getTime() - tzOffsetMs(guess));
}
function longDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
}
function shortDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
}
// v9.4: the extension's automatic schedule is Mon-Fri (sync-core.js WORK_DAYS). True for Sat/Sun.
export function isWeekend(ymd: string): boolean {
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return wd === 0 || wd === 6;
}
// The ET day before `ymd`.
function prevYmd(ymd: string): string {
  return etYmd(new Date(etMidnightUtc(ymd).getTime() - 12 * 3600 * 1000));
}
// "Fri 10-23"
function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  return `${wd} ${ymd.slice(5)}`;
}
function agoText(iso: string | null): string {
  if (!iso) return 'never';
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (!isFinite(h)) return 'never';
  if (h < 1) return 'less than an hour ago';
  if (h < 36) return `${Math.round(h)} hours ago`;
  return `${Math.floor(h / 24)} days ago`;
}
function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function cmpVer(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// v9.2 (b): the published extension = the highest valid x.y.z among the sources we have.
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
export function publishedExtVersion(...candidates: Array<string | null | undefined>): string {
  let best: string | null = null;
  for (const c of candidates) {
    const v = String(c ?? '').trim().replace(/^v/i, '');
    if (!SEMVER_RE.test(v)) continue;
    if (best === null || cmpVer(v, best) > 0) best = v;
  }
  return best || FALLBACK_LATEST_EXT;
}
async function siteLatestExt(): Promise<string | null> {
  try {
    const r = await fetch(SITE_HEALTH_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j.latest_ext === 'string' ? j.latest_ext : null;
  } catch (_e) {
    return null;   // site unreachable: fall back to config
  }
}

// v9.2 (a): the extension's daily cap on NEW prospects (salesnav-radar-extension/limits.js):
// config daily_lead_target (default 10, ceiling 100), halved while limits_half_until is in the future,
// 0 while limits_pause_until is. Returns null when it cannot tell.
export function dailyCap(cfg: Record<string, string>, at: Date): number | null {
  const raw = cfg.daily_lead_target;
  const n = raw === undefined || raw === null || String(raw).trim() === '' ? 10 : Number(raw);
  if (!isFinite(n) || n < 0) return null;
  let cap = Math.min(Math.floor(n), 100);
  const t = (k: string) => { const v = cfg[k] ? new Date(cfg[k]).getTime() : NaN; return isFinite(v) ? v : 0; };
  if (t('limits_pause_until') > at.getTime()) return 0;
  if (t('limits_half_until') > at.getTime()) cap = Math.max(1, Math.floor(cap * 0.5));
  return cap;
}
const CAP_SINCE_EXT = '1.17.2';
export function capReached(newTargets: number, cap: number | null): boolean {
  return cap !== null && cap > 0 && newTargets >= cap;
}

/* ---------- data ---------- */
async function stats(ownerKey: string, start: Date, end: Date): Promise<any> {
  const rows = await sb('rpc/radar_daily_stats', { method: 'POST', body: { p_owner: ownerKey, p_start: start.toISOString(), p_end: end.toISOString() } });
  return rows || {};
}
// v8: what "New prospects" is compared against. The day before only counts if Radar actually
// ran that day (a run was recorded, or prospects landed). Otherwise walk back to the last day
// that ran; after LOOKBACK_DAYS with no run, fall back to the 7-day average.
const LOOKBACK_DAYS = 7;
type PrevRef = { ymd: string; n: number; gap: number; workGap?: number } | null;   // gap = days without a run in between; workGap = of those, weekdays
async function extActivity(ownerKey: string, start: Date, end: Date): Promise<any> {
  try {
    const r = await sb('rpc/radar_ext_activity', { method: 'POST', body: { p_owner: ownerKey, p_start: start.toISOString(), p_end: end.toISOString() } });
    return (Array.isArray(r) ? r[0] : r) || {};
  } catch (_e) { return {}; }
}
function dayRan(ps: any): boolean {
  return (+ps?.runs || 0) > 0 || (+ps?.new_targets || 0) > 0;
}
async function lastRunDay(ownerKey: string, dayYmd: string, statsFn = stats): Promise<PrevRef> {
  let ymd = dayYmd;
  let workGap = 0;
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const p = prevYmd(ymd);
    const ps = await statsFn(ownerKey, etMidnightUtc(p), etMidnightUtc(ymd));
    if (dayRan(ps)) return { ymd: p, n: +ps.new_targets || 0, gap: i, workGap };
    if (!isWeekend(p)) workGap++;
    ymd = p;
  }
  return null;
}
// Returns the card's sub-line for "New prospects".
export function prevDeltaHtml(cur: number, ref: PrevRef, avg7: number, weekendIdle = false): string {
  // v9.4: a weekend day with no run is the schedule - no red "-20 since Fri".
  if (weekendIdle) return `<span style="color:#94a3b8;">weekend &#8212; no run scheduled</span>`;
  if (!ref) return delta(cur, avg7, `7-day avg (no run in the ${LOOKBACK_DAYS} days before)`);
  if (ref.gap === 0) return delta(cur, ref.n, 'the day before');
  // v9.4: only weekdays count as "without a run" (Mon-Fri schedule); Monday vs Friday = last working day.
  const wg = ref.workGap ?? ref.gap;
  if (wg === 0) return delta(cur, ref.n, `${dayLabel(ref.ymd)} (last working day)`);
  return delta(cur, ref.n, `${dayLabel(ref.ymd)} — ${wg} working day${wg === 1 ? '' : 's'} without a run`, 'since');
}

// v9 (c): every owner that collects. Candidates = extension clients seen in the last 14 days,
// app users, and anyone who logged a run that day. An owner belongs to the fleet if it collected
// that day or in the 7 days before (so test/abandoned installs are not reported as "silent").
type OwnerDay = { owner_key: string; label: string; runs: number; newTargets: number; written: number; collected: boolean; invites?: number; invitesFailed?: number; act?: any };
function collectedOn(s: any): boolean {
  return (+s?.new_targets || 0) > 0 || (+s?.best_saved || 0) > 0;
}
async function fleetDay(start: Date, end: Date, names: Record<string, string>, primary: string, primaryStats: any, statsFn = stats): Promise<OwnerDay[]> {
  const keys = new Set<string>([primary]);
  try {
    const since = new Date(start.getTime() - 14 * 86400000).toISOString();
    const gc: Array<{ owner_key: string }> = await sb(`gate_clients?select=owner_key&seen_at=gte.${enc(since)}`);
    for (const r of gc) if (r.owner_key) keys.add(r.owner_key);
  } catch (_e) { /* best-effort */ }
  for (const k of Object.keys(names)) keys.add(k);
  // v10: accounts without a users row get the name from their latest LinkedIn login (not the raw owner key).
  try {
    const lg: Array<{ owner_key: string; name: string | null }> = await sb(`activity_log?select=owner_key,name:detail->>name&action=eq.login&order=at.desc&limit=1000`);
    for (const r of lg) if (r.owner_key && r.name && !names[r.owner_key]) names[r.owner_key] = r.name;
  } catch (_e) { /* best-effort */ }
  try {
    const ran: Array<{ owner_key: string }> = await sb(`activity_log?select=owner_key&action=eq.sync_log&at=gte.${enc(start.toISOString())}&at=lt.${enc(end.toISOString())}`);
    for (const r of ran) if (r.owner_key) keys.add(r.owner_key);
  } catch (_e) { /* best-effort */ }
  const out: OwnerDay[] = [];
  for (const k of keys) {
    let s: any;
    try { s = k === primary ? primaryStats : await statsFn(k, start, end); } catch (_e) { continue; }
    const n = +s.new_targets || 0;
    const before = Math.round((+s.avg7 || 0) * 7) - n;          // first-seen in the 7 days before
    const collected = collectedOn(s);
    const a = await extActivity(k, start, end);
    // v10: an account that only sent bridge invites that day still belongs in the table.
    if (k !== primary && !collected && before <= 0 && !(+a.invites_sent || 0)) continue;    // never collects: not part of the fleet
    out.push({ owner_key: k, label: names[k] || k, runs: +s.runs || 0, newTargets: n, written: +s.saved || 0, collected, invites: +a.invites_sent || 0, invitesFailed: +a.invites_failed || 0, act: a });
  }
  return out.sort((a, b) => (a.owner_key === primary ? -1 : b.owner_key === primary ? 1 : b.newTargets - a.newTargets || b.written - a.written));
}
function silentText(o: OwnerDay, weekend = false): string {
  return `${o.label} (${o.runs === 0 ? (weekend ? 'weekend — not scheduled' : 'did not run') : `ran ${o.runs}×, saved 0`})`;
}

// v9 (b): HTTP 429 (rate limited) / 401 (signed out) entries in the owner's log for the day.
const HTTP_RE = { '429': /(status\W{0,4}|HTTP\s?)429\b/i, '401': /(status\W{0,4}|HTTP\s?)401\b/i };
type HttpCounts = { c429: number; c401: number };
function httpFromProblems(problems: string[]): HttpCounts {
  return { c429: problems.filter(p => HTTP_RE['429'].test(p)).length, c401: problems.filter(p => HTTP_RE['401'].test(p)).length };
}
async function httpErrors(ownerKey: string, start: Date, end: Date, problems: string[]): Promise<HttpCounts> {
  try {
    const rows: Array<{ log: any[] }> = await sb(`activity_log?select=log:detail->log&owner_key=eq.${enc(ownerKey)}&action=eq.sync_log&at=gte.${enc(start.toISOString())}&at=lt.${enc(end.toISOString())}`);
    const out = { c429: 0, c401: 0 };
    for (const r of rows) for (const e of (Array.isArray(r.log) ? r.log : [])) {
      if (e?.level !== 'error' && e?.level !== 'warn') continue;
      const t = JSON.stringify(e);
      if (HTTP_RE['429'].test(t)) out.c429++;
      if (HTTP_RE['401'].test(t)) out.c401++;
    }
    return out;
  } catch (_e) {
    return httpFromProblems(problems);   // distinct log lines - a lower bound
  }
}
// v9.5: only things that HAPPENED on the reported day. The all-time dead-bridge count is a standing
// backlog (see deadBridgesNote) and no longer turns the verdict amber.
function healthIssues(_s: any, http: HttpCounts): string[] {
  const out: string[] = [];
  if (http.c429 > 0) out.push(`HTTP 429 (rate limited by LinkedIn) logged ${http.c429}×`);
  if (http.c401 > 0) out.push(`HTTP 401 (signed out / not authorised) logged ${http.c401}×`);
  return out;
}

async function configMap(ownerKey: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const rows: Array<{ owner_key: string; key: string; value: string }> =
      await sb(`config?select=owner_key,key,value&or=(owner_key.eq.${enc(ownerKey)},owner_key.eq.${enc(GLOBAL_OWNER_KEY)})`);
    for (const r of rows) if (r.owner_key === GLOBAL_OWNER_KEY && !(r.key in out)) out[r.key] = r.value;
    for (const r of rows) if (r.owner_key === ownerKey) out[r.key] = r.value;
  } catch (_e) { /* config is best-effort */ }
  return out;
}

/* ---------- send-once guard (v4) ---------- */
async function lastSentDay(ownerKey: string): Promise<string | null> {
  try {
    const rows: Array<{ value: string }> =
      await sb(`config?owner_key=eq.${enc(ownerKey)}&key=eq.${enc(SENT_KEY)}&select=value&limit=1`);
    return rows.length && rows[0].value ? String(rows[0].value).trim() : null;
  } catch (_e) {
    return null;
  }
}
async function markSentDay(ownerKey: string, dayYmd: string): Promise<void> {
  try {
    await sb('config', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: [{ owner_key: ownerKey, key: SENT_KEY, value: dayYmd, updated_at: new Date().toISOString() }],
    });
  } catch (_e) { /* best-effort */ }
}

async function loadResendKey(cfg: Record<string, string>): Promise<string | null> {
  const envKey = Deno.env.get('RESEND_API_KEY');
  if (envKey) return envKey;
  if (cfg.resend_api_key) return cfg.resend_api_key;
  try {
    const any: Array<{ value: string }> = await sb(`config?key=eq.resend_api_key&select=value&limit=1`);
    if (any.length && any[0].value) return any[0].value;
  } catch (_e) { /* ignore */ }
  return null;
}
async function loadRecipients(): Promise<Array<{ owner_key: string; email: string; display_name: string | null }>> {
  const select = 'owner_key,email,display_name,is_admin,status';
  let rows: any[] = await sb(`users?select=${enc(select)}&email=not.is.null&or=(status.eq.active,is_admin.eq.true)`);
  let list = rows.filter(r => r.email && String(r.email).trim());
  if (!list.length) {
    rows = await sb(`users?select=${enc(select)}&email=not.is.null&is_admin=eq.true`);
    list = rows.filter(r => r.email && String(r.email).trim());
  }
  return list.map(r => ({ owner_key: r.owner_key, email: String(r.email).trim(), display_name: r.display_name ?? null }));
}

/* ---------- verdicts ---------- */
type Verdict = { level: 'critical' | 'warn' | 'ok'; title: string; body: string };

function jobVerdict(s: any, fleet: OwnerDay[] = [], issues: string[] = [], cap: number | null = null, weekend = false): Verdict {
  const v = jobVerdictBase(s, fleet, cap, weekend);
  if (v.title.startsWith('Weekend')) return v;   // v9.4: dead bridges still listed under "Needs attention"
  // v9 (b): never green while there are 429/401s in the log (v9.5: dead bridges no longer count).
  if (v.level === 'ok' && issues.length) {
    return { level: 'warn', title: v.title.replace('Radar did its job', 'Radar collected, but needs attention'), body: `${v.body} ${issues.map(i => `❌ ${i}.`).join(' ')}` };
  }
  return v;
}
function jobVerdictBase(s: any, fleet: OwnerDay[], cap: number | null = null, weekend = false): Verdict {
  // Judge the day on the BEST run, not the sum. A second, dead browser reporting 0/0 must never
  // turn a day the real browser worked into "COLLECTION FAILED".
  const runs = +s.runs || 0, done = +s.run_done || 0;
  const found = Math.max(+s.found || 0, +s.best_found || 0);
  const saved = Math.max(+s.saved || 0, +s.best_saved || 0);
  const newTargets = +s.new_targets || 0;
  const listed = +s.listed || 0;
  const problems: string[] = Array.isArray(s.problems) ? s.problems : [];
  const scrapeBroke = problems.some(p => /scrape:error|window\/tab unavailable|login|session/i.test(p));
  // If ANY browser collected yesterday, the day was not a scraper failure - whatever the other
  // browsers logged. This is the guard that was missing.
  const someoneCollected = (+s.best_saved || 0) > 0 || (+s.new_targets || 0) > 0;

  if (runs === 0) {
    // v9 (c): only "did not run" when NO owner collected. Other owners collecting means Radar ran;
    // this account's browser was the one that stayed silent.
    const others = fleet.filter(o => o.collected);
    if (others.length) {
      const n = others.reduce((a, o) => a + o.newTargets, 0);
      const w = others.reduce((a, o) => a + o.written, 0);
      const silent = fleet.filter(o => !o.collected);
      return {
        level: 'warn',
        title: `This account did not run yesterday — ${others.length} other account${others.length === 1 ? '' : 's'} collected`,
        body: `Radar itself worked: ${others.map(o => o.label).join(', ')} brought in ${n} new prospect${n === 1 ? '' : 's'} (${w} record(s) written). Silent yesterday: ${silent.map(o => silentText(o, weekend)).join(', ')}. For this account, open Chrome with the Radar extension; last run seen ${agoText(s.last_run_at)}.`,
      };
    }
    if (weekend) {
      // v9.4: Sat/Sun with no run anywhere = the extension's Mon-Fri schedule, not an outage.
      return { level: 'ok', title: 'Weekend — no collection scheduled', body: `Nothing to fix: the Radar extension collects automatically Monday to Friday, 08:30–19:00 local time, so no account ran yesterday. Last run seen: ${agoText(s.last_run_at)}. Collection resumes on Monday morning; if Monday's report shows no run, that one is real.` };
    }
    return { level: 'critical', title: 'Radar did NOT run yesterday', body: `No account collected anything and no collection run was recorded here. The Chrome extension is the only scheduler — this means Chrome was never opened, the extension is disabled or needs reloading, or it crashed before it could report in. Last run seen: ${agoText(s.last_run_at)}.` };
  }
  if (done === 0 && !someoneCollected) {
    return { level: 'critical', title: 'The daily run started but never finished', body: `${runs} run(s) began yesterday and none reached completion. The run is dying mid-way — check the extension log for the last step it reached.` };
  }
  if (found > 0 && saved === 0 && newTargets === 0) {
    return { level: 'critical', title: `Collected ${found} prospects but saved 0`, body: 'The scrape worked but the ingest into Radar is failing — every prospect found yesterday was thrown away. This is the "N found / 0 saved" failure mode; it needs a backend fix, not an extension reload.' };
  }
  if (found === 0 && saved === 0 && scrapeBroke && !someoneCollected) {
    return { level: 'critical', title: 'The run completed but collected nothing — the scraper failed', body: `Radar ran and reported "ok", but harvested 0 prospects and logged scraping errors. Usually the Sales Navigator session expired or the background scrape window could not open.${problems.length ? ' Logged: ' + problems.slice(0, 3).join('; ') + '.' : ''}` };
  }
  if (newTargets === 0 && saved === 0) {
    return { level: 'warn', title: 'Radar ran cleanly but found nothing new', body: 'No errors — the bridges scraped yesterday simply returned no new people. Normal if those bridges were already harvested; worth a look if it repeats several days running.' };
  }
  if (newTargets === 0 && saved > 0) {
    return { level: 'warn', title: 'Radar ran, but nobody new came out of it', body: `The extension wrote ${saved} record(s) — all of them people Radar already had. No one new to Radar yesterday.` };
  }
  // v9 (a): "new to Radar" and "records written" are different counts and are stated side by side,
  // never as "N of them" (a run that does not finish reports no written count, so new can exceed it).
  return {
    level: 'ok',
    title: `Radar did its job — ${newTargets} new prospect${newTargets === 1 ? '' : 's'}`,
    body: `${newTargets} prospect${newTargets === 1 ? '' : 's'} new to Radar (first seen yesterday), from ${runs} run(s).${capReached(newTargets, cap) ? ` That is the daily cap: the extension takes at most ${cap} new prospects a day (Radar setting "daily lead target"), so the same number several days running is expected.` : ''}${saved > 0 ? ` Separately, the extension reported ${saved} record(s) written in the ${done} run(s) that finished — that count includes people Radar already had.` : ''}${listed > 0 ? ` ${listed} were filed into your Sales Navigator list.` : ''}`,
  };
}

function extVerdict(s: any, latest: string): Verdict {
  const running = s.ext_version ? String(s.ext_version) : null;
  if (!running) {
    return { level: 'warn', title: `Chrome extension needs upgrading — move to v${latest}`, body: `The installed extension never reports its version, which means it is older than v${FALLBACK_LATEST_EXT} (the first build that does). Open chrome://extensions, load the latest Radar build and click Reload. Until then this report cannot confirm which version is collecting for you.` };
  }
  const d = cmpVer(running, latest);
  if (d < 0) {
    return { level: 'warn', title: `Old Chrome extension in place — v${running} installed, v${latest} available`, body: `Yesterday's collection ran on v${running}. Download the latest build from the Extension page in Radar, then reload it at chrome://extensions.` };
  }
  if (d > 0) {
    return { level: 'ok', title: `Chrome extension v${running} (ahead of the published v${latest})`, body: 'You are running a build newer than the one published in the app — remember to upload it so other users get it too.' };
  }
  return { level: 'ok', title: `Chrome extension up to date (v${running})`, body: '' };
}

// v5. Stale browsers running ALONGSIDE a current one - the failure mode no single-version
// warning could ever describe. (v6/v7/v8 rules: see repo copy.)
type VerRow = { version: string; runs: number; found: number; saved: number; listed: number; errors: number; last_run_at: string };
function browsersVerdict(s: any, latest: string): Verdict | null {
  const rows: VerRow[] = Array.isArray(s.by_version) ? s.by_version : [];
  if (rows.length < 2) return null;
  const isStale = (r: VerRow) => r.version === 'unreported' || cmpVer(r.version, latest) < 0;
  const stale = rows.filter(isStale);
  const good = rows.filter(r => !isStale(r));
  const vl = (r: VerRow) => `v${r.version === 'unreported' ? '?' : r.version}`;
  const savedOf = (r: VerRow) => +r.saved || 0;
  if (!stale.length) {
    return { level: 'ok', title: `${rows.length} browsers collecting, all on v${latest}`, body: rows.map(r => `v${r.version}: ${r.runs} run(s), ${r.saved} saved`).join(' · ') };
  }
  const dayProduced = (+s.new_targets || 0) > 0 || (+s.best_saved || 0) > 0;
  const collecting = rows.filter(r => savedOf(r) > 0).sort((a, b) => savedOf(b) - savedOf(a));
  const staleIdle = stale.filter(r => savedOf(r) === 0);
  const idleErrors = staleIdle.reduce((n, r) => n + (+r.errors || 0), 0);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const idleLine = staleIdle.length
    ? ` ${staleIdle.map(vl).join(', ')} ${staleIdle.length === 1 ? 'is' : 'are'} on an old build and saved 0${idleErrors ? `; ${idleErrors} of the log lines below come from ${staleIdle.length === 1 ? 'it' : 'them'}, not from your working setup` : ''}.`
    : '';

  if (collecting.length) {
    const w = collecting[0];
    const others = collecting.slice(1).map(r => `${vl(r)}${isStale(r) ? ' (old build)' : ''} also saved ${r.saved}`);
    const othersLine = others.length ? ` ${others.join('; ')}.` : '';
    if (!isStale(w)) {
      return {
        level: 'ok',
        title: `Collecting on ${vl(w)} — ${plural(stale.length, 'other browser')} on old builds`,
        body: `${vl(w)} saved ${w.saved} record(s) yesterday.${othersLine}${idleLine} Left alone deliberately — nothing to do here.`,
      };
    }
    const curIdle = good.filter(r => savedOf(r) === 0);
    return {
      level: 'warn',
      title: `Collecting on old build ${vl(w)} — v${latest} available`,
      body: `${vl(w)} saved ${w.saved} record(s) yesterday, so collection works, but on an old build.${othersLine}${curIdle.length ? ` ${curIdle.map(vl).join(', ')} ran too and saved 0.` : ''}${idleLine} Update the collecting browser from the Extension page in Radar, then reload it at chrome://extensions.`,
    };
  }

  if (good.length && dayProduced) {
    const w = good[0];
    return {
      level: 'ok',
      title: `Collecting on ${vl(w)} — ${plural(stale.length, 'other browser')} on old builds`,
      body: `${vl(w)} brought in the day's ${s.new_targets} new prospect(s) yesterday (no browser has reported its saved count yet).${idleLine} Left alone deliberately — nothing to do here.`,
    };
  }
  const deadWeight = stale.reduce((n, r) => n + (+r.errors || 0), 0);
  const staleDesc = stale.map(r => `${vl(r)} (${r.runs} run(s), ${r.saved} saved, ${r.errors} error(s))`).join(', ');
  return {
    level: 'critical',
    title: `${stale.length} outdated browser${stale.length === 1 ? '' : 's'} still running Radar`,
    body: `More than one Chrome is running the Radar extension on this account and ${stale.length === 1 ? 'one is' : 'some are'} out of date: ${staleDesc}. ${good.length ? `The current build (v${good[0].version}) saved ${good[0].saved} record(s).` : ''} The outdated browser${stale.length === 1 ? '' : 's'} contributed ${deadWeight} of the errors listed below and collected nothing — those errors describe THAT browser, not your account. Update it at chrome://extensions, or remove the extension from it so it stops reporting.`,
  };
}

/* ---------- html ---------- */
const C = {
  critical: { bg: '#fef2f2', border: '#fecaca', bar: '#b91c1c', text: '#7f1d1d', icon: '&#9888;&#65039;' },
  warn: { bg: '#fffbeb', border: '#fde68a', bar: '#b45309', text: '#78350f', icon: '&#9888;&#65039;' },
  ok: { bg: '#f0fdf4', border: '#bbf7d0', bar: '#15803d', text: '#14532d', icon: '&#10003;' },
};

function banner(v: Verdict, big = false): string {
  const c = C[v.level];
  const pad = big ? '18px 20px' : '13px 16px';
  const size = big ? '18px' : '15px';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;"><tr>
    <td style="background:${c.bg};border:1px solid ${c.border};border-left:5px solid ${c.bar};border-radius:10px;padding:${pad};">
      <div style="font-size:${size};font-weight:700;color:${c.bar};line-height:1.35;">${c.icon} ${esc(v.title)}</div>
      ${v.body ? `<div style="font-size:14px;color:${c.text};margin-top:7px;line-height:1.55;">${esc(v.body)}</div>` : ''}
    </td></tr></table>`;
}

function delta(cur: number, ref: number, refLabel: string, joiner = 'vs'): string {
  const round = Math.round((cur - ref) * 10) / 10;
  if (Math.abs(round) < 0.05) return `<span style="color:#94a3b8;">&#8212; same as ${esc(refLabel)}</span>`;
  const up = round > 0;
  return `<span style="color:${up ? '#16a34a' : '#dc2626'};font-weight:600;">${up ? '&#9650; +' : '&#9660; '}${round}</span> <span style="color:#94a3b8;">${esc(joiner)} ${esc(refLabel)}</span>`;
}

function card(label: string, value: string | number, sub: string): string {
  return `<td width="33%" style="padding:5px;" valign="top"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;"><tr><td style="padding:14px 10px;text-align:center;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-size:28px;font-weight:700;color:#0f172a;line-height:1;">${esc(value)}</div>
    <div style="font-size:12px;color:#64748b;margin-top:6px;">${esc(label)}</div>
    ${sub ? `<div style="font-size:11px;margin-top:5px;">${sub}</div>` : ''}
  </td></tr></table></td>`;
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:7px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#64748b;">${esc(label)}</td>
    <td style="padding:7px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0f172a;font-weight:600;text-align:right;">${value}</td></tr>`;
}

function sectionTitle(t: string): string {
  return `<div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin:22px 0 8px;font-weight:700;">${esc(t)}</div>`;
}

// v9.5: standing backlog line (no cross, does not affect the verdict or subject).
export function deadBridgesNote(s: any): string | null {
  const dead = +s.bridges_never_scraped || 0;
  if (dead <= 0) return null;
  return `Standing (not about yesterday): ${dead} active bridge${dead === 1 ? '' : 's'} ha${dead === 1 ? 's' : 've'} never produced a prospect — mostly bridges that are not 1st-degree connections yet (the extension skips them and queues an invite) or whose Sales Navigator search ignores the connection filter. Review or switch them off on the Bridges page.`;
}

// v10: in a multi-account email the invitations block covers EVERY account (each line says which).
export function mergeInvites(fleet: OwnerDay[], own: any): any {
  if (fleet.length < 2) return own;
  const acts = fleet.map(o => ({ o, a: o.act || {} }));
  const sum = (k: string) => acts.reduce((n, x) => n + (+x.a[k] || 0), 0);
  const on = acts.filter(x => String(x.a.invites_mode || '').toLowerCase() === 'on').map(x => x.o.label);
  const waiting = acts.filter(x => x.a.invites_waiting !== null && x.a.invites_waiting !== undefined);
  return {
    invites_sent: sum('invites_sent'), invites_failed: sum('invites_failed'), invites_accepted: sum('invites_accepted'),
    invites_waiting: waiting.length ? waiting.reduce((n, x) => n + (+x.a.invites_waiting || 0), 0) : null,
    not_connected: sum('not_connected'),
    mode_text: on.length ? on.join(', ') : 'no account',
    invites_sent_list: acts.flatMap(x => (x.a.invites_sent_list || []).map((i: any) => ({ bridge: i.bridge, source: [i.source, x.o.label].filter(Boolean).join(' · ') }))),
    invites_failed_list: acts.flatMap(x => (x.a.invites_failed_list || []).map((i: any) => ({ bridge: `${i.bridge} (${x.o.label})`, reason: i.reason }))),
  };
}
export function invitesSection(a: any): string {
  const sent: Array<{ bridge: string; source: string | null }> = Array.isArray(a?.invites_sent_list) ? a.invites_sent_list : [];
  const failed: Array<{ bridge: string; reason: string }> = Array.isArray(a?.invites_failed_list) ? a.invites_failed_list : [];
  const mode = a?.mode_text ? String(a.mode_text) : a?.invites_mode ? String(a.invites_mode).toUpperCase() : 'unknown';
  const li = (t: string) => `<li style="margin:3px 0;">${t}</li>`;
  return sectionTitle('Bridge invitations (connection requests)') +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>` +
    card('Invitations sent', +a?.invites_sent || 0, `<span style="color:#94a3b8;">to 2nd/3rd-degree bridges</span>`) +
    card('Accepted', +a?.invites_accepted || 0, `<span style="color:#94a3b8;">bridge became 1st-degree</span>`) +
    card('Still waiting', a?.invites_waiting ?? '—', `<span style="color:#94a3b8;">bridges not yet connected</span>`) +
    `</tr></table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
    row(a?.mode_text ? 'Invitations switched ON for' : 'Invitations switched', mode === 'ON' || a?.mode_text ? esc(mode) : `<span style="color:#b45309;">${esc(mode)}</span>`) +
    row('Bridges skipped (not 1st-degree yet)', String(a?.not_connected ?? '—')) +
    row('Invitations that failed', failed.length ? `<span style="color:#dc2626;">${+a.invites_failed || failed.length}</span>` : '0') +
    `</table>` +
    (sent.length ? `<div style="font-size:13px;color:#334155;margin:8px 0 0;"><b>Sent to:</b><ul style="margin:4px 0 0;padding-left:20px;line-height:1.5;">${sent.map(x => li(`${esc(x.bridge)}${x.source ? ` <span style="color:#94a3b8;">(${esc(x.source)})</span>` : ''}`)).join('')}</ul></div>` : '') +
    (failed.length ? `<div style="font-size:13px;color:#334155;margin:8px 0 0;"><b>Failed:</b><ul style="margin:4px 0 0;padding-left:20px;line-height:1.5;">${failed.map(x => li(`${esc(x.bridge)} <span style="color:#94a3b8;">— ${esc(x.reason)}</span>`)).join('')}</ul></div>` : '');
}
export function extSection(a: any): string {
  const ran = (+a?.runs_started || 0) + (+a?.runs_done || 0) > 0;
  if (!ran) return sectionTitle('What the Chrome extension did') + `<div style="font-size:14px;color:#94a3b8;">The extension logged no activity yesterday.</div>`;
  const t = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—';
  const held: string[] = Array.isArray(a.gate_held) ? a.gate_held.filter(Boolean) : [];
  return sectionTitle('What the Chrome extension did') +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
    row('Runs', `${+a.runs_done || 0} finished of ${+a.runs_started || 0} started <span style="font-weight:400;color:#94a3b8;">(${t(a.first_at)}–${t(a.last_at)} ET${a.version ? `, v${esc(a.version)}` : ''})</span>`) +
    row('Sales Navigator pages read', String(+a.pages_read || 0)) +
    row('Bridges read', `${+a.bridges_read || 0} <span style="font-weight:400;color:#94a3b8;">(${+a.bridges_with_leads || 0} returned prospects)</span>`) +
    row('Prospects found / saved', `${+a.found || 0} / ${+a.saved || 0}`) +
    row('Prospect LinkedIn URLs resolved', String(+a.urls_resolved || 0)) +
    row('Filed into the Sales Navigator list', String(+a.listed || 0)) +
    row('Bridge profile URLs resolved', String(+a.bridge_urls_resolved || 0)) +
    row('Sources searched for new bridges', `${+a.discover_sources || 0} <span style="font-weight:400;color:#94a3b8;">(${+a.discover_candidates || 0} candidates)</span>`) +
    row('Bridge invitations sent', String(+a.invites_sent || 0)) +
    (held.length ? row('Paused by the LinkedIn safety gate', `<span style="color:#b45309;">${esc(held.join(', '))}</span>`) : '') +
    (a.limits_why ? row('Limits in force', esc(a.limits_why)) : '') +
    row('Errors in the log', (+a.errors || 0) > 0 ? `<span style="color:#dc2626;">${+a.errors}</span>` : '0') +
    `</table>`;
}

function buildHtml(name: string, s: any, dayYmd: string, job: Verdict, ext: Verdict, browsers: Verdict | null, prevRef: PrevRef = null, fleet: OwnerDay[] = [], issues: string[] = [], primary = GLOBAL_OWNER_KEY, act: any = {}): string {
  const newTargets = +s.new_targets || 0;
  const avg7 = +s.avg7 || 0;
  const byBridge: Array<{ bridge: string; n: number }> = Array.isArray(s.by_bridge) ? s.by_bridge : [];
  const problems: string[] = Array.isArray(s.problems) ? s.problems : [];

  const attention: string[] = issues.map(i => `❌ ${i}.`);
  const silent = fleet.filter(o => !o.collected);
  const weekend = isWeekend(dayYmd);
  const weekendIdle = weekend && (+s.runs || 0) === 0 && !fleet.some(o => o.collected) && newTargets === 0;
  if (silent.length && fleet.some(o => o.collected)) attention.push(`Silent yesterday: ${silent.map(o => silentText(o, weekend)).join(', ')}.`);
  const deadNote = deadBridgesNote(s);
  if (deadNote) attention.push(deadNote);
  if (+s.total_no_url > 0) attention.push(`${s.total_no_url} of ${s.total_targets} prospects still have no public LinkedIn URL, so they cannot be pushed to Botdog.`);
  if (+s.bad_titles > 0) attention.push(`${s.bad_titles} prospect(s) collected yesterday have a corrupted job title ("Add … to selection") — the scraper is reading the checkbox label instead of the title.`);
  const verRows: VerRow[] = Array.isArray(s.by_version) ? s.by_version : [];
  if (verRows.length > 1) {
    attention.push(`${verRows.length} different browsers ran Radar yesterday (${verRows.map(r => `v${r.version}`).join(', ')}) — the log lines below are pooled across all of them.`);
  }
  for (const p of problems.slice(0, 6)) attention.push(`Extension log: ${p}`);

  const bridgeRows = byBridge.length
    ? byBridge.map(b => `<tr><td style="padding:6px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#334155;">${esc(b.bridge)}</td><td style="padding:6px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0f172a;font-weight:600;text-align:right;">${b.n}</td></tr>`).join('')
    : `<tr><td colspan="2" style="padding:10px 0;font-size:14px;color:#94a3b8;">No bridge produced a new prospect yesterday.</td></tr>`;

  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#12211d;">
  <tr><td style="background:#ffffff;border-top:4px solid #FE1B04;border-bottom:1px solid #e2e8f0;padding:20px 22px 16px;">
    <div style="color:#12211d;font-size:22px;font-weight:700;">Radar &#8212; Daily Report</div>
    <div style="color:#4a5a55;font-size:14px;margin-top:4px;">${esc(longDate(dayYmd))}</div>
  </td></tr>
  <tr><td style="padding:22px 22px 8px;">
    <div style="font-size:15px;color:#334155;margin:0 0 16px;">Hi ${esc(name || 'there')}, here is what Radar did yesterday.</div>
    ${banner(job, true)}
    ${banner(ext)}
    ${browsers ? banner(browsers) : ''}

    ${sectionTitle('Progress yesterday')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${card('New to Radar (first seen)', newTargets, prevDeltaHtml(newTargets, prevRef, avg7, weekendIdle))}
      ${card('7-day average', avg7, delta(newTargets, avg7, '7-day avg'))}
      ${card('Total collected', s.total_targets ?? 0, `<span style=\"color:#94a3b8;\">all time</span>`)}
    </tr></table>

    ${sectionTitle('The pipeline')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${row('New to Radar yesterday (first seen)', String(newTargets))}
      ${row('Records written by the extension', `${+s.saved || 0} <span style=\"font-weight:400;color:#94a3b8;\">(new + already known; ${+s.run_done || 0} of ${+s.runs || 0} runs finished and reported)</span>`)}
      ${row('… of those, with a usable LinkedIn URL', String(s.new_targets_with_url ?? 0))}
      ${row('Filed into the Sales Navigator list', String(s.salesnav_listed ?? 0))}
      ${row('Pushed to Botdog outreach', String(s.botdog_pushed ?? 0))}
      ${row('New bridges added', String(s.new_bridges ?? 0))}
      ${row('New sources added', String(s.new_sources ?? 0))}
      ${row('Running totals', `${s.total_sources ?? 0} sources &middot; ${s.total_bridges ?? 0} bridges &middot; ${s.total_targets ?? 0} prospects`)}
      ${row('Pushed to Botdog, all time', String(s.total_pushed ?? 0))}
      ${row('Last successful capture', `${esc(String(s.last_capture ?? '').slice(0, 10) || 'never')} <span style=\"font-weight:400;color:#94a3b8;\">(${esc(agoText(s.last_capture))})</span>`)}
    </table>

    ${(() => {
      const rows: VerRow[] = Array.isArray(s.by_version) ? s.by_version : [];
      if (rows.length < 2) return '';
      return sectionTitle('Browsers that ran') +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
        rows.map(r => row(`Extension v${r.version}`,
          `${r.saved} saved &middot; ${r.runs} run(s) &middot; <span style="color:${(+r.errors) > 0 ? '#dc2626' : '#94a3b8'};">${r.errors} error(s)</span>`)).join('') +
        `</table>`;
    })()}

    ${(() => {
      if (fleet.length < 2) return '';
      return sectionTitle('All accounts yesterday') +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
        fleet.map(o => row(`${o.label}${o.owner_key === primary ? ' (this account)' : ''}`,
          o.collected
            ? `${o.newTargets} new &middot; ${o.written} written &middot; ${o.invites || 0} invite(s) &middot; ${o.runs} run(s)`
            : o.runs === 0 && weekend
            ? `<span style="color:#94a3b8;">weekend &#8212; not scheduled</span>`
            : `<span style="color:#b45309;">silent &#8212; ${o.runs === 0 ? 'did not run' : `${o.runs} run(s), saved 0`}</span>${o.invites ? ` &middot; ${o.invites} invite(s)` : ''}`)).join('') +
        `</table>`;
    })()}

    ${invitesSection(mergeInvites(fleet, act))}
    ${extSection(act)}

    ${sectionTitle('Where yesterday’s prospects came from')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bridgeRows}</table>

    ${sectionTitle('Needs attention')}
    ${attention.length
      ? `<ul style=\"margin:6px 0 0;padding-left:20px;color:#334155;font-size:14px;line-height:1.6;\">${attention.map(a => `<li style=\"margin:5px 0;\">${esc(a)}</li>`).join('')}</ul>`
      : `<div style=\"color:#16a34a;font-size:14px;\">All clear &#8212; nothing needs attention.</div>`}

    <div style="text-align:center;margin:28px 4px 10px;">
      <a href="${APP_URL}" style="display:inline-block;background:#ffffff;color:#d11200;border:2px solid #FE1B04;text-decoration:none;font-size:15px;font-weight:700;padding:10px 26px;border-radius:9px;">Open Radar</a>
    </div>
  </td></tr>
  <tr><td style="padding:16px 24px 22px;border-top:1px solid #e2e8f0;">
    <div style="font-size:12px;color:#94a3b8;line-height:1.6;">Generated by Radar (daily-report ${REPORT_VERSION}) &#8212; radar.gershoncrm.com. Covers ${esc(longDate(dayYmd))}, midnight to midnight, New York time.<br/>Reply to <a href="mailto:support@gershonconsulting.com" style="color:#1f6f5c;text-decoration:underline;">support@gershonconsulting.com</a>.</div>
  </td></tr>
</table></td></tr></table></body></html>`;
}

async function sendEmail(key: string, to: string, subject: string, html: string): Promise<void> {
  // v9.3: retries 429/5xx/network 3x with one Idempotency-Key per email (../_shared/resend.ts).
  const r = await sendResend(key, { from: FROM, to: [to], reply_to: 'support@gershonconsulting.com', subject, html }, { label: 'radar-daily' });
  if (!r.ok) throw new Error(`resend ${r.status || 'network'} after ${r.attempts} attempt(s): ${(r.error || '').slice(0, 200)}`);
}

/* ---------- entry ---------- */
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);
  let provided: string | null = url.searchParams.get('secret');
  if (req.method === 'POST' && !provided) {
    try { provided = (await req.json())?.secret ?? null; } catch { provided = null; }
  }
  const expected = Deno.env.get(CRON_SECRET_ENV);
  if (!expected) return json({ ok: false, error: `not configured: set the ${CRON_SECRET_ENV} function secret` }, 503);
  if (!provided || provided !== expected) return json({ ok: false, error: 'unauthorized' }, 401);

  const dry = url.searchParams.get('dry') === '1';
  const force = url.searchParams.get('force') === '1';
  const toOverride = url.searchParams.get('to');
  const todayEt = etYmd(new Date());
  const dayYmd = url.searchParams.get('date') || etYmd(new Date(etMidnightUtc(todayEt).getTime() - 12 * 3600 * 1000));
  const start = etMidnightUtc(dayYmd);
  const nextYmd = etYmd(new Date(start.getTime() + 36 * 3600 * 1000));
  const end = etMidnightUtc(nextYmd);

  let recipients;
  try { recipients = await loadRecipients(); } catch (e) { return json({ ok: false, error: `load recipients: ${String(e)}` }, 200); }

  const sent: string[] = [];
  const skipped: Array<{ email: string; reason: string }> = [];
  const errors: Array<{ email: string; error: string }> = [];
  let preview: string | null = null;
  let previewSubject = '';
  const siteExt = await siteLatestExt();   // once per invocation

  for (const r of recipients) {
    try {
      if (!dry && !force) {
        const already = await lastSentDay(r.owner_key);
        if (already === dayYmd) {
          skipped.push({ email: r.email, reason: `already sent for ${dayYmd}` });
          continue;
        }
      }

      const cfg = await configMap(r.owner_key);
      const latestExt = publishedExtVersion(cfg.latest_ext_version, siteExt, FALLBACK_LATEST_EXT);
      const s = await stats(r.owner_key, start, end);
      // The cap exists from extension 1.17.2 on (limits.js); older builds collect without one.
      const cap = s.ext_version && cmpVer(String(s.ext_version), CAP_SINCE_EXT) >= 0 ? dailyCap(cfg, start) : null;
      const names: Record<string, string> = {};
      for (const u of recipients) if (u.owner_key) names[u.owner_key] = u.display_name || u.owner_key;
      const fleet = await fleetDay(start, end, names, r.owner_key, s);
      const problems: string[] = Array.isArray(s.problems) ? s.problems : [];
      const issues = healthIssues(s, await httpErrors(r.owner_key, start, end, problems));
      const weekend = isWeekend(dayYmd);
      const job = jobVerdict(s, fleet, issues, cap, weekend);
      const ext = extVerdict(s, latestExt);
      const browsers = browsersVerdict(s, latestExt);
      let prevRef: PrevRef = null;
      try { prevRef = await lastRunDay(r.owner_key, dayYmd); } catch (_e) { prevRef = null; /* falls back to the 7-day average */ }
      const act = await extActivity(r.owner_key, start, end);
      const html = buildHtml(r.display_name || '', s, dayYmd, job, ext, browsers, prevRef, fleet, issues, r.owner_key, act);

      const tag = (browsers && browsers.level === 'critical' && job.level !== 'critical')
        ? ' — ⚠️ OUTDATED BROWSER'
        : job.level === 'critical'
        ? ((+s.runs || 0) === 0 ? ' — ⚠️ DID NOT RUN' : ' — ⚠️ COLLECTION FAILED')
        : weekend && (+s.runs || 0) === 0 && !fleet.some(o => o.collected) && (+s.new_targets || 0) === 0
        ? ' — weekend, no run (by design)'
        : (+s.runs || 0) === 0 && fleet.some(o => o.collected)
        ? ` — this account did not run (other accounts +${fleet.reduce((a, o) => a + o.newTargets, 0)} new)`
        : ((+s.new_targets || 0) > 0 ? ` — +${s.new_targets} new prospects${capReached(+s.new_targets || 0, cap) ? ' (daily cap reached)' : ''}${issues.length ? ` · needs attention: ${issues[0]}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}` : ''}` : ' — no new prospects');
      const inv = fleet.length > 1 ? fleet.reduce((x, o) => x + (o.invites || 0), 0) : (+act.invites_sent || 0);
      const subject = `Radar Report — ${shortDate(dayYmd)}${tag}${inv ? ` · ${inv} bridge invite(s)` : ''}`;

      const to = toOverride || cfg.report_email || r.email;
      if (dry) { preview = html; previewSubject = subject; sent.push(`${to} (dry)`); continue; }

      const key = await loadResendKey(cfg);
      if (!key) { errors.push({ email: to, error: 'no resend key' }); continue; }
      await sendEmail(key, to, subject, html);
      sent.push(to);
      await markSentDay(r.owner_key, dayYmd);
    } catch (e) {
      errors.push({ email: r.email, error: String(e) });
    }
  }

  if (dry && preview) return new Response(preview, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'X-Report-Subject': encodeURIComponent(previewSubject) } });
  return json({ ok: true, day: dayYmd, window: [start.toISOString(), end.toISOString()], sent: sent.length, recipients: sent, skipped, errors });
});
