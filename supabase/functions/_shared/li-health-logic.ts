/**
 * LinkedIn health — pure logic shared by the `li-health` edge function (Radar Supabase project).
 * Moves two Claude scheduled tasks into the app (2026-11-24, Olivier's rule: a recurring report is a
 * feature of the app, endpoint + cron in the app's own repo):
 *   #39 "LinkedIn daily signal check (401 auto-pause)"  -> mode "daily"
 *   #11 "LinkedIn Safety: weekly account grade"          -> mode "weekly"
 * No I/O here: every function takes plain data, so tests/li-health.test.mjs can run it with Node.
 */

export const H = 3600000;
export const TZ = 'America/New_York';

// Known long-term silent accounts (task #39): not news unless they START producing data.
export const KNOWN_SILENT = ['radar-uaZAWIvJMU', 'radar-bz3NkpOfOa'];
export const RUNBOOK_DAILY_CEILING = 80;

export type Refusal = { owner_key: string; http_status: string | null; n: number; first_ev: string | null; last_ev: string | null };
export type GateAccount = {
  account_key: string; label?: string | null; status: string; daily_cap: number | null; weekly_cap: number | null;
  restricted_until?: string | null; notes?: string | null; updated_at?: string | null;
};
export type GateVolume = { account_key: string; last_action: string | null; v24: number; v7d?: number; denies_24?: number; total_rows?: number };

/** owner_key in the Radar DB = gate account_key without 'radar-' (olivier-primary <-> xTVW0K1qKi). */
export function ownerKeyOf(accountKey: string): string {
  if (accountKey === 'olivier-primary') return 'xTVW0K1qKi';
  return accountKey.startsWith('radar-') ? accountKey.slice(6) : accountKey;
}
export function accountKeyOf(ownerKey: string): string {
  return ownerKey === 'xTVW0K1qKi' ? 'olivier-primary' : 'radar-' + ownerKey;
}
export const isTemplate = (k: string) => k.endsWith('-template');

// ---------- working hours (Mon-Fri, America/New_York) — same method as health-check v4 ----------
function tzOffsetMs(ms: number) {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
function etDay(ms: number) { const l = new Date(ms + tzOffsetMs(ms)); return { y: l.getUTCFullYear(), m: l.getUTCMonth(), d: l.getUTCDate(), wd: l.getUTCDay() }; }
function etMidnight(y: number, m: number, d: number) { const g = Date.UTC(y, m, d); let t = g - tzOffsetMs(g); t = g - tzOffsetMs(t); return t; }
export function workingHoursBetween(fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return 0;
  if (toMs - fromMs > 400 * 24 * H) return Infinity;
  let t = fromMs, ms = 0;
  while (t < toMs) { const e = etDay(t); const next = etMidnight(e.y, e.m, e.d + 1); const end = Math.min(next > t ? next : t + H, toMs); if (e.wd !== 0 && e.wd !== 6) ms += end - t; t = end; }
  return ms / H;
}
/** YYYY-MM-DD in New York (used in idempotency keys, check ids and subjects). */
export function nyDate(ms: number): string { const e = etDay(ms); return `${e.y}-${String(e.m + 1).padStart(2, '0')}-${String(e.d).padStart(2, '0')}`; }
export function monD(ms: number): string { return new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(new Date(ms)); }

// ---------- refusals ----------
export type StatusCounts = { n401: number; n429: number; n500: number; last401: string | null; last429: string | null; first401: string | null };
/** Fold the refusal rows (one per owner_key + http_status) into counts per owner. Null statuses are ignored. */
export function countsByOwner(rows: Refusal[]): Record<string, StatusCounts> {
  const out: Record<string, StatusCounts> = {};
  for (const r of rows || []) {
    const c = (out[r.owner_key] ||= { n401: 0, n429: 0, n500: 0, last401: null, last429: null, first401: null });
    const s = String(r.http_status ?? '');
    const n = Number(r.n) || 0;
    if (s === '401') { c.n401 += n; c.last401 = maxIso(c.last401, r.last_ev); c.first401 = minIso(c.first401, r.first_ev); }
    else if (s === '429') { c.n429 += n; c.last429 = maxIso(c.last429, r.last_ev); }
    else if (/^5\d\d$/.test(s)) c.n500 += n;
  }
  return out;
}
const maxIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : (a > b ? a : b));
const minIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : (a < b ? a : b));

