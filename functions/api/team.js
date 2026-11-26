// functions/api/team.js (2026-11-26, app v1.25.0) - Settings > Team: give other people access to a Radar account.
// The account and the caller's role come ONLY from the verified LinkedIn session cookie (radar_session).
//
// GET  /api/team                                   -> { success, role, can_manage, account, members, workspaces }
// POST /api/team { op:'invite', name, email, linkedin_url, role }   (owner / full)
// POST /api/team { op:'update', id, role }                          (owner / full)
// POST /api/team { op:'remove', id }                                (owner / full)
// POST /api/team { op:'switch', owner_key }  -> re-issues the session for another account the person can open
// See functions/_lib/team.js for storage and the role rules.

import { verify, sign } from '../_lib/session.js';
import { TEAM_KEY, ROLES, parseTeam, findMember, validateInvite, publicMember, canManageTeam, findMemberships } from '../_lib/team.js';

const SUPABASE_URL = 'https://pkzeeqehwmtnqxdpdesl.supabase.co';
const enc = encodeURIComponent;
const json = (o, s = 200, extra) => {
  const h = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  if (extra) for (const [k, v] of extra) h.append(k, v);
  return new Response(JSON.stringify(o), { status: s, headers: h });
};

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => { const [k, ...r] = p.trim().split('='); if (k) out[k.trim()] = r.join('=').trim(); });
  return out;
}
function makeSb(env) {
  return async function sb(path, init = {}) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
    });
    if (!r.ok) throw new Error('supabase ' + r.status);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
}

async function readTeam(sb, owner) {
  const rows = await sb(`config?owner_key=eq.${enc(owner)}&key=eq.${TEAM_KEY}&select=value&limit=1`);
  return parseTeam(rows && rows[0] && rows[0].value);
}
async function writeTeam(sb, owner, list) {
  await sb('config?on_conflict=owner_key,key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ owner_key: owner, key: TEAM_KEY, value: JSON.stringify(list), updated_at: new Date().toISOString() }])
  });
}
async function accountName(sb, owner) {
  try {
    const u = await sb(`users?owner_key=eq.${enc(owner)}&select=display_name,email&limit=1`);
    return (u && u[0] && (u[0].display_name || u[0].email)) || owner;
  } catch (e) { return owner; }
}
async function log(sb, owner, action, detail) {
  try { await sb('activity_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ owner_key: owner, action, detail }]) }); } catch (e) {}
}

// Who is calling, on which account, with which role. null = not signed in / no longer allowed.
export async function callerContext(sb, session) {
  if (!session || !session.sub || !session.owner_key) return null;
  if (session.role) {
    const m = findMember(await readTeam(sb, session.owner_key), session);
    if (!m) return null;                         // removed since sign-in
    return { owner: session.owner_key, role: m.role, member: m };
  }
  try {
    const u = await sb(`users?owner_key=eq.${enc(session.owner_key)}&select=status&limit=1`);
    if (u && u[0] && (u[0].status === 'suspended' || u[0].status === 'pending')) return null;
  } catch (e) {}
  return { owner: session.owner_key, role: 'owner', member: null };
}

export async function onRequest({ request, env }) {
  if (!env.SUPABASE_SERVICE_KEY || !env.SESSION_SECRET) return json({ success: false, error: 'not configured' }, 500);
  const sb = makeSb(env);
  const session = await verify(parseCookies(request.headers.get('Cookie')).radar_session, env.SESSION_SECRET);
  let ctx;
  try { ctx = await callerContext(sb, session); } catch (e) { return json({ success: false, error: String(e.message || e) }, 500); }
  if (!ctx) return json({ success: false, error: 'not signed in' }, 401);

  try {
    if (request.method === 'GET') {
      const list = await readTeam(sb, ctx.owner);
      const memberships = await findMemberships(sb, session).catch(() => []);
      const workspaces = [];
      const selfOwner = session.role ? (session.self_owner || null) : ctx.owner;
      if (selfOwner) workspaces.push({ owner_key: selfOwner, name: 'My own Radar', role: 'owner', current: selfOwner === ctx.owner && !session.role });
      for (const w of memberships) {
        workspaces.push({ owner_key: w.owner_key, name: await accountName(sb, w.owner_key), role: w.member.role, current: !!session.role && w.owner_key === ctx.owner });
      }
      return json({
        success: true, role: ctx.role, can_manage: canManageTeam(ctx.role),
        account: { owner_key: ctx.owner, name: await accountName(sb, ctx.owner) },
        members: canManageTeam(ctx.role) ? list.map(publicMember) : [],
        workspaces
      });
    }

    if (request.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405);
    let body = {}; try { body = await request.json(); } catch (e) {}
    const op = String(body.op || '');

    if (op === 'switch') {
      const target = String(body.owner_key || '');
      let payload = null;
      // back to the person's own account
      const own = await sb(`users?linkedin_sub=eq.${enc(session.sub)}&select=owner_key,is_admin,status&limit=1`).catch(() => null);
      if (own && own[0] && own[0].owner_key === target && own[0].status !== 'suspended') {
        payload = { sub: session.sub, email: session.email, name: session.name, owner_key: target, adm: !!own[0].is_admin, iat: Date.now() };
      } else {
        const m = findMember(await readTeam(sb, target), session);
        if (m) payload = { sub: session.sub, email: session.email, name: session.name, owner_key: target, role: m.role,
                           self_owner: (own && own[0] && own[0].owner_key) || null, adm: false, iat: Date.now() };
      }
      if (!payload) return json({ success: false, error: 'no access to that account' }, 403);
      const token = await sign(payload, env.SESSION_SECRET);
      return json({ success: true }, 200, [['Set-Cookie', `radar_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`]]);
    }

    if (!canManageTeam(ctx.role)) return json({ success: false, error: 'Only the account owner or a Full member can change the team.' }, 403);
    const list = await readTeam(sb, ctx.owner);
    const by = session.email || session.name || '';

    if (op === 'invite') {
      const v = validateInvite(body, list, new Date().toISOString(), by);
      if (!v.ok) return json({ success: false, error: v.error }, 400);
      list.push(v.member);
      await writeTeam(sb, ctx.owner, list);
      await log(sb, ctx.owner, 'team_invite', { email: v.member.email, role: v.member.role, by });
      return json({ success: true, member: publicMember(v.member), members: list.map(publicMember) });
    }
    const idx = list.findIndex(m => m.id === body.id);
    if (idx < 0) return json({ success: false, error: 'member not found' }, 404);

    if (op === 'update') {
      const role = String(body.role || '').toLowerCase();
      if (!ROLES.includes(role)) return json({ success: false, error: 'Pick Full, Semi or Viewer.' }, 400);
      list[idx].role = role;
      await writeTeam(sb, ctx.owner, list);
      await log(sb, ctx.owner, 'team_role', { email: list[idx].email, role, by });
      return json({ success: true, members: list.map(publicMember) });
    }
    if (op === 'remove') {
      const [gone] = list.splice(idx, 1);
      await writeTeam(sb, ctx.owner, list);
      await log(sb, ctx.owner, 'team_remove', { email: gone.email, by });
      return json({ success: true, members: list.map(publicMember) });
    }
    return json({ success: false, error: 'unknown op' }, 400);
  } catch (e) {
    return json({ success: false, error: String(e && e.message || e) }, 500);
  }
}
