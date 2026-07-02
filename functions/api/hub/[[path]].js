// functions/api/hub/[[path]].js
// Authenticated proxy to the Apps Script hub.
// 1. Validates the session cookie (server-side — owner cannot be spoofed).
// 2. Injects the verified `owner` (LinkedIn sub) into every request.
// 3. Forwards the request to the Apps Script web app with HUB_SECRET.
// 4. The browser never sees HUB_SECRET or sends an unverified owner.
//
// GET  /api/hub?action=getSources    → hub?action=getSources&owner=<sub>&secret=<HUB_SECRET>
// POST /api/hub                      → hub with JSON body containing owner + secret
// GET  /api/hub?callback=_cb&...     → JSONP preserved (passes callback through)

import { verify } from '../../_lib/session.js';

// Apps Script webapp URL — public, but every call is gated by HUB_SECRET
const HUB_URL = 'https://script.google.com/macros/s/AKfycbzFX-DPwGDGFPoIxdYwNq5mMztXHNs33PHUNQox-vgrvQbgA2KLccMN9DI-YURCIWxbPw/exec';

function parseCookies(header) {
    const result = {};
    (header || '').split(';').forEach(part => {
          const [k, ...rest] = part.trim().split('=');
          if (k) result[k.trim()] = rest.join('=').trim();
    });
    return result;
}

export async function onRequest({ request, env }) {
    // Authenticate
  const cookies = parseCookies(request.headers.get('Cookie'));
    const session = await verify(cookies.radar_session, env.SESSION_SECRET);

  if (!session) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthenticated' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
        });
  }

  const owner = session.sub; // LinkedIn sub — server-verified, cannot be faked by client

  if (request.method === 'GET') {
        // Forward GET with owner + secret appended as query params
      const incoming = new URL(request.url);
        const upstream = new URL(HUB_URL);

      // Copy all original params
      for (const [k, v] of incoming.searchParams) {
              upstream.searchParams.set(k, v);
      }

      // Inject auth — overwrite any client-supplied owner/secret
      upstream.searchParams.set('owner', owner);
        upstream.searchParams.set('secret', env.HUB_SECRET);

      const resp = await fetch(upstream.toString(), { method: 'GET' });
        const body = await resp.text();

      return new Response(body, {
              status: resp.status,
              headers: {
                        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
                        'Cache-Control': 'no-store',
              },
      });
  }

  if (request.method === 'POST') {
        // Parse incoming body, inject owner + secret, forward
      let payload = {};
        try {
                const raw = await request.text();
                payload = JSON.parse(raw);
        } catch {
                return new Response(JSON.stringify({ ok: false, error: 'bad JSON body' }), {
                          status: 400,
                          headers: { 'Content-Type': 'application/json' },
                });
        }

      // Overwrite any client-supplied owner/secret — trust only our session
      payload.owner = owner;
        payload.secret = env.HUB_SECRET;

      const resp = await fetch(HUB_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify(payload),
      });
        const body = await resp.text();

      return new Response(body, {
              status: resp.status,
              headers: {
                        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
                        'Cache-Control': 'no-store',
              },
      });
  }

  return new Response('Method not allowed', { status: 405 });
}
