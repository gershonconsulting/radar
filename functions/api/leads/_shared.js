// functions/api/leads/_shared.js
// Helpers shared by the Leads endpoints. Kept in one place so the list and the
// sync agree on exactly what "the same LinkedIn profile" means.

export function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const [k, ...rest] = p.trim().split('=');
    if (k) out[k.trim()] = rest.join('=').trim();
  });
  return out;
}

export const json = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

// --- Supabase REST helper (service key stays server-side) ---
// Mirrors the sb() in functions/api/enrich-company.js.
export async function sb(env, path, opts = {}) {
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
  return body;
}

// Normalize a LinkedIn profile URL so Botdog's copy and ours compare equal.
// Botdog returns e.g. "https://www.linkedin.com/in/Jane-Doe/?originalSubdomain=fr"
// while a target may hold "http://linkedin.com/in/jane-doe". Both -> "linkedin.com/in/jane-doe".
// Returns '' when there is no usable profile slug, so callers can skip it.
export function normalizeLinkedInUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.split('#')[0].split('?')[0];          // drop fragment + query string
  s = s.replace(/^https?:\/\//i, '');          // drop scheme
  s = s.replace(/^[a-z0-9-]+\.linkedin\.com/i, 'linkedin.com'); // www./fr./de. -> linkedin.com
  s = s.replace(/\/+$/, '');                   // drop trailing slash(es)
  s = s.toLowerCase();
  if (!s.includes('linkedin.com/in/')) return '';
  return s;
}
