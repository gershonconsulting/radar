// =============================================================
// Radar - Sales Navigator Collector (sync-core.js / service worker)
// Scrapes connections from Sales Navigator, resolves public /in/ URLs,
// POSTs to Apps Script hub. Logs every step to chrome.storage.local
// so the Radar dashboard can display them in real time.
// =============================================================

const WEBAPP_URL    = 'https://script.google.com/macros/s/AKfycbzFX-DPwGDGFPoIxdYwNq5mMztXHNs33PHUNQox-vgrvQbgA2KLccMN9DI-YURCIWxbPw/exec';
const INGEST_SECRET = 'radar_7Kq3mZ9pX2vL8nT';
const MAX_PAGES     = 25;
const MAX_RESOLVE_PER_RUN = 100;

// Each bridge belongs to a Source (the organization it represents).
// Add new bridges from other Sources here: { bridge, source, category, urn, results }.
// NOTE: These 6 are now a SEED FALLBACK only. Live collection uses ACTIVE bridges
// pulled from the hub (getBridges). If the hub returns zero bridges, we fall back
// to these AND push them to the hub via addBridges (source 'The Triana Group') so
// they can be activated there. (addBridges can't set active=true - that's a hub-side
// toggle - so the seed still runs this first time via the fallback path.)
const BRIDGES = [
  { bridge: 'Elie Cohen',                source: 'The Triana Group', category: 'partner', urn: 'ACwAAAALvckBqvkWA1X60puCvmWbDTndKhJyWdw', results: 55  },
  { bridge: 'Jabril Bensedrine',         source: 'The Triana Group', category: 'partner', urn: 'ACwAAAAZ62QBFLpds_ZGdkq4MHkHmJvovRixzkM', results: 45  },
  { bridge: 'Phil Jeudy',                source: 'The Triana Group', category: 'partner', urn: 'ACwAAAAbEFEBcIoDyt1Se4852krlmZrdxTryE-I', results: 207 },
  { bridge: 'Mathias Cohen',             source: 'The Triana Group', category: 'partner', urn: 'ACwAAAARL38BwmwLt6iIb6vHgLP6Up5fXq3Qoms', results: 30  },
  { bridge: 'Anne Charlotte Le Bourhis', source: 'The Triana Group', category: 'partner', urn: 'ACwAAABWZEIB8mgZv6MlSCv22joSKYhvnrBylvU', results: 53  },
  { bridge: 'Marie-Josee Rodi-Andrieu',  source: 'The Triana Group', category: 'partner', urn: 'ACwAAABSExEBFWA3dHRNEffTytW-ivqxxt45vDg', results: 336 },
];

const SEARCH_FILTERS = {
  seniority:       ['Owner / Partner', 'CXO'],
  geography:       'Europe',
  headcountMin:    11,
  headcountMax:    50,
  excludeMessaged: true,
};

// Bridge discovery: for each Source with an org_id, find senior people AT that org
// (Owner/Partner 320, CXO 310, VP 300) to propose as candidate bridges.
const DISCOVER_SENIORITY_IDS = ['320', '310', '300'];
const MAX_CANDIDATES_PER_SOURCE = 40;
// Bridge discovery cadence: new senior people inside a Source change slowly, so we only
// look for new candidate bridges ~monthly. Prospect COLLECTION from active bridges still
// runs every daily sync. Tracked via chrome.storage.local 'lastDiscoverAt'.
const DISCOVER_INTERVAL_DAYS = 30;

// --- Logging ---
const MAX_LOG_ENTRIES = 200;
async function log(level, msg, data) {
  const entry = { ts: new Date().toISOString(), level, msg, data: data !== undefined ? data : null };
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log']('[Radar]', msg, data !== undefined ? data : '');
  try {
    const stored = await chrome.storage.local.get('radarLog');
    const arr = stored.radarLog || [];
    arr.unshift(entry);
    await chrome.storage.local.set({ radarLog: arr.slice(0, MAX_LOG_ENTRIES) });
  } catch(e) {}
}
async function clearLog() { await chrome.storage.local.set({ radarLog: [] }); }

// --- Alarms / schedule ---
// The extension is the ONLY scheduler — Radar runs fully standalone, with no dependence on
// Claude, Cowork, scheduled tasks, or Apps Script triggers. The schedule lives in
// chrome.storage.local ('radar_schedule') and is set from the web app Settings page.
const DEFAULT_SCHEDULE = {
  targetsEveryHours: 24,     // how often to collect prospects (targets)
  bridgesMode: 'new-only',   // 'new-only' | 'periodic' | 'manual'
  bridgesEveryDays: 30       // used only when bridgesMode === 'periodic'
};
async function getSchedule() {
  const d = await chrome.storage.local.get('radar_schedule');
  return Object.assign({}, DEFAULT_SCHEDULE, d.radar_schedule || {});
}
async function applySchedule(sched) {
  const s = Object.assign({}, DEFAULT_SCHEDULE, sched || {});
  s.targetsEveryHours = Math.max(1, Number(s.targetsEveryHours) || 24);
  s.bridgesEveryDays  = Math.max(1, Number(s.bridgesEveryDays) || 30);
  await chrome.storage.local.set({ radar_schedule: s });
  await chrome.alarms.clear('dailySync');
  chrome.alarms.create('dailySync', { periodInMinutes: Math.round(s.targetsEveryHours * 60), delayInMinutes: 1 });
  await log('info', 'schedule:applied', { everyHours: s.targetsEveryHours, bridgesMode: s.bridgesMode, bridgesEveryDays: s.bridgesEveryDays });
  return s;
}
chrome.runtime.onInstalled.addListener(async () => { await applySchedule(await getSchedule()); await log('info', 'Extension installed, schedule set'); });
chrome.runtime.onStartup.addListener(async () => { await applySchedule(await getSchedule()); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'dailySync') runSync(); });

