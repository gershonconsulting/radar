/**
 * li-health — the two LinkedIn safety reports, moved from Claude scheduled tasks into Radar (2026-11-24).
 *   runDaily  = task #39 "LinkedIn daily signal check (401 auto-pause)" — silent when nothing is found.
 *   runWeekly = task #11 "LinkedIn Safety: weekly account grade"        — one summary email every Monday.
 * The SQL below is the SQL of the two task prompts, unchanged (plus 24h / 7d variants of the same
 * refusal query where the prompt asks for those windows). I/O is injected (Deps) so tests run offline.
 *
 * Airtable: both tasks wrote to base appFhB17PkHQDqTlh (Accounts notes, Daily Health Check rows,
 * Incidents). No Airtable token exists in this project, so the app does NOT write Airtable; the
 * week-on-week grade trend that #11 read from Airtable is kept in public.config instead
 * (key li_safety_grade, owner_key = gate account_key; estate under owner_key '_estate').
 */
import {
  accountKeyOf, classifyDaily, cmpVersion, countsByOwner, estateGrade, esc, GRADE_COLOURS, gradeAccount, H, isTemplate,
  KNOWN_SILENT, monD, nyDate, ownerKeyOf, pauseNote11, pauseNote39, RUNBOOK_DAILY_CEILING, statusFor, subjectMark,
  trendOf, type GateAccount, type Refusal,
} from '../_shared/li-health-logic.ts';

export type Row = Record<string, any>;
export type Deps = {
  now: () => number;
  radar: (sql: string, params?: unknown[]) => Promise<Row[]>;   // Radar DB pkzeeqehwmtnqxdpdesl
  gate: ((sql: string, params?: unknown[]) => Promise<Row[]>) | null; // Gate DB zywlzopoxhkbblembkja (null = not configured)
  send: (payload: Record<string, unknown>, idempotencyKey: string) => Promise<{ ok: boolean; id?: string; error?: string }>;
  dry: boolean;                                                // dry = no email, no gate/config writes
};

export const TO = ['report@gershonconsulting.com'];
export const FROM_39 = 'LinkedIn Health <alerts@gershon.ai>';
export const FROM_11 = 'GC LinkedIn Safety <alerts@gershon.ai>';
export const AIRTABLE = 'https://airtable.com/appFhB17PkHQDqTlh';

// ---------------- SQL (verbatim from the task prompts) ----------------
const REFUSALS = (interval: string) => `select a.owner_key, (e->>'data')::jsonb->>'status' as http_status, count(*) as n, min(e->>'ts') as first_ev, max(e->>'ts') as last_ev
from activity_log a, lateral jsonb_array_elements(case when jsonb_typeof(a.detail->'log')='array' then a.detail->'log' else (a.detail->>'log')::jsonb end) e
where a.action='sync_log' and a.at > now()-interval '${interval}'
  and e->>'msg' in ('resolve:refused','scrape:failed','salesnav-list:chunk-failed') and (e->>'data') is not null
group by 1,2 order by 1,2;`;
export const SQL = {
  refusals36h: REFUSALS('36 hours'),
  refusals24h: REFUSALS('24 hours'),
  refusals7d: REFUSALS('7 days'),
  refusals10d: REFUSALS('10 days'),
  lock36h: `select owner_key, at, left(detail->>'log', 400) from activity_log where action='sync_log' and at > now()-interval '36 hours' and (detail->>'log') ~* '(999|checkpoint|restrict|unusual|verify|captcha|authwall|session expired|not authorized)' order by at desc limit 10;`,
  lock7d: `select owner_key, max(at) as at from activity_log where action='sync_log' and at > now()-interval '7 days' and (detail->>'log') ~* '(999|checkpoint|restrict|unusual|verify|captcha|authwall|session expired)' group by 1;`,
  gateAccounts39: `select account_key, label, status, daily_cap, weekly_cap from li_gate_accounts where account_key not like '%-template' order by account_key;`,
  gateVolume39: `select account_key, max(ts) as last_action, count(*) filter (where ts > now()-interval '24 hours') as v24, count(*) filter (where decision='deny' and ts > now()-interval '24 hours') as denies_24 from li_gate_ledger group by 1;`,
  gateClients: `select owner_key, ext_version, seen_at from gate_clients order by seen_at desc;`,
  loginOf: `select owner_key, at, detail->>'email' as email, detail->>'name' as name from activity_log where action='login' and owner_key=$1 order by at desc limit 1;`,
  pause: `update li_gate_accounts set status='paused', notes = coalesce(notes,'') || $2, updated_at = now() where account_key=$1 and status not in ('paused','restricted') returning account_key;`,
  // task #11
  gateAccounts11: `select account_key, label, status, restricted_until, daily_cap, weekly_cap, hourly_cap, notes, updated_at from li_gate_accounts order by account_key;`,
  gateVolume11: `select account_key, count(*) filter (where ts > now()-interval '24 hours') as v24, count(*) filter (where ts > now()-interval '7 days') as v7d, count(*) filter (where decision='deny' and ts > now()-interval '7 days') as denies_7d, max(ts) as last_action, count(*) as total_rows from li_gate_ledger group by account_key order by account_key;`,
  denyReasons: `select account_key, reason, count(*) as n, min(ts), max(ts) from li_gate_ledger where ts > now()-interval '7 days' and decision='deny' group by 1,2 order by 1,3 desc;`,
  identities: `select owner_key, at, detail->>'email' as email, detail->>'name' as name from activity_log where action='login' and at > now()-interval '60 days' order by owner_key, at desc;`,
  radarUsers30d: `select distinct owner_key from activity_log where action in ('login','sync_log') and at > now()-interval '30 days';`,
  loginCheck: `select distinct on (a.owner_key) a.owner_key, e->>'ts' as ts, (e->>'data')::jsonb->>'loggedIn' as logged_in from activity_log a, lateral jsonb_array_elements(case when jsonb_typeof(a.detail->'log')='array' then a.detail->'log' else (a.detail->>'log')::jsonb end) e where a.action='sync_log' and a.at > now()-interval '7 days' and e->>'msg'='login-check' and (e->>'data') is not null order by a.owner_key, e->>'ts' desc;`,
  configGet: `select owner_key, value from config where key=$1;`,
  configSet: `insert into config(owner_key, key, value, updated_at) values ($1,$2,$3,now()) on conflict (owner_key, key) do update set value=excluded.value, updated_at=now();`,
};

