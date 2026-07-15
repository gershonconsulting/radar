// functions/api/enrich-company.js
// Enriches target companies with French registry data from Pappers, caches them in
// Supabase, and recomputes each target's ICP grade from real company facts.
//
// GET  /api/enrich-company?preview=ACME        -> look up one company, return facts (no write)
// POST /api/enrich-company  {limit: 25}        -> enrich the next N un-enriched companies
//
// The Pappers token lives ONLY in the PAPPERS_API_KEY env var (Cloudflare), never in
// the browser and never in the repo.

import { verify } from '../_lib/session.js';

const PAPPERS_SEARCH = 'https://api.pappers.fr/v2/recherche';
const PAPPERS_COMPANY = 'https://api.pappers.fr/v2/entreprise';

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const [k, ...rest] = p.trim().split('=');
    if (k) out[k.trim()] = rest.join('=').trim();
  });
  return out;
}
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// --- Supabase REST helpers (service key stays server-side) ---
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
  if (!r.ok) throw new Error(`supabase ${r.status}: ${text.slice(0, 200)}`);
  return body;
}

// Strip LinkedIn noise so "ACME SAS · Paris" matches the registry.
function cleanCompanyName(raw) {
  return String(raw || '')
    .replace(/\s*[·|].*$/, '')
    .replace(/\s*\((.*?)\)\s*$/, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+(is hiring|we're hiring|is reachable|was last active.*)$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// --- Pappers lookup: search by name -> fetch full company by SIREN ---
async function pappersLookup(env, name) {
  const token = env.PAPPERS_API_KEY;
  if (!token) throw new Error('PAPPERS_API_KEY not configured');

  const su = new URL(PAPPERS_SEARCH);
  su.searchParams.set('api_token', token);
  su.searchParams.set('q', name);
  su.searchParams.set('par_page', '1');
  su.searchParams.set('precision', 'standard');
  const sr = await fetch(su.toString());
  if (sr.status === 401) throw new Error('pappers 401 — bad or missing API token');
  if (!sr.ok) throw new Error(`pappers search ${sr.status}`);
  const sj = await sr.json();
  const hit = (sj.resultats || [])[0];
  if (!hit || !hit.siren) return { status: 'not_found' };

  const cu = new URL(PAPPERS_COMPANY);
  cu.searchParams.set('api_token', token);
  cu.searchParams.set('siren', hit.siren);
  const cr = await fetch(cu.toString());
  if (!cr.ok) return { status: 'not_found' };
  const c = await cr.json();

  // Latest available annual accounts (Pappers returns newest-first).
  const fin = (c.finances && c.finances[0]) || {};
  const siege = c.siege || {};

  return {
    status: 'ok',
    facts: {
      siren: c.siren || hit.siren,
      legal_name: c.nom_entreprise || c.denomination || hit.nom_entreprise || null,
      year_created: c.date_creation ? Number(String(c.date_creation).slice(0, 4)) : null,
      employees: (typeof c.effectif === 'number') ? c.effectif : null,
      employees_label: c.tranche_effectif || c.effectif_min_max || null,
      revenue_eur: (fin.chiffre_affaires != null) ? Math.round(Number(fin.chiffre_affaires)) : null,
      revenue_year: fin.annee ? Number(fin.annee) : null,
      result_eur: (fin.resultat != null) ? Math.round(Number(fin.resultat)) : null,
      city: siege.ville || null,
      postal_code: siege.code_postal || null,
      naf_code: c.code_naf || null,
      naf_label: c.libelle_code_naf || null,
      is_active: c.entreprise_cessee === true ? false : true,
      category: c.categorie_entreprise || null,
      raw: { siren: c.siren, finances_years: (c.finances || []).map(f => f.annee) }
    }
  };
}

// --- ICP scoring from real company facts (0-100 -> letter) ---
// Rationale: Olivier's A+ = a substantial foreign (French) company able to expand to the US.
// Size and traction beat job title alone. Each signal is additive and explained in score_reason.
export function scoreCompany(f) {
  if (!f) return { score: null, grade: null, reason: 'no company data' };
  let score = 0;
  const why = [];

  // Revenue: the strongest signal of ability to fund a US move.
  const rev = f.revenue_eur;
  if (rev != null) {
    if (rev >= 50e6)      { score += 40; why.push('revenue ≥ €50M (+40)'); }
    else if (rev >= 10e6) { score += 34; why.push('revenue ≥ €10M (+34)'); }
    else if (rev >= 2e6)  { score += 26; why.push('revenue ≥ €2M (+26)'); }
    else if (rev >= 500e3){ score += 16; why.push('revenue ≥ €500k (+16)'); }
    else                  { score += 6;  why.push('revenue < €500k (+6)'); }
  }

  // Headcount: capacity to staff an expansion.
  const emp = f.employees;
  if (emp != null) {
    if (emp >= 250)     { score += 25; why.push('250+ employees (+25)'); }
    else if (emp >= 50) { score += 22; why.push('50+ employees (+22)'); }
    else if (emp >= 10) { score += 16; why.push('10+ employees (+16)'); }
    else                { score += 8;  why.push('<10 employees (+8)'); }
  }

  // Maturity: too young rarely expands abroad; very established is a strong fit.
  const yr = f.year_created;
  if (yr) {
    const age = (new Date()).getFullYear() - yr;
    if (age >= 10)     { score += 20; why.push(`${age}y old (+20)`); }
    else if (age >= 4) { score += 15; why.push(`${age}y old (+15)`); }
    else               { score += 7;  why.push(`${age}y old — early (+7)`); }
  }

  // Profitability: funds its own expansion.
  if (f.result_eur != null) {
    if (f.result_eur > 0) { score += 10; why.push('profitable (+10)'); }
    else                  { score += 2;  why.push('not profitable (+2)'); }
  }

  // ETI/GE are prime expansion candidates.
  if (f.category === 'ETI' || f.category === 'GE') { score += 5; why.push(`${f.category} (+5)`); }

  if (f.is_active === false) { score = Math.min(score, 15); why.push('company ceased — capped'); }

  const grade = score >= 80 ? 'A+' : score >= 65 ? 'A' : score >= 50 ? 'B' : score >= 32 ? 'C' : 'D';
  return { score, grade, reason: why.join(' · ') };
}

export async function onRequest({ request, env }) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verify(cookies.radar_session, env.SESSION_SECRET);
  if (!session) return json({ ok: false, error: 'unauthenticated' }, 401);
  const owner = session.owner_key || session.sub;

  try {
    // --- Preview one company (no writes) so you can see the raw facts ---
    if (request.method === 'GET') {
      const u = new URL(request.url);
      const preview = u.searchParams.get('preview');
      if (!preview) return json({ ok: false, error: 'pass ?preview=CompanyName' }, 400);
      const name = cleanCompanyName(preview);
      const res = await pappersLookup(env, name);
      if (res.status !== 'ok') return json({ ok: true, name, found: false });
      return json({ ok: true, name, found: true, facts: res.facts, ...scoreCompany(res.facts) });
    }

    // --- Batch enrich ---
    if (request.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await request.text() || '{}'); } catch {}
      const limit = Math.min(Number(body.limit) || 20, 50);

      // Distinct company names on this owner's targets that we haven't enriched yet.
      const targets = await sb(env, `targets?owner_key=eq.${encodeURIComponent(owner)}&company=not.is.null&select=company&limit=1000`);
      const already = await sb(env, `companies?owner_key=eq.${encodeURIComponent(owner)}&select=name`);
      const done = new Set((already || []).map(c => c.name));
      const names = [...new Set((targets || []).map(t => cleanCompanyName(t.company)).filter(Boolean))]
        .filter(n => !done.has(n))
        .slice(0, limit);

      const results = [];
      for (const name of names) {
        let row = { owner_key: owner, name, enriched_at: new Date().toISOString() };
        try {
          const res = await pappersLookup(env, name);
          if (res.status === 'ok') {
            const s = scoreCompany(res.facts);
            row = { ...row, ...res.facts, enrich_status: 'ok' };
            results.push({ name, found: true, grade: s.grade, score: s.score });
          } else {
            row.enrich_status = 'not_found';
            results.push({ name, found: false });
          }
        } catch (e) {
          row.enrich_status = 'error';
          results.push({ name, error: String(e.message || e) });
        }
        await sb(env, 'companies?on_conflict=owner_key,name', {
          method: 'POST', body: JSON.stringify(row),
          prefer: 'resolution=merge-duplicates,return=minimal'
        });
      }

      // Re-link targets to companies and write the new grade/score.
      const companies = await sb(env, `companies?owner_key=eq.${encodeURIComponent(owner)}&enrich_status=eq.ok&select=*`);
      let regraded = 0;
      for (const c of (companies || [])) {
        const s = scoreCompany(c);
        if (!s.grade) continue;
        await sb(env, `targets?owner_key=eq.${encodeURIComponent(owner)}&company=eq.${encodeURIComponent(c.name)}`, {
          method: 'PATCH',
          body: JSON.stringify({ company_id: c.id, grade: s.grade, score: s.score, score_reason: s.reason }),
          prefer: 'return=minimal'
        });
        regraded++;
      }

      return json({ ok: true, enriched: results.length, regraded_companies: regraded, results });
    }

    return json({ ok: false, error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
