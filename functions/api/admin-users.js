// functions/api/admin-users.js
// Admin-only user management, talking DIRECTLY to Supabase (no Apps Script hub).
//
// GET  /api/admin-users  -> every Radar user + per-user stats
//                           (sources / bridges / targets counts, last_login_at, login_count)
// POST /api/admin-users  {linkedin_url, display_name, email}
//                        -> invite/create a user with a fresh random owner_key
//
// 401 unauthenticated / 403 unless the session email is in ADMIN_EMAILS.
// The Supabase service key stays server-side (env.SUPABASE_SERVICE_KEY), never in the browser.
//
// NOTE: the `users` table has no `status`/`invited_at` columns, so an "invited" user is
// simply a row with an owner_key but no linkedin_sub (they've never signed in). The
// GET response exposes that as a derived `status` field; nothing is persisted for it.

import { verify } from '../_lib/session.js';

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const [k, ...rest] = p.trim().split('=');
    if (k) out[k.trim()] = rest.join('=').trim();
  });
  return out;
}

const json = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

function isAdminEmail(email, env) {
  const admins = (env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return admins.includes(String(email || '').toLowerCase());
}

// --- Supabase REST helper (same pattern as enrich-company.js) ---
async function sb(env, path, opts = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1/${path}`;
  const r = await fetch(url, {
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
  if (!r.ok) throw new Error(`supabase ${r.status}: ${String(text).slice(0, 200)}`);
  return { body, headers: r.headers };
}

// Exact row count without hauling the rows over the wire: HEAD + count=exact
// returns "Content-Range: 0-24/206"; we want the total after the slash.
async function countRows(env, table, ownerKey, extraFilter) {
  const filter = `owner_key=eq.${encodeURIComponent(ownerKey)}` + (extraFilter ? `&${extraFilter}` : '');
  const { headers } = await sb(env, `${table}?${filter}&select=owner_key`, {
    method: 'HEAD',
    prefer: 'count=exact'
  });
  const range = headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

// 10-char alphanumeric, matching the shape of the existing owner keys (e.g. 'xTVW0K1qKi').
function makeOwnerKey() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = '';
  // Modulo bias over a 62-char alphabet is negligible here: this is an opaque
  // identifier with a uniqueness check below, not a secret.
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function normalizeLinkedInUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '').split('?')[0];
}

export async function onRequest({ request, env }) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verify(cookies.radar_session, env.SESSION_SECRET);

  if (!session) return json({ ok: false, error: 'unauthenticated' }, 401);
  if (!isAdminEmail(session.email, env)) return json({ ok: false, error: 'forbidden' }, 403);

  try {
    // ---- List every user with their per-user stats ----
    if (request.method === 'GET') {
      const { body: users } = await sb(env, 'users?select=*&order=created_at.asc');

      const rows = await Promise.all((users || []).map(async (u) => {
        const [sources, bridges, targets, logins] = await Promise.all([
          countRows(env, 'sources', u.owner_key),
          countRows(env, 'bridges', u.owner_key),
          countRows(env, 'targets', u.owner_key),
          countRows(env, 'activity_log', u.owner_key, 'action=eq.login')
        ]);
        return {
          id: u.id,
          owner_key: u.owner_key,
          email: u.email || '',
          display_name: u.display_name || '',
          linkedin_url: u.linkedin_url || '',
          linkedin_sub: u.linkedin_sub || null,
          is_admin: !!u.is_admin,
          created_at: u.created_at || null,
          last_login_at: u.last_login_at || null,
          login_count: logins,
          // Derived, not stored: a user who has never completed LinkedIn OIDC has no sub.
          status: u.linkedin_sub ? 'active' : 'invited',
          stats: { sources, bridges, targets }
        };
      }));

      return json({ ok: true, users: rows });
    }

    // ---- Invite / create a user ----
    if (request.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await request.text()) || '{}'); }
      catch { return json({ ok: false, error: 'bad JSON body' }, 400); }

      const linkedinUrl = normalizeLinkedInUrl(body.linkedin_url);
      if (!/linkedin\.com\/in\//i.test(linkedinUrl)) {
        return json({ ok: false, error: 'linkedin_url must be a LinkedIn profile URL (linkedin.com/in/...)' }, 400);
      }

      const email = String(body.email || '').trim().toLowerCase();
      if (email && email.indexOf('@') === -1) {
        return json({ ok: false, error: 'email is not a valid address' }, 400);
      }
      const displayName = String(body.display_name || '').trim();

      // Already invited? Match on the profile URL (the only stable pre-login identifier)
      // and fall back to email. Return the existing row rather than minting a second key.
      const { body: byUrl } = await sb(
        env,
        `users?linkedin_url=eq.${encodeURIComponent(linkedinUrl)}&select=*&limit=1`
      );
      if (byUrl && byUrl.length) {
        return json({ ok: true, existing: true, user: byUrl[0] });
      }
      if (email) {
        const { body: byEmail } = await sb(
          env,
          `users?email=eq.${encodeURIComponent(email)}&select=*&limit=1`
        );
        if (byEmail && byEmail.length) {
          return json({ ok: true, existing: true, user: byEmail[0] });
        }
      }

      // Fresh owner_key, re-rolled on the (vanishingly unlikely) collision.
      let ownerKey = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = makeOwnerKey();
        const { body: clash } = await sb(
          env,
          `users?owner_key=eq.${encodeURIComponent(candidate)}&select=owner_key&limit=1`
        );
        if (!clash || !clash.length) { ownerKey = candidate; break; }
      }
      if (!ownerKey) return json({ ok: false, error: 'could not allocate a unique owner_key' }, 500);

      // Upsert on owner_key, per the table's unique constraint.
      const row = {
        owner_key: ownerKey,
        email: email || null,
        display_name: displayName || null,
        linkedin_url: linkedinUrl,
        is_admin: false
      };
      const { body: created } = await sb(env, 'users?on_conflict=owner_key', {
        method: 'POST',
        body: JSON.stringify(row),
        prefer: 'resolution=merge-duplicates,return=representation'
      });

      const user = Array.isArray(created) ? created[0] : created;

      // Audit trail. Best-effort: a failed log must not fail the invite.
      try {
        await sb(env, 'activity_log', {
          method: 'POST',
          body: JSON.stringify({
            owner_key: ownerKey,
            action: 'invited',
            detail: { by: session.email, linkedin_url: linkedinUrl, email: email || null }
          }),
          prefer: 'return=minimal'
        });
      } catch (e) { /* non-fatal */ }

      return json({ ok: true, existing: false, user });
    }

    return json({ ok: false, error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
