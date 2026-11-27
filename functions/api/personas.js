// functions/api/personas.js - Radar "Personas" (ICP optimization), app v1.25.0, 2026-11-26
//
//   GET /api/personas  -> { ok, at, list_name, total, personas[], dims, radar }
//
// Input: the account's Sales Navigator "Recommended Leads" list, read once a week by the extension
// (ext 1.19.0 -> hub v28 saveRecommendedLeads -> config key recommended_leads).
// Groups those people into personas by what they share (role x industry), describes each one
// (locations, company sizes, founders, warm reach, examples, suggested Sales Nav filters) and compares
// it with what Radar actually collects for this account (prospects with the same role, and how many
// of them are graded ICP A/B) - so the page shows which personas Radar already converts on and which
// LinkedIn suggests but Radar does not reach yet.
//
// Owner is taken ONLY from the signed-in radar_session cookie (same rule as /api/intelligence).
// Deterministic (no AI needed). If the Workers AI binding is present, one short plain-English
// summary is added; without it the page works the same.

import { verify } from '../_lib/session.js';

const SUPABASE_URL = 'https://pkzeeqehwmtnqxdpdesl.supabase.co';
const MAX_TARGET_PAGES = 15;
const MIN_PERSONA = 3;
const MAX_PERSONAS = 7;
const enc = encodeURIComponent;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// ---------- classification (pure, exported for tests) ----------
const ROLES = [
  ['Investor / Board', /\b(investor|venture|general partner|managing partner|board member|chair(man|woman)?|angel)\b/i],
  ['CTO / Technical lead', /\b(cto|cpto|chief (technology|technical|product( and technology)?) officer|vp (of )?engineering|head of engineering|engineering|technical co-?founder)\b/i],
  ['COO / Operations', /\b(coo|chief operating officer|operations|ops)\b/i],
  ['CFO / Finance', /\b(cfo|chief financial officer|finance|financial)\b/i],
  ['CMO / Marketing', /\b(cmo|chief marketing officer|marketing|brand|growth)\b/i],
  ['Sales / Revenue', /\b(cro|chief revenue officer|sales|revenue|business development|partnerships?)\b/i],
  ['Product', /\b(cpo|chief product officer|product)\b/i],
  ['HR / People', /\b(chro|people|talent|human resources|hr)\b/i],
  ['CEO / President', /\b(ceo|chief executive|president|managing director|general manager|owner|directeur g[ée]n[ée]ral)\b/i],
  ['Founder', /\bfound(er|ing)\b/i]
];
export function roleOf(title) {
  const t = String(title || '');
  if (!t.trim()) return 'Unknown role';
  // A founder who is also CEO is a CEO; a "Co-founder & CTO" is technical - order of ROLES decides.
  if (/\b(ceo|chief executive)\b/i.test(t) && !/\b(cto|chief technology)\b/i.test(t)) return 'CEO / President';
  for (const [name, re] of ROLES) if (re.test(t)) return name;
  if (/\b(vp|vice president|head|director|chief)\b/i.test(t)) return 'Other executive';
  return 'Other';
}
export const isFounder = (title) => /\bfound(er|ing)\b/i.test(String(title || ''));

