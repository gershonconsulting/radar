// functions/api/auth/linkedin/callback.js
// LinkedIn OpenID Connect callback handler.
// 1. Validates CSRF state cookie.
// 2. Exchanges authorization code for tokens (server-side only — secret never leaves here).
// 3. Fetches user info from LinkedIn.
// 4. Resolves the user against the Supabase `users` store (invite-only):
//      - match by linkedin_sub, then by email; claims invited rows on first login
//      - legacy ALLOWLIST emails claim the solo owner row (bootstrap for Olivier)
//      - unknown users get a `pending` row and land on /?pending=1 (request access)
//      - suspended users land on /?denied=1
//    If Supabase isn't configured, falls back to the old ALLOWLIST-only gate so
//    login can never break.
// 5. Issues a signed HMAC session cookie carrying { sub, email, name, owner_key, adm }.

import { sign } from '../../../_lib/session.js';

const SUPABASE_URL = 'https://pkzeeqehwmtnqxdpdesl.supabase.co';
const SOLO_OWNER = 'xTVW0K1qKi'; // pre-multi-user owner of all existing data

function parseCookies(header) {
  const result = {};
  (header || '').split(';').forEach(part => {
    const [k, ...rest] = part.trim().split('=');
    if (k) result[k.trim()] = rest.join('=').trim();
  });
  return result;
}

async function sb(env, path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new Error(`supabase ${r.status}: ${String(text).slice(0, 180)}`);
  return body;
}

function allowlisted(email, env) {
  const list = (env.ALLOWLIST || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return !!email && list.includes(String(email).toLowerCase());
}

function makeOwnerKey() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const enc = encodeURIComponent;

// Find (and claim) the users row for this LinkedIn identity.
// Returns { user } or null when the user is unknown.
async function resolveUser(env, who) {
  // 1. Exact match on linkedin_sub (returning user).
  let rows = await sb(env, `users?linkedin_sub=eq.${enc(who.sub)}&select=*&limit=1`);
  if (rows && rows.length) return { user: rows[0] };

  const email = String(who.email || '').toLowerCase();

  // 2. Invited by email — claim the row by writing the sub.
  if (email) {
    rows = await sb(env, `users?email=eq.${enc(email)}&linkedin_sub=is.null&select=*&limit=1`);
    if (rows && rows.length) {
      const claimed = await sb(env, `users?id=eq.${enc(rows[0].id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ linkedin_sub: who.sub, display_name: rows[0].display_name || who.name || null })
      });
      return { user: (claimed && claimed[0]) || rows[0] };
    }
  }

  // 3. Legacy ALLOWLIST bootstrap: attach to the solo owner row if it's unclaimed.
  if (allowlisted(email, env)) {
    rows = await sb(env, `users?owner_key=eq.${enc(SOLO_OWNER)}&select=*&limit=1`);
    if (rows && rows.length && !rows[0].linkedin_sub) {
      const patch = { linkedin_sub: who.sub, status: 'active' };
      if (!rows[0].email && email) patch.email = email;
      if (!rows[0].display_name && who.name) patch.display_name = who.name;
      const claimed = await sb(env, `users?id=eq.${enc(rows[0].id)}`, {
        method: 'PATCH', body: JSON.stringify(patch)
      });
      return { user: (claimed && claimed[0]) || rows[0] };
    }
    // Solo row already claimed — create an active row for this allowlisted email.
    const created = await sb(env, 'users', {
      method: 'POST',
      body: JSON.stringify({
        owner_key: makeOwnerKey(), email: email || null, display_name: who.name || null,
        linkedin_sub: who.sub, status: 'active', is_admin: false
      })
    });
    return { user: created && created[0] };
  }

  return null; // unknown user
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(request.headers.get('Cookie'));

  // CSRF check
  if (!code || !state || state !== cookies.li_state) {
    return new Response('Bad state — possible CSRF. Please try signing in again.', { status: 400 });
  }

  // Exchange authorization code for tokens (LINKEDIN_CLIENT_SECRET only used here, server-side)
  let tok;
  try {
    const tokenResp = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.LINKEDIN_REDIRECT_URI,
        client_id: env.LINKEDIN_CLIENT_ID,
        client_secret: env.LINKEDIN_CLIENT_SECRET,
      }),
    });
    tok = await tokenResp.json();
  } catch (err) {
    return new Response('Token exchange failed: ' + String(err), { status: 502 });
  }

  if (!tok.access_token) {
    return new Response('LinkedIn returned no access token: ' + JSON.stringify(tok), { status: 502 });
  }

  // Fetch identity claims (OpenID Connect userinfo)
  let who;
  try {
    const infoResp = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + tok.access_token },
    });
    who = await infoResp.json(); // { sub, email, name, given_name, family_name, ... }
  } catch (err) {
    return new Response('Userinfo fetch failed: ' + String(err), { status: 502 });
  }

  const deny = (flag) => Response.redirect('https://radar.gershoncrm.com/app.html?' + flag + '=1', 302);

  // ---- Resolve against the users store (invite-only gate) ----
  let user = null;
  if (env.SUPABASE_SERVICE_KEY) {
    try {
      const hit = await resolveUser(env, who);

      if (!hit || !hit.user) {
        // Unknown user → record an access request (pending) once, then show the pending state.
        try {
          await sb(env, 'users', {
            method: 'POST',
            body: JSON.stringify({
              owner_key: makeOwnerKey(), email: String(who.email || '').toLowerCase() || null,
              display_name: who.name || null, linkedin_sub: who.sub, status: 'pending', is_admin: false
            }),
            prefer: 'return=minimal'
          });
        } catch (e) { /* row may already exist from a prior attempt */ }
        return deny('pending');
      }

      user = hit.user;
      if (user.status === 'suspended') return deny('denied');
      if (user.status === 'pending') return deny('pending');

      // invited → active on first successful login; stamp last_login.
      try {
        await sb(env, `users?id=eq.${enc(user.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'active', last_login_at: new Date().toISOString() }),
          prefer: 'return=minimal'
        });
        await sb(env, 'activity_log', {
          method: 'POST',
          body: JSON.stringify({ owner_key: user.owner_key, action: 'login', detail: { email: who.email || null, via: 'oauth' } }),
          prefer: 'return=minimal'
        });
      } catch (e) { /* non-fatal */ }
    } catch (e) {
      // Supabase down — fall back to the ALLOWLIST so the owner is never locked out.
      if (!allowlisted(who.email, env)) return deny('denied');
    }
  } else {
    // No Supabase configured — legacy ALLOWLIST-only behavior.
    if (!allowlisted(who.email, env)) return deny('denied');
  }

  // Issue signed session cookie
  const token = await sign(
    {
      sub: who.sub, email: who.email, name: who.name,
      owner_key: (user && user.owner_key) || null,
      adm: !!(user && user.is_admin),
      iat: Date.now()
    },
    env.SESSION_SECRET
  );

  const headers = new Headers({ Location: 'https://radar.gershoncrm.com/app.html' });
  headers.append('Set-Cookie', 'li_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  headers.append('Set-Cookie', `radar_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  return new Response(null, { status: 302, headers });
}
