// Radar — daily-report edge function (v8)
// ONE email per day, per user, describing YESTERDAY (America/New_York day).
// Triggered by pg_cron: POST { secret } (or GET ?secret=). verify_jwt=false.
// Optional overrides for testing: ?date=YYYY-MM-DD (the ET day to report on), ?to=email, ?dry=1
//
// v4 (2026-08-21) — send-once guard: `daily_report_sent_for` holds the last ET day actually
// delivered, per owner. Use ?force=1 to deliberately re-send; ?dry=1 bypasses it (sends nothing).
//
// 2026-10-22 (repo copy of deployed v7): sender display name "Radar" -> "GC Radar Report"
// (Olivier's GC-prefix rule, see FROM below). Address, reply-to, recipients and subject unchanged.
// 2026-10-27: house style for report emails - white header (dark #12211d text, Gershon red #CC3333
// accent rule) instead of white-on-navy; white page, max-width 680px; links/button #1f6f5c, no light-on-dark.
//
// v8 (2026-10-28) — three fixes after the 2026-10-26 email:
//  1. "+1259 vs the day before" compared against a day that did NOT run (0 prospects). The
//     comparison now looks back (up to 7 ET days, same radar_daily_stats RPC, read-only) for the
//     last day that actually ran and says so: "+1259 since Fri 10-23 — 2 days without a run". If
//     nothing ran in the 7 days before, it compares against the 7-day average instead.
//     (new_targets_prev from the RPC is no longer used for this - see supabase/HANDOFF.txt.)
//  2. browsersVerdict said "v1.15.0 ... collected nothing" while the "Browsers that ran" table
//     printed 258 saved for v1.15.0. It assumed every old-build browser collects nothing and
//     credited the day to the current build. It now reads each browser's own `saved` - the
//     number the table prints - so the banner and the table always agree.
//  3. Sender display name "GC Radar Report" -> "GC Radar" (GC-prefix rule for Gershon internal reports).

const REPORT_VERSION = 'v8';
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = 'radar_7Kq3mZ9pX2vL8nT';
const GLOBAL_OWNER_KEY = 'xTVW0K1qKi';
const TZ = 'America/New_York';
const APP_URL = 'https://radar.gershoncrm.com/app.html';
const FALLBACK_LATEST_EXT = '1.7.3';
const SENT_KEY = 'daily_report_sent_for';
const FROM = 'GC Radar <radar@gershon.ai>';

// v5 (2026-08-28) — the report blended several browsers into one verdict.
// Under a single owner_key, one Chrome on ext v1.9.1 collects at 02:30-04:10 ET while other,
// forgotten Chromes (v1.9.0, v1.7.4) run later and report found:0 / saved:0 plus no-tab,
// not-authenticated and scrape-window errors. On 2026-08-27 the v1.7.4 browser produced 38 of the
// day's 39 error entries, all landing in the same "Needs attention" list as the healthy browser's
// - and `ext_version` was unbounded by the report window, so the same email could blame the
// account for a dead browser AND claim the extension was up to date. radar_daily_stats now
// returns `by_version`, `best_*` and a window-bounded `ext_version`; this file reads them.

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