// --- Messages ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'syncNow') {
    runSync().then(async r => { await pushLog(); sendResponse({ ok: true, result: r }); }).catch(async e => { await pushLog(); sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
  if (msg.action === 'discoverNow') {
    // Manual discovery scans all sources, resets the monthly clock, and clears any pending flags.
    discoverBridges().then(async r => { await chrome.storage.local.set({ lastDiscoverAt: new Date().toISOString() }); await clearDiscoverPending([]); await closeScrapeWindow(); await pushLog(); sendResponse({ ok: true, result: r }); }).catch(async e => { await closeScrapeWindow(); await pushLog(); sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
  if (msg.action === 'getLog') {
    chrome.storage.local.get('radarLog', d => sendResponse({ ok: true, log: d.radarLog || [] }));
    return true;
  }
  if (msg.action === 'clearLog') { clearLog().then(() => sendResponse({ ok: true })); return true; }
  if (msg.action === 'salesNavStatus') {
    checkLogin().then(ok => sendResponse({ ok: !!ok })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.action === 'getSchedule') {
    getSchedule().then(s => sendResponse({ ok: true, schedule: s })).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.action === 'setSchedule') {
    applySchedule(msg.schedule).then(s => sendResponse({ ok: true, schedule: s })).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.action === 'setBotdogConfig') {
    // Store the Botdog key + bridges campaign so the sync can invite bridges directly.
    const upd = {};
    if (msg.key) upd.radar_botdog_key = msg.key;
    if (msg.campaign) upd.radar_bridges_campaign = msg.campaign;
    chrome.storage.local.set(upd).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.action === 'pushBridgesNow') {
    // Triggered from the dashboard — invite non-1st bridges to the Botdog campaign now.
    pushBridgesToBotdog().then(async r => { await pushLog(); sendResponse({ ok: true, result: r }); })
      .catch(async e => { await pushLog(); sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
});

// Forward the run log to the hub so it's visible server-side (for debugging).
async function pushLog() {
  try {
    const stored = await chrome.storage.local.get('radarLog');
    const arr = stored.radarLog || [];
    await fetch(WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secret: INGEST_SECRET, action: 'pushLog', log: arr.slice(0, 150) }) });
  } catch (e) {}
}

// Clear the "collect bridges now" (discover_pending) flag on the hub for the given source
// names once we've discovered them (or all pending if no names passed).
async function clearDiscoverPending(names) {
  try {
    await fetch(WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secret: INGEST_SECRET, action: 'clearDiscoverPending', names: names || [] }) });
  } catch (e) {}
}

// --- Main sync ---
async function runSync() {
  await clearLog();
  await log('info', 'run:start');
  notify('Sync started', 'Scanning Sales Navigator slowly to stay under the radar…');
  const loggedIn = await checkLogin();
  await log('info', 'login-check', { loggedIn });
  if (!loggedIn) { await log('warn', 'No Sales Nav tab detected - proceeding anyway (opened tabs use your logged-in session)'); }

  // Step 1: discover candidate bridges from Sources — ONCE PER SOURCE, then never again
  // automatically. Prospect collection is the priority. We only look for bridges when:
  //   (a) the user asks — popup "Find Bridges Now" (discoverNow) or a source flagged
  //       "collect now" (discover_pending); or
  //   (b) a source has NEVER been discovered yet (zero bridges on the hub for it) — the
  //       one-time first pass for a brand-new source.
  // A source that already has bridges is NEVER re-hunted on its own (no monthly top-up).
  // Everything else skips straight to Step 2 (collecting prospects), which always runs.
  try {
    let sources = [];
    try { sources = await getSources(); } catch (e) { sources = []; }
    // Build the set of sources that already have at least one bridge (i.e. already discovered).
    const discoveredSources = new Set();
    try {
      const rb = await fetchHubJsonp('getBridges');
      ((rb && rb.bridges) || []).forEach(b => { if (b && b.source) discoveredSources.add(_normName(b.source)); });
    } catch (e) {}
    const sched = await getSchedule();               // 'new-only' | 'periodic' | 'manual'
    const pending = sources.filter(s => String(s.discover_pending || '').trim());
    // Brand-new sources: have an org_id to search with, and no bridges discovered yet.
    const neverDiscovered = sources.filter(s =>
      String(s.org_id || '').trim() &&
      !String(s.discover_pending || '').trim() &&
      !discoveredSources.has(_normName(s.name))
    );
    if (pending.length) {
      // User explicitly asked to collect bridges for these sources — always honored.
      await log('info', 'discover:pending', { count: pending.length, sources: pending.map(s => s.name) });
      await discoverBridges(pending);
      await clearDiscoverPending(pending.map(s => s.name));
    }
    // 'manual' mode: only user-triggered discovery (pending). Otherwise do the one-time first
    // pass for brand-new sources.
    if (sched.bridgesMode !== 'manual' && neverDiscovered.length) {
      await log('info', 'discover:first-pass', { count: neverDiscovered.length, sources: neverDiscovered.map(s => s.name) });
      await discoverBridges(neverDiscovered);
    }
    // 'periodic' mode: re-hunt ALL sources every bridgesEveryDays (the user opted into a refresh
    // cadence from Settings). Default 'new-only' never re-hunts an already-discovered source.
    if (sched.bridgesMode === 'periodic') {
      const store = await chrome.storage.local.get('lastDiscoverAt');
      const last = store.lastDiscoverAt ? new Date(store.lastDiscoverAt).getTime() : 0;
      const due = !last || (Date.now() - last) >= sched.bridgesEveryDays * 86400000;
      if (due) {
        await log('info', 'discover:periodic', { everyDays: sched.bridgesEveryDays });
        await discoverBridges(sources);
        await chrome.storage.local.set({ lastDiscoverAt: new Date().toISOString() });
      }
    }
    if (!pending.length && !neverDiscovered.length && sched.bridgesMode !== 'periodic') {
      await log('info', 'discover:skip', { reason: 'all sources already discovered - prioritizing prospects', bridgesMode: sched.bridgesMode });
    }
  } catch (err) { await log('error', 'discover:error', { error: String(err) }); }

  // Step 2 onward runs inside a try/finally so the dedicated background scrape window is
  // ALWAYS torn down at the end of the run, whatever path we exit by.
  try {
    // Step 2: resolve the list of bridges to collect from. Prefer ACTIVE bridges from the hub;
    // fall back to the hardcoded seed if the hub returns none (and seed them into the hub).
    const bridges = shuffle(await resolveActiveBridges());
    await log('info', 'scrape:bridges', { count: bridges.length, order: 'randomized' });

    const allLeads = [];
    for (const bridge of bridges) {
      try {
        await log('info', 'scrape:start', { bridge: bridge.bridge });
        const leads = await scrapeBridge(bridge);
        await log('info', 'scrape:done', { bridge: bridge.bridge, leadCount: leads.length });
        if (leads.length) notify('New targets', leads.length + ' new connections via ' + bridge.bridge);
        allLeads.push(...leads);
      } catch (err) { await log('error', 'scrape:error', { bridge: bridge.bridge, error: String(err) }); }
      await humanDelay(12000, 28000);
    }
    await log('info', 'scrape:total', { totalLeads: allLeads.length });

    await log('info', 'resolve:start', { toResolve: Math.min(allLeads.filter(l => !l.linkedin_url).length, MAX_RESOLVE_PER_RUN) });
    const resolved = await resolvePublicUrls(allLeads);
    await log('info', 'resolve:done', { resolvedCount: resolved.filter(l => l.linkedin_url).length });

    // Invite non-1st-degree bridges into the dedicated Botdog campaign (best-effort; never blocks the run).
    try { await pushBridgesToBotdog(); } catch (e) { await log('warn', 'bridge-push:error', { error: String(e) }); }

    if (!WEBAPP_URL || WEBAPP_URL === '__WEBAPP_URL__') { await log('warn', 'WEBAPP_URL not set'); return { status: 'no-webapp-url' }; }

    try {
      await log('info', 'ingest:start', { leads: resolved.length });
      const result = await postToHub(resolved);
      await log('info', 'run:done', { written: result.written, status: result.status || 'ok' });
      notify('Sync complete', ((result && result.written) || 0) + ' new targets added.');
      return result;
    } catch(err) { await log('error', 'ingest:error', { error: String(err) }); return { status: 'ingest-error', error: String(err) }; }
  } finally {
    // Always clean up the dedicated background scrape window at the end of the run.
    await closeScrapeWindow();
  }
}

// --- Hub reads (JSONP-style: hub wraps the JSON in a callback we strip) ---
async function fetchHubJsonp(action) {
  const cb  = 'cb';
  const url = WEBAPP_URL + '?action=' + encodeURIComponent(action) + '&callback=' + cb + '&_=' + Date.now();
  const resp = await fetch(url);
  let text = await resp.text();
  text = text.trim();
  // Strip a leading `cb(` (or any `word(`) and a trailing `)` / `);`.
  const open = text.indexOf('(');
  if (open !== -1 && /^[\w$.]+$/.test(text.slice(0, open))) {
    text = text.slice(open + 1);
    text = text.replace(/\)\s*;?\s*$/, '');
  }
  return JSON.parse(text);
}

