// =============================================================
// Radar — Sales Navigator Collector  (sync-core.js / service worker)
// Scrapes connections from Sales Navigator, resolves public /in/ URLs,
// POSTs to Apps Script hub.
// =============================================================

const WEBAPP_URL      = 'https://script.google.com/macros/s/AKfycbzFX-DPwGDGFPoIxdYwNq5mMztXHNs33PHUNQox-vgrvQbgA2KLccMN9DI-YURCIWxbPw/exec';
const INGEST_SECRET    = 'radar_7Kq3mZ9pX2vL8nT';
const MAX_PAGES        = 25;
const MAX_RESOLVE_PER_RUN = 100;

// Bridges: each entry is a Sales Navigator list URL fragment + metadata
const BRIDGES = [
  {
    bridge: 'Elie Cohen',
    category: 'partner',
    urn: 'ACwAAAALvckBqvkWA1X60puCvmWbDTndKhJyWdw',
    // Exact saved-search query (Olivier's ICP: Owner/Partner+CXO, 11-50, Europe, connections-of Elie Cohen, exclude Messaged)
    savedSearchId: '5671606490'
  },
];

// ICP target filters applied during scrape
const SEARCH_FILTERS = {
  seniority:      ['Owner / Partner', 'CXO'],   // ids: 320, 310
  geography:      'Europe',                      // id: 100506914
  headcountMin:   11,
  headcountMax:   50,                            // headcount bucket C: 11-50
  excludeMessaged: true,                         // LEAD_INTERACTIONS: LIMP excluded
};

// ---------------------------------------------------------------
// Install daily alarm on startup
// ---------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('dailySync', { periodInMinutes: 1440 });
  console.log('[Radar] Extension installed, daily alarm set');
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'dailySync') runSync();
});

// ---------------------------------------------------------------
// Message handler — triggered by popup "Sync Now" button
// ---------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'syncNow') {
    runSync().then(result => sendResponse({ ok: true, result }))
             .catch(err  => sendResponse({ ok: false, error: String(err) }));
    return true; // keep channel open for async
  }
});

// ---------------------------------------------------------------
// Main sync flow
// ---------------------------------------------------------------
async function runSync() {
  console.log('[Radar] run:start');

  // 1. Check Sales Nav login
  const loggedIn = await checkLogin();
  console.log('[Radar] login-check', { loggedIn });
  if (!loggedIn) { console.warn('[Radar] Not logged in, aborting'); return { status: 'not-logged-in' }; }

  // 2. Scrape leads from each bridge
  const allLeads = [];
  for (const bridge of BRIDGES) {
    try {
      const leads = await scrapeBridge(bridge);
      console.log('[Radar] scrape-done', { bridge: bridge.bridge, leadCount: leads.length });
      allLeads.push(...leads);
    } catch (err) {
      console.error('[Radar] scrape-error', bridge.bridge, String(err));
    }
  }

  // 3. Resolve public LinkedIn URLs
  const resolved = await resolvePublicUrls(allLeads);
  console.log('[Radar] resolve-done', { resolved: resolved.filter(l => l.linkedin_url).length });

  // 4. POST to Apps Script
  if (!WEBAPP_URL || WEBAPP_URL === '__WEBAPP_URL__') {
    console.warn('[Radar] WEBAPP_URL not configured');
    return { status: 'no-webapp-url', leads: resolved };
  }

  const result = await postToHub(resolved);
  console.log('[Radar] run:done', result);
  return result;
}

// ---------------------------------------------------------------
// Check if logged into Sales Navigator
// ---------------------------------------------------------------
async function checkLogin() {
  return new Promise(resolve => {
    chrome.tabs.query({ url: 'https://www.linkedin.com/sales/*' }, tabs => {
      if (tabs.length > 0) { resolve(true); return; }
      // Try to get any LinkedIn tab
      chrome.tabs.query({ url: 'https://www.linkedin.com/*' }, allTabs => {
        resolve(allTabs.length > 0);
      });
    });
  });
}