/* ---------- data ---------- */
async function stats(ownerKey: string, start: Date, end: Date): Promise<any> {
  const rows = await sb('rpc/radar_daily_stats', { method: 'POST', body: { p_owner: ownerKey, p_start: start.toISOString(), p_end: end.toISOString() } });
  return rows || {};
}
// v8: what "New prospects" is compared against. The day before only counts if Radar actually
// ran that day (a run was recorded, or prospects landed). Otherwise walk back to the last day
// that ran; after LOOKBACK_DAYS with no run, fall back to the 7-day average.
const LOOKBACK_DAYS = 7;
type PrevRef = { ymd: string; n: number; gap: number } | null;   // gap = days without a run in between
function dayRan(ps: any): boolean {
  return (+ps?.runs || 0) > 0 || (+ps?.new_targets || 0) > 0;
}
async function lastRunDay(ownerKey: string, dayYmd: string, statsFn = stats): Promise<PrevRef> {
  let ymd = dayYmd;
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const p = prevYmd(ymd);
    const ps = await statsFn(ownerKey, etMidnightUtc(p), etMidnightUtc(ymd));
    if (dayRan(ps)) return { ymd: p, n: +ps.new_targets || 0, gap: i };
    ymd = p;
  }
  return null;
}
// Returns the card's sub-line for "New prospects".
function prevDeltaHtml(cur: number, ref: PrevRef, avg7: number): string {
  if (!ref) return delta(cur, avg7, `7-day avg (no run in the ${LOOKBACK_DAYS} days before)`);
  if (ref.gap === 0) return delta(cur, ref.n, 'the day before');
  return delta(cur, ref.n, `${dayLabel(ref.ymd)} — ${ref.gap} day${ref.gap === 1 ? '' : 's'} without a run`, 'since');
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

function jobVerdict(s: any): Verdict {
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
    return { level: 'critical', title: 'Radar did NOT run yesterday', body: `No collection run was recorded at all. The Chrome extension is the only scheduler — this means Chrome was never opened, the extension is disabled or needs reloading, or it crashed before it could report in. Last run seen: ${agoText(s.last_run_at)}.` };
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
    return { level: 'warn', title: 'Radar ran, but nobody new came out of it', body: `The extension saw ${found} profile(s) and wrote ${saved} record(s) — all of them people Radar already had. No net progress yesterday.` };
  }
  return {
    level: 'ok',
    title: `Radar did its job — ${newTargets} new prospect${newTargets === 1 ? '' : 's'}`,
    body: `${runs} run(s)${saved > 0 ? `. The extension saw ${found} profile(s) and wrote ${saved} record(s); ${newTargets} of them were people Radar had never seen before` : ` produced ${newTargets} prospect(s) Radar had never seen before`}${listed > 0 ? `, and ${listed} were filed into your Sales Navigator list` : ''}.`,
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
// warning could ever describe.
type VerRow = { version: string; runs: number; found: number; saved: number; listed: number; errors: number; last_run_at: string };
function browsersVerdict(s: any, latest: string): Verdict | null {
  const rows: VerRow[] = Array.isArray(s.by_version) ? s.by_version : [];
  if (rows.length < 2) return null;
  const isStale = (r: VerRow) => r.version === 'unreported' || cmpVer(r.version, latest) < 0;
  const stale = rows.filter(isStale);
  const good = rows.filter(r => !isStale(r));
  const vl = (r: VerRow) => `v${r.version === 'unreported' ? '?' : r.version}`;
  const savedOf = (r: VerRow) => +r.saved || 0;
  // v6 (2026-08-28, Olivier's call): only ONE browser has to work. Other Chromes are knowingly
  // left on old builds and will not be fixed, so shouting about them daily would train the reader
  // to ignore a red banner - the exact habit that let a real outage hide for days. Red is reserved
  // for "the pipeline is actually broken". If a current build collected anything, the stale
  // browsers are reported as a plain fact and the subject line stays clean.
  //
  // v7: `saved` comes from run:done, which a long run may never push inside the day - on
  // 2026-08-28 v1.9.1 showed 8 runs, run_done 0, saved 0 while 1133 targets actually landed. So do
  // NOT gate on r.saved alone: if a current build ran at all and the day produced prospects, it
  // was that browser (the stale ones demonstrably collect nothing).
  //
  // v8: ...except when they do. On 2026-10-26 the v1.15.0 browser saved 258 (printed in the
  // "Browsers that ran" table) while this banner said it "collected nothing" and credited the day
  // to the current build. Every per-browser statement below now comes from that browser's own
  // `saved` - the same number the table prints. The dayProduced heuristic is only used when NO
  // browser reported a saved count.
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
      // A current build did the most work.
      return {
        level: 'ok',
        title: `Collecting on ${vl(w)} — ${plural(stale.length, 'other browser')} on old builds`,
        body: `${vl(w)} saved ${w.saved} record(s) yesterday.${othersLine}${idleLine} Left alone deliberately — nothing to do here.`,
      };
    }
    // The browser doing the work is itself on an old build: still collecting, so not red.
    const curIdle = good.filter(r => savedOf(r) === 0);
    return {
      level: 'warn',
      title: `Collecting on old build ${vl(w)} — v${latest} available`,
      body: `${vl(w)} saved ${w.saved} record(s) yesterday, so collection works, but on an old build.${othersLine}${curIdle.length ? ` ${curIdle.map(vl).join(', ')} ran too and saved 0.` : ''}${idleLine} Update the collecting browser from the Extension page in Radar, then reload it at chrome://extensions.`,
    };
  }

  // No browser reported a saved count (run:done can lag - see v7 above).
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

function buildHtml(name: string, s: any, dayYmd: string, job: Verdict, ext: Verdict, browsers: Verdict | null, prevRef: PrevRef = null): string {
  const newTargets = +s.new_targets || 0;
  const avg7 = +s.avg7 || 0;
  const byBridge: Array<{ bridge: string; n: number }> = Array.isArray(s.by_bridge) ? s.by_bridge : [];
  const problems: string[] = Array.isArray(s.problems) ? s.problems : [];

  const attention: string[] = [];
  if (+s.bridges_never_scraped > 0) attention.push(`${s.bridges_never_scraped} active bridge(s) have never produced a single prospect — their Sales Navigator search has never run successfully.`);
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
  <tr><td style="background:#ffffff;border-top:4px solid #CC3333;border-bottom:1px solid #e2e8f0;padding:20px 22px 16px;">
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
      ${card('New prospects', newTargets, prevDeltaHtml(newTargets, prevRef, avg7))}
      ${card('7-day average', avg7, delta(newTargets, avg7, '7-day avg'))}
      ${card('Total collected', s.total_targets ?? 0, `<span style=\"color:#94a3b8;\">all time</span>`)}
    </tr></table>

    ${sectionTitle('The pipeline')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${row('Prospects collected yesterday', String(newTargets))}
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

    ${sectionTitle('Where yesterday’s prospects came from')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bridgeRows}</table>

    ${sectionTitle('Needs attention')}
    ${attention.length
      ? `<ul style=\"margin:6px 0 0;padding-left:20px;color:#334155;font-size:14px;line-height:1.6;\">${attention.map(a => `<li style=\"margin:5px 0;\">${esc(a)}</li>`).join('')}</ul>`
      : `<div style=\"color:#16a34a;font-size:14px;\">All clear &#8212; nothing needs attention.</div>`}

    <div style="text-align:center;margin:28px 4px 10px;">
      <a href="${APP_URL}" style="display:inline-block;background:#ffffff;color:#1f6f5c;border:2px solid #1f6f5c;text-decoration:none;font-size:15px;font-weight:700;padding:10px 26px;border-radius:9px;">Open Radar</a>
    </div>
  </td></tr>
  <tr><td style="padding:16px 24px 22px;border-top:1px solid #e2e8f0;">
    <div style="font-size:12px;color:#94a3b8;line-height:1.6;">Generated by Radar (daily-report ${REPORT_VERSION}) &#8212; radar.gershoncrm.com. Covers ${esc(longDate(dayYmd))}, midnight to midnight, New York time.<br/>Reply to <a href="mailto:support@gershonconsulting.com" style="color:#1f6f5c;text-decoration:underline;">support@gershonconsulting.com</a>.</div>
  </td></tr>
</table></td></tr></table></body></html>`;
}

async function sendEmail(key: string, to: string, subject: string, html: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: 'support@gershonconsulting.com', subject, html }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/* ---------- entry ---------- */
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);
  let provided: string | null = url.searchParams.get('secret');
  if (req.method === 'POST' && !provided) {
    try { provided = (await req.json())?.secret ?? null; } catch { provided = null; }
  }
  if (provided !== CRON_SECRET) return json({ ok: false, error: 'unauthorized' }, 401);

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
      const latestExt = (cfg.latest_ext_version || FALLBACK_LATEST_EXT).trim();
      const s = await stats(r.owner_key, start, end);
      const job = jobVerdict(s);
      const ext = extVerdict(s, latestExt);
      const browsers = browsersVerdict(s, latestExt);
      let prevRef: PrevRef = null;
      try { prevRef = await lastRunDay(r.owner_key, dayYmd); } catch (_e) { prevRef = null; /* falls back to the 7-day average */ }
      const html = buildHtml(r.display_name || '', s, dayYmd, job, ext, browsers, prevRef);

      const tag = (browsers && browsers.level === 'critical' && job.level !== 'critical')
        ? ' — ⚠️ OUTDATED BROWSER'
        : job.level === 'critical'
        ? ((+s.runs || 0) === 0 ? ' — ⚠️ DID NOT RUN' : ' — ⚠️ COLLECTION FAILED')
        : ((+s.new_targets || 0) > 0 ? ` — +${s.new_targets} prospects` : ' — no new prospects');
      const subject = `Radar Report — ${shortDate(dayYmd)}${tag}`;

      const to = toOverride || cfg.report_email || r.email;
      if (dry) { preview = html; sent.push(`${to} (dry)`); continue; }

      const key = await loadResendKey(cfg);
      if (!key) { errors.push({ email: to, error: 'no resend key' }); continue; }
      await sendEmail(key, to, subject, html);
      sent.push(to);
      await markSentDay(r.owner_key, dayYmd);
    } catch (e) {
      errors.push({ email: r.email, error: String(e) });
    }
  }

  if (dry && preview) return new Response(preview, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
  return json({ ok: true, day: dayYmd, window: [start.toISOString(), end.toISOString()], sent: sent.length, recipients: sent, skipped, errors });
});
