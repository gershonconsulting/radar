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
const MAX_CANDIDATES_PER_SOURCE = 25;

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

// --- Alarms ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('dailySync', { periodInMinutes: 1440 });
  log('info', 'Extension installed, daily alarm set');
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'dailySync') runSync(); });

// --- Messages ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'syncNow') {
    runSync().then(async r => { await pushLog(); sendResponse({ ok: true, result: r }); }).catch(async e => { await pushLog(); sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
  if (msg.action === 'discoverNow') {
    discoverBridges().then(async r => { await pushLog(); sendResponse({ ok: true, result: r }); }).catch(async e => { await pushLog(); sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
  if (msg.action === 'getLog') {
    chrome.storage.local.get('radarLog', d => sendResponse({ ok: true, log: d.radarLog || [] }));
    return true;
  }
  if (msg.action === 'clearLog') { clearLog().then(() => sendResponse({ ok: true })); return true; }
});

// Forward the run log to the hub so it's visible server-side (for debugging).
async function pushLog() {
  try {
    const stored = await chrome.storage.local.get('radarLog');
    const arr = stored.radarLog || [];
    await fetch(WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secret: INGEST_SECRET, action: 'pushLog', log: arr.slice(0, 150) }) });
  } catch (e) {}
}

// --- Main sync ---
async function runSync() {
  await clearLog();
  await log('info', 'run:start');
  const loggedIn = await checkLogin();
  await log('info', 'login-check', { loggedIn });
  if (!loggedIn) { await log('warn', 'No Sales Nav tab detected - proceeding anyway (opened tabs use your logged-in session)'); }

  // Step 1: discover new candidate bridges from Sources (best-effort, never blocks collection).
  try { await discoverBridges(); }
  catch (err) { await log('error', 'discover:error', { error: String(err) }); }

  // Step 2: resolve the list of bridges to collect from. Prefer ACTIVE bridges from the hub;
  // fall back to the hardcoded seed if the hub returns none (and seed them into the hub).
  const bridges = await resolveActiveBridges();
  await log('info', 'scrape:bridges', { count: bridges.length });

  const allLeads = [];
  for (const bridge of bridges) {
    try {
      await log('info', 'scrape:start', { bridge: bridge.bridge });
      const leads = await scrapeBridge(bridge);
      await log('info', 'scrape:done', { bridge: bridge.bridge, leadCount: leads.length });
      allLeads.push(...leads);
    } catch (err) { await log('error', 'scrape:error', { bridge: bridge.bridge, error: String(err) }); }
  }
  await log('info', 'scrape:total', { totalLeads: allLeads.length });

  await log('info', 'resolve:start', { toResolve: Math.min(allLeads.filter(l => !l.linkedin_url).length, MAX_RESOLVE_PER_RUN) });
  const resolved = await resolvePublicUrls(allLeads);
  await log('info', 'resolve:done', { resolvedCount: resolved.filter(l => l.linkedin_url).length });

  if (!WEBAPP_URL || WEBAPP_URL === '__WEBAPP_URL__') { await log('warn', 'WEBAPP_URL not set'); return { status: 'no-webapp-url' }; }

  try {
    await log('info', 'ingest:start', { leads: resolved.length });
    const result = await postToHub(resolved);
    await log('info', 'run:done', { written: result.written, status: result.status || 'ok' });
    return result;
  } catch(err) { await log('error', 'ingest:error', { error: String(err) }); return { status: 'ingest-error', error: String(err) }; }
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

// POST candidate bridges to the hub. Server dedupes by urn and sets active=false for new ones.
async function addBridges(source, bridges) {
  const resp = await fetch(WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: INGEST_SECRET, action: 'addBridges', source, bridges }),
  });
  try { return await resp.json(); } catch (e) { return { success: false, error: String(e) }; }
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
async function discoverBridges() {
  await log('info', 'discover:start');
  let sources = [];
  try { sources = await getSources(); }
  catch (err) { await log('error', 'discover:sources-failed', { error: String(err) }); return { status: 'sources-failed', error: String(err) }; }

  let totalCandidates = 0;
  for (const src of sources) {
    const orgId = (src.org_id || '').toString().trim();
    if (!orgId) { continue; }
    try {
      await log('info', 'discover:source', { source: src.name, org_id: orgId });
      const query = '(filters:List((type:CURRENT_COMPANY,values:List((id:urn%3Ali%3Aorganization%3A' + orgId + ',selectionType:INCLUDED))),(type:SENIORITY_LEVEL,values:List(' +
        DISCOVER_SENIORITY_IDS.map(id => '(id:' + id + ',selectionType:INCLUDED)').join(',') +
        '))))';
      const url = 'https://www.linkedin.com/sales/search/people?query=' + encodeURIComponent(query);
      const candidates = await scrapeDiscoveryInTab(url);
      const trimmed = candidates.slice(0, MAX_CANDIDATES_PER_SOURCE);
      if (trimmed.length > 0) {
        const res = await addBridges(src.name, trimmed);
        await log('info', 'discover:pushed', { source: src.name, count: trimmed.length, ok: !!(res && res.success) });
      } else {
        await log('info', 'discover:empty', { source: src.name });
      }
      totalCandidates += trimmed.length;
      await sleep(1500);
    } catch (err) {
      await log('error', 'discover:source-error', { source: src.name, error: String(err) });
    }
  }
  await log('info', 'discover:done', { totalCandidates });
  return { status: 'ok', totalCandidates };
}