async function getSources() {
  const data = await fetchHubJsonp('getSources');
  return (data && data.sources) ? data.sources : [];
}

async function getBridges() {
  const data = await fetchHubJsonp('getBridges');
  return (data && data.bridges) ? data.bridges : [];
}

// ─── Bridge invites → dedicated Botdog campaign ─────────────────────────────
// Every sync, invite the bridges you are NOT connected to (not 1st-degree) into the
// dedicated "bridges" Botdog campaign, so they become 1st-degree and their networks
// open up. enricherPro fills the public /in/ URL when it's missing. Deduped via storage.
const BRIDGES_CAMPAIGN_ID_DEFAULT = '3e07e3ee-8144-4429-b73a-1751d1466d35';
const ENRICHER_BASE = 'https://enricherpro.com';
const BOTDOG_CONTACTS_URL = 'https://api.botdog.io/v1/campaigns/contacts';
const MAX_BRIDGE_PUSH_PER_RUN = 25;

// Strip LinkedIn status suffixes / trailing emoji from a name (for enricherPro lookups).
function cleanPersonName(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  const cut = s.match(/\s+(?:is|was)\s+(?:reachable|last active|open to work|a group member|hiring|online|out of office)\b/i);
  if (cut && cut.index >= 0) s = s.slice(0, cut.index);
  s = s.replace(/\s*[•·]\s*.*$/, '');
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}].*$/u, '');
  return s.replace(/\s+/g, ' ').replace(/^[\s.,;:•·\-]+|[\s.,;:•·\-]+$/g, '').trim();
}

// Resolve a public linkedin.com/in/ URL from name+company via enricherPro.
async function enricherResolve(firstName, lastName, company, title) {
  try {
    const resp = await fetch(ENRICHER_BASE + '/api/enrich', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName, lastName, company, title })
    });
    if (!resp.ok) return '';
    const o = await resp.json();
    const url = o.linkedInUrl || o.linkedin_url || '';
    if (url && /linkedin\.com\/in\//i.test(url) && o.linkedInValidated !== false) return String(url).split('?')[0];
  } catch (e) {}
  return '';
}

