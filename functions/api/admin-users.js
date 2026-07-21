// functions/api/admin-users.js
// Admin-only user management, talking DIRECTLY to Supabase (no Apps Script hub).
//
// GET    /api/admin-users  -> every Radar user + per-user stats
//                             (sources / bridges / targets counts, last_login_at, login_count)
// POST   /api/admin-users  {linkedin_url?, email?, display_name?}
//                          -> invite/create a user with a fresh random owner_key
// PATCH  /api/admin-users  {owner_key, status?, is_admin?, display_name?, email?,
//                           sales_nav_ok?, extension_ok?, botdog_ok?}
//                          -> update a user (approve / suspend / promote / flags)
// DELETE /api/admin-users  {owner_key} -> remove the user row (their data rows stay)
//
// 401 unauthenticated / 403 unless the caller is an admin:
//   users.is_admin (DB) OR session.adm (stamped at login) OR ADMIN_EMAILS env.
// The Supabase service key stays server-side (env.SUPABASE_SERVICE_KEY), never in the browser.

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

// --- Supabase REST helper ---
async function sb(env, path, opts = {}) {
  const url = `${env.SUPABASE_URL || 'https://pkzeeqehwmtnqxdpdesl.supabase.co'}/rest/v1/${path}`;
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

const enc = encodeURIComponent;

// Resolve the caller's users row (for is_admin + self-action guards).
async function callerRow(env, session) {
  try {
    const filters = [];
    if (session.owner_key) filters.push(`owner_key.eq.${session.owner_key}`);
    if (session.sub) filters.push(`linkedin_sub.eq.${session.sub}`);
    if (session.email) filters.push(`email.eq.${String(session.email).toLowerCase()}`);
    if (!filters.length) return null;
    const { body } = await sb(env, `users?or=(${enc(filters.join(','))})&select=*&limit=1`);
    return (body && body[0]) || null;
  } catch (e) { return null; }
}

// Exact row count without hauling the rows over the wire: HEAD + count=exact
async function countRows(env, table, ownerKey, extraFilter) {
  const filter = `owner_key=eq.${enc(ownerKey)}` + (extraFilter ? `&${extraFilter}` : '');
  const { headers } = await sb(env, `${table}?${filter}&select=owner_key`, {
    method: 'HEAD',
    prefer: 'count=exact'
  });
  const range = headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

// 10-char alphanumeric, matching the shape of the existing owner keys.
function makeOwnerKey() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function normalizeLinkedInUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '').split('?')[0];
}

const STATUSES = ['pending', 'invited', 'active', 'suspended'];

async function audit(env, ownerKey, action, detail) {
  try {
    await sb(env, 'activity_log', {
      method: 'POST',
      body: JSON.stringify({ owner_key: ownerKey, action, detail }),
      prefer: 'return=minimal'
    });
  } catch (e) { /* non-fatal */ }
}

