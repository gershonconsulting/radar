// functions/api/me.js
// Returns the currently authenticated user from the session cookie.
// Called by the frontend gate on every page load.
// 200 + user object = authenticated; 401 = not signed in.

import { verify } from '../_lib/session.js';

function parseCookies(header) {
  const result = {};
  (header || '').split(';').forEach(part => {
    const [k, ...rest] = part.trim().split('=');
    if (k) result[k.trim()] = rest.join('=').trim();
  });
  return result;
}

function isAdminEmail(email, env) {
  const admins = (env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return admins.includes(String(email || '').toLowerCase());
}

// --- Best-effort login tracking -------------------------------------------
// Records at most one 'login' row per owner per LOGIN_WINDOW_MS so that /api/me
// (called on every page load) doesn't inflate the count into a page-view meter.
//
// This is strictly fire-and-forget: every path is wrapped in try/catch, it runs
// via waitUntil AFTER the response is already returned, and it is skipped
// entirely unless Supabase is configured. It can never delay or break auth.
const LOGIN_WINDOW_MS = 30 * 60 * 1000; // 30 min

async function trackLogin(env, session) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return; // not configured — skip
  const owner = session.owner_key || session.sub;
  if (!owner) return;

  const base = `${env.SUPABASE_URL}/rest/v1`;
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  const now = new Date();

  // Keep the users row current (and self-heal a missing one) without clobbering
  // an existing display_name/email with nulls.
  const row = {
    owner_key: owner,
    linkedin_sub: session.sub || null,
    last_login_at: now.toISOString(),
  };
  if (session.email) row.email = String(session.email).toLowerCase();
  if (session.name) row.display_name = session.name;

  await fetch(`${base}/users?on_conflict=owner_key`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });

  // Debounce: only log a new 'login' if the last one is outside the window.
  const since = new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString();
  const recent = await fetch(
    `${base}/activity_log?owner_key=eq.${encodeURIComponent(owner)}` +
      `&action=eq.login&at=gte.${encodeURIComponent(since)}&select=id&limit=1`,
    { headers }
  );
  const hits = recent.ok ? await recent.json() : null;
  if (Array.isArray(hits) && hits.length) return; // already counted recently

  await fetch(`${base}/activity_log`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({
      owner_key: owner,
      action: 'login',
      detail: { email: session.email || null },
    }),
  });
}

export async function onRequestGet({ request, env, waitUntil }) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verify(cookies.radar_session, env.SESSION_SECRET);

  if (!session) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fire-and-forget: never awaited on the response path, never allowed to throw.
  try {
    const tracking = trackLogin(env, session).catch(() => {});
    if (typeof waitUntil === 'function') waitUntil(tracking);
  } catch (e) { /* tracking must never break auth */ }

  return new Response(
    JSON.stringify({
      ok: true,
      isAdmin: isAdminEmail(session.email, env),
      user: {
        sub: session.sub,
        email: session.email,
        name: session.name,
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
