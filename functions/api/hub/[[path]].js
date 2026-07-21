// functions/api/hub/[[path]].js
// Radar hub — now backed by SUPABASE (the Google Sheet + Apps Script are retired).
//
// Same contract the dashboard and extension already speak, so nothing else changes:
//   GET  /api/hub?callback=_cb&_=…                 -> { success, rows, excluded_leads }  (targets)
//   GET  /api/hub?callback=_cb&action=getSources   -> { success, sources }
//   GET  /api/hub?callback=_cb&action=getBridges   -> { success, bridges }
//   GET  /api/hub?callback=_cb&action=getConfig    -> { …config }
//   GET  /api/hub?callback=_cb&action=keyStatus    -> { botdog_set, resend_set, … }
//   POST /api/hub  { leads:[…] }                   -> ingest targets  (captures level/country/city/language!)
//   POST /api/hub  { action:'addSource'|'addBridges'|'setBridgeActive'|'deleteBridge'|
//                    'setConfig'|'logLogin'|'pushLog'|'clearDiscoverPending'|'feedback'|'setExcluded' }
//
// Owner is taken from the verified LinkedIn session for browser calls; the extension posts
// with the shared INGEST secret and no cookie, so those writes use the single-owner key.

import { verify } from '../../_lib/session.js';

const SUPABASE_URL = 'https://pkzeeqehwmtnqxdpdesl.supabase.co';
const INGEST_SECRET = 'radar_7Kq3mZ9pX2vL8nT';   // shared secret the extension already sends
const SOLO_OWNER   = 'xTVW0K1qKi';               // Olivier's owner_key (single-user today)

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => { const [k, ...r] = p.trim().split('='); if (k) out[k.trim()] = r.join('=').trim(); });
  return out;
}
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
// JSONP: the dashboard reads text and strips _cb( … ). Honor its callback name.
function jsonp(cb, obj) {
  return new Response((cb || '_cb') + '(' + JSON.stringify(obj) + ')', {
    status: 200, headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' }
  });
}

// --- Supabase REST helper (service key stays server-side) ---
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
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new Error(`supabase ${r.status}: ${String(text).slice(0, 180)}`);
  return body;
}
const enc = encodeURIComponent;

// ---- READ helpers ----
async function readTargets(env, owner) {
  const rows = await sb(env, `targets?owner_key=eq.${enc(owner)}&order=collected_date.desc&limit=5000`);
  // Shape each row to what the dashboard expects (it reads these keys directly).
  return (rows || []).map(t => ({
    collected_date: t.collected_date, first_name: t.first_name, last_name: t.last_name,
    title: t.title, company: t.company, linkedin_url: t.linkedin_url,
    radar_person: t.radar_person, lead_id: t.lead_id, botdog_pushed: t.botdog_pushed,
    connection: t.connection || '', country: t.country || '', city: t.city || '',
    language: t.language || '', grade: t.grade || '', selected: t.selected
  }));
}
async function readExcluded(env, owner) {
  const rows = await sb(env, `targets?owner_key=eq.${enc(owner)}&selected=eq.false&select=lead_id`);
  return (rows || []).map(r => r.lead_id).filter(Boolean);
}
async function readSources(env, owner) {
  const rows = await sb(env, `sources?owner_key=eq.${enc(owner)}&order=added_date.asc`);
  return (rows || []).map(s => ({ name: s.name, linkedin_url: s.linkedin_url, category: s.category, org_id: s.org_id, discover_keyword: s.discover_keyword, added_date: s.added_date }));
}
async function readBridges(env, owner) {
  const rows = await sb(env, `bridges?owner_key=eq.${enc(owner)}&order=added_date.asc&limit=5000`);
  return (rows || []).map(b => ({ source: b.source, name: b.name, title: b.title, urn: b.urn, linkedin_url: b.linkedin_url, connection: b.connection, active: b.active, added_date: b.added_date }));
}
async function readConfig(env, owner) {
  const rows = await sb(env, `config?owner_key=eq.${enc(owner)}`);
  const cfg = {}; (rows || []).forEach(r => { cfg[r.key] = r.value; });
  return cfg;
}
async function setConfigKeys(env, owner, obj) {
  const rows = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([key, value]) => ({ owner_key: owner, key, value: String(value), updated_at: new Date().toISOString() }));
  if (rows.length) await sb(env, 'config?on_conflict=owner_key,key', { method: 'POST', body: JSON.stringify(rows), prefer: 'resolution=merge-duplicates,return=minimal' });
}

