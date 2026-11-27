// functions/_lib/team.js (2026-11-26, app v1.25.0) - Radar team access.
// Olivier 2026-11-26: "We need to be able to give access to the Radar platform to others. For instance
// Amos (Meteor Biotech) has two people that should be able to access the platform on his behalf.
// Settings: a place for users and access options Full, Semi, Viewer. Dedicated LinkedIn + email field.
// Login with LinkedIn."
//
// Storage: one config row per account, key 'team_members', value = JSON array (no schema change).
//   { id, name, email (optional since v1.27.1), linkedin_url, role: full|semi|viewer, status: invited|active,
//     token (personal invite link secret, v1.27.1),
//     sub (LinkedIn OIDC sub, bound on first sign-in), invited_at, invited_by, last_login_at }
// A member signs in with LinkedIn; the match is the EMAIL of their LinkedIn account (OIDC gives no
// profile URL), then their sub once bound. Removed members are deleted from the list.
//
// Roles
//   full   - everything the owner can do: Settings (ICP link, Sales Nav lists, keys, Botdog) + Team
//   semi   - works the campaign: add sources/bridges, switch bridges on/off, priorities, exclude
//            prospects, re-run discovery. No Settings, no deletes, no Team changes.
//   viewer - read only.
// A member's own Chrome extension is never linked to the account (the app does not relay the owner
// key to it): collection stays on the owner's LinkedIn.

export const TEAM_KEY = 'team_members';
export const ROLES = ['full', 'semi', 'viewer'];
export const ROLE_LABELS = { owner: 'Owner', full: 'Full', semi: 'Semi', viewer: 'Viewer' };
export const MAX_MEMBERS = 10;

// Hub write actions a SEMI member may perform (anything else needs full/owner).
const SEMI_ACTIONS = new Set(['addSource', 'addBridges', 'setBridgeActive', 'setSourcePriority', 'queueDiscover', 'feedback', 'logLogin']);
const VIEWER_ACTIONS = new Set(['feedback', 'logLogin', 'pushLog']);
// setConfig keys a semi member may write (excluding prospects is campaign work, not a setting).
const SEMI_CONFIG_KEYS = new Set(['excluded_leads']);

export function normEmail(e) { return String(e || '').trim().toLowerCase(); }

