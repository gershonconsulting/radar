// li-health — Radar Supabase edge function (project pkzeeqehwmtnqxdpdesl), verify_jwt OFF, secret-protected.
// Replaces Claude scheduled tasks #39 (daily LinkedIn signal check, 401 auto-pause) and #11 (LinkedIn Safety
// weekly grade). Scheduled by pg_cron (supabase/handoff/2026-11-24-li-health-cron.sql).
//   POST { "secret": "...", "mode": "daily" | "weekly", "dry": true? }   (or GET ?mode=&secret=&dry=1)
//   dry = build the email and return it as JSON; no email, no pause, no config write.
// Secrets:
//   LI_HEALTH_CRON_SECRET  required — same value as Vault secret li_health_cron_secret (used by the cron job)
//   GATE_DB_URL            required — Postgres connection string of the Gate project zywlzopoxhkbblembkja
//                          (Session pooler URI). Without it the email says the gate is unreachable.
//   SUPABASE_DB_URL        injected by Supabase (Radar DB)
//   RESEND_API_KEY         optional — falls back to config.resend_api_key like health-check / daily-report
import postgres from 'npm:postgres@3.4.5';
import { sendResend } from '../_shared/resend.ts';
import { runDaily, runWeekly } from './report.ts';

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
const radarSql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 1 });
const gateUrl = Deno.env.get('GATE_DB_URL');
const gateSql = gateUrl ? postgres(gateUrl, { prepare: false, max: 1 }) : null;
// Rows as plain objects; timestamps as ISO strings (the report compares and prints them as text).
const iso = (r: Record<string, any>) => { for (const k in r) if (r[k] instanceof Date) r[k] = r[k].toISOString(); return r; };
const q = (c: any) => async (text: string, params: unknown[] = []) => Array.from(await c.unsafe(text, params as any[])).map((r: any) => iso({ ...r })) as Record<string, any>[];

async function resendKey(): Promise<string | null> {
  const env = Deno.env.get('RESEND_API_KEY');
  if (env) return env;
  try { const r = await radarSql`select value from config where key='resend_api_key' and value <> '' order by (owner_key='xTVW0K1qKi') desc limit 1`; return r[0]?.value ?? null; } catch { return null; }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }
  const secret = String(body.secret ?? url.searchParams.get('secret') ?? '');
  const expected = Deno.env.get('LI_HEALTH_CRON_SECRET');
  if (!expected || secret !== expected) return json({ error: 'forbidden' }, 403);
  const mode = String(body.mode ?? url.searchParams.get('mode') ?? '');
  const dry = body.dry === true || ['1', 'true'].includes(url.searchParams.get('dry') || '');
  const deps = {
    now: () => Date.now(),
    radar: q(radarSql),
    gate: gateSql ? q(gateSql) : null,
    dry,
    send: async (payload: Record<string, unknown>, key: string) => {
      const k = await resendKey();
      if (!k) return { ok: false, error: 'no Resend key' };
      const r = await sendResend(k, payload, { idempotencyKey: key, label: 'li-health-' + mode });
      return { ok: r.ok, id: r.id, error: r.error };
    },
  };
  try {
    if (mode === 'daily') return json(await runDaily(deps));
    if (mode === 'weekly') return json(await runWeekly(deps));
    return json({ error: 'mode must be daily or weekly' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