const num = (x: unknown) => (x == null ? 0 : Number(x) || 0);
const card = (inner: string) => `<!doctype html><html><body style="margin:0;background:#ffffff;" bgcolor="#ffffff"><table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#12211d;"><tr><td align="center" style="padding:20px 12px;"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;">${inner}</table></td></tr></table></body></html>`;

async function nameOf(d: Deps, owner: string, fallback: string) {
  try { const r = await d.radar(SQL.loginOf, [owner]); if (r[0]) return String(r[0].name || r[0].email || fallback); } catch (_) { /* keep fallback */ }
  return fallback;
}
async function configMap(d: Deps, key: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try { for (const r of await d.radar(SQL.configGet, [key])) out[r.owner_key] = String(r.value ?? ''); } catch (_) { /* empty */ }
  return out;
}

// ======================================================================
// task #39 — daily signal check
// ======================================================================
export async function runDaily(d: Deps) {
  const nowMs = d.now(), date = nyDate(nowMs);
  const unreachable: string[] = [];
  let r36: Refusal[] = [], r24: Refusal[] = [], r7: Refusal[] = [], lockRows: Row[] = [], gateRows: Row[] = [], volRows: Row[] = [];
  let radarOk = true;
  try {
    r36 = (await d.radar(SQL.refusals36h)) as Refusal[];
    r24 = (await d.radar(SQL.refusals24h)) as Refusal[];
    r7 = (await d.radar(SQL.refusals7d)) as Refusal[];
    lockRows = await d.radar(SQL.lock36h);
  } catch (e) { radarOk = false; unreachable.push(`Radar DB (pkzeeqehwmtnqxdpdesl): ${(e as Error).message}`); }
  try {
    if (!d.gate) throw new Error('GATE_DB_URL is not set');
    gateRows = await d.gate(SQL.gateAccounts39);
    volRows = await d.gate(SQL.gateVolume39);
  } catch (e) { unreachable.push(`LinkedIn Access Gate (zywlzopoxhkbblembkja): ${(e as Error).message}`); }

  const silentAlerted = await configMap(d, 'li_silent_alerted_last_action');
  const cls = classifyDaily({
    nowMs, accounts: gateRows as GateAccount[], volume: volRows as any, refusals36h: r36, refusals24h: r24, refusals7d: r7,
    lockOwners: [...new Set(lockRows.map((x) => String(x.owner_key)))], silentAlerted,
  });

  // auto-pause on 401 (never caps, never on 429 alone, never reopen)
  const paused: string[] = [];
  for (const a of cls.toPause) {
    const note = pauseNote39(date, a.last401 || 'unknown time', a.n401_36h, a.n401_7d);
    if (d.dry || !d.gate) { a.reasons.push(d.dry ? 'would be auto-paused (dry run)' : 'NOT paused: gate not reachable'); continue; }
    try { const r = await d.gate(SQL.pause, [a.account_key, note]); if (r.length) { paused.push(a.account_key); a.reasons.push('auto-paused now'); } }
    catch (e) { a.reasons.push('auto-pause FAILED: ' + (e as Error).message); unreachable.push(`pause of ${a.account_key} failed`); }
  }
  for (const a of cls.attention) a.label = await nameOf(d, a.owner_key, a.label);

  const somethingFound = cls.attention.length > 0 || unreachable.length > 0;
  const summary = `${cls.checked} accounts checked, no LinkedIn-side refusals, no new silent accounts`;
  if (!somethingFound) return { sent: false, quiet: true, summary, checked: cls.checked };

  // subject
  let subject: string;
  if (!radarOk) subject = `[39] LinkedIn daily check ${date}: Radar DB unreachable — no LinkedIn signal today`;
  else if (cls.attention.length === 1 && unreachable.length === 0) {
    const a = cls.attention[0];
    const what = a.n401_36h ? `HTTP 401 from LinkedIn${paused.includes(a.account_key) ? ', auto-paused' : a.alreadyPaused ? ' (already paused)' : ''}` : a.lock ? 'lock wording in the log' : a.silent ? 'silent for 48+ working hours' : `${a.n429_24h}× HTTP 429 in 24h`;
    subject = `[39] ${a.label} (${a.account_key}) — ${what}`;
  } else subject = `[39] LinkedIn daily check ${date}: ${cls.attention.length + (unreachable.length ? 1 : 0)} accounts need attention`;

  const decision = (a: any) => a.n401_36h ? 'Ask the user to confirm the account is clear; keep it paused until the extension stops logging 401s, then reopen below the previous ceiling.'
    : a.lock ? 'Check the account with the user before any further automation.'
    : a.silent ? 'Ask the user whether LinkedIn shows a warning; a sudden stop after heavy use is how a lock looks from the inside.'
    : 'Watch: 429 is the stage before 401. Consider lowering the cap.';
  const blocks = cls.attention.map((a) => `<tr><td style="padding:12px 0;border-top:1px solid #e2e8f0;font-size:14px;line-height:1.55;">
<b>${esc(a.label)}</b> <span style="color:#4f5c60;font-size:12px;">${esc(a.account_key)} · owner ${esc(a.owner_key)} · gate ${esc(a.status)}</span><br>
${a.n401_36h ? `HTTP 401 ×${a.n401_36h} in 36h (${a.n401_7d} in 7d), first ${esc(a.first401)}, last ${esc(a.last401)} UTC<br>` : ''}
${a.n429_24h || a.n429_7d ? `HTTP 429 ×${a.n429_24h} in 24h, ${a.n429_7d} in 7d<br>` : ''}
${a.lock ? 'Lock wording found in the extension log (36h)<br>' : ''}
${a.silent ? `Silent: last gate action ${esc(a.last_action)} (more than 48 working hours)<br>` : ''}
Last 24h: ${a.v24} actions${a.daily_cap ? ` of a daily cap of ${a.daily_cap}` : ''}<br>
Paused by this check: <b>${paused.includes(a.account_key) ? 'yes, just now' : a.alreadyPaused ? 'already paused/restricted — unchanged' : 'no'}</b><br>
<span style="color:#1f6f5c;">Decision owed: ${esc(decision(a))}</span></td></tr>`).join('');
  const unreach = unreachable.length ? `<tr><td style="padding:12px;border:2px solid #b42318;color:#b42318;font-size:14px;"><b>Source not reachable — this is NOT an OK.</b><br>${unreachable.map(esc).join('<br>')}</td></tr>` : '';
  const html = card(`<tr><td style="border-top:4px solid #b42318;padding:16px 0 8px;font-size:20px;font-weight:700;color:#12211d;">LinkedIn daily signal check — ${esc(date)}</td></tr>${unreach}${blocks}
<tr><td style="padding:16px 0;color:#4f5c60;font-size:12px;border-top:1px solid #e2e8f0;">Task #39 · now run by the Radar app (Supabase function li-health, mode daily) · 401 = LinkedIn rejected the session (pre-lock); 429 = rate-limited · auto-pause on 401 only, never on 429, never reopened automatically<br><a href="${AIRTABLE}" style="color:#1f6f5c;">${AIRTABLE}</a></td></tr>`);
  const text = [`LinkedIn daily signal check — ${date}`, ...unreachable.map((u) => 'SOURCE NOT REACHABLE: ' + u),
    ...cls.attention.map((a) => `- ${a.label} (${a.account_key}): ${a.reasons.join('; ')}. Paused: ${paused.includes(a.account_key) ? 'yes' : a.alreadyPaused ? 'already' : 'no'}. Decision: ${decision(a)}`),
    '', 'Task #39', AIRTABLE].join('\n');

  if (d.dry) return { sent: false, dry: true, subject, html, text, paused, attention: cls.attention };
  const res = await d.send({ from: FROM_39, to: TO, subject, html, text }, `li-daily-39-${date}`);
  if (res.ok && !d.dry) {
    for (const a of cls.attention.filter((x) => x.silent && x.last_action)) {
      try { await d.radar(SQL.configSet, [a.account_key, 'li_silent_alerted_last_action', String(a.last_action)]); } catch (_) { /* best effort */ }
    }
  }
  return { sent: res.ok, id: res.id, error: res.error, subject, paused, attention: cls.attention.length };
}

