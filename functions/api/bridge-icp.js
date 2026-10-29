// functions/api/bridge-icp.js (2026-10-29, app v1.19.0)
// READ-ONLY per-account bridge ICP ranking for the Radar app's Bridges page.
// Olivier 2026-10-29: the report is PER USER and independent - each client sees only their own bridges.
// The owner comes ONLY from the verified LinkedIn session cookie (radar_session), never from the URL,
// so one client can never read another client's ranking.
//
// GET /api/bridge-icp -> { success, icp, totals:{prospects,scorable,icp}, bridges:[{bridge,source,prospects,scorable,
//                          icp,grade_a,hit_pct,verdict,last_collected}] }
// Data: Supabase view bridge_icp_stats (fed by the targets ICP-score trigger) + table icp_rules.
// verdict: focus (60%+ hit rate and 10+ ICP) | normal | slow (<30%) | cant_judge (<10 prospects with a title)

import { verify } from '../_lib/session.js';

const SUPABASE_URL = 'https://pkzeeqehwmtnqxdpdesl.supabase.co';
const enc = encodeURIComponent;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => { const [k, ...r] = p.trim().split('='); if (k) out[k.trim()] = r.join('=').trim(); });
  return out;
}
async function sb(env, path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` }
  });
  if (!r.ok) throw new Error('supabase ' + r.status);
  return r.json();
}
async function ownerFromSession(request, env) {
  const session = await verify(parseCookies(request.headers.get('Cookie')).radar_session, env.SESSION_SECRET);
  if (!session || !session.sub) return null;
  const filter = session.owner_key ? `owner_key=eq.${enc(session.owner_key)}` : `linkedin_sub=eq.${enc(session.sub)}`;
  try {
    const u = await sb(env, `users?${filter}&select=owner_key,status&limit=1`);
    if (u && u[0] && u[0].owner_key) {
      if (u[0].status === 'suspended' || u[0].status === 'pending') return null;
      return u[0].owner_key;
    }
  } catch (e) {}
  return session.owner_key || null;
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return json({ success: false, error: 'method not allowed' }, 405);
  if (!env.SUPABASE_SERVICE_KEY || !env.SESSION_SECRET) return json({ success: false, error: 'not configured' }, 500);
  const owner = await ownerFromSession(request, env);
  if (!owner) return json({ success: false, error: 'not signed in' }, 401);
  try {
    const [rows, rule] = await Promise.all([
      sb(env, `bridge_icp_stats?owner_key=eq.${enc(owner)}&select=bridge,source,prospects,scorable,icp,grade_a,hit_pct,verdict,last_collected&order=icp.desc,prospects.desc`),
      sb(env, `icp_rules?owner_key=eq.${enc(owner)}&select=note`)
    ]);
    const totals = { prospects: 0, scorable: 0, icp: 0 };
    for (const r of rows || []) { totals.prospects += +r.prospects || 0; totals.scorable += +r.scorable || 0; totals.icp += +r.icp || 0; }
    const note = rule && rule[0] && rule[0].note ? String(rule[0].note).replace(/^[^:]*:\s*/, '') : '';
    return json({ success: true, icp: note, totals, bridges: rows || [] });
  } catch (e) {
    return json({ success: false, error: String(e && e.message || e) }, 500);
  }
}
