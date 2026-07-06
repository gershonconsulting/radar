// functions/api/admin.js
// Admin-only proxy to the Apps Script hub for user management.
// Handles GET /api/admin?action=getUsers and POST /api/admin (upsertUser, setUserStatus,
// setUserRole, setUserFlag, ...). 403s unless the session email is in ADMIN_EMAILS.
// Injects HUB_SECRET server-side; admin actions are global (not owner-scoped).

import { verify } from '../_lib/session.js';

const HUB_URL = 'https://script.google.com/macros/s/AKfycbzFX-DPwGDGFPoIxdYwNq5mMztXHNs33PHUNQox-vgrvQbgA2KLccMN9DI-YURCIWxbPw/exec';

function parseCookies(header) {
  const result = {};
  (header || '').split(';').forEach(part => {
    const [k, ...rest] = part.trim().split('=');
    if (k) result[k.trim()] = rest.join('=').trim();
  });
  return result;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function isAdminEmail(email, env) {
  const admins = (env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return admins.includes(String(email || '').toLowerCase());
}

export async function onRequest({ request, env }) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verify(cookies.radar_session, env.SESSION_SECRET);

  if (!session) return json({ ok: false, error: 'unauthenticated' }, 401);
  if (!isAdminEmail(session.email, env)) return json({ ok: false, error: 'forbidden' }, 403);

  if (request.method === 'GET') {
    const incoming = new URL(request.url);
    const upstream = new URL(HUB_URL);
    for (const [k, v] of incoming.searchParams) upstream.searchParams.set(k, v);
    upstream.searchParams.set('secret', env.HUB_SECRET);
    const resp = await fetch(upstream.toString(), { method: 'GET' });
    const body = await resp.text();
    return new Response(body, { status: resp.status, headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' } });
  }

  if (request.method === 'POST') {
    let payload = {};
    try { payload = JSON.parse(await request.text()); }
    catch { return json({ ok: false, error: 'bad JSON body' }, 400); }
    payload.secret = env.HUB_SECRET;
    payload.admin_email = session.email; // for audit
    const resp = await fetch(HUB_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    const body = await resp.text();
    return new Response(body, { status: resp.status, headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' } });
  }

  return new Response('Method not allowed', { status: 405 });
}