export function isEmail(e) { return /^[^\s@,;"'<>]+@[^\s@,;"'<>]+\.[a-z]{2,}$/i.test(String(e || '').trim()); }

// Accepts linkedin.com/in/<slug> (any subdomain, with or without https, trailing slash/query).
export function normLinkedin(u) {
  const s = String(u || '').trim();
  const m = s.match(/^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%.]+)\/?(?:[?#].*)?$/i);
  return m ? 'https://www.linkedin.com/in/' + m[1].replace(/\/$/, '') : null;
}

export function parseTeam(value) {
  if (!value) return [];
  try {
    const arr = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(arr) ? arr.filter(m => m && (m.email || m.token) && ROLES.includes(m.role)) : [];
  } catch (e) { return []; }
}

export function findMember(list, who) {
  const sub = who && who.sub ? String(who.sub) : '';
  const email = normEmail(who && who.email);
  return (list || []).find(m => (sub && m.sub && m.sub === sub)) ||
         // email match only while the row is not yet bound to another LinkedIn identity
         (list || []).find(m => email && normEmail(m.email) === email && (!m.sub || m.sub === sub)) || null;
}

// Validate an invite / update. Returns { ok, error, member }.
export function validateInvite(body, list, now = new Date().toISOString(), by = '') {
  const name = String(body.name || '').trim().slice(0, 120);
  const email = normEmail(body.email);
  const li = normLinkedin(body.linkedin_url);
  const role = String(body.role || '').toLowerCase();
  if (email && !isEmail(email)) return { ok: false, error: 'This email does not look right (or leave it empty and send the invite link).' };
  if (!li) return { ok: false, error: 'Enter their LinkedIn profile link (linkedin.com/in/...).' };
  if (!ROLES.includes(role)) return { ok: false, error: 'Pick an access level: Full, Semi or Viewer.' };
  if (email && (list || []).some(m => normEmail(m.email) === email)) return { ok: false, error: 'This email already has access.' };
  if ((list || []).some(m => m.linkedin_url && m.linkedin_url.toLowerCase() === li.toLowerCase())) return { ok: false, error: 'This LinkedIn profile already has access.' };
  if ((list || []).length >= MAX_MEMBERS) return { ok: false, error: 'Limit reached (' + MAX_MEMBERS + ' people per account).' };
  const id = 'm' + Math.random().toString(36).slice(2, 10);
  return { ok: true, member: { id, name, email: email || '', linkedin_url: li, role, status: 'invited', sub: null, token: makeToken(), invited_at: now, invited_by: by, last_login_at: null } };
}

export function makeToken() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  let t = ''; for (let i = 0; i < b.length; i++) t += A[b[i] % A.length];
  return t;
}
export function inviteUrl(origin, m) { return m && m.token ? origin + '/api/auth/linkedin/login?invite=' + m.token : ''; }

// Member whose personal invite link this is: unclaimed, or already claimed by this same LinkedIn identity.
export function findByToken(list, token, sub) {
  if (!token) return null;
  return (list || []).find(m => m.token && m.token === token && (!m.sub || m.sub === sub)) || null;
}

// Accounts whose team list holds this invite token. sb(path) = Supabase REST GET.
export async function findInvite(sb, token, sub) {
  if (!/^[A-Za-z0-9]{20,64}$/.test(String(token || ''))) return null;
  const rows = await sb(`config?key=eq.${TEAM_KEY}&value=like.${encodeURIComponent('*' + token + '*')}&select=owner_key,value&limit=5`);
  for (const r of rows || []) {
    const m = findByToken(parseTeam(r.value), token, sub);
    if (m) return { owner_key: r.owner_key, member: m };
  }
  return null;
}

// What a member list looks like to the browser (no LinkedIn sub). Only owners / Full members get the list.
export function publicMember(m, origin = '') {
  return { id: m.id, name: m.name || '', email: m.email || '', linkedin_url: m.linkedin_url || '', role: m.role,
           invite_url: origin ? inviteUrl(origin, m) : '',
           status: m.status || 'invited', invited_at: m.invited_at || null, last_login_at: m.last_login_at || null };
}

// role: 'owner' | 'full' | 'semi' | 'viewer'
export function canManageTeam(role) { return role === 'owner' || role === 'full'; }
export function canEditSettings(role) { return role === 'owner' || role === 'full'; }

// May this role send this hub write? body = the parsed POST body.
export function canHubWrite(role, body) {
  if (role === 'owner' || role === 'full') return true;
  const action = body && body.action ? String(body.action) : (body && Array.isArray(body.leads) ? 'ingest' : '');
  if (role === 'viewer') return VIEWER_ACTIONS.has(action);
  if (role === 'semi') {
    if (action === 'setConfig') {
      const keys = Object.keys(body).filter(k => !['action', 'secret', 'owner'].includes(k));
      return keys.length > 0 && keys.every(k => SEMI_CONFIG_KEYS.has(k));
    }
    return SEMI_ACTIONS.has(action);
  }
  return false;
}

// Which account a member should land on at sign-in.
// own: the person's own users row (or null). ownHasData: their own account has at least one source.
// memberships: [{ owner_key, member }] where they are listed.
export function pickWorkspace({ own, ownHasData, isAdmin, memberships }) {
  const ms = memberships || [];
  if (own && (isAdmin || ownHasData || !ms.length)) return { kind: 'own' };
  if (ms.length) return { kind: 'member', owner_key: ms[0].owner_key, member: ms[0].member };
  return { kind: own ? 'own' : 'new' };
}

// Find every account listing this person. sb(path) = Supabase REST GET returning rows.
export async function findMemberships(sb, who) {
  const email = normEmail(who && who.email);
  const sub = who && who.sub ? String(who.sub) : '';
  const enc = encodeURIComponent;
  const clean = s => s.replace(/[*,()"\\]/g, '');
  const found = new Map();
  const probes = [];
  if (email) probes.push(`config?key=eq.${TEAM_KEY}&value=ilike.${enc('*' + clean(email) + '*')}&select=owner_key,value&limit=20`);
  if (sub) probes.push(`config?key=eq.${TEAM_KEY}&value=like.${enc('*' + clean(sub) + '*')}&select=owner_key,value&limit=20`);
  for (const p of probes) {
    const rows = await sb(p);
    for (const r of rows || []) {
      if (found.has(r.owner_key)) continue;
      const m = findMember(parseTeam(r.value), { sub, email });
      if (m) found.set(r.owner_key, { owner_key: r.owner_key, member: m });
    }
  }
  return Array.from(found.values());
}