const INDUSTRIES = [
  ['Health & Life sciences', /health|hospital|medical|pharma|biotech|life science|wellness|fitness|mental|clinic|veterinar|diagnos/i],
  ['Software & AI', /software|internet|information technology|it services|computer|data|artificial|technology, information|saas|cyber|network/i],
  ['Financial services', /financ|bank|insurance|invest|capital|venture|accounting|fintech|payment|real estate/i],
  ['Marketing & Media', /marketing|advertis|media|publishing|public relations|design|entertainment|broadcast/i],
  ['Industry & Manufacturing', /manufactur|industrial|machinery|automotive|aviation|aerospace|chemical|construction|building|electrical|semiconductor|robot|energy|oil|utilities|mining|plastics/i],
  ['Consulting & Services', /consult|legal|law|staffing|recruit|outsourc|professional services|business services|human resources/i],
  ['Retail & Consumer', /retail|consumer|food|beverage|apparel|fashion|cosmetic|luxury|e-?commerce|restaurant|hospitality|travel/i],
  ['Education & Research', /education|e-learning|research|university|academ|think tank/i]
];
export function industryOf(ind) {
  const s = String(ind || '');
  if (!s.trim()) return 'Industry unknown';
  for (const [name, re] of INDUSTRIES) if (re.test(s)) return name;
  return 'Other industries';
}
export function regionOf(geo) {
  const g = String(geo || '');
  if (!g.trim()) return 'Unknown';
  if (/new york|brooklyn|manhattan|jersey|connecticut|greenwich|stamford/i.test(g)) return 'US - New York area';
  if (/san francisco|bay area|california|los angeles|seattle|washington, united|oregon|palo alto|menlo|san jose|los altos|mountain view/i.test(g)) return 'US - West Coast';
  if (/boston|massachusetts/i.test(g)) return 'US - Boston';
  if (/united states|, (al|ak|az|ar|co|ct|de|fl|ga|il|in|ia|ks|ky|la|me|md|mi|mn|ms|mo|mt|ne|nv|nh|nm|nc|nd|oh|ok|pa|ri|sc|sd|tn|tx|ut|vt|va|wv|wi|wy)\b|texas|florida|chicago|illinois|atlanta|georgia|miami|austin|denver|colorado/i.test(g)) return 'US - other';
  if (/france|paris|lyon|marseille|[îi]le-de-france/i.test(g)) return 'France';
  if (/united kingdom|london|england|scotland/i.test(g)) return 'UK';
  if (/canada|toronto|montreal|vancouver/i.test(g)) return 'Canada';
  if (/germany|spain|italy|netherlands|belgium|switzerland|sweden|denmark|norway|finland|ireland|portugal|austria|poland|europe/i.test(g)) return 'Europe - other';
  return 'Other';
}
export function sizeOf(range) {
  const m = String(range || '').match(/^(\d+)/);
  if (!m) return 'Size unknown';
  const n = +m[1];
  return n < 11 ? '1-10' : n < 51 ? '11-50' : n < 201 ? '51-200' : n < 1001 ? '201-1000' : '1000+';
}
// Countries as targets.country stores them (ISO or names) -> the same region buckets, coarse.
function regionOfCountry(c) {
  const s = String(c || '').trim();
  if (/^(us|usa|united states)$/i.test(s)) return 'US';
  if (/^(fr|france)$/i.test(s)) return 'France';
  if (/^(gb|uk|united kingdom)$/i.test(s)) return 'UK';
  return s ? 'Other' : 'Unknown';
}
const usLike = (region) => /^US/.test(region) ? 'US' : region === 'France' ? 'France' : region === 'UK' ? 'UK' : region === 'Unknown' ? 'Unknown' : 'Other';

const SN_FUNCTION = { 'CTO / Technical lead': 'Engineering / Information Technology', 'COO / Operations': 'Operations', 'CFO / Finance': 'Finance',
  'CMO / Marketing': 'Marketing', 'Sales / Revenue': 'Sales / Business Development', 'Product': 'Product Management', 'HR / People': 'Human Resources' };
const SN_SENIORITY = { 'CEO / President': 'CXO, Owner / Partner', 'Founder': 'Owner / Partner, CXO', 'Investor / Board': 'Owner / Partner', 'Other executive': 'Vice President, Director' };

function count(arr, f) { const o = {}; for (const x of arr) { const k = f(x); o[k] = (o[k] || 0) + 1; } return o; }
function topN(o, n, total) { return Object.entries(o).filter(([k]) => !/unknown/i.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ label: k, n: v, pct: total ? Math.round(v * 100 / total) : 0 })); }
const pct = (a, b) => (b ? Math.round(a * 100 / b) : 0);