// ======================================================================
// task #11 — weekly grade
// ======================================================================
type Acct = {
  key: string; owner: string; person: string; status: string; check: string; grade: ReturnType<typeof gradeAccount>; trend: string;
  v24: number | null; v7d: number | null; daily_cap: number | null; weekly_cap: number | null; n401: number; n429: number; last401: string | null; last429: string | null;
  ext: string | null; signedOut: boolean; why: string; updated_at: string | null; restricted_until: string | null; denies: string[];
};
export async function runWeekly(d: Deps) {
  const nowMs = d.now(), date = nyDate(nowMs);
  const sources: string[] = [], unavailable: string[] = ['Claude-in-Chrome browser read and voice alert (not used by the app)', 'Snov.io (no LinkedIn accounts connected since 2026-08-17)', 'Airtable log (no token in this project — not written by the app)'];
  let gateOk = true, radarOk = true;
  let accounts: Row[] = [], vol: Row[] = [], denies: Row[] = [];
  try {
    if (!d.gate) throw new Error('GATE_DB_URL is not set');
    accounts = await d.gate(SQL.gateAccounts11); vol = await d.gate(SQL.gateVolume11); denies = await d.gate(SQL.denyReasons);
    sources.push('LinkedIn Access Gate (live)');
  } catch (e) { gateOk = false; unavailable.unshift(`LinkedIn Access Gate: ${(e as Error).message}`); }
  let r10: Refusal[] = [], r7: Refusal[] = [], r24: Refusal[] = [], lock: Row[] = [], idents: Row[] = [], clients: Row[] = [], users30: Row[] = [], loginChk: Row[] = [];
  try {
    r10 = (await d.radar(SQL.refusals10d)) as Refusal[]; r7 = (await d.radar(SQL.refusals7d)) as Refusal[]; r24 = (await d.radar(SQL.refusals24h)) as Refusal[];
    lock = await d.radar(SQL.lock7d); idents = await d.radar(SQL.identities); clients = await d.radar(SQL.gateClients);
    users30 = await d.radar(SQL.radarUsers30d); loginChk = await d.radar(SQL.loginCheck);
    sources.push('Radar activity_log (live)');
  } catch (e) { radarOk = false; unavailable.unshift(`Radar DB: ${(e as Error).message}`); }

  const c7 = countsByOwner(r7), c24 = countsByOwner(r24), c10 = countsByOwner(r10);
  const lockSet = new Set(lock.map((x) => String(x.owner_key)));
  const ident: Record<string, string> = {};
  for (const r of idents) if (!ident[r.owner_key]) ident[r.owner_key] = String(r.name || r.email || '');
  const extOf: Record<string, string> = {};
  let latestExt: string | null = null;
  for (const r of clients) { if (r.ext_version && !extOf[r.owner_key]) extOf[r.owner_key] = String(r.ext_version); if (r.ext_version && (!latestExt || cmp(String(r.ext_version), latestExt) > 0)) latestExt = String(r.ext_version); }
  const signedOut = new Set(loginChk.filter((r) => String(r.logged_in) === 'false').map((r) => String(r.owner_key)));
  const volOf: Record<string, Row> = {}; for (const v of vol) volOf[v.account_key] = v;
  const denyOf: Record<string, Row[]> = {}; for (const r of denies) (denyOf[r.account_key] ||= []).push(r);
  const prev = await configMap(d, 'li_safety_grade');
  const parsePrev = (k: string) => { try { return prev[k] ? JSON.parse(prev[k]) : null; } catch { return null; } };

  const list: Acct[] = [];
  const pausedNow: string[] = [];
  for (const a of accounts) {
    if (isTemplate(a.account_key)) continue;
    const o = ownerKeyOf(a.account_key), v = volOf[a.account_key];
    const s7 = c7[o], s10 = c10[o];
    const v7rows = num(v?.v7d);
    const noTelemetry = !v || v7rows === 0;
    const dRows = denyOf[a.account_key] || [];
    const outside = dRows.filter((r) => r.reason === 'outside_window').reduce((x, r) => x + num(r.n), 0);
    const counted = dRows.filter((r) => r.reason !== 'outside_window').reduce((x, r) => x + num(r.n), 0);
    const last = v?.last_action ? new Date(v.last_action).getTime() : NaN;
    const staleData = !isNaN(last) && nowMs - last > 72 * H && nowMs - last <= 14 * 24 * H;
    const gIn = {
      status: a.status, n401_7d: s7?.n401 || 0, lock: lockSet.has(o), n429_7d: s7?.n429 || 0,
      v24: noTelemetry ? null : num(v?.v24), v7d: noTelemetry ? null : v7rows, daily_cap: a.daily_cap, weekly_cap: a.weekly_cap,
      deniesCounted: counted, deniesOutsideWindow: outside, extVersion: extOf[o] || null, latestExt, signedOut: signedOut.has(o), staleData, noTelemetry,
    };
    const grade = gradeAccount(gIn);
    const p = parsePrev(a.account_key);
    const check = statusFor({ gateReachable: gateOk, n401_7d: gIn.n401_7d, gateStatus: a.status, lock: gIn.lock, deniesCounted: counted, v24: gIn.v24, v7d: gIn.v7d, daily_cap: a.daily_cap, weekly_cap: a.weekly_cap, n429_7d: gIn.n429_7d });
    // auto-pause on a 401 inside the last 24 hours
    const n401_24 = c24[o]?.n401 || 0;
    if (n401_24 > 0 && a.status !== 'paused' && a.status !== 'restricted' && d.gate && !d.dry) {
      try { const r = await d.gate(SQL.pause, [a.account_key, pauseNote11(date, c24[o]?.last401 || 'unknown time', gIn.n401_7d)]); if (r.length) pausedNow.push(a.account_key); } catch (_) { unavailable.push(`auto-pause of ${a.account_key} failed`); }
    }
    list.push({
      key: a.account_key, owner: o, person: ident[o] || a.label || a.account_key, status: a.status, check, grade, trend: trendOf(p, grade),
      v24: gIn.v24, v7d: gIn.v7d, daily_cap: a.daily_cap, weekly_cap: a.weekly_cap, n401: s10?.n401 || 0, n429: s10?.n429 || 0, last401: s10?.last401 || null, last429: s10?.last429 || null,
      ext: extOf[o] || null, signedOut: signedOut.has(o), why: grade.penalties.join('; ') || 'no findings', updated_at: a.updated_at || null, restricted_until: a.restricted_until || null,
      denies: dRows.map((r) => `${r.reason} ×${r.n}`),
    });
  }
  const order = (x: Acct) => (x.grade.score == null ? 101 : x.grade.score);
  list.sort((a, b) => order(a) - order(b));
  const estate = estateGrade(list.map((x) => x.grade.score));
  const estateTrend = trendOf(parsePrev('_estate'), estate);

  // roll-call: Radar users (30d) with no gate key, gate keys with no identity
  const gateOwners = new Set(list.map((x) => x.owner));
  const noGate = users30.map((r) => String(r.owner_key)).filter((o) => !gateOwners.has(o) && !accounts.some((a) => a.account_key === accountKeyOf(o)));

  // warnings
  const warnings: { level: 'red' | 'orange'; text: string }[] = [];
  for (const x of list) {
    if (x.n401 && (c7[x.owner]?.n401 || 0)) warnings.push({ level: 'red', text: `${x.person}: LinkedIn rejected the session (HTTP 401 ×${c7[x.owner]?.n401}) this week${pausedNow.includes(x.key) ? ' — auto-paused today' : ''}.` });
    if (lockSet.has(x.owner)) warnings.push({ level: 'red', text: `${x.person}: lock wording found in the extension log.` });
    if (x.status === 'restricted' && x.restricted_until && new Date(x.restricted_until).getTime() <= nowMs) warnings.push({ level: 'red', text: `${x.person}: reopen date reached but reopening needs the user's confirmation and a clean log.` });
  }
  if (noGate.length) warnings.push({ level: 'red', text: `${noGate.length} Radar user(s) collect with no safety gate key (${noGate.join(', ')}) — no cap at all.` });
  for (const x of list) {
    if ((c7[x.owner]?.n429 || 0) >= 10) warnings.push({ level: 'orange', text: `${x.person}: rate-limited by LinkedIn ${c7[x.owner]?.n429} times this week.` });
    if (x.v7d != null && Number(x.weekly_cap) > 0 && x.v7d >= 0.8 * Number(x.weekly_cap)) warnings.push({ level: 'orange', text: `${x.person}: this week's usage is ${Math.round((100 * x.v7d) / Number(x.weekly_cap))}% of the cap.` });
    if (x.status === 'paused' && x.updated_at && nowMs - new Date(x.updated_at).getTime() > 7 * 24 * H) warnings.push({ level: 'orange', text: `${x.person}: paused for more than 7 days with no decision.` });
    if (x.ext && latestExt && cmp(x.ext, latestExt) < 0) warnings.push({ level: 'orange', text: `${x.person}: extension ${x.ext} is older than ${latestExt}.` });
    if (x.signedOut) warnings.push({ level: 'orange', text: `${x.person}: the browser is signed out of LinkedIn.` });
    if (Number(x.daily_cap) > RUNBOOK_DAILY_CEILING) warnings.push({ level: 'orange', text: `${x.person}: daily cap ${x.daily_cap} is above the runbook ceiling of ${RUNBOOK_DAILY_CEILING}.` });
  }
  if (!gateOk || !radarOk) warnings.push({ level: 'orange', text: `A source was unavailable: ${unavailable[0]}` });
  warnings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1));
  const shown = warnings.slice(0, 8);

  // recommendations (3 to 5, by expected effect)
  const recs: { action: string; who: string; effect: string; reply?: string; gain: number }[] = [];
  for (const x of list) {
    if (Number(x.daily_cap) > RUNBOOK_DAILY_CEILING) recs.push({ action: `Lower ${x.person}'s daily cap from ${x.daily_cap} to ${RUNBOOK_DAILY_CEILING}`, who: 'Olivier — decision', effect: `+15 points for ${x.person}`, reply: `Reply: OK cap ${RUNBOOK_DAILY_CEILING}`, gain: 15 });
    if (x.ext && latestExt && cmp(x.ext, latestExt) < 0) recs.push({ action: `Update the Radar extension on ${x.person}'s computer to ${latestExt}`, who: 'Gershon team — tell the client', effect: `+10 points for ${x.person}`, gain: 10 });
    if (x.signedOut) recs.push({ action: `Ask ${x.person} to sign back in to LinkedIn in the Radar browser`, who: 'Gershon team — tell the client', effect: `+25 points for ${x.person}`, gain: 25 });
    if (x.status === 'paused' && x.updated_at && nowMs - new Date(x.updated_at).getTime() > 7 * 24 * H && !(c7[x.owner]?.n401)) recs.push({ action: `Decide on ${x.person}'s paused account (paused since ${String(x.updated_at).slice(0, 10)})`, who: 'Olivier — decision', effect: 'ends an open decision; reopen only below the previous ceiling', reply: 'Reply: keep paused / reopen at 30', gain: 8 });
    if (c7[x.owner]?.n401) recs.push({ action: `Keep ${x.person} paused and ask them to confirm LinkedIn shows no restriction`, who: 'Gershon team — tell the client', effect: 'prevents a lock; no reopen until the 401s stop', gain: 20 });
  }
  if (noGate.length) recs.push({ action: `Give the ${noGate.length} Radar user(s) without a gate key a key with the standard 45/day cap`, who: 'Olivier — decision', effect: 'puts every collecting account under a cap', reply: 'Reply: OK gate keys', gain: 30 });
  recs.sort((a, b) => b.gain - a.gain);
  const recShow = recs.slice(0, 5);

  // tiles
  const tiles = { AB: 0, C: 0, D: 0, F: 0, Q: 0 };
  for (const x of list) { const l = x.grade.letter; if (l === 'A' || l === 'B') tiles.AB++; else if (l === 'C') tiles.C++; else if (l === 'D') tiles.D++; else if (l === 'F') tiles.F++; else tiles.Q++; }
  const reds = shown.filter((w) => w.level === 'red').length, oranges = shown.filter((w) => w.level === 'orange').length;
  const topFact = (shown[0]?.text || 'no warnings this week').replace(/[.:].*$/, '').split(/\s+/).slice(0, 8).join(' ');
  const arrow = estateTrend.startsWith('▲') ? '▲' : estateTrend.startsWith('▼') ? '▼' : '=';
  const subject = `${subjectMark(shown)} [11] LinkedIn Safety ${monD(nowMs)}: grade ${estate.letter} (${estate.score ?? '?'}) ${arrow} · ${reds} red, ${oranges} orange · ${topFact}`;

  const badge = (letter: string, score: number | null, size = 14) => { const c = GRADE_COLOURS[letter] || GRADE_COLOURS['?']; return `<span style="display:inline-block;background-color:${c.bg};color:${c.fg};font-weight:700;font-size:${size}px;padding:${size > 20 ? '10px 18px' : '3px 8px'};border-radius:${size > 20 ? 12 : 6}px;">${esc(letter)}${score != null && size <= 20 ? ' ' + score : ''}</span>`; };
  const bar = (x: Acct) => {
    if (x.v7d == null || !Number(x.weekly_cap)) return `<span style="color:#4a5560;font-size:12px;">no telemetry</span>`;
    const r = x.v7d / Number(x.weekly_cap), w = Math.min(120, Math.round(120 * r)), col = r > 0.8 ? '#b42318' : r >= 0.6 ? '#8a5a00' : '#0b6b3a';
    return `<table cellpadding="0" cellspacing="0"><tr><td width="120" bgcolor="#eceff2" style="background-color:#eceff2;width:120px;height:8px;"><div style="width:${w}px;height:8px;background-color:${col};"></div></td><td style="padding-left:6px;font-size:12px;">${x.v7d}/${x.weekly_cap}</td></tr></table>`;
  };
  const answers = (x: Acct) => (!x.n401 && !x.n429 ? `<span style="color:#0b6b3a;">0 refusals</span>` : `<span style="color:${x.n401 ? '#b42318' : '#b04a00'};">${[x.n429 ? `${x.n429}× 429` : '', x.n401 ? `${x.n401}× 401` : ''].filter(Boolean).join(' · ')} (last ${esc(String(x.last401 || x.last429 || '').slice(0, 10))})</span>`);
  const tile = (label: string, n: number, k: string) => { const c = GRADE_COLOURS[k]; return `<td align="center" bgcolor="${c.bg}" style="background-color:${c.bg};color:${c.fg};padding:8px 4px;font-size:12px;border:2px solid #ffffff;"><b style="font-size:18px;">${n}</b><br>${label}</td>`; };
  const html = card(`
<tr><td style="font-size:12px;color:#4a5560;padding-bottom:10px;">Task #11 · LinkedIn Safety · Monday ${esc(date)}</td></tr>
<tr><td style="padding:8px 0 14px;"><table cellpadding="0" cellspacing="0"><tr><td>${badge(estate.letter, estate.score, 44)}</td><td style="padding-left:16px;font-size:15px;line-height:1.5;"><b style="font-size:22px;">${estate.score ?? '?'}/100</b> <span style="color:#4f5c60;">${esc(estateTrend)}</span><br>${esc(shown[0] ? shown[0].text : 'No warnings this week: no LinkedIn refusals and usage within caps.')}</td></tr></table></td></tr>
<tr><td><table width="100%" cellpadding="0" cellspacing="0"><tr>${tile('A–B', tiles.AB, 'A')}${tile('C', tiles.C, 'C')}${tile('D', tiles.D, 'D')}${tile('F', tiles.F, 'F')}${tile('?', tiles.Q, '?')}<td align="center" style="padding:8px 4px;font-size:12px;color:#12211d;"><b style="font-size:18px;">${list.length}</b><br>accounts checked</td></tr></table></td></tr>
<tr><td style="padding-top:14px;">${shown.length ? `<div style="border:2px solid #b42318;padding:10px 14px;font-size:14px;line-height:1.55;"><b style="color:#b42318;">⚠ Warnings</b><br>${shown.map((w) => `${w.level === 'red' ? '🔴' : '🟠'} ${esc(w.text)}`).join('<br>')}</div>` : `<div style="border:2px solid #0b6b3a;padding:10px 14px;color:#0b6b3a;font-size:14px;"><b>No warnings this week</b></div>`}</td></tr>
<tr><td style="padding-top:14px;font-size:14px;line-height:1.55;"><b style="font-size:16px;">Recommendations</b><ol style="margin:6px 0 0;padding-left:20px;">${recShow.map((r) => `<li style="margin-bottom:6px;"><b>${esc(r.action)}</b><br><span style="color:#4f5c60;">Who: ${esc(r.who)} · Effect: ${esc(r.effect)}</span>${r.reply ? `<br><span style="display:inline-block;background-color:#eceff2;padding:2px 8px;border-radius:10px;font-size:12px;">${esc(r.reply)}</span>` : ''}</li>`).join('') || '<li>Nothing to change this week.</li>'}</ol></td></tr>
<tr><td style="padding-top:14px;"><table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse;">
<tr style="color:#4f5c60;font-size:12px;"><td>Grade</td><td>Account</td><td>Status</td><td>This week's usage</td><td>LinkedIn answers</td></tr>
${list.map((x) => `<tr style="border-top:1px solid #e2e8f0;"><td valign="top">${badge(x.grade.letter, x.grade.score)}<br><span style="font-size:11px;color:#4f5c60;">${esc(x.trend)}</span></td><td valign="top"><b>${esc(x.person)}</b><br><span style="font-size:11px;color:#4a5560;">${esc(x.key)}</span><br><span style="font-size:12px;color:#4f5c60;">${esc(x.why)}</span></td><td valign="top">${esc(x.check)}</td><td valign="top">${bar(x)}</td><td valign="top">${answers(x)}</td></tr>`).join('')}
</table></td></tr>
${noGate.length ? `<tr><td style="padding-top:14px;font-size:14px;"><b>Not in the gate</b><br>${noGate.map((o) => `${esc(ident[o] || o)} <span style="color:#4a5560;font-size:12px;">(owner ${esc(o)})</span>`).join('<br>')}</td></tr>` : ''}
<tr><td style="padding-top:18px;border-top:1px solid #e2e8f0;font-size:11px;color:#4a5560;line-height:1.5;">Sources: ${esc(sources.join(', ') || 'none')} · unavailable: ${esc(unavailable.join('; '))}<br>
Writes: ${pausedNow.length ? 'auto-paused ' + esc(pausedNow.join(', ')) : 'no pauses'}; grades stored for next week's trend (Radar config li_safety_grade).<br>
Gate blocks this week: ${esc(list.filter((x) => x.denies.length).map((x) => `${x.key}: ${x.denies.join(', ')}`).join(' | ') || 'none')}<br>
<a href="${AIRTABLE}" style="color:#1f6f5c;">${AIRTABLE}</a><br>Task #11 · run by the Radar app (Supabase function li-health, mode weekly) · grading rules: A 90+ · B 80+ · C 70+ · D 50+ · F below 50</td></tr>`);
  const text = [`Task #11 · LinkedIn Safety · Monday ${date}`, `Estate grade ${estate.letter} (${estate.score ?? '?'}) ${estateTrend}`, '',
    'Warnings:', ...(shown.length ? shown.map((w) => `${w.level === 'red' ? 'RED' : 'ORANGE'} ${w.text}`) : ['none']), '',
    'Recommendations:', ...recShow.map((r, i) => `${i + 1}. ${r.action} — Who: ${r.who} · Effect: ${r.effect}${r.reply ? ' · ' + r.reply : ''}`), '',
    'Accounts:', ...list.map((x) => `${x.grade.letter} ${x.grade.score ?? ''} ${x.trend} — ${x.person} (${x.key}) — ${x.check} — usage ${x.v7d ?? 'no telemetry'}/${x.weekly_cap ?? '-'} — 401:${x.n401} 429:${x.n429} — ${x.why}`),
    ...(noGate.length ? ['', 'Not in the gate: ' + noGate.join(', ')] : []), '', 'Sources: ' + sources.join(', '), 'Unavailable: ' + unavailable.join('; '), AIRTABLE, 'Task #11'].join('\n');

  if (d.dry) return { sent: false, dry: true, subject, html, text, estate, accounts: list.map((x) => ({ key: x.key, letter: x.grade.letter, score: x.grade.score, status: x.check })), warnings: shown, recommendations: recShow };
  const res = await d.send({ from: FROM_11, to: TO, subject, html, text }, `li-safety-11-${date}`);
  if (res.ok) {
    for (const x of list) { try { await d.radar(SQL.configSet, [x.key, 'li_safety_grade', JSON.stringify({ date, letter: x.grade.letter, score: x.grade.score })]); } catch (_) { /* best effort */ } }
    try { await d.radar(SQL.configSet, ['_estate', 'li_safety_grade', JSON.stringify({ date, letter: estate.letter, score: estate.score })]); } catch (_) { /* best effort */ }
  }
  return { sent: res.ok, id: res.id, error: res.error, subject, estate, paused: pausedNow };
}

const cmp = cmpVersion;
export { KNOWN_SILENT };
