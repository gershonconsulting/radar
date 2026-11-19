// functions/api/intelligence.js - Radar "Intelligence" menu, server side (app v1.20.0, 2026-11-17)
//
// Same three modes as the Gershon Intelligence menu on Pulse (approved 2026-10-05), on Cloudflare
// Workers AI (env.AI binding) - no Anthropic / OpenAI key anywhere.
//
//   GET  /api/intelligence            -> { ok, ai, signed_in }   (health)
//   POST /api/intelligence  { mode: 'analyze' | 'suggest' | 'chat', messages? }
//        -> { mode, text, model, engine }
//
// Radar difference: the DATA the model reads is built HERE, on the server, from Supabase, for the
// owner taken ONLY from the signed-in radar_session cookie (same rule as /api/bridge-icp). The
// browser never sends data, so one account can never make the AI read another account's prospects.

import { verify } from '../_lib/session.js';

const SUPABASE_URL = 'https://pkzeeqehwmtnqxdpdesl.supabase.co';
const MODELS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];
const MAX_TURNS = 12;
const MAX_TARGET_PAGES = 15;           // x1000 rows - prospects are aggregated, never sent raw
const enc = encodeURIComponent;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const BASE =
  'You are the Intelligence assistant inside Radar by Gershon.ai (radar.gershon.ai). Radar watches ' +
  'SOURCES (companies such as competitors or partners), finds BRIDGES (people at those sources whose LinkedIn ' +
  'network reaches the user\'s ideal customers) and collects their 1st-degree connections as PROSPECTS, graded ' +
  'A/B/C/D against the user\'s ICP (A+B = ICP match, ? = no job title so it cannot be graded). Bridge verdicts: ' +
  'focus (high ICP hit rate), normal, slow (low hit rate), cant_judge (too few graded prospects). Prospects can be ' +
  'pushed to Botdog for outreach and filed in a Sales Navigator list. ' +
  'You only know what is in the DATA block below - never invent numbers, names or facts. If the data is thin, ' +
  'say so plainly. Write for a busy founder: short, concrete, no filler. Use short markdown: "## " headings, ' +
  '"- " bullets, **bold** for key figures. Always say Prospects (never Targets).';

const TASK = {
  analyze:
    'Produce an ANALYSIS of this Radar account. Sections: "## Snapshot" (3-5 bullets with the key figures), ' +
    '"## What stands out" (which sources and bridges bring ICP prospects, trends over the last 30 days, ' +
    'concentrations), "## Risks" (stalled collection, unhealthy or slow bridges, ungraded prospects, sources ' +
    'with no bridges). Max ~250 words.',
  suggest:
    'Produce IMPROVEMENT SUGGESTIONS for this Radar account. Give the 5 highest-impact actions, ranked. For each: ' +
    '"- **Action** - why (cite the figure from the data) - expected effect". Think about: which bridges to focus ' +
    'or slow down, which sources to add more bridges to or drop, ICP coverage, collection health, Botdog / Sales ' +
    'Navigator follow-through. Then "## Quick win today" with one action under 15 minutes. Max ~300 words.',
  chat:
    'Answer the user\'s question about their Radar data and possible improvements. Be direct; cite figures from ' +
    'the data. If the question cannot be answered from the data, say what is missing.'
};

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

const day = (s) => String(s || '').slice(0, 10);
function bump(o, k, n = 1) { k = k == null || k === '' ? 'unknown' : String(k); o[k] = (o[k] || 0) + n; }
function top(o, n) { return Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n); }

// Builds the compact account summary the model reads. Pure function - exported for tests.
export function summarize({ sources = [], bridges = [], targets = [], stats = [], activity = [], icp = '' }, now = new Date()) {
  const d = (n) => new Date(now.getTime() - n * 864e5).toISOString().slice(0, 10);
  const d7 = d(7), d30 = d(30), d60 = d(60);
  const grades = {}, countries = {}, perBridge = {}, perDay = {};
  let last7 = 0, last30 = 0, prev30 = 0, botdog = 0, listed = 0, unselected = 0, lastCollected = '';
  for (const t of targets) {
    const c = day(t.collected_date || t.first_seen_at);
    bump(grades, t.grade || '?'); bump(countries, t.country);
    const b = perBridge[t.radar_person || 'unknown'] || (perBridge[t.radar_person || 'unknown'] = { total: 0, last30: 0 });
    b.total++;
    if (c >= d7) last7++;
    if (c >= d30) { last30++; b.last30++; bump(perDay, c); } else if (c >= d60) prev30++;
    if (t.botdog_pushed) botdog++;
    if (t.salesnav_listed_at) listed++;
    if (t.selected === false) unselected++;
    if (c > lastCollected) lastCollected = c;
  }
  const bySource = {};
  for (const b of bridges) {
    const s = bySource[b.source || 'Added by hand'] || (bySource[b.source || 'Added by hand'] = { bridges: 0, active: 0, prospects: 0, icp: 0 });
    s.bridges++; if (b.active) s.active++;
    const p = perBridge[b.name]; if (p) s.prospects += p.total;
  }
  for (const r of stats) { const s = bySource[r.source || 'Added by hand']; if (s) s.icp += +r.icp || 0; }
  const health = {}; bridges.forEach(b => bump(health, b.health || 'unknown'));
  const verdicts = {}; stats.forEach(r => bump(verdicts, r.verdict));
  const acts = {}; activity.forEach(a => bump(acts, a.action));
  const graded = targets.length - (grades['?'] || 0);
  const icpCount = (grades.A || 0) + (grades.B || 0);

  return {
    icp_definition: icp || '(no ICP rule set for this account - prospects stay ungraded)',
    totals: {
      sources: sources.length, bridges: bridges.length, active_bridges: bridges.filter(b => b.active).length,
      prospects: targets.length, graded_prospects: graded, icp_prospects_A_B: icpCount,
      icp_rate_of_graded: graded ? Math.round(icpCount * 100 / graded) + '%' : 'n/a',
      pushed_to_botdog: botdog, filed_in_salesnav_list: listed, deselected_by_user: unselected
    },
    collection: {
      last_collected_day: lastCollected || 'never', new_last_7_days: last7, new_last_30_days: last30,
      new_previous_30_days: prev30, per_day_last_30: Object.fromEntries(Object.entries(perDay).sort())
    },
    grades, top_countries: top(countries, 8),
    sources: sources.map(s => ({ name: s.name, priority: s.priority || null, category: s.category, added: day(s.added_date),
      discovered: !!s.discovered, ...(bySource[s.name] || { bridges: 0, active: 0, prospects: 0, icp: 0 }) })).slice(0, 40),
    bridge_health: health, bridge_verdicts: verdicts,
    top_bridges_by_icp: stats.slice(0, 15).map(r => ({ bridge: r.bridge, source: r.source, prospects: r.prospects,
      icp: r.icp, hit_pct: r.hit_pct, verdict: r.verdict, last_collected: day(r.last_collected) })),
    slow_bridges: stats.filter(r => r.verdict === 'slow').slice(0, 10).map(r => ({ bridge: r.bridge, source: r.source, prospects: r.prospects, hit_pct: r.hit_pct })),
    unhealthy_bridges: bridges.filter(b => b.health && !/^(ok|healthy|good|productive|unknown)$/i.test(b.health)).slice(0, 10)
      .map(b => ({ bridge: b.name, source: b.source, health: b.health, reason: b.health_reason, empty_runs: b.empty_runs })),
    activity_last_7_days: acts
  };
}

