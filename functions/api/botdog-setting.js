// functions/api/botdog-setting.js (2026-11-17, app v1.20.0)
// Per-account Botdog ON/OFF switch shown in Settings.
// Olivier 2026-11-17: "Botdog is an option on Settings, if it is clicked it is used, if it is not
// clicked no reason to show data related to Botdog."
// The owner comes ONLY from the verified LinkedIn session cookie (radar_session), never from the request.
//
// GET  /api/botdog-setting            -> { success, enabled, key_set, stored }
// POST /api/botdog-setting {enabled}  -> { success, enabled }
// Stored as config row (owner_key, 'botdog_enabled', 'on'|'off').
// Default when never set: ON only if the account already has a Botdog API key (keeps Olivier's
// existing outreach running; client accounts, which have no key, start OFF).

import { verify } from '../_lib/session.js';

const SUPABASE_URL = 'https://pkzeeqehwmtnqxdpdesl.supabase.co';
const enc = encodeURIComponent;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => { const [k, ...r] = p.trim().split('='); if (k) out[k.trim()] = r.join('=').trim(); });
  return out;
}
async function sb(env, path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  if (!r.ok) throw new Error('supabase ' + r.status);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
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

export function resolveEnabled(stored, keySet) {
  if (stored === 'on') return true;
  if (stored === 'off') return false;
  return !!keySet;
}

export async function onRequest({ request, env }) {
  if (!env.SUPABASE_SERVICE_KEY || !env.SESSION_SECRET) return json({ success: false, error: 'not configured' }, 500);
  const owner = await ownerFromSession(request, env);
  if (!owner) return json({ success: false, error: 'not signed in' }, 401);
  try {
    if (request.method === 'GET') {
      const rows = await sb(env, `config?owner_key=eq.${enc(owner)}&key=in.(botdog_enabled,botdog_api_key)&select=key,value`);
      const m = {}; (rows || []).forEach(r => { m[r.key] = r.value; });
      const keySet = !!m.botdog_api_key;
      return json({ success: true, enabled: resolveEnabled(m.botdog_enabled, keySet), key_set: keySet, stored: m.botdog_enabled || null });
    }
    if (request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch (e) {}
      if (typeof body.enabled !== 'boolean') return json({ success: false, error: 'enabled must be true or false' }, 400);
      const value = body.enabled ? 'on' : 'off';
      await sb(env, 'config?on_conflict=owner_key,key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ owner_key: owner, key: 'botdog_enabled', value, updated_at: new Date().toISOString() }])
      });
      return json({ success: true, enabled: body.enabled });
    }
    return json({ success: false, error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ success: false, error: String(e && e.message || e) }, 500);
  }
}
