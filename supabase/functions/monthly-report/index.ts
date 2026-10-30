// Radar — monthly-report edge function (v1, 2026-10-01)
// 2026-10-30 (repo copy of deployed v1): sender display name "Radar" -> "GC Radar" (GC-prefix rule for
// Gershon report emails, same as daily-report v8 / health-check in PR #14). Only the FROM line and this comment
// differ from the live v1. ./report.js (46KB) is unchanged in the live function and is not copied here.
// Ported from Linalysis monthly reports (linalysis/worker/monthly-report-block.js).
// On the 1st of each month (pg_cron job `radar-monthly-report`) it reports on the PREVIOUS month:
//   • one report per account  → the account's registered email, bcc report_email
//   • one estate/admin report → report_email (report@gershonconsulting.com)
// Every email = full HTML report in the body + one-page PDF attached. Sent via Resend.
// Data: SQL function public.radar_monthly_stats(p_month 'YYYY-MM').
// Auth: { secret } in POST body or ?secret=. verify_jwt=false.
// Params: ?month=YYYY-MM  ?dry=1 (send nothing, return plan)  ?force=1 (ignore send-once guard)
//         ?only=<email|estate> (one report)  ?to=<email> (override recipient, no bcc)
//         ?preview=<email|estate>&format=html|pdf (return the rendered report, sends nothing)
import { rmWindow, rmAccount, rmUserPdf, rmEstatePdf, rmEstate, rmUserHtml, rmEstateHtml, rmSubjects } from './report.js';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = 'radar_7Kq3mZ9pX2vL8nT';
const GLOBAL_OWNER_KEY = 'xTVW0K1qKi';
const TZ = 'America/New_York';
const FROM = 'GC Radar <radar@gershon.ai>';
const USER_SENT_KEY = 'monthly_report_sent_for';
const ESTATE_SENT_KEY = 'monthly_estate_sent_for';

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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
async function getCfg(owner: string, key: string): Promise<string | null> {
  try { const r = await sb(`config?owner_key=eq.${encodeURIComponent(owner)}&key=eq.${key}&select=value&limit=1`); return r.length ? r[0].value : null; }
  catch { return null; }
}
async function setCfg(owner: string, key: string, value: string) {
  try { await sb('config', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: [{ owner_key: owner, key, value, updated_at: new Date().toISOString() }] }); } catch { /* best effort */ }
}
async function logAct(owner: string, detail: unknown) {
  try { await sb('activity_log', { method: 'POST', prefer: 'return=minimal', body: [{ owner_key: owner, action: 'monthly_report', detail }] }); } catch { /* best effort */ }
}
async function resendKey(): Promise<string | null> {
  const k = Deno.env.get('RESEND_API_KEY'); if (k) return k;
  try { const r = await sb('config?key=eq.resend_api_key&select=value&limit=1'); return r.length ? r[0].value : null; } catch { return null; }
}
function prevMonthEt(): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  let y = +p.find(x => x.type === 'year')!.value, m = +p.find(x => x.type === 'month')!.value - 1;
  if (m === 0) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