// ---- resolve the owner for this request ----
async function resolveOwner(request, env, payloadSecret) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verify(cookies.radar_session, env.SESSION_SECRET);
  if (session && session.sub) {
    // Sessions carry owner_key since the multi-user login gate; verify status when possible.
    try {
      const filter = session.owner_key
        ? `owner_key=eq.${enc(session.owner_key)}`
        : `linkedin_sub=eq.${enc(session.sub)}`;
      const u = await sb(env, `users?${filter}&select=owner_key,status&limit=1`);
      if (u && u[0] && u[0].owner_key) {
        if (u[0].status === 'suspended' || u[0].status === 'pending') return { owner: null, authed: false };
        return { owner: u[0].owner_key, authed: true };
      }
    } catch (e) {}
    if (session.owner_key) return { owner: session.owner_key, authed: true };
    return { owner: SOLO_OWNER, authed: true };   // legacy cookie fallback
  }
  // Extension (no cookie): shared secret maps to the solo owner until per-user keys ship.
  if (payloadSecret && payloadSecret === INGEST_SECRET) return { owner: SOLO_OWNER, authed: true };
  return { owner: null, authed: false };
}

export async function onRequest({ request, env }) {
  if (!env.SUPABASE_SERVICE_KEY) return json({ ok: false, error: 'SUPABASE_SERVICE_KEY not configured' }, 500);
  const url = new URL(request.url);

  try {
    // ---------------- GET (reads, JSONP) ----------------
    if (request.method === 'GET') {
      const cb = url.searchParams.get('callback') || '_cb';
      const action = url.searchParams.get('action') || '';
      const { owner } = await resolveOwner(request, env, url.searchParams.get('secret'));
      const own = owner || SOLO_OWNER;   // legacy fallback: extension GETs carry no cookie (yet)

      if (!action) {  // bare call = targets list
        const [rows, excluded] = await Promise.all([readTargets(env, own), readExcluded(env, own)]);
        return jsonp(cb, { success: true, rows, excluded_leads: JSON.stringify(excluded) });
      }
      if (action === 'getSources') return jsonp(cb, { success: true, sources: await readSources(env, own) });
      if (action === 'getBridges') return jsonp(cb, { success: true, bridges: await readBridges(env, own) });
      if (action === 'getConfig')  return jsonp(cb, await readConfig(env, own));
      if (action === 'keyStatus') {
        const cfg = await readConfig(env, own);
        return jsonp(cb, {
          botdog_set: !!(env.BOTDOG_API_KEY || cfg.botdog_api_key),
          resend_set: !!(env.RESEND_API_KEY || cfg.resend_api_key),
          pappers_set: !!(env.PAPPERS_API_KEY || cfg.pappers_api_key),
          tested_at: new Date().toISOString()
        });
      }
      if (action === 'getBotdogCampaigns') return jsonp(cb, { campaigns: [] });  // handled by /api/botdog/campaigns
      return jsonp(cb, { success: false, error: 'unknown action: ' + action });
    }

    // ---------------- POST (writes) ----------------
    if (request.method === 'POST') {
      let p = {}; try { p = JSON.parse(await request.text()); } catch { return json({ ok: false, error: 'bad JSON body' }, 400); }
      const { owner, authed } = await resolveOwner(request, env, p.secret);
      if (!authed) return json({ ok: false, error: 'unauthenticated' }, 401);
      const own = owner;

      // --- INGEST targets (no action, has leads[]) — THIS captures level/country/city/language ---
      if (Array.isArray(p.leads)) {
        const rows = p.leads.filter(l => l && l.lead_id).map(l => ({
          owner_key: own,
          collected_date: l.collected_date || new Date().toISOString(),
          first_name: l.first_name || '', last_name: l.last_name || '',
          title: l.title || '', company: l.company || '', linkedin_url: l.linkedin_url || '',
          radar_person: l.radar_person || '', lead_id: l.lead_id,
          connection: l.connection || '', country: l.country || '', city: l.city || '', language: l.language || ''
        }));
        let inserted = 0;
        if (rows.length) {
          await sb(env, 'targets?on_conflict=owner_key,lead_id', {
            method: 'POST', body: JSON.stringify(rows),
            prefer: 'resolution=merge-duplicates,return=minimal'   // dedupe, and fill fields on re-collect
          });
          inserted = rows.length;
        }
        return json({ success: true, ok: true, received: p.leads.length, upserted: inserted });
      }

      const action = p.action || '';

      if (action === 'addSource') {
        const orgId = (String(p.linkedin_url || '').match(/(?:organization|company)\/(\d+)/) || [])[1] || p.org_id || null;
        await sb(env, 'sources?on_conflict=owner_key,name', {
          method: 'POST',
          body: JSON.stringify([{ owner_key: own, name: p.name, linkedin_url: p.linkedin_url || null, category: p.category || null, org_id: orgId, discover_keyword: p.discover_keyword || null, discover_pending: !!p.discover_now, added_date: new Date().toISOString() }]),
          prefer: 'resolution=merge-duplicates,return=minimal'
        });
        return json({ saved: true, ok: true });
      }

      if (action === 'addBridges') {
        const src = p.source || 'Manual';
        const rows = (p.bridges || []).filter(b => b && b.urn).map(b => ({
          owner_key: own, source: src, name: b.name || '', title: b.title || '', urn: b.urn,
          linkedin_url: b.linkedin_url || null, connection: b.connection || '',
          active: b.active === true, added_date: new Date().toISOString()
        }));
        let added = 0;
        if (rows.length) {
          // Upsert: new bridges land; existing ones get title/connection/url filled if non-empty.
          await sb(env, 'bridges?on_conflict=owner_key,urn', { method: 'POST', body: JSON.stringify(rows), prefer: 'resolution=merge-duplicates,return=minimal' });
          added = rows.length;
        }
        return json({ saved: true, ok: true, added });
      }

      if (action === 'setBridgeActive') {
        await sb(env, `bridges?owner_key=eq.${enc(own)}&urn=eq.${enc(p.urn)}`, { method: 'PATCH', body: JSON.stringify({ active: !!p.active }), prefer: 'return=minimal' });
        return json({ saved: true, ok: true });
      }

      if (action === 'deleteBridge') {
        await sb(env, `bridges?owner_key=eq.${enc(own)}&urn=eq.${enc(p.urn)}`, { method: 'DELETE', prefer: 'return=minimal' });
        return json({ saved: true, ok: true });
      }

      if (action === 'setExcluded') {
        // p.lead_id + p.excluded(bool): flip targets.selected. Kept forever so re-collection isn't "new".
        await sb(env, `targets?owner_key=eq.${enc(own)}&lead_id=eq.${enc(p.lead_id)}`, { method: 'PATCH', body: JSON.stringify({ selected: !p.excluded }), prefer: 'return=minimal' });
        return json({ saved: true, ok: true });
      }

      if (action === 'setConfig') {
        await setConfigKeys(env, own, {
          botdog_api_key: p.botdog_api_key, resend_api_key: p.resend_api_key, pappers_api_key: p.pappers_api_key,
          botdog_campaign_id: p.botdog_campaign_id, botdog_bridges_campaign_id: p.botdog_bridges_campaign_id
        });
        return json({ saved: true, ok: true });
      }

      if (action === 'logLogin') {
        try { await sb(env, 'activity_log', { method: 'POST', body: JSON.stringify([{ owner_key: own, action: 'login', detail: { email: p.email, name: p.name, linkedin_sub: p.linkedin_sub } }]), prefer: 'return=minimal' }); } catch (e) {}
        return json({ saved: true, ok: true });
      }

      if (action === 'feedback') {
        try { await sb(env, 'activity_log', { method: 'POST', body: JSON.stringify([{ owner_key: own, action: 'feedback', detail: { type: p.type, body: p.body, page: p.page } }]), prefer: 'return=minimal' }); } catch (e) {}
        return json({ saved: true, ok: true });
      }

      if (action === 'pushLog') {
        try { await sb(env, 'activity_log', { method: 'POST', body: JSON.stringify([{ owner_key: own, action: 'sync_log', detail: { log: (p.log || []).slice(0, 150) } }]), prefer: 'return=minimal' }); } catch (e) {}
        return json({ saved: true, ok: true });
      }

      if (action === 'clearDiscoverPending') {
        const names = p.names || [];
        if (names.length) {
          const list = names.map(n => `"${String(n).replace(/"/g, '')}"`).join(',');
          await sb(env, `sources?owner_key=eq.${enc(own)}&name=in.(${enc(list)})`, { method: 'PATCH', body: JSON.stringify({ discover_pending: false, discovered: true }), prefer: 'return=minimal' });
        }
        return json({ saved: true, ok: true });
      }

      return json({ ok: false, error: 'unknown action: ' + action }, 400);
    }

    return json({ ok: false, error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
