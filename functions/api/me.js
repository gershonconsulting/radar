// functions/api/me.js
// Returns the currently authenticated user from the session cookie.
// Called by the frontend gate on every page load.
// 200 + user object = authenticated; 401 = not signed in (or suspended).
//
// isAdmin = users.is_admin (DB) OR session.adm (stamped at login) OR ADMIN_EMAILS env.
// Suspended users are rejected here even if they still hold a valid cookie.

import { verify } from '../_lib/session.js';

const SUPABASE_URL = 'https://pkzeeqehwmtnqxdpdesl.supabase.co';
const SOLO_OWNER = 'xTVW0K1qKi';

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

function allowlisted(email, env) {
  const list = (env.ALLOWLIST || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return !!email && list.includes(String(email).toLowerCase());
}

const enc = encodeURIComponent;

async function sbFetch(env, path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!r.ok) throw new Error('supabase ' + r.status);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// Look up the users row for this session: owner_key → sub → email.
// Legacy cookies (no owner_key) from allowlisted emails claim the unclaimed solo row.
async function findUser(env, session) {
  if (!env.SUPABASE_SERVICE_KEY) return null;
  if (session.owner_key) {
    const rows = await sbFetch(env, `users?owner_key=eq.${enc(session.owner_key)}&select=*&limit=1`);
    if (rows && rows.length) return rows[0];
  }
  if (session.sub) {
    const rows = await sbFetch(env, `users?linkedin_sub=eq.${enc(session.sub)}&select=*&limit=1`);
    if (rows && rows.length) return rows[0];
  }
  const email = String(session.email || '').toLowerCase();
  if (email) {
    const rows = await sbFetch(env, `users?email=eq.${enc(email)}&select=*&limit=1`);
    if (rows && rows.length) {
      // Claim: bind this LinkedIn sub to the row if it has none yet.
      if (!rows[0].linkedin_sub && session.sub) {
        try {
          await sbFetch(env, `users?id=eq.${enc(rows[0].id)}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ linkedin_sub: session.sub })
          });
        } catch (e) { /* non-fatal */ }
      }
      return rows[0];
    }
  }
  // Bootstrap: allowlisted legacy session, no row matched — claim the unclaimed solo row.
  if (allowlisted(email, env) && session.sub) {
    const rows = await sbFetch(env, `users?owner_key=eq.${enc(SOLO_OWNER)}&select=*&limit=1`);
    if (rows && rows.length && !rows[0].linkedin_sub) {
      try {
        await sbFetch(env, `users?id=eq.${enc(rows[0].id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ linkedin_sub: session.sub, status: 'active' })
        });
      } catch (e) { /* non-fatal */ }
      return rows[0];
    }
  }
  return null;
}

// --- Best-effort login tracking (debounced to one 'login' row per 30 min) ---
const LOGIN_WINDOW_MS = 30 * 60 * 1000;

async function trackLogin(env, session, owner) {
  if (!env.SUPABASE_SERVICE_KEY || !owner) return;
  const base = `${SUPABASE_URL}/rest/v1`;
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  const now = new Date();

  await fetch(`${base}/users?owner_key=eq.${enc(owner)}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ last_login_at: now.toISOString() }),
  });

  const since = new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString();
  const recent = await fetch(
    `${base}/activity_log?owner_key=eq.${enc(owner)}` +
      `&action=eq.login&at=gte.${enc(since)}&select=id&limit=1`,
    { headers }
  );
  const hits = recent.ok ? await recent.json() : null;
  if (Array.isArray(hits) && hits.length) return;

  await fetch(`${base}/activity_log`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ owner_key: owner, action: 'login', detail: { email: session.email || null } }),
  });
}

export async function onRequestGet({ request, env, waitUntil }) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verify(cookies.radar_session, env.SESSION_SECRET);

  const unauthed = () => new Response(JSON.stringify({ ok: false }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      // Kill the cookie so a suspended/unknown user drops back to the sign-in screen.
      'Set-Cookie': 'radar_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    },
  });

  if (!session) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Resolve the user row (best-effort — DB being down never locks the app).
  let user = null;
  try { user = await findUser(env, session); } catch (e) { user = null; }

  if (user && user.status === 'suspended') return unauthed();

  const owner = (user && user.owner_key) || session.owner_key || null;
  const isAdmin = !!(user && user.is_admin) || !!session.adm || isAdminEmail(session.email, env);

  try {
    const tracking = trackLogin(env, session, owner).catch(() => {});
    if (typeof waitUntil === 'function') waitUntil(tracking);
  } catch (e) { /* tracking must never break auth */ }

  return new Response(
    JSON.stringify({
      ok: true,
      isAdmin,
      user: {
        sub: session.sub,
        email: session.email,
        name: session.name,
        owner_key: owner,
        status: (user && user.status) || null,
        onboarding: user ? {
          linkedin: !!user.linkedin_sub,
          sales_nav: !!user.sales_nav_ok,
          extension: !!user.extension_ok,
          botdog: !!user.botdog_ok,
          onboarded_at: user.onboarded_at || null
        } : null
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