export async function onRequest({ request, env }) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verify(cookies.radar_session, env.SESSION_SECRET);

  if (!session) return json({ ok: false, error: 'unauthenticated' }, 401);

  const me = await callerRow(env, session);
  const isAdmin = !!(me && me.is_admin) || !!session.adm || isAdminEmail(session.email, env);
  if (!isAdmin) return json({ ok: false, error: 'forbidden' }, 403);

  const myOwnerKey = (me && me.owner_key) || session.owner_key || null;

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
          status: u.status || (u.linkedin_sub ? 'active' : 'invited'),
          invited_by: u.invited_by || null,
          onboarding: {
            linkedin: !!u.linkedin_sub,
            sales_nav: !!u.sales_nav_ok,
            extension: !!u.extension_ok,
            botdog: !!u.botdog_ok,
            onboarded_at: u.onboarded_at || null
          },
          stats: { sources, bridges, targets }
        };
      }));

      return json({ ok: true, users: rows, me: { owner_key: myOwnerKey } });
    }

    // ---- Invite / create a user ----
    if (request.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await request.text()) || '{}'); }
      catch { return json({ ok: false, error: 'bad JSON body' }, 400); }

      const linkedinUrl = normalizeLinkedInUrl(body.linkedin_url);
      const email = String(body.email || '').trim().toLowerCase();
      const displayName = String(body.display_name || '').trim();

      if (linkedinUrl && !/linkedin\.com\/in\//i.test(linkedinUrl)) {
        return json({ ok: false, error: 'linkedin_url must be a LinkedIn profile URL (linkedin.com/in/...)' }, 400);
      }
      if (email && email.indexOf('@') === -1) {
        return json({ ok: false, error: 'email is not a valid address' }, 400);
      }
      if (!email && !linkedinUrl) {
        return json({ ok: false, error: 'provide an email (recommended) or a LinkedIn profile URL' }, 400);
      }

      // Already invited? Match on email first (the login-matching identifier), then URL.
      if (email) {
        const { body: byEmail } = await sb(env, `users?email=eq.${enc(email)}&select=*&limit=1`);
        if (byEmail && byEmail.length) return json({ ok: true, existing: true, user: byEmail[0] });
      }
      if (linkedinUrl) {
        const { body: byUrl } = await sb(env, `users?linkedin_url=eq.${enc(linkedinUrl)}&select=*&limit=1`);
        if (byUrl && byUrl.length) return json({ ok: true, existing: true, user: byUrl[0] });
      }

      // Fresh owner_key, re-rolled on the (vanishingly unlikely) collision.
      let ownerKey = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = makeOwnerKey();
        const { body: clash } = await sb(env, `users?owner_key=eq.${enc(candidate)}&select=owner_key&limit=1`);
        if (!clash || !clash.length) { ownerKey = candidate; break; }
      }
      if (!ownerKey) return json({ ok: false, error: 'could not allocate a unique owner_key' }, 500);

      const row = {
        owner_key: ownerKey,
        email: email || null,
        display_name: displayName || null,
        linkedin_url: linkedinUrl || null,
        is_admin: false,
        status: 'invited',
        invited_by: session.email || null
      };
      const { body: created } = await sb(env, 'users?on_conflict=owner_key', {
        method: 'POST',
        body: JSON.stringify(row),
        prefer: 'resolution=merge-duplicates,return=representation'
      });

      const user = Array.isArray(created) ? created[0] : created;
      await audit(env, ownerKey, 'invited', { by: session.email, linkedin_url: linkedinUrl || null, email: email || null });
      return json({ ok: true, existing: false, user });
    }

    // ---- Update a user (approve / suspend / promote / flags) ----
    if (request.method === 'PATCH') {
      let body = {};
      try { body = JSON.parse((await request.text()) || '{}'); }
      catch { return json({ ok: false, error: 'bad JSON body' }, 400); }

      const target = String(body.owner_key || '').trim();
      if (!target) return json({ ok: false, error: 'owner_key required' }, 400);

      const patch = {};
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) return json({ ok: false, error: 'bad status' }, 400);
        patch.status = body.status;
      }
      if (body.is_admin !== undefined) patch.is_admin = !!body.is_admin;
      if (body.display_name !== undefined) patch.display_name = String(body.display_name).trim() || null;
      if (body.email !== undefined) {
        const e = String(body.email).trim().toLowerCase();
        if (e && e.indexOf('@') === -1) return json({ ok: false, error: 'email is not a valid address' }, 400);
        patch.email = e || null;
      }
      ['sales_nav_ok', 'extension_ok', 'botdog_ok'].forEach(k => {
        if (body[k] !== undefined) patch[k] = !!body[k];
      });
      if (!Object.keys(patch).length) return json({ ok: false, error: 'nothing to update' }, 400);

      // Lockout guards: an admin cannot suspend or demote themself.
      if (target === myOwnerKey) {
        if (patch.status === 'suspended') return json({ ok: false, error: "you can't suspend yourself" }, 400);
        if (patch.is_admin === false) return json({ ok: false, error: "you can't remove your own admin role" }, 400);
      }

      const { body: updated } = await sb(env, `users?owner_key=eq.${enc(target)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch)
      });
      if (!updated || !updated.length) return json({ ok: false, error: 'user not found' }, 404);

      await audit(env, target, 'user_updated', { by: session.email, patch });
      return json({ ok: true, user: updated[0] });
    }

    // ---- Delete a user row (their collected data stays, orphaned by owner_key) ----
    if (request.method === 'DELETE') {
      let body = {};
      try { body = JSON.parse((await request.text()) || '{}'); }
      catch { return json({ ok: false, error: 'bad JSON body' }, 400); }

      const target = String(body.owner_key || '').trim();
      if (!target) return json({ ok: false, error: 'owner_key required' }, 400);
      if (target === myOwnerKey) return json({ ok: false, error: "you can't delete yourself" }, 400);

      const { body: deleted } = await sb(env, `users?owner_key=eq.${enc(target)}`, {
        method: 'DELETE'
      });
      if (!deleted || !deleted.length) return json({ ok: false, error: 'user not found' }, 404);

      await audit(env, target, 'user_deleted', { by: session.email, email: deleted[0].email || null });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
