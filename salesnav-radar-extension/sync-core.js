// =============================================================
// Radar — Sales Navigator Collector (sync-core.js / service worker)
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
    runSync().then(r => sendResponse({ ok: true, result: r })).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.action === 'getLog') {
    chrome.storage.local.get('radarLog', d => sendResponse({ ok: true, log: d.radarLog || [] }));
    return true;
  }
  if (msg.action === 'clearLog') { clearLog().then(() => sendResponse({ ok: true })); return true; }
});

// --- Main sync ---
async function runSync() {
  await clearLog();
  await log('info', 'run:start');
  const loggedIn = await checkLogin();
  await log('info', 'login-check', { loggedIn });
  if (!loggedIn) { await log('warn', 'Not logged into Sales Navigator — open a Sales Nav tab first'); return { status: 'not-logged-in' }; }

  const allLeads = [];
  for (const bridge of BRIDGES) {
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