async function pushBridgesToBotdog() {
  const cfg = await chrome.storage.local.get(['radar_botdog_key', 'radar_bridges_campaign', 'radar_bridges_pushed']);
  const key = cfg.radar_botdog_key;
  const campaign = cfg.radar_bridges_campaign || BRIDGES_CAMPAIGN_ID_DEFAULT;
  if (!key) { await log('info', 'bridge-push:skip', { reason: 'no Botdog key — set it in Settings' }); return { ok: false, reason: 'no-key' }; }
  const pushed = new Set(cfg.radar_bridges_pushed || []);
  let bridges = [];
  try { bridges = await getBridges(); } catch (e) { return { ok: false, reason: 'bridges-fetch-failed' }; }
  const is1st = b => /1st|^1\b/i.test(String(b.connection || ''));
  const todo = bridges.filter(b => b && b.urn && !is1st(b) && !pushed.has(b.urn));
  await log('info', 'bridge-push:start', { candidates: todo.length, campaign });
  let sent = 0;
  for (const b of todo) {
    if (sent >= MAX_BRIDGE_PUSH_PER_RUN) break;
    let url = String(b.linkedin_url || '');
    if (!/linkedin\.com\/in\//i.test(url)) {
      const name = cleanPersonName(b.name || '');
      const parts = name.split(/\s+/);
      url = await enricherResolve(parts.shift() || '', parts.join(' '), b.source || '', b.title || '');
      await sleep(400);
    }
    if (!/linkedin\.com\/in\//i.test(url)) continue;   // no public URL yet — try again next run
    try {
      const resp = await fetch(BOTDOG_CONTACTS_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ campaign_id: campaign, profiles: [{ linkedin_url: url.split('?')[0] }] })
      });
      if (resp.ok) { pushed.add(b.urn); sent++; }
    } catch (e) {}
    await sleep(600);
  }
  await chrome.storage.local.set({ radar_bridges_pushed: [...pushed] });
  await log('info', 'bridge-push:done', { sent });
  if (sent) notify('Bridges invited', sent + ' bridge(s) added to your Botdog invite campaign.');
  return { ok: true, sent, candidates: todo.length };
}

// POST candidate bridges to the hub. Server dedupes by urn and sets active=false for new ones.
async function addBridges(source, bridges) {
  const resp = await fetch(WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: INGEST_SECRET, action: 'addBridges', source, bridges }),
  });
  try { return await resp.json(); } catch (e) { return { success: false, error: String(e) }; }
}

// Activate discovered bridges immediately so the NEXT sync collects prospects from them.
// The hub stores new candidates as active=false; without this they'd sit idle forever and
// the source would show "no bridges yet" even though discovery found people. We auto-activate
// because bridge discovery already narrows to senior roles (+ optional keyword) — the user can
// still deactivate any they don't want from the Bridges tab.
async function activateBridges(bridges) {
  for (const b of bridges) {
    const urn = b && (b.urn || b.entityUrn);
    if (!urn) continue;
    try {
      await fetch(WEBAPP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ secret: INGEST_SECRET, action: 'setBridgeActive', urn, active: true }),
      });
    } catch (e) { /* best-effort; a missed activation is retried on the next discovery */ }
  }
}

// Resolve the bridges to COLLECT from. Prefer ACTIVE hub bridges; else fall back to the
// hardcoded seed AND push the seed into the hub so it can be activated there next time.
// Returns objects shaped like the BRIDGES entries scrapeBridge expects:
//   { bridge, source, category, urn }
async function resolveActiveBridges() {
  let hubBridges = [];
  try { hubBridges = await getBridges(); }
  catch (err) { await log('warn', 'bridges:fetch-failed', { error: String(err) }); }

  const active = (hubBridges || []).filter(b => b.active === true && b.urn);
  if (active.length > 0) {
    await log('info', 'bridges:active', { count: active.length });
    return active.map(b => ({
      bridge:   b.name || '',
      source:   b.source || '',
      category: b.connection || 'partner',
      urn:      b.urn,
    }));
  }

  // Fallback: no active bridges on the hub - use the hardcoded seed and register it.
  await log('warn', 'bridges:none-active-using-seed', { seedCount: BRIDGES.length });
  try {
    const payload = BRIDGES.map(b => ({
      name:         b.bridge,
      title:        '',
      urn:          b.urn,
      linkedin_url: '',
      connection:   b.category || '',
    }));
    const res = await addBridges('The Triana Group', payload);
    await log('info', 'bridges:seed-pushed', { added: (res && res.added) || null, ok: !!(res && res.success) });
  } catch (err) { await log('warn', 'bridges:seed-push-failed', { error: String(err) }); }
  return BRIDGES;
}

// --- Bridge discovery ---
// For each Source with an org_id, search Sales Nav for senior people AT that org and
// propose them as candidate bridges (pushed to the hub as active=false).
async function discoverBridges(sourcesArg) {
  await log('info', 'discover:start');
  let sources = sourcesArg || null;
  if (!sources) {
    try { sources = await getSources(); }
    catch (err) { await log('error', 'discover:sources-failed', { error: String(err) }); return { status: 'sources-failed', error: String(err) }; }
  }

  let totalCandidates = 0;
  for (const src of shuffle(sources)) {
    const orgId = (src.org_id || '').toString().trim();
    if (!orgId) { continue; }
    try {
      // Optional per-source role/function keyword (e.g. "Team France Export"). Essential for
      // large orgs where "senior alone" is too broad — narrows to the bridge's actual function.
      // Strip DSL-breaking chars; spaces are fine (encodeURIComponent handles them below).
      const kw = (src.discover_keyword || '').toString().trim().replace(/[(),:]/g, ' ').replace(/\s+/g, ' ').trim();
      const kwPart = kw ? 'keywords:' + kw + ',' : '';
      await log('info', 'discover:source', { source: src.name, org_id: orgId, keyword: kw || '(none)' });
      const query = '(' + kwPart + 'filters:List((type:CURRENT_COMPANY,values:List((id:urn%3Ali%3Aorganization%3A' + orgId + ',selectionType:INCLUDED))),(type:SENIORITY_LEVEL,values:List(' +
        DISCOVER_SENIORITY_IDS.map(id => '(id:' + id + ',selectionType:INCLUDED)').join(',') +
        '))))';
      const url = 'https://www.linkedin.com/sales/search/people?query=' + encodeURIComponent(query);
      const candidates = await scrapeDiscoveryInTab(url);
      const trimmed = candidates.slice(0, MAX_CANDIDATES_PER_SOURCE);
      if (trimmed.length > 0) {
        const res = await addBridges(src.name, trimmed);
        // Auto-activate so the next sync collects prospects from them (no manual step).
        await activateBridges(trimmed);
        await log('info', 'discover:pushed', { source: src.name, count: trimmed.length, ok: !!(res && res.success), activated: true });
        notify('New bridges', trimmed.length + ' people found at ' + src.name + ' — prospects will be collected on the next sync.');
      } else {
        await log('info', 'discover:empty', { source: src.name });
      }
      totalCandidates += trimmed.length;
      await humanDelay(12000, 28000);
    } catch (err) {
      await log('error', 'discover:source-error', { source: src.name, error: String(err) });
    }
  }
  await log('info', 'discover:done', { totalCandidates });
  return { status: 'ok', totalCandidates };
}