// ---------- task #39: daily classification ----------
export type DailyInput = {
  nowMs: number;
  accounts: GateAccount[];
  volume: GateVolume[];
  refusals36h: Refusal[];
  refusals24h: Refusal[];
  refusals7d: Refusal[];
  lockOwners: string[];                       // owner_keys with a lock phrase in the 36h log
  silentAlerted: Record<string, string>;      // account_key -> last_action already alerted on
};
export type DailyAccount = {
  account_key: string; owner_key: string; label: string; status: string; daily_cap: number | null;
  v24: number; last_action: string | null;
  n401_36h: number; n401_7d: number; last401: string | null; first401: string | null;
  n429_24h: number; n429_7d: number; lock: boolean;
  silent: boolean; pause: boolean; alreadyPaused: boolean;
  reasons: string[];
};
/** Silent = gate open, non-zero daily cap, activity in the previous 7 days, nothing written for > 48 working hours. */
export function isSilent(a: GateAccount, lastAction: string | null, nowMs: number): boolean {
  if (a.status !== 'open' || !(Number(a.daily_cap) > 0) || !lastAction) return false;
  const l = new Date(lastAction).getTime();
  if (isNaN(l) || nowMs - l > 7 * 24 * H) return false;
  return workingHoursBetween(l, nowMs) > 48;
}
export function classifyDaily(inp: DailyInput) {
  const c36 = countsByOwner(inp.refusals36h), c24 = countsByOwner(inp.refusals24h), c7 = countsByOwner(inp.refusals7d);
  const vol: Record<string, GateVolume> = {};
  for (const v of inp.volume || []) vol[v.account_key] = v;
  const rows: DailyAccount[] = [];
  for (const a of inp.accounts || []) {
    if (isTemplate(a.account_key)) continue;
    const o = ownerKeyOf(a.account_key);
    const v = vol[a.account_key];
    const s36 = c36[o], s24 = c24[o], s7 = c7[o];
    const lastAction = v?.last_action ?? null;
    const lock = (inp.lockOwners || []).includes(o);
    const alreadyPaused = a.status === 'paused' || a.status === 'restricted';
    const n401 = s36?.n401 || 0;
    const known = KNOWN_SILENT.includes(a.account_key);
    let silent = isSilent(a, lastAction, inp.nowMs) && !known;
    // "newly" silent: alert once per silent episode (keyed on the last action seen).
    if (silent && inp.silentAlerted[a.account_key] && inp.silentAlerted[a.account_key] === String(lastAction)) silent = false;
    const r: DailyAccount = {
      account_key: a.account_key, owner_key: o, label: a.label || a.account_key, status: a.status, daily_cap: a.daily_cap,
      v24: Number(v?.v24) || 0, last_action: lastAction,
      n401_36h: n401, n401_7d: s7?.n401 || 0, last401: s36?.last401 || null, first401: s36?.first401 || null,
      n429_24h: s24?.n429 || 0, n429_7d: s7?.n429 || 0, lock,
      silent, pause: n401 > 0 && !alreadyPaused, alreadyPaused, reasons: [],
    };
    if (n401 > 0) r.reasons.push(`HTTP 401 ×${n401} in 36h`);
    if (lock) r.reasons.push('lock wording in the extension log');
    if (silent) r.reasons.push('silent for more than 48 working hours');
    if (r.n429_24h >= 10) r.reasons.push(`HTTP 429 ×${r.n429_24h} in 24h`);
    rows.push(r);
  }
  // Radar owners with a 401/lock but no gate key still count as something to report.
  const known = new Set(rows.map((r) => r.owner_key));
  for (const o of new Set([...Object.keys(c36), ...(inp.lockOwners || [])])) {
    if (known.has(o)) continue;
    const s36 = c36[o];
    const n401 = s36?.n401 || 0, lock = (inp.lockOwners || []).includes(o), n429 = c24[o]?.n429 || 0;
    if (!n401 && !lock && n429 < 10) continue;
    rows.push({ account_key: '(no gate key)', owner_key: o, label: o, status: 'no gate key', daily_cap: null, v24: 0, last_action: null,
      n401_36h: n401, n401_7d: c7[o]?.n401 || 0, last401: s36?.last401 || null, first401: s36?.first401 || null,
      n429_24h: n429, n429_7d: c7[o]?.n429 || 0, lock, silent: false, pause: false, alreadyPaused: false,
      reasons: [n401 ? `HTTP 401 ×${n401} in 36h` : '', lock ? 'lock wording' : '', n429 >= 10 ? `HTTP 429 ×${n429} in 24h` : ''].filter(Boolean) });
  }
  const attention = rows.filter((r) => r.reasons.length > 0);
  return { rows, attention, toPause: rows.filter((r) => r.pause), checked: rows.filter((r) => r.account_key !== '(no gate key)').length };
}
export function pauseNote39(dateIso: string, tsUtc: string, n36: number, n7: number): string {
  return ` | ${dateIso} auto-paused by the daily LinkedIn signal check (task #39): HTTP 401 from LinkedIn at ${tsUtc}, ${n36} in the last 36h and ${n7} in 7d. Do not reopen until the user confirms the account is clear AND the extension stops logging 401s; reopen BELOW the previous ceiling.`;
}
export function pauseNote11(dateIso: string, tsUtc: string, n7: number): string {
  return ` | ${dateIso} auto-paused by the LinkedIn Safety check: HTTP 401 from LinkedIn at ${tsUtc} (${n7} in 7d). Do not reopen until the user confirms the account is clear AND the extension stops logging 401s; reopen below the previous ceiling.`;
}

