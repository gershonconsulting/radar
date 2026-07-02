// functions/api/auth/linkedin/callback.js
// LinkedIn OpenID Connect callback handler.
// 1. Validates CSRF state cookie.
// 2. Exchanges authorization code for tokens (server-side only — secret never leaves here).
// 3. Fetches user info from LinkedIn.
// 4. Checks email against ALLOWLIST env var.
// 5. Issues a signed HMAC session cookie.

import { sign } from '../../../_lib/session.js';

function parseCookies(header) {
    const result = {};
    (header || '').split(';').forEach(part => {
          const [k, ...rest] = part.trim().split('=');
          if (k) result[k.trim()] = rest.join('=').trim();
    });
    return result;
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

  // Allowlist check (server-side gate — never trust the client)
  const allowlist = (env.ALLOWLIST || '')
      .toLowerCase()
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

  if (!who.email || !allowlist.includes(who.email.toLowerCase())) {
        return Response.redirect('https://radar.gershoncrm.com/?denied=1', 302);
  }

  // Issue signed session cookie (owner id = LinkedIn `sub`)
  const token = await sign(
    { sub: who.sub, email: who.email, name: who.name, iat: Date.now() },
        env.SESSION_SECRET
      );

  const headers = new Headers({ Location: 'https://radar.gershoncrm.com/' });

  // Clear CSRF cookie
  headers.append('Set-Cookie', 'li_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');

  // Set long-lived session cookie (30 days)
  headers.append(
        'Set-Cookie',
        `radar_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
      );

  return new Response(null, { status: 302, headers });
}