async function send(key: string, msg: Record<string, unknown>) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
    const body = await res.text();
    if (res.ok) return JSON.parse(body).id as string;
    if (res.status === 429) { await sleep(1500); continue; }
    throw new Error(`resend ${res.status}: ${body.slice(0, 200)}`);
  }
  throw new Error('resend rate-limited');
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  let secret = url.searchParams.get('secret');
  if (!secret && req.method === 'POST') { try { secret = (await req.json())?.secret ?? null; } catch { secret = null; } }
  if (secret !== CRON_SECRET) return json({ ok: false, error: 'unauthorized' }, 401);

  const month = url.searchParams.get('month') || prevMonthEt();
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ ok: false, error: 'month must be YYYY-MM' }, 400);
  const dry = url.searchParams.get('dry') === '1', force = url.searchParams.get('force') === '1';
  const only = url.searchParams.get('only'), toOverride = url.searchParams.get('to');
  const preview = url.searchParams.get('preview'), format = url.searchParams.get('format') || 'html';

  const data = await sb('rpc/radar_monthly_stats', { method: 'POST', body: { p_month: month } });
  const win = rmWindow(month), latest = data.latest_ext || '1.15.0', admin = data.report_email || 'report@gershonconsulting.com';
  const accounts = (data.accounts || []).map((r: any) => rmAccount(r, win, latest));
  const now = new Date();
  const build = `build ${now.toISOString().slice(0, 10)}.${now.toISOString().slice(11, 16).replace(':', '')}-monthly`;
  const generatedAt = 'Generated ' + new Intl.DateTimeFormat('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }).format(now) + ' ET';
  const E = rmEstate(accounts, win, latest);

  if (preview) {
    const a = preview === 'estate' ? null : accounts.find((x: any) => x.email === preview);
    if (preview !== 'estate' && !a) return json({ ok: false, error: 'no such account' }, 404);
    if (format === 'pdf') {
      const pdf = a ? rmUserPdf(a, win, latest, build).pdf : rmEstatePdf(accounts, win, latest, build, generatedAt).pdf;
      return new Response(pdf.bytes(), { headers: { 'Content-Type': 'application/pdf' } });
    }
    return new Response(a ? rmUserHtml(a, win, latest) : rmEstateHtml(accounts, win, latest, generatedAt), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const key = dry ? 'dry' : await resendKey();
  if (!key) return json({ ok: false, error: 'no RESEND key' }, 500);
  const out: any[] = [];

  // estate report
  if (!only || only === 'estate') {
    const done = !force && (await getCfg(GLOBAL_OWNER_KEY, ESTATE_SENT_KEY)) === month;
    if (done) out.push({ report: 'estate', skipped: `already sent for ${month}` });
    else {
      const subject = rmSubjects(accounts[0] || {}, win, E).estate, to = toOverride || admin;
      if (dry) out.push({ report: 'estate', to, subject, dry: true });
      else {
        try {
          const id = await send(key, { from: FROM, to: [to], reply_to: 'support@gershonconsulting.com', subject,
            html: rmEstateHtml(accounts, win, latest, generatedAt),
            attachments: [{ filename: `radar-${month}-platform-report.pdf`, content: rmEstatePdf(accounts, win, latest, build, generatedAt).pdf.base64() }] });
          out.push({ report: 'estate', to, subject, sent: true, id });
          if (!toOverride) await setCfg(GLOBAL_OWNER_KEY, ESTATE_SENT_KEY, month);
          await logAct(GLOBAL_OWNER_KEY, { type: 'estate', month, to, id });
        } catch (e) { out.push({ report: 'estate', to, sent: false, error: String(e) }); }
        await sleep(700);
      }
    }
  }

  // one report per account
  for (const a of accounts) {
    if (only && only !== a.email) continue;
    const done = !force && (await getCfg(a.owner_key, USER_SENT_KEY)) === month;
    if (done) { out.push({ report: 'user', email: a.email, skipped: `already sent for ${month}` }); continue; }
    const subject = rmSubjects(a, win, E).user;
    const to = toOverride || a.email, bcc = toOverride || a.email === admin ? undefined : [admin];
    if (dry) { out.push({ report: 'user', to, bcc, subject, dry: true }); continue; }
    try {
      const { pdf } = rmUserPdf(a, win, latest, build);
      const id = await send(key, { from: FROM, to: [to], ...(bcc ? { bcc } : {}), reply_to: 'support@gershonconsulting.com', subject,
        html: rmUserHtml(a, win, latest),
        attachments: [{ filename: `radar-${month}-${a.email.replace(/[^a-z0-9]+/gi, '-')}.pdf`, content: pdf.base64() }] });
      out.push({ report: 'user', to, bcc, subject, sent: true, id });
      if (!toOverride) await setCfg(a.owner_key, USER_SENT_KEY, month);
      await logAct(a.owner_key, { type: 'user', month, to, id });
    } catch (e) { out.push({ report: 'user', to, sent: false, error: String(e) }); }
    await sleep(700);
  }
  return json({ ok: true, month, accounts: accounts.length, producing: E.live.length, deliveries: out });
});