// --- Dedicated background scrape window ---
// Sales Nav VIRTUALIZES results: a tab must be active:true to render. Making it active
// in the user's CURRENT window steals focus every time. Instead we route ALL scraping
// page-opens into a single dedicated background window that is NEVER focused. A tab that
// is active:true inside an UNFOCUSED window still renders (virtualization works), but the
// window itself never grabs the user's focus. Helpers are defensive so a window/tab error
// never aborts a run.
let scrapeWindowId = null;

// Ensure the dedicated background window exists; (re)create it if missing. Returns its id.
async function getScrapeWindow() {
  if (scrapeWindowId !== null) {
    try {
      await chrome.windows.get(scrapeWindowId);
      return scrapeWindowId;  // still exists
    } catch (e) {
      scrapeWindowId = null;  // was closed by the user; recreate below
    }
  }
  try {
    const win = await chrome.windows.create({ focused: false, state: 'normal', width: 1280, height: 900, top: 40, left: 40 });
    scrapeWindowId = win.id;
    // Defensively re-assert unfocused (some platforms briefly focus a new window).
    try { await chrome.windows.update(scrapeWindowId, { focused: false }); } catch (e) {}
  } catch (e) {
    scrapeWindowId = null;
  }
  return scrapeWindowId;
}

// Open a scrape URL as an active tab INSIDE the unfocused background window (renders, no
// global focus steal). Returns the created tab (or null on failure).
async function openScrapeTab(url) {
  const winId = await getScrapeWindow();
  if (winId === null) return null;
  try {
    const tab = await chrome.tabs.create({ windowId: winId, url, active: true });
    // Re-assert unfocused right after, defensively — the window must never grab focus.
    try { await chrome.windows.update(winId, { focused: false }); } catch (e) {}
    return tab;
  } catch (e) {
    return null;
  }
}

// Tear down the dedicated background window (called at the end of a run).
async function closeScrapeWindow() {
  if (scrapeWindowId !== null) {
    try { await chrome.windows.remove(scrapeWindowId); } catch (e) {}
    scrapeWindowId = null;
  }
}

// Open the discovery search in a background tab (inside the unfocused scrape window) and
// scrape candidate bridge cards.
async function scrapeDiscoveryInTab(url) {
  const tab = await openScrapeTab(url);
  if (!tab) throw new Error('scrape window/tab unavailable');
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractCandidatesFromPage }, results => {
        const out = (results && results[0]) ? (results[0].result || []) : [];
        const err = chrome.runtime.lastError;
        // Linger like a human reading the page, then close the tab (leave the window open).
        setTimeout(() => { try { chrome.tabs.remove(tab.id); } catch (e) {} }, 3500 + Math.floor(Math.random() * 5000));
        if (err) { reject(new Error(err.message)); return; }
        resolve(out);
      });
    }, 6000 + Math.floor(Math.random() * 3500));
  });
}