// Open the discovery search in a background tab and scrape candidate bridge cards.
async function scrapeDiscoveryInTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, tab => {
      setTimeout(() => {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractCandidatesFromPage }, results => {
          chrome.tabs.remove(tab.id);
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          resolve(results && results[0] ? results[0].result || [] : []);
        });
      }, 5000);
    });
  });
}

// Injected into the discovery search page. Anchors on the /sales/lead/ links, climbs to
// the card, reads name, urn, title, and connection degree. Returns candidate bridge objects
// shaped for addBridges: { name, title, urn, linkedin_url, connection }.
async function extractCandidatesFromPage() {
  // Sales Nav lazy-renders search results; poll (and scroll) until the lead links appear.
  for (let _p = 0; _p < 15; _p++) {
    if (document.querySelectorAll('a[href*="/sales/lead/"]').length > 0) break;
    try { window.scrollTo(0, document.body.scrollHeight); } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 400));
  const results = [];
  document.querySelectorAll('a[href*="/sales/lead/"]').forEach(linkEl => {
    try {
      const name = (linkEl.textContent || '').trim();
      if (!name) return;
      const urnMatch = linkEl.href.match(/\/sales\/lead\/([^,?\/]+)/);
      if (!urnMatch) return;
      const urn = urnMatch[1];

      // Climb to the card (the ancestor that also holds a company link, if present).
      let card = linkEl;
      for (let i = 0; i < 6 && card && card.parentElement; i++) {
        card = card.parentElement;
        if (card.querySelector('a[href*="/sales/company/"]')) break;
      }
      if (!card) card = linkEl.parentElement || linkEl;

      // Collect the text leaves in the card, in document order.
      const txts = Array.from(card.querySelectorAll('span, div'))
        .map(e => e.childElementCount === 0 ? (e.textContent || '').trim() : '')
        .filter(Boolean);

      // Title = text leaf near the company name; else the leaf right after the name.
      let title = '';
      const compEl  = card.querySelector('a[href*="/sales/company/"]');
      const company = compEl ? compEl.textContent.trim() : '';
      const ci = company ? txts.indexOf(company) : -1;
      if (ci > 0) title = txts[ci - 1];
      if (!title) {
        const ni = txts.indexOf(name);
        if (ni !== -1 && ni + 1 < txts.length) title = txts[ni + 1];
      }

      // Connection degree - look for a 1st/2nd/3rd token in the card text.
      let connection = '';
      const degMatch = (card.textContent || '').match(/\b(1st|2nd|3rd)\b/);
      if (degMatch) connection = degMatch[1];

      results.push({ name, title: title || '', urn, linkedin_url: '', connection });
    } catch (e) {}
  });
  // De-dupe by urn within the page.
  const seen = new Set();
  return results.filter(r => { if (seen.has(r.urn)) return false; seen.add(r.urn); return true; });
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
    await sleep(1500);
  }
  return leads;
}

async function scrapePageInTab(url, bridge) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, tab => {
      setTimeout(() => {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractLeadsFromPage, args: [bridge.bridge, bridge.category, bridge.source] }, results => {
          chrome.tabs.remove(tab.id);
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          resolve(results && results[0] ? results[0].result || [] : []);
        });
      }, 5000);
    });
  });
}

function extractLeadsFromPage(radarPerson, category, source) {
  const results = [];
  // Anchor on the lead link, then climb to the card that also holds a company link.
  document.querySelectorAll('a[href*="/sales/lead/"]').forEach(linkEl => {
    try {
      let card = linkEl;
      for (let i = 0; i < 6 && card && card.parentElement; i++) {
        card = card.parentElement;
        if (card.querySelector('a[href*="/sales/company/"]')) break;
      }
      if (!card) return;
      const name = (linkEl.textContent || '').trim();
      if (!name) return;
      const urnMatch = linkEl.href.match(/\/sales\/lead\/([^,?\/]+)/);
      const compEl   = card.querySelector('a[href*="/sales/company/"]');
      const company  = compEl ? compEl.textContent.trim() : '';
      // Title = the text leaf sitting just before the company name in the card.
      let title = '';
      const txts = Array.from(card.querySelectorAll('span, div'))
        .map(e => e.childElementCount === 0 ? (e.textContent || '').trim() : '')
        .filter(Boolean);
      const ci = txts.indexOf(company);
      if (ci > 0) title = txts[ci - 1];
      const parts = name.split(' ');
      results.push({
        first_name: parts[0] || '',
        last_name: parts.slice(1).join(' ') || '',
        title: title,
        company: company,
        radar_person: radarPerson,
        source: source || '',
        lead_id: urnMatch ? urnMatch[1] : (parts[0] + (parts[1] || '')).replace(/\s/g, ''),
        collected_date: new Date().toISOString(),
        linkedin_url: ''
      });
    } catch(e) {}
  });
  // De-dupe by lead_id within the page.
  const seen = new Set();
  return results.filter(r => { if (seen.has(r.lead_id)) return false; seen.add(r.lead_id); return true; });
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
  return new Promise(resolve => {
    chrome.tabs.create({ url: 'https://www.linkedin.com/sales/lead/' + urn + ',NAME_SEARCH,undefined', active: false }, tab => {
      setTimeout(() => {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { const l = document.querySelector('a[href*="linkedin.com/in/"]'); return l ? l.href.split('?')[0] : null; } }, results => {
          chrome.tabs.remove(tab.id);
          resolve(results && results[0] ? results[0].result : null);
        });
      }, 2500);
    });
  });
}

async function postToHub(leads) {
  const resp = await fetch(WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: INGEST_SECRET, leads }) });
  return resp.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