// leads: compact rows from the extension. targets: [{title,country,grade}] of this account.
export function buildPersonas(leads = [], targets = []) {
  const rows = (leads || []).filter(l => l && l.name).map(l => ({ ...l, role: roleOf(l.title), ind: industryOf(l.industry),
    region: regionOf(l.geo), sz: sizeOf(l.size), founder: isFounder(l.title) }));
  const total = rows.length;
  const groups = {};
  for (const r of rows) (groups[r.role + '|' + r.ind] = groups[r.role + '|' + r.ind] || []).push(r);
  let keys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  const main = keys.filter(k => groups[k].length >= MIN_PERSONA && !/^Unknown role/.test(k)).slice(0, MAX_PERSONAS);
  // Small groups with the same ROLE are merged into one "role, mixed industries" persona when that reaches MIN_PERSONA.
  const rest = keys.filter(k => !main.includes(k));
  const byRole = {};
  for (const k of rest) { const role = k.split('|')[0]; (byRole[role] = byRole[role] || []).push(...groups[k]); }
  const mixed = Object.entries(byRole).filter(([role, m]) => m.length >= MIN_PERSONA && role !== 'Unknown role')
    .sort((a, b) => b[1].length - a[1].length).slice(0, Math.max(0, MAX_PERSONAS - main.length));
  const used = new Set();
  const list = main.map(k => ({ role: k.split('|')[0], ind: k.split('|')[1], members: groups[k] }))
    .concat(mixed.map(([role, m]) => ({ role, ind: 'Mixed industries', members: m })));
  list.forEach(p => p.members.forEach(m => used.add(m)));

  // What Radar collects for this account, by role (+ coarse country) - the conversion side.
  const tRows = (targets || []).map(t => ({ role: roleOf(t.title), region: regionOfCountry(t.country), icp: /^[AB]$/.test(String(t.grade || '')), graded: !!t.grade && t.grade !== '?' }));
  const tByRole = {};
  for (const t of tRows) { const o = tByRole[t.role] || (tByRole[t.role] = { n: 0, icp: 0, graded: 0, regions: {} }); o.n++; if (t.icp) o.icp++; if (t.graded) o.graded++; o.regions[t.region] = (o.regions[t.region] || 0) + 1; }
  const tTotal = tRows.length;

  const personas = list.map((p, i) => {
    const m = p.members, n = m.length;
    const regions = topN(count(m, x => x.region), 3, n);
    const sizes = topN(count(m, x => x.sz), 3, n);
    const industries = topN(count(m, x => x.industry || ''), 4, n).filter(x => x.label);
    const founders = m.filter(x => x.founder).length;
    const warm = m.filter(x => /^(1st|2nd)$/.test(x.degree)).length;
    const r = tByRole[p.role] || { n: 0, icp: 0, graded: 0, regions: {} };
    const mainRegion = regions[0] ? usLike(regions[0].label) : 'Unknown';
    const inRegion = r.regions[mainRegion] || 0;
    // Role share: how much of the Recommended Leads this role is, vs how much of the account's prospects it is.
    const roleShareReco = pct(rows.filter(x => x.role === p.role).length, total);
    const roleShareRadar = pct(r.n, tTotal);
    let verdict, verdict_text;
    if (!tTotal) { verdict = 'no_data'; verdict_text = 'No Radar prospects yet to compare with.'; }
    else if (r.n === 0) { verdict = 'gap'; verdict_text = 'LinkedIn suggests this persona, but Radar has collected none of them yet.'; }
    else if (r.graded >= 10 && pct(r.icp, r.graded) < 15) { verdict = 'off_icp'; verdict_text = 'Radar collects this role, but few match your ICP rule - check the rule or the sources.'; }
    else if (roleShareRadar * 2 < roleShareReco) { verdict = 'underserved'; verdict_text = 'This role is ' + roleShareReco + '% of what LinkedIn recommends but only ' + roleShareRadar + '% of your Radar prospects - add sources or bridges that reach them.'; }
    else if (r.graded >= 10 && pct(r.icp, r.graded) >= 40) { verdict = 'converts'; verdict_text = 'Radar already brings this persona, and most of them match your ICP.'; }
    else { verdict = 'covered'; verdict_text = 'Radar collects this persona at a normal rate.'; }
    const label = (p.role === 'Founder' ? 'Founder' : p.role) + ' · ' + p.ind;
    return {
      id: 'p' + (i + 1), name: label, role: p.role, industry_group: p.ind, size: n, share: pct(n, total),
      founders_pct: pct(founders, n), warm_pct: pct(warm, n),
      regions, company_sizes: sizes, industries,
      examples: m.slice(0, 6).map(x => ({ name: x.name, title: x.title, company: x.company, geo: x.geo, degree: x.degree })),
      salesnav_filters: {
        seniority: SN_SENIORITY[p.role] || 'CXO, Vice President, Director',
        function: SN_FUNCTION[p.role] || '',
        industry: industries.slice(0, 3).map(x => x.label).join(', ') || p.ind,
        geography: regions.slice(0, 2).map(x => x.label.replace(/^US - /, '')).join(', '),
        headcount: sizes.slice(0, 2).map(x => x.label).join(', ')
      },
      radar: { prospects_same_role: r.n, share_of_your_prospects: pct(r.n, tTotal), icp_graded: r.graded, icp_match: r.icp,
        icp_rate: r.graded ? pct(r.icp, r.graded) : null, in_main_region: inRegion, main_region: mainRegion },
      verdict, verdict_text
    };
  });

  const others = rows.filter(r => !used.has(r));
  return {
    total, grouped: total - others.length,
    personas,
    others: { size: others.length, examples: others.slice(0, 8).map(x => ({ name: x.name, title: x.title, company: x.company })) },
    dims: {
      roles: topN(count(rows, x => x.role), 8, total), industries: topN(count(rows, x => x.ind), 8, total),
      regions: topN(count(rows, x => x.region), 8, total), company_sizes: topN(count(rows, x => x.sz), 6, total),
      founders_pct: pct(rows.filter(x => x.founder).length, total),
      degree: { first: rows.filter(x => x.degree === '1st').length, second: rows.filter(x => x.degree === '2nd').length, third: rows.filter(x => x.degree === '3rd').length }
    },
    radar_prospects: tTotal
  };
}