// ---------- task #11: grading ----------
export type GradeInput = {
  status: string;               // gate status
  n401_7d: number; lock: boolean; n429_7d: number;
  v24: number | null; v7d: number | null; daily_cap: number | null; weekly_cap: number | null;
  deniesCounted: number;        // pacing / cap / other denies in 7d (everything except outside_window)
  deniesOutsideWindow: number;
  extVersion: string | null; latestExt: string | null;
  signedOut: boolean;
  staleData: boolean;           // data older than 72h on an account active the week before
  noTelemetry: boolean;         // zero ledger rows in 7d
};
export type Grade = { score: number | null; letter: string; penalties: string[]; unverifiedVolume: boolean };
export function cmpVersion(a: string, b: string): number {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0), pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
export function letterFor(score: number | null): string {
  if (score == null) return '?';
  return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 50 ? 'D' : 'F';
}
export const GRADE_COLOURS: Record<string, { fg: string; bg: string }> = {
  A: { fg: '#0b6b3a', bg: '#e3f5ea' }, B: { fg: '#0b6b3a', bg: '#e3f5ea' }, C: { fg: '#8a5a00', bg: '#fff4d6' },
  D: { fg: '#b04a00', bg: '#ffe6d5' }, F: { fg: '#b42318', bg: '#fde4e1' }, '?': { fg: '#4a5560', bg: '#eceff2' },
};
/** Task #11 scoring formula, verbatim: start at 100 and subtract; caps for restricted (30) and paused (60). */
export function gradeAccount(g: GradeInput): Grade {
  const p: string[] = [];
  let s = 100;
  const sub = (n: number, why: string) => { if (n > 0) { s -= n; p.push(`−${n} ${why}`); } };
  if (g.n401_7d > 0) sub(60, `HTTP 401 ×${g.n401_7d} in 7 days`);
  if (g.lock) sub(60, 'lock wording in the log');
  if (g.n429_7d > 0) sub(Math.min(30, 2 * g.n429_7d), `HTTP 429 ×${g.n429_7d} in 7 days`);
  if (!g.noTelemetry && g.v7d != null && Number(g.weekly_cap) > 0) {
    const r = g.v7d / Number(g.weekly_cap);
    if (r > 1) sub(35, `weekly usage ${Math.round(r * 100)}% of cap`);
    else if (r >= 0.8) sub(20, `weekly usage ${Math.round(r * 100)}% of cap`);
    else if (r >= 0.6) sub(8, `weekly usage ${Math.round(r * 100)}% of cap`);
  }
  if (!g.noTelemetry && g.v24 != null && Number(g.daily_cap) > 0 && g.v24 / Number(g.daily_cap) >= 0.8) sub(10, 'last 24h at 80%+ of daily cap');
  sub(Math.min(15, 3 * (g.deniesCounted || 0)), `${g.deniesCounted} blocked by the safety gate`);
  sub(Math.min(5, 1 * (g.deniesOutsideWindow || 0)), `${g.deniesOutsideWindow} outside the time window`);
  if (g.extVersion && g.latestExt && cmpVersion(g.extVersion, g.latestExt) < 0) sub(10, `extension ${g.extVersion} older than ${g.latestExt}`);
  if (g.signedOut) sub(25, 'browser not signed in to LinkedIn');
  if (Number(g.daily_cap) > RUNBOOK_DAILY_CEILING) sub(15, `daily cap ${g.daily_cap} above the runbook ceiling of ${RUNBOOK_DAILY_CEILING}`);
  if (g.staleData) sub(5, 'data older than 72h');
  if (g.status === 'restricted' && s > 30) { s = 30; p.push('capped at 30: gate status restricted'); }
  if (g.status === 'paused' && s > 60) { s = 60; p.push('capped at 60: gate status paused (a decision is owed)'); }
  s = Math.max(0, s);
  if (g.noTelemetry) {
    if (p.length === 0) return { score: null, letter: '?', penalties: ['no telemetry in 7 days'], unverifiedVolume: true };
    return { score: s, letter: letterFor(s), penalties: [...p, 'unverified volume'], unverifiedVolume: true };
  }
  return { score: s, letter: letterFor(s), penalties: p, unverifiedVolume: false };
}
/** Estate = average of scored accounts, capped: any F -> at most C (79); two or more F -> at most D (69). */
export function estateGrade(scores: (number | null)[]): { score: number | null; letter: string } {
  const sc = scores.filter((x): x is number => typeof x === 'number');
  if (!sc.length) return { score: null, letter: '?' };
  let avg = Math.round(sc.reduce((a, b) => a + b, 0) / sc.length);
  const f = sc.filter((x) => x < 50).length;
  if (f >= 2) avg = Math.min(avg, 69); else if (f === 1) avg = Math.min(avg, 79);
  return { score: avg, letter: letterFor(avg) };
}
export function trendOf(prev: { letter: string; score: number | null } | null, cur: { score: number | null }): string {
  if (!prev) return 'new';
  if (prev.score == null || cur.score == null) return `= (last week ${prev.letter})`;
  const arrow = cur.score > prev.score ? '▲' : cur.score < prev.score ? '▼' : '=';
  return `${arrow} (last week ${prev.letter} ${prev.score})`;
}
/** Task #11 status rule (the LinkedIn signal outranks the gate). */
export function statusFor(x: { gateReachable: boolean; n401_7d: number; gateStatus: string; lock: boolean; deniesCounted: number; v24: number | null; v7d: number | null; daily_cap: number | null; weekly_cap: number | null; n429_7d: number }): string {
  if (!x.gateReachable) return 'Check failed';
  if (x.n401_7d > 0 || x.gateStatus === 'restricted' || x.lock) return 'Restricted';
  const dc = Number(x.daily_cap), wc = Number(x.weekly_cap);
  if (x.gateStatus === 'paused' || x.deniesCounted > 0 || (x.v24 != null && dc > 0 && x.v24 >= 0.8 * dc) || (x.v7d != null && wc > 0 && x.v7d >= 0.8 * wc) || x.n429_7d >= 10) return 'Degraded';
  return 'OK';
}
/** Subject prefix for #11: 🔴 any red warning, else 🟠 any orange, else ✅. */
export function subjectMark(warnings: { level: 'red' | 'orange' }[]): string {
  return warnings.some((w) => w.level === 'red') ? '🔴' : warnings.some((w) => w.level === 'orange') ? '🟠' : '✅';
}

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