async function loadAccount(env, owner) {
  const o = `owner_key=eq.${enc(owner)}`;
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const [sources, bridges, stats, rule, activity] = await Promise.all([
    sb(env, `sources?${o}&category=neq.suggested&select=name,priority,category,added_date,discovered&order=added_date.desc`),
    sb(env, `bridges?${o}&select=name,source,active,health,health_reason,empty_runs,last_scraped_at`),
    sb(env, `bridge_icp_stats?${o}&select=bridge,source,prospects,scorable,icp,hit_pct,verdict,last_collected&order=icp.desc,prospects.desc`).catch(() => []),
    sb(env, `icp_rules?${o}&select=note`).catch(() => []),
    sb(env, `activity_log?${o}&at=gte.${enc(since)}&select=action&limit=5000`).catch(() => [])
  ]);
  const targets = [];
  for (let p = 0; p < MAX_TARGET_PAGES; p++) {
    const rows = await sb(env, `targets?${o}&select=collected_date,first_seen_at,grade,country,radar_person,botdog_pushed,salesnav_listed_at,selected&order=id.asc`,
      `${p * 1000}-${p * 1000 + 999}`);
    targets.push(...rows);
    if (rows.length < 1000) break;
  }
  const icp = rule && rule[0] && rule[0].note ? String(rule[0].note).replace(/^[^:]*:\s*/, '') : '';
  return summarize({ sources, bridges, targets, stats, activity, icp });
}

async function run(env, messages, maxTokens) {
  let lastErr = 'no model answered';
  for (const model of MODELS) {
    try {
      const r = await env.AI.run(model, { messages, max_tokens: maxTokens, temperature: 0.3 });
      const text = r && (typeof r.response === 'string' ? r.response : (r.result && r.result.response) || '');
      if (text && text.trim()) return { text: text.trim(), model };
      lastErr = 'empty answer from ' + model;
    } catch (e) { lastErr = String(e && e.message || e); }
  }
  throw new Error(lastErr);
}

export async function onRequestGet({ request, env }) {
  let signedIn = false;
  try { signedIn = !!(env.SESSION_SECRET && await ownerFromSession(request, env)); } catch (e) {}
  return json({ ok: true, ai: !!env.AI, signed_in: signedIn, models: MODELS });
}

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_SERVICE_KEY || !env.SESSION_SECRET) return json({ error: 'Radar is not configured on this deployment.' }, 500);
  const owner = await ownerFromSession(request, env);
  if (!owner) return json({ error: 'Please sign in again.' }, 401);
  if (!env.AI) return json({ error: 'Intelligence is being switched on (Cloudflare Workers AI binding "AI" missing).' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const mode = TASK[body.mode] ? body.mode : 'analyze';

  let data;
  try { data = await loadAccount(env, owner); } catch (e) { return json({ error: 'Could not read your Radar data: ' + e.message }, 502); }
  const system = BASE + '\n\n' + TASK[mode] + '\n\nDATA (Radar account, ' + new Date().toISOString().slice(0, 10) + '):\n"""\n' +
    JSON.stringify(data).slice(0, 16000) + '\n"""';
  const messages = [{ role: 'system', content: system }];
  if (mode === 'chat') {
    const turns = (Array.isArray(body.messages) ? body.messages : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-MAX_TURNS).map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (!turns.length || turns[turns.length - 1].role !== 'user') return json({ error: 'Chat needs a question' }, 400);
    messages.push(...turns);
  } else {
    messages.push({ role: 'user', content: mode === 'analyze' ? 'Analyse my Radar account.' : 'What should I improve in my Radar?' });
  }
  try {
    const out = await run(env, messages, mode === 'chat' ? 700 : 900);
    return json({ mode, text: out.text, model: out.model, engine: 'cloudflare-workers-ai' });
  } catch (e) {
    return json({ error: 'AI unavailable: ' + e.message }, 502);
  }
}