// Injected into the discovery search page. Anchors on the /sales/lead/ links, climbs to
// the card, reads name, urn, title, and connection degree. Returns candidate bridge objects
// shaped for addBridges: { name, title, urn, linkedin_url, connection }.
async function extractCandidatesFromPage() {
  // Sales Nav renders results as a VIRTUALIZED list: only cards near the viewport exist
  // in the DOM at any moment. So we scroll-accumulate — extract every rendered card into
  // a Map keyed by urn (so each person is captured once even as cards recycle), scroll one
  // viewport, let the next batch render, and repeat.
  const byUrn = new Map();
  const CAP = 60;

  // Robust name cleaner: strip LinkedIn status suffixes ("… is reachable",
  // "… was last active 2 days ago", etc.), trailing emoji/flag/symbol runs, and
  // trailing " • …" segments / stray punctuation. Returns just the person's name.
  const STATUS_WORDS = 'reachable|last active|open to work|a group member|hiring|online|out of office';
  const cleanName = (raw) => {
    let s = (raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    // 1) Cut at the first " is " / " was " followed by a status word.
    const cut = s.match(new RegExp('\\s+(?:is|was)\\s+(?:' + STATUS_WORDS + ')\\b', 'i'));
    if (cut && cut.index >= 0) s = s.slice(0, cut.index);
    // 2) Drop any trailing " • …" segments (LinkedIn appends these after the name).
    s = s.replace(/\s*[•·]\s*.*$/, '');
    // 3) Strip a trailing run of emoji / flags / symbols (from the first such char
    //    at the tail through the end): keep only up to the last Latin-letter word.
    s = s.replace(/[^\p{L}\p{N}.'\-)]+$/u, '');            // trailing symbols/punct
    s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}].*$/u, '');
    // 4) Final tidy: collapse spaces and trim stray leading/trailing punctuation.
    s = s.replace(/\s+/g, ' ').replace(/^[\s.,;:•·\-]+|[\s.,;:•·\-]+$/g, '').trim();
    return s;
  };

  // Extract every currently-rendered lead card into the Map (defensive per-card).
  const harvest = () => {
    document.querySelectorAll('a[href*="/sales/lead/"]').forEach(linkEl => {
      try {
        const name = cleanName(linkEl.textContent || '');
        if (!name) return;
        const urnMatch = linkEl.href.match(/\/sales\/lead\/([^,?\/]+)/);
        if (!urnMatch) return;
        const urn = urnMatch[1];
        if (byUrn.has(urn)) return;  // already captured this person
        const linkedin_url = linkEl.href.split('?')[0];  // Sales Nav profile link (open to connect)

        // Climb to the card.
        let card = linkEl;
        for (let i = 0; i < 7 && card && card.parentElement; i++) {
          card = card.parentElement;
          if (card.querySelector('a[href*="/sales/company/"]') || (card.textContent || '').length > 60) break;
        }
        if (!card) card = linkEl.parentElement || linkEl;

        // Text leaves in the card.
        const txts = Array.from(card.querySelectorAll('span, div'))
          .map(e => e.childElementCount === 0 ? (e.textContent || '').replace(/\s+/g, ' ').trim() : '')
          .filter(Boolean);
        const compEl  = card.querySelector('a[href*="/sales/company/"]');
        const company = compEl ? compEl.textContent.replace(/\s+/g, ' ').trim() : '';

        // Connection degree - look for a 1st/2nd/3rd token in the card text AND aria-labels.
        // Handles "· 1st", "1st degree", a leading-dot form, or a standalone token.
        let connection = '';
        const degSources = [card.textContent || ''];
        try {
          card.querySelectorAll('[aria-label]').forEach(el => degSources.push(el.getAttribute('aria-label') || ''));
        } catch (e) {}
        for (const src of degSources) {
          const m = src.match(/(?:[·•.]\s*)?\b(1st|2nd|3rd)\b(?:\s*degree)?/i);
          if (m) { connection = m[1].toLowerCase(); break; }
        }

        // Title/headline = the LONGEST descriptive leaf that isn't the name, a status
        // phrase, a lone degree token, the company, "mutual connections"/"connection"
        // text, or "Message"/"View … profile" UI text.
        const nlow = name.toLowerCase();
        const clow = company.toLowerCase();
        let title = '';
        for (const t of txts) {
          if (!t || t.length < 3) continue;
          const tl = t.toLowerCase();
          if (tl === nlow || tl.indexOf(nlow) === 0) continue;
          if (clow && (tl === clow || tl.indexOf(clow) === 0)) continue;
          if (/^[·•.\s]*(1st|2nd|3rd)(\s*degree)?[·•.\s]*$/i.test(t)) continue;
          if (/\b(is|was)\s+(reachable|last active|open to work|a group member|hiring|online|out of office)\b/i.test(t)) continue;
          if (/mutual connection|connections?$|^shared|degree connection/i.test(t)) continue;
          if (/^message$|view .* profile|^view profile|^connect$|^save$|^more$/i.test(t)) continue;
          if (t.length > title.length) title = t;  // keep the longest qualifying leaf
        }
        if (title.length > 200) title = title.slice(0, 200);

        byUrn.set(urn, { name, title: title, urn, linkedin_url: linkedin_url, connection });
      } catch (e) {}
    });
  };

  // 1) Wait for the first lead link to appear (poll up to ~15s, scrolling to bottom each pass).
  for (let _p = 0; _p < 15; _p++) {
    if (document.querySelectorAll('a[href*="/sales/lead/"]').length > 0) break;
    try { window.scrollTo(0, document.body.scrollHeight); } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 400));

  // 2) Scroll-accumulate: harvest, scroll ~one viewport, let next batch render. Stop early
  // if no NEW urns are seen for 3 consecutive iterations, or once we hit the cap.
  let stale = 0;
  for (let iter = 0; iter < 18 && byUrn.size < CAP; iter++) {
    const before = byUrn.size;
    harvest();
    if (byUrn.size === before) { stale++; if (stale >= 3) break; } else { stale = 0; }
    try { window.scrollBy(0, Math.round(window.innerHeight * 0.8)); } catch (e) {}
    await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random() * 600)));
  }
  harvest();  // final pass after the last scroll

  // Return accumulated values (deduped by urn), capped for safety.
  return Array.from(byUrn.values()).slice(0, CAP);
}

async function checkLogin() {
  return new Promise(resolve => {
    chrome.tabs.query({ url: 'https://www.linkedin.com/sales/*' }, tabs => {
      if (tabs.length > 0) { resolve(true); return; }
      chrome.tabs.query({ url: 'https://www.linkedin.com/*' }, t => resolve(t.length > 0));
    });
  });
}

async function scrapeBridge(bridge) {
  const leads = [];
  const urn  = bridge.urn;
  const name = bridge.bridge.replace(/ /g, '%20');
  const query = '(filters:List((type:SENIORITY_LEVEL,values:List((id:320,text:Owner%20%2F%20Partner,selectionType:INCLUDED),(id:310,text:CXO,selectionType:INCLUDED))),(type:COMPANY_HEADCOUNT,values:List((id:C,text:11-50,selectionType:INCLUDED))),(type:CONNECTION_OF,values:List((id:' + urn + ',text:' + name + ',selectionType:INCLUDED))),(type:REGION,values:List((id:100506914,text:Europe,selectionType:INCLUDED))),(type:LEAD_INTERACTIONS,values:List((id:LIMP,text:Messaged,selectionType:EXCLUDED)))))';
  const baseUrl = 'https://www.linkedin.com/sales/search/people?query=' + encodeURIComponent(query);
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = baseUrl + (page > 1 ? '&page=' + page : '');
    await log('info', 'scrape:page', { bridge: bridge.bridge, page });
    const pageLeads = await scrapePageInTab(url, bridge);
    if (!pageLeads || pageLeads.length === 0) { await log('info', 'scrape:page-empty', { bridge: bridge.bridge, page }); break; }
    leads.push(...pageLeads);
    await log('info', 'scrape:page-done', { bridge: bridge.bridge, page, count: pageLeads.length });
    if (pageLeads.length < 25) break;
    await humanDelay(6000, 14000);
  }
  return leads;
}

