// functions/api/admin-campaigns.js (2026-11-17, app v1.19.2)
// READ-ONLY master view of every Radar account for /admin ("All campaigns").
// GET -> { ok, generated_at, totals, accounts:[...], hidden_tests }   (aggregation: functions/_lib/admin-campaigns.js)
// 401 unauthenticated / 403 unless the caller is an admin - same rule as /api/admin-users:
//   users.is_admin (DB) OR session.adm (stamped at login) OR ADMIN_EMAILS env.
// The Supabase service key stays server-side. Nothing is written.

import { verify } from '../_lib/session.js';
import { build } from '../_lib/admin-campaigns.js';

const enc = encodeURIComponent;
const PAGE = 1000;
const json = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => { const [k, ...r] = p.trim().split('='); if (k) out[k.trim()] = r.join('=').trim(); });
  return out;
}

async function sb(env, path) {
  const base = env.SUPABASE_URL || 'https://pkzeeqehwmtnqxdpdesl.supabase.co';
  const r = await fetch(`${base}/rest/v1/${path}`, {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` }
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

// Every row of a table, PAGE at a time (PostgREST caps a response at 1000 rows).
async function all(env, table, select) {
  const out = [];
  for (let off = 0; off < 200000; off += PAGE) {
    const rows = await sb(env, `${table}?select=${select}&order=id.asc&limit=${PAGE}&offset=${off}`);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function isAdmin(env, session) {
  const admins = (env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (session.adm || admins.includes(String(session.email || '').toLowerCase())) return true;
  const f = [];
  // Team members (session.role) sign in to someone else's account: never match that owner's row.
  if (session.owner_key && !session.role) f.push(`owner_key.eq.${session.owner_key}`);
  if (session.sub) f.push(`linkedin_sub.eq.${session.sub}`);
  if (session.email) f.push(`email.eq.${String(session.email).toLowerCase()}`);
  if (!f.length) return false;
  try {
    const u = await sb(env, `users?or=(${enc(f.join(','))})&select=is_admin,status&limit=1`);
    return !!(u && u[0] && u[0].is_admin && u[0].status !== 'suspended');
  } catch (e) { return false; }
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return json({ ok: false, error: 'method not allowed' }, 405);
  if (!env.SUPABASE_SERVICE_KEY || !env.SESSION_SECRET) return json({ ok: false, error: 'not configured' }, 500);
  const session = await verify(parseCookies(request.headers.get('Cookie')).radar_session, env.SESSION_SECRET);
  if (!session) return json({ ok: false, error: 'unauthenticated' }, 401);
  if (!(await isAdmin(env, session))) return json({ ok: false, error: 'forbidden' }, 403);

  try {
    const [users, sources, bridges, targets, config, icpRules] = await Promise.all([
      sb(env, 'users?select=owner_key,display_name,email,last_login_at,status'),
      all(env, 'sources', 'owner_key,category'),
      all(env, 'bridges', 'owner_key,active'),
      all(env, 'targets', 'owner_key,collected_date,grade,botdog_pushed,salesnav_listed_at'),
      sb(env, `config?key=in.(${enc('limits_pause_until,limits_half_until,preanalysis_suggestions')})&select=owner_key,key,value`),
      sb(env, 'icp_rules?select=owner_key')
    ]);
    const out = build({ users, sources, bridges, targets, config, icpRules }, Date.now());
    return json({ ok: true, generated_at: new Date().toISOString(), ...out });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}