// ---------- server ----------
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => { const [k, ...r] = p.trim().split('='); if (k) out[k.trim()] = r.join('=').trim(); });
  return out;
}
async function sb(env, path, range) {
  const headers = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
  if (range) { headers['Range-Unit'] = 'items'; headers.Range = range; }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
  if (!r.ok) throw new Error('supabase ' + r.status);
  return r.json();
}
async function ownerFromSession(request, env) {
  const session = await verify(parseCookies(request.headers.get('Cookie')).radar_session, env.SESSION_SECRET);
  if (!session || !session.sub) return null;
  const filter = session.owner_key ? `owner_key=eq.${enc(session.owner_key)}` : `linkedin_sub=eq.${enc(session.sub)}`;
  try {
    const u = await sb(env, `users?${filter}&select=owner_key,status&limit=1`);
    if (u && u[0] && u[0].owner_key) {
      if (u[0].status === 'suspended' || u[0].status === 'pending') return null;
      return u[0].owner_key;
    }
  } catch (e) {}
  return session.owner_key || null;
}

async function aiSummary(env, result) {
  if (!env.AI || !result.personas.length) return '';
  const data = result.personas.map(p => ({ name: p.name, size: p.size, regions: p.regions.map(r => r.label), sizes: p.company_sizes.map(s => s.label),
    radar_prospects: p.radar.prospects_same_role, icp_rate: p.radar.icp_rate, verdict: p.verdict }));
  const messages = [
    { role: 'system', content: 'You help a founder optimise their ideal customer profile (ICP) on LinkedIn. Only use the DATA. Write 3 short bullets "- ": ' +
      'which persona to prioritise, which gap to fix in Radar, and one Sales Navigator search to try. Max 90 words. Say Prospects, never Targets.' },
    { role: 'user', content: 'DATA: ' + JSON.stringify(data).slice(0, 6000) }
  ];
  for (const model of ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct']) {
    try { const r = await env.AI.run(model, { messages, max_tokens: 300, temperature: 0.3 }); const t = r && (r.response || (r.result && r.result.response)); if (t && String(t).trim()) return String(t).trim(); } catch (e) {}
  }
  return '';
}

export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_SERVICE_KEY || !env.SESSION_SECRET) return json({ error: 'Radar is not configured on this deployment.' }, 500);
  const owner = await ownerFromSession(request, env);
  if (!owner) return json({ error: 'Please sign in again.' }, 401);
  const o = `owner_key=eq.${enc(owner)}`;
  let saved = null;
  try {
    const c = await sb(env, `config?${o}&key=eq.recommended_leads&select=value,updated_at`);
    if (c && c[0] && c[0].value) saved = JSON.parse(c[0].value);
  } catch (e) { return json({ error: 'Could not read your Radar data: ' + e.message }, 502); }
  if (!saved || !Array.isArray(saved.leads) || !saved.leads.length) {
    return json({ ok: true, empty: true, message: 'Your Recommended Leads have not been read yet. The Radar extension reads them once a week (ext 1.19.0 or later) - or click "Read them now".' });
  }
  const targets = [];
  try {
    for (let p = 0; p < MAX_TARGET_PAGES; p++) {
      const rows = await sb(env, `targets?${o}&select=title,country,grade&order=id.asc`, `${p * 1000}-${p * 1000 + 999}`);
      targets.push(...rows);
      if (rows.length < 1000) break;
    }
  } catch (e) {}
  const result = buildPersonas(saved.leads, targets);
  const wantAi = new URL(request.url).searchParams.get('ai') === '1';
  return json({ ok: true, at: saved.at, list_name: saved.list_name || 'Recommended Leads', ai: !!env.AI,
    summary: wantAi ? await aiSummary(env, result) : '', ...result });
}