async function scrapePageInTab(url, bridge) {
  const tab = await openScrapeTab(url);
  if (!tab) throw new Error('scrape window/tab unavailable');
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractLeadsFromPage, args: [bridge.bridge, bridge.category, bridge.source] }, results => {
        const out = (results && results[0]) ? (results[0].result || []) : [];
        const err = chrome.runtime.lastError;
        // Linger like a human reading the page, then close the tab (leave the window open).
        setTimeout(() => { try { chrome.tabs.remove(tab.id); } catch (e) {} }, 3500 + Math.floor(Math.random() * 5000));
        if (err) { reject(new Error(err.message)); return; }
        resolve(out);
      });
    }, 6000 + Math.floor(Math.random() * 3500));
  });
}

async function extractLeadsFromPage(radarPerson, category, source) {
  // Sales Nav renders results as a VIRTUALIZED list: only cards near the viewport exist
  // in the DOM at any moment. So we scroll-accumulate — extract every rendered card into
  // a Map keyed by the URN (lead_id), scroll one viewport, let the next batch render, and
  // repeat, so each person is captured once even as cards recycle.
  const byUrn = new Map();
  const CAP = 60;

  // Robust name cleaner: strip LinkedIn status suffixes ("… is reachable",
  // "… was last active 2 days ago", etc.), trailing emoji/flag/symbol runs, and
  // trailing " • …" segments / stray punctuation. Returns just the person's name.
  const STATUS_WORDS = 'reachable|last active|open to work|a group member|hiring|online|out of office';
  const cleanName = (raw) => {
    let s = (raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    // 1) Cut at the first " is " / " was " followed by a status word.
    const cut = s.match(new RegExp('\\s+(?:is|was)\\s+(?:' + STATUS_WORDS + ')\\b', 'i'));
    if (cut && cut.index >= 0) s = s.slice(0, cut.index);
    // 2) Drop any trailing " • …" segments (LinkedIn appends these after the name).
    s = s.replace(/\s*[•·]\s*.*$/, '');
    // 3) Strip a trailing run of emoji / flags / symbols.
    s = s.replace(/[^\p{L}\p{N}.'\-)]+$/u, '');            // trailing symbols/punct
    s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}].*$/u, '');
    // 4) Final tidy.
    s = s.replace(/\s+/g, ' ').replace(/^[\s.,;:•·\-]+|[\s.,;:•·\-]+$/g, '').trim();
    return s;
  };

  // Extract every currently-rendered lead card into the Map (defensive per-card).
  const harvest = () => {
    // Anchor on the lead link, then climb to the card that also holds a company link.
    document.querySelectorAll('a[href*="/sales/lead/"]').forEach(linkEl => {
      try {
        // Clean status suffixes / emoji off the name BEFORE splitting into first/last.
        const name = cleanName(linkEl.textContent || '');
        if (!name) return;
        const urnMatch = linkEl.href.match(/\/sales\/lead\/([^,?\/]+)/);
        const parts = name.split(' ');
        const lead_id = urnMatch ? urnMatch[1] : (parts[0] + (parts[1] || '')).replace(/\s/g, '');
        if (byUrn.has(lead_id)) return;  // already captured this person

        let card = linkEl;
        for (let i = 0; i < 6 && card && card.parentElement; i++) {
          card = card.parentElement;
          if (card.querySelector('a[href*="/sales/company/"]')) break;
        }
        if (!card) return;
        const compEl   = card.querySelector('a[href*="/sales/company/"]');
        const company  = compEl ? compEl.textContent.replace(/\s+/g, ' ').trim() : '';

        // Text leaves in the card = elements with no child elements (the visible bits of text).
        const txts = Array.from(card.querySelectorAll('span, div'))
          .map(e => e.childElementCount === 0 ? (e.textContent || '').replace(/\s+/g, ' ').trim() : '')
          .filter(Boolean);

        const nlow = name.toLowerCase();
        const clow = company.toLowerCase();

        // Connection degree of THIS prospect relative to the user (1st/2nd/3rd).
        // Scan the card's text and any aria-labels for the degree badge.
        let connection = '';
        try {
          let deg = (card.textContent || '').match(/(?:^|[·•\s])(1st|2nd|3rd)\b/i)
                 || (card.textContent || '').match(/\b(1st|2nd|3rd)\s+degree/i);
          if (!deg) {
            const al = Array.from(card.querySelectorAll('[aria-label]'))
              .map(e => e.getAttribute('aria-label') || '').join(' ');
            deg = al.match(/\b(1st|2nd|3rd)\b/i);
          }
          if (deg) connection = deg[1].toLowerCase();
        } catch (e) {}

        // Location = a short text leaf that looks like a place: contains a comma OR ends in
        // "Region"/"Area" (e.g. "Greater Paris Metropolitan Region", "London, England, United
        // Kingdom"), and isn't the name/company/status/degree/UI text. Best-effort.
        let location = '';
        for (const t of txts) {
          if (!t || t.length < 3 || t.length > 80) continue;
          const tl = t.toLowerCase();
          if (tl === nlow || tl.indexOf(nlow) === 0) continue;
          if (clow && (tl === clow || tl.indexOf(clow) === 0)) continue;
          if (/^[·•.\s]*(1st|2nd|3rd)(\s*degree)?[·•.\s]*$/i.test(t)) continue;
          if (/\b(is|was)\s+(reachable|last active|open to work|a group member|hiring|online|out of office)\b/i.test(t)) continue;
          if (/mutual connection|connections?$|^shared|degree connection/i.test(t)) continue;
          if (/^message$|view .* profile|^view profile|^connect$|^save$|^more$/i.test(t)) continue;
          const looksPlace = t.indexOf(',') !== -1 || /(?:Region|Area)$/i.test(t);
          if (!looksPlace) continue;
          location = t;
          break;  // take the first plausible location leaf
        }
        // Derive country/city from a comma-separated location; else leave blank.
        let country = '', city = '';
        if (location.indexOf(',') !== -1) {
          const segs = location.split(',').map(s => s.trim()).filter(Boolean);
          if (segs.length) { city = segs[0]; country = segs[segs.length - 1]; }
        }

        // Title/headline = the LONGEST descriptive leaf that isn't the name, a status phrase,
        // a lone degree token, the company, "mutual connection(s)"/connection text, the
        // captured location, or "Message"/"Save"/"Connect"/"View … profile" UI text. Cap ~200.
        let title = '';
        for (const t of txts) {
          if (!t || t.length < 3) continue;
          const tl = t.toLowerCase();
          if (tl === nlow || tl.indexOf(nlow) === 0) continue;
          if (clow && (tl === clow || tl.indexOf(clow) === 0)) continue;
          if (location && t === location) continue;
          if (/^[·•.\s]*(1st|2nd|3rd)(\s*degree)?[·•.\s]*$/i.test(t)) continue;
          if (/\b(is|was)\s+(reachable|last active|open to work|a group member|hiring|online|out of office)\b/i.test(t)) continue;
          if (/mutual connection|connections?$|^shared|degree connection/i.test(t)) continue;
          if (/^message$|view .* profile|^view profile|^connect$|^save$|^more$/i.test(t)) continue;
          // Reject Sales Nav CTA/placeholder text that appears where a title would be for
          // out-of-network cards (e.g. "Save this lead to your list and get alerts when they
          // change jobs, post to LinkedIn, and more.").
          if (/save this lead|get alerts|save to list|add to list|change jobs, post/i.test(tl)) continue;
          if (t.length > title.length) title = t;  // keep the longest qualifying leaf
        }
        if (title.length > 200) title = title.slice(0, 200);

        // Language (best-effort): only from the card, never by opening the profile. If the card
        // (or a descendant) carries a `lang` attribute, use its value; otherwise leave blank.
        let language = '';
        try {
          const langEl = card.matches('[lang]') ? card : card.querySelector('[lang]');
          if (langEl) language = (langEl.getAttribute('lang') || '').trim();
        } catch (e) {}

        byUrn.set(lead_id, {
          first_name: parts[0] || '',
          last_name: parts.slice(1).join(' ') || '',
          title: title,
          company: company,
          connection: connection,
          location: location,
          country: country,
          city: city,
          language: language,
          radar_person: radarPerson,
          source: source || '',
          lead_id: lead_id,
          collected_date: new Date().toISOString(),
          linkedin_url: ''
        });
      } catch(e) {}
    });
  };

  // 1) Wait for the first lead link to appear (poll up to ~15s, scrolling to bottom each pass).
  for (let _p = 0; _p < 15; _p++) {
    if (document.querySelectorAll('a[href*="/sales/lead/"]').length > 0) break;
    try { window.scrollTo(0, document.body.scrollHeight); } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 400));

  // 2) Scroll-accumulate: harvest, scroll ~one viewport, let next batch render. Stop early
  // if no NEW urns are seen for 3 consecutive iterations, or once we hit the cap.
  let stale = 0;
  for (let iter = 0; iter < 18 && byUrn.size < CAP; iter++) {
    const before = byUrn.size;
    harvest();
    if (byUrn.size === before) { stale++; if (stale >= 3) break; } else { stale = 0; }
    try { window.scrollBy(0, Math.round(window.innerHeight * 0.8)); } catch (e) {}
    await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random() * 600)));
  }
  harvest();  // final pass after the last scroll

  // Return accumulated values (deduped by lead_id/urn), capped for safety.
  return Array.from(byUrn.values()).slice(0, CAP);
}