// ---------------------------------------------------------------
// Scrape a bridge's Sales Navigator connection list
// ---------------------------------------------------------------
async function scrapeBridge(bridge) {
  const leads = [];
  // Open a hidden tab to Sales Nav connections filtered by bridge URN
  const baseUrl = `https://www.linkedin.com/sales/lists/people?listType=CONNECTIONS&connectionOf=${bridge.urn}`;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = baseUrl + `&page=${page}`;
    const pageLeads = await scrapePageInTab(url, bridge);
    if (!pageLeads || pageLeads.length === 0) break;
    leads.push(...pageLeads);
    if (pageLeads.length < 25) break; // last page
    await sleep(1500);
  }

  return leads;
}

async function scrapePageInTab(url, bridge) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, tab => {
      const tabId = tab.id;
      setTimeout(() => {
        chrome.scripting.executeScript({
          target: { tabId },
          func: extractLeadsFromPage,
          args: [bridge.bridge, bridge.category]
        }, results => {
          chrome.tabs.remove(tabId);
          if (chrome.runtime.lastError) { resolve([]); return; }
          resolve(results && results[0] ? results[0].result || [] : []);
        });
      }, 3000); // wait for page load
    });
  });
}

// ---------------------------------------------------------------
// Page-context function: extract leads from Sales Nav page DOM
// ---------------------------------------------------------------
function extractLeadsFromPage(radarPerson, category) {
  const results = [];
  const cards = document.querySelectorAll('[data-view-name="profile-entity-lockup"], .artdeco-entity-lockup');
  cards.forEach(card => {
    try {
      const nameEl  = card.querySelector('[data-anonymize="person-name"], .artdeco-entity-lockup__title');
      const titleEl = card.querySelector('[data-anonymize="job-title"], .artdeco-entity-lockup__subtitle');
      const compEl  = card.querySelector('[data-anonymize="company-name"]');
      const linkEl  = card.querySelector('a[href*="/sales/lead/"]');
      const urnMatch = linkEl && linkEl.href.match(/\/sales\/lead\/([^,?/]+)/);

      if (!nameEl) return;
      const fullName  = nameEl.textContent.trim();
      const nameParts = fullName.split(' ');
      const firstName = nameParts[0] || '';
      const lastName  = nameParts.slice(1).join(' ') || '';

      results.push({
        first_name:      firstName,
        last_name:       lastName,
        title:           titleEl ? titleEl.textContent.trim() : '',
        company:         compEl  ? compEl.textContent.trim()  : '',
        radar_person:    radarPerson,
        lead_id:         urnMatch ? urnMatch[1] : (firstName + lastName).replace(/\s/g, ''),
        collected_date:  new Date().toISOString(),
        linkedin_url:    '' // filled in resolve step
      });
    } catch (e) { /* skip malformed card */ }
  });
  return results;
}

// ---------------------------------------------------------------
// Resolve Sales Nav URNs to public linkedin.com/in/ URLs
// ---------------------------------------------------------------
async function resolvePublicUrls(leads) {
  const unresolved = leads.filter(l => !l.linkedin_url && l.lead_id);
  const toResolve  = unresolved.slice(0, MAX_RESOLVE_PER_RUN);

  for (const lead of toResolve) {
    try {
      const url = await resolveUrn(lead.lead_id);
      if (url) lead.linkedin_url = url;
    } catch (e) { /* skip */ }
    await sleep(600); // gentle pacing
  }

  return leads;
}

async function resolveUrn(urn) {
  return new Promise(resolve => {
    const salesUrl = `https://www.linkedin.com/sales/lead/${urn},NAME_SEARCH,undefined`;
    chrome.tabs.create({ url: salesUrl, active: false }, tab => {
      setTimeout(() => {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const link = document.querySelector('a[href*="linkedin.com/in/"]');
            return link ? link.href.split('?')[0] : null;
          }
        }, results => {
          chrome.tabs.remove(tab.id);
          resolve(results && results[0] ? results[0].result : null);
        });
      }, 2500);
    });
  });
}

// ---------------------------------------------------------------
// POST leads to Apps Script hub
// ---------------------------------------------------------------
async function postToHub(leads) {
  const resp = await fetch(WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: INGEST_SECRET, leads })
  });
  return resp.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