async function resolvePublicUrls(leads) {
  for (const lead of leads.filter(l => !l.linkedin_url && l.lead_id).slice(0, MAX_RESOLVE_PER_RUN)) {
    try { const url = await resolveUrn(lead.lead_id); if (url) lead.linkedin_url = url; }
    catch(e) { await log('warn', 'resolve:urn-failed', { lead_id: lead.lead_id, error: String(e) }); }
    await sleep(600);
  }
  return leads;
}

async function resolveUrn(urn) {
  const tab = await openScrapeTab('https://www.linkedin.com/sales/lead/' + urn + ',NAME_SEARCH,undefined');
  if (!tab) return null;
  return new Promise(resolve => {
    setTimeout(() => {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { const l = document.querySelector('a[href*="linkedin.com/in/"]'); return l ? l.href.split('?')[0] : null; } }, results => {
        try { chrome.tabs.remove(tab.id); } catch (e) {}
        resolve(results && results[0] ? results[0].result : null);
      });
    }, 2500);
  });
}

async function postToHub(leads) {
  const resp = await fetch(WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: INGEST_SECRET, leads }) });
  return resp.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Randomized human-like delay (ms) to avoid looking automated to LinkedIn.
function humanDelay(minMs, maxMs) { return sleep(minMs + Math.floor(Math.random() * Math.max(0, maxMs - minMs))); }

// Fisher-Yates shuffle. We randomize the ORDER in which we visit bridges (and sources during
// discovery) on every run, so the access pattern isn't identical each time — a fixed order is
// an easy automation signature for LinkedIn to spot. Returns a shuffled copy.
function shuffle(arr) {
  const a = (arr || []).slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

// Accent-insensitive key for matching source names between getSources and getBridges.
function _normName(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }

// Desktop notification from Radar. Fails silently if the permission isn't granted.
function notify(title, message) {
  try {
    chrome.notifications.create('radar_' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Radar — ' + title,
      message: String(message || ''),
      priority: 1
    });
  } catch (e) {}
}
