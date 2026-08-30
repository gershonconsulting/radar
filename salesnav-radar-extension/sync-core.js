// =============================================================
// Radar - Sales Navigator Collector (sync-core.js / service worker)
// Scrapes connections from Sales Navigator, resolves public /in/ URLs,
// POSTs to Apps Script hub. Logs every step to chrome.storage.local
// so the Radar dashboard can display them in real time.
// =============================================================

// Radar hub is now the Supabase-backed Cloudflare Function (the Google Sheet is retired).
// The extension posts here with the shared INGEST_SECRET; the function maps that to the owner.
const WEBAPP_URL    = 'https://pkzeeqehwmtnqxdpdesl.supabase.co/functions/v1/hub';
const INGEST_SECRET = 'radar_7Kq3mZ9pX2vL8nT';
const MAX_PAGES     = 25;
const MAX_RESOLVE_PER_RUN = 400;  // API lookups now, not page loads - so this can be far higher
// ---- Run discipline (1.9.0) ---------------------------------------------------
// A single run on 2026-08-25 scraped for SEVEN HOURS (3446 leads, hundreds of Sales Nav page
// loads). It filed 200 prospects into the lead list at 08:16 and was refused with a 401 by
// 14:53 - the scrape burned the very session the list phase depends on. Runs are now bounded,
// and the list phase runs BETWEEN bridges so prospects land while the session is still healthy.
const MAX_BRIDGES_PER_RUN = 15;   // bridges scraped per run (rest rotate in next run)
const MAX_PAGES_PER_RUN   = 150;  // hard ceiling on Sales Nav page loads per run
const LIST_EVERY_N_BRIDGES = 4;   // file into the lead list this often during a run
// After LinkedIn refuses the session (401/403), stop asking for a while instead of hammering.
const SALESNAV_COOLDOWN_KEY = 'radar_salesnav_cooldown_until';
const SALESNAV_COOLDOWN_MS  = 6 * 60 * 60 * 1000;
// Bridges we are NOT connected to are exactly what the invite campaign exists for — but Botdog
// needs a public /in/ URL and 0 of 75 bridges had one, so it could never run. Resolve a few per
// run. Deliberately small: each one opens a lead page, and this is new behaviour worth watching.
const BRIDGE_URL_RESOLVE_PER_RUN = 10;

// ===== Per-user isolation =====
// The signed-in user's owner_key is relayed from the web app (radar-ext-set-owner) and cached
// here, then injected into EVERY hub call so this browser's collection writes to THIS user's
// data — never the shared bucket. Without it the hub falls back to the legacy solo owner.
let CURRENT_OWNER = '';
try { chrome.storage.local.get('radar_owner').then(function(r){ CURRENT_OWNER = (r && r.radar_owner) || ''; }); } catch(e) {}
(function(){
  const _origFetch = self.fetch.bind(self);
  self.fetch = function(input, init){
    try {
      const u = (typeof input === 'string') ? input : (input && input.url) || '';
      if (u && u.indexOf(WEBAPP_URL) === 0 && CURRENT_OWNER) {
        const method = (init && init.method ? init.method : 'GET').toUpperCase();
        if (method === 'GET') {
          if (typeof input === 'string' && input.indexOf('owner=') === -1) {
            input = input + (input.indexOf('?') >= 0 ? '&' : '?') + 'owner=' + encodeURIComponent(CURRENT_OWNER);
          }
        } else if (init && typeof init.body === 'string') {
          try { const b = JSON.parse(init.body); if (b && typeof b === 'object' && b.owner === undefined) { b.owner = CURRENT_OWNER; init = Object.assign({}, init, { body: JSON.stringify(b) }); } } catch(e) {}
        }
      }
    } catch(e) {}
    return _origFetch(input, init);
  };
})();

// Bridges are ALWAYS the user's own: they come from the hub (getBridges) and are the
// ones the user switched on in the Radar dashboard. There is deliberately NO hardcoded
// seed here. v1.7.3 and earlier shipped six demo bridges belonging to another account and
// pushed them into any hub that had no active bridges yet — which handed every new user a
// stranger's network and scraped it. Never reintroduce a seed list.
const BRIDGES = [];

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

// Installed build number, read from the manifest. Stamped into the run log so the server-side
// daily report can tell whether an outdated extension is still doing the collecting.
let EXT_VERSION = '0.0.0';
try { EXT_VERSION = chrome.runtime.getManifest().version; } catch (e) {}

// --- Logging ---
const MAX_LOG_ENTRIES = 200;
let RUN_ERRORS = 0;
async function log(level, msg, data) {
  if (level === 'error') RUN_ERRORS++;
  const entry = { ts: new Date().toISOString(), level, msg, data: data !== undefined ? data : null };
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log']('[Radar]', msg, data !== undefined ? data : '');
  try {
    const stored = await chrome.storage.local.get('radarLog');
    const arr = stored.radarLog || [];
    arr.unshift(entry);
    await chrome.storage.local.set({ radarLog: arr.slice(0, MAX_LOG_ENTRIES) });
  } catch(e) {}
}
async function clearLog() { RUN_ERRORS = 0; await chrome.storage.local.set({ radarLog: [] }); }

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
// Automatic collection runs AT MOST once per ~day. Every automatic trigger — Chrome startup
// (the primary one), the backup daily alarm, or a sync request relayed from the web app — is
// gated by AUTO_MIN_MS so it can never fire every few minutes again. The popup "Sync Now"
// button bypasses this (force=true) so a manual run always works.
const AUTO_MIN_MS = 20 * 60 * 60 * 1000;  // 20h — guarantees ~once/day without double runs
async function getLastRunAt() { try { const s = await chrome.storage.local.get('radar_last_run_at'); return s.radar_last_run_at ? new Date(s.radar_last_run_at).getTime() : 0; } catch (e) { return 0; } }
async function maybeAutoRun(trigger) {
  const age = Date.now() - (await getLastRunAt());
  if (age < AUTO_MIN_MS) { await log('info', 'run:skip-auto', { trigger, ranHoursAgo: Math.round(age / 3600000) }); return { status: 'skipped-recent' }; }
  const r = await runSync();
  try { await pushLog(); } catch (e) {}
  return r;
}
chrome.runtime.onInstalled.addListener(async () => { await applySchedule(await getSchedule()); await log('info', 'Extension installed, schedule set'); });
// PRIMARY trigger: the first time Chrome opens each day (gated to once/day by maybeAutoRun).
chrome.runtime.onStartup.addListener(async () => { await applySchedule(await getSchedule()); await maybeAutoRun('startup'); });
// BACKUP: if Chrome stays open for many hours, the daily alarm still fires it (also gated).
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'dailySync') maybeAutoRun('alarm'); });

// --- Messages ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'setOwner') {
    // The web app relays the signed-in user's owner_key here so collection stays per-user.
    CURRENT_OWNER = String(msg.owner || '');
    try { chrome.storage.local.set({ radar_owner: CURRENT_OWNER }); } catch (e) {}
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === 'syncNow') {
    // force=true (popup "Sync Now" button) always runs; anything else (web-app relay) is gated
    // to once/~day by maybeAutoRun so an open app tab can't trigger a run every few minutes.
    if (msg.force) {
      runSync().then(async r => { await pushLog(); sendResponse({ ok: true, result: r }); }).catch(async e => { await pushLog(); sendResponse({ ok: false, error: String(e) }); });
    } else {
      maybeAutoRun('message').then(r => sendResponse({ ok: true, result: r })).catch(e => sendResponse({ ok: false, error: String(e) }));
    }
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
  if (msg.action === 'getNotifLog') {
    chrome.storage.local.get(['radarNotifLog', 'radar_unsaved_leads'], d =>
      sendResponse({ ok: true, notifs: d.radarNotifLog || [], buffered: (d.radar_unsaved_leads || []).length }));
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
  if (msg.action === 'setBridgeInvites') {
    // Every non-1st-degree bridge is invited by default; this is the opt-out list.
    chrome.storage.local.set({ radar_bridge_invite_skips: msg.skips || [] })
      .then(() => sendResponse({ ok: true, skips: (msg.skips || []).length }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
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
  if (msg.action === 'salesnavListNow') {
    // Triggered from the dashboard / popup — file pending prospects into the Sales Nav list now.
    saveTargetsToSalesNavList()
      .then(async r => { await closeScrapeWindow(); await pushLog(); sendResponse({ ok: true, result: r }); })
      .catch(async e => { await closeScrapeWindow(); await pushLog(); sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
  if (msg.action === 'salesnavBridgesListNow') {
    // Triggered from the dashboard - file pending bridges into the Sales Nav bridges list now.
    saveBridgesToSalesNavList()
      .then(async r => { await closeScrapeWindow(); await pushLog(); sendResponse({ ok: true, result: r }); })
      .catch(async e => { await closeScrapeWindow(); await pushLog(); sendResponse({ ok: false, error: String(e) }); });
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
let SYNC_RUNNING = false;
async function runSync() {
  if (SYNC_RUNNING) { await log('warn', 'run:already-running'); return { status: 'already-running' }; }
  SYNC_RUNNING = true;
  // Stamp the run time up front so a near-simultaneous trigger (e.g. the +1min alarm) is gated out.
  try { await chrome.storage.local.set({ radar_last_run_at: new Date().toISOString() }); } catch (e) {}
  await clearLog();
  await log('info', 'run:start', { version: EXT_VERSION });
  // (No desktop "Sync started" popup — collection runs quietly; see notify() level gating.)
  const loggedIn = await checkLogin();
  await log('info', 'login-check', { loggedIn });
  if (!loggedIn) { await log('warn', 'No Sales Nav tab detected - proceeding anyway (opened tabs use your logged-in session)'); }

  // PRIORITY PHASE — file everything still pending into the dedicated Sales Navigator lead
  // list BEFORE anything else. Getting prospects into that list is the product; scraping is
  // only how the list gets fed. Running it up front means a slow, broken or killed scrape can
  // never starve it (the MV3 worker dying mid-run used to take the list phase down with it).
  // It no-ops cheaply when nothing is pending, and runs again at the end of the run to file
  // whatever this run just collected.
  let listedTotal = 0;
  try {
    const pre = await saveTargetsToSalesNavList();
    listedTotal += (pre && pre.added) || 0;
  } catch (e) { await log('warn', 'salesnav-list:error', { error: String(e) }); }

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
    // A Source added by pasting a company URL has no Sales Nav org id yet. Resolve it here so
    // the user is never asked for one, and so this same run can discover its bridges.
    try { sources = await resolveMissingOrgIds(sources); } catch (e) { await log('warn', 'orgid:phase-error', { error: String(e) }); }
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
    const allBridges = shuffle(await resolveActiveBridges());
    // PRE-FLIGHT. CONNECTION_OF only works for 1st-degree connections; for anyone else Sales
    // Nav drops the filter and hands back a generic pool. Up to 1.9.0 the only defence was the
    // fingerprint guard, which costs a real scrape per bridge to trigger — 30 bridges burned
    // 116 scrape runs before they were switched off, and that wasted load is what got the
    // account 401'd. Now: skip when we POSITIVELY KNOW the degree is not 1st. A blank degree
    // stays eligible (it means unknown, not "not connected") and falls through to the cheap
    // page-1 fingerprint guard.
    const notFirstDegree = b => {
      const c = String(b.connection || '').toLowerCase().trim();
      return !!c && !/^1st\b|^1\b/.test(c);
    };
    const notConnected = allBridges.filter(notFirstDegree);
    const eligible     = allBridges.filter(b => !notFirstDegree(b));
    if (notConnected.length) {
      await log('warn', 'scrape:skip-not-connected', {
        count: notConnected.length,
        pagesSaved: notConnected.length * MAX_PAGES,
        bridges: notConnected.map(b => b.bridge + ' (' + b.connection + ')').slice(0, 20),
        reason: 'Not a 1st-degree connection — Sales Nav would drop the CONNECTION_OF filter and return a generic search. Queued for an invite instead of being scraped.'
      });
    }
    // Bound the run. The order is randomized every run, so capping here rotates through the
    // full pool over a few days instead of doing one marathon pass that gets the account
    // throttled. (2026-08-25: one uncapped run ran 7h and ended in a 401.)
    // Cap AFTER filtering, so the per-run budget is never spent on bridges we skip anyway.
    const bridges = eligible.slice(0, MAX_BRIDGES_PER_RUN);
    await log('info', 'scrape:bridges', {
      count: bridges.length,
      eligible: eligible.length,
      of: allBridges.length,
      skippedNotConnected: notConnected.length,
      deferred: Math.max(0, eligible.length - bridges.length),
      cap: MAX_BRIDGES_PER_RUN,
      order: 'randomized'
    });

    if (!WEBAPP_URL || WEBAPP_URL === '__WEBAPP_URL__') { await log('warn', 'WEBAPP_URL not set'); return { status: 'no-webapp-url' }; }

    // First, flush anything a previous (interrupted) run scraped but couldn't save.
    let savedTotal = 0, foundTotal = 0;
    try { const f = await flushBuffer(); savedTotal += f; if (f) await pushLog(); } catch (e) { await log('warn', 'buffer:flush-error', { error: String(e) }); }

    // Shared URL-resolution budget for the whole run (resolving opens a tab per lead).
    const resolveState = { left: MAX_RESOLVE_PER_RUN };
    // Shared page-load budget: the hard ceiling on how much Sales Navigator this run touches.
    const pageBudget = { left: MAX_PAGES_PER_RUN };
    let bridgesDone = 0;

    // CRITICAL: write EACH bridge's leads to the hub as soon as they're scraped. Previously the
    // run hoarded all ~80 bridges' leads in memory and wrote once at the very end - with dozens of
    // active bridges that end never arrives (the MV3 service worker is killed first), so nothing
    // saved even though every bridge popped "found N". Per-bridge writes = data lands immediately
    // and an interrupted run keeps everything up to the point it stopped.
    for (const bridge of bridges) {
      if (pageBudget.left <= 0) {
        await log('warn', 'scrape:budget-reached', {
          cap: MAX_PAGES_PER_RUN,
          scraped: bridgesDone,
          skipped: bridges.length - bridgesDone,
          reason: 'page budget spent - remaining bridges roll over to the next run'
        });
        break;
      }
      let leads = [];
      // A bridge without a real Sales Navigator member urn can never be searched: the
      // CONNECTION_OF filter is invalid, so LinkedIn quietly returns a generic result set.
      if (!/^ACwAA/.test(String(bridge.urn || ''))) {
        await log('warn', 'scrape:invalid-urn', { bridge: bridge.bridge, urn: String(bridge.urn || '').slice(0, 12) });
        continue;
      }
      try {
        await log('info', 'scrape:start', { bridge: bridge.bridge });
        leads = await scrapeBridge(bridge, pageBudget);
        await log('info', 'scrape:done', { bridge: bridge.bridge, leadCount: leads.length });
      } catch (err) { await log('error', 'scrape:error', { bridge: bridge.bridge, error: String(err) }); leads = []; }

      // Guard: an identical result set already seen from ANOTHER bridge means Sales Nav dropped
      // the CONNECTION_OF filter. Never ingest it - it would be credited to the wrong bridge.
      try {
        const dup = await filterWasIgnored(bridge, leads);
        if (dup) {
          await log('warn', 'scrape:filter-ignored', {
            bridge: bridge.bridge,
            matched: dup.owner,
            count: leads.length,
            reason: 'Same ' + leads.length + ' results as "' + dup.owner + '" - Sales Nav dropped the CONNECTION_OF filter (this bridge is probably not a 1st-degree connection)'
          });
          notify('Bridge switched off', bridge.bridge + ' returns a generic search, not their network - switched off.', 'error');
          leads = [];
        }
      } catch (e) { await log('warn', 'filter-guard:error', { bridge: bridge.bridge, error: String(e) }); }

      foundTotal += leads.length;

      if (leads.length) {
        try { await resolvePublicUrls(leads, resolveState); } catch (e) { await log('warn', 'resolve:error', { bridge: bridge.bridge, error: String(e) }); }
        try {
          const res = await postToHub(leads);
          const nn = (res && (res.upserted != null ? res.upserted : res.written)) || 0;
          savedTotal += nn;
          await log('info', 'ingest:bridge', { bridge: bridge.bridge, found: leads.length, saved: nn });
          // Silent (info-level) — logged to the in-app notification log, no desktop popup.
          notify('New targets', leads.length + ' found via ' + bridge.bridge + ' - ' + nn + ' saved.');
        } catch (err) {
          // A failed save now throws (see postToHub): hold the leads for retry AND surface it
          // as a real desktop error, instead of silently reporting "0 saved".
          await log('error', 'ingest:bridge-error', { bridge: bridge.bridge, error: String(err) });
          await bufferLeads(leads);
          notify('Save issue', leads.length + ' via ' + bridge.bridge + ' held for retry — ' + String(err), 'error');
        }
        try { await pushLog(); } catch (e) {}
      }
      bridgesDone++;
      // Keep filing DURING the run, not only at the ends. The 2026-08-25 failure was a run whose
      // list phase succeeded at 08:16 and was refused at 14:53 - everything collected in between
      // waited seven hours for a session that no longer existed. Filing every few bridges means
      // prospects land while the session is still good, and a later refusal costs far less.
      if (bridgesDone % LIST_EVERY_N_BRIDGES === 0 && bridgesDone < bridges.length) {
        try {
          const mid = await saveTargetsToSalesNavList();
          listedTotal += (mid && mid.added) || 0;
        } catch (e) { await log('warn', 'salesnav-list:error', { error: String(e) }); }
      }
      await humanDelay(12000, 28000);
    }

    // File every new prospect into the dedicated Sales Navigator lead list. Runs on EVERY sync,
    // including runs that found nothing new, so any backlog keeps draining. Best-effort: a
    // failure here must never lose the leads we just saved.
    try {
      const listRes = await saveTargetsToSalesNavList();
      listedTotal += (listRes && listRes.added) || 0;
    } catch (e) { await log('warn', 'salesnav-list:error', { error: String(e) }); }

    // The BRIDGES list. Every bridge discovered from a Source that we are NOT connected to gets
    // filed into its own Sales Navigator list, so it can be worked as a connection campaign -
    // those networks stay invisible until we connect. This runs whether or not Botdog is set up:
    // the two lists are what Radar guarantees, Botdog only automates the outreach on top.
    let bridgesListed = 0;
    try {
      const bl = await saveBridgesToSalesNavList();
      bridgesListed = (bl && bl.added) || 0;
    } catch (e) { await log('warn', 'salesnav-bridges:error', { error: String(e) }); }

    // Give the invite campaign something to work with: resolve a few missing bridge URLs.
    let bridgeUrls = { attempted: 0, resolved: 0, remaining: 0 };
    try { bridgeUrls = await resolveBridgeUrls(BRIDGE_URL_RESOLVE_PER_RUN); }
    catch (e) { await log('warn', 'bridge-url:error', { error: String(e) }); }

    // OPTIONAL phase. Botdog is an add-on, not a requirement: Radar is complete without it, and
    // a missing key is an info-level skip, never an error (best-effort; never blocks the run).
    let bridgePush = null;
    try { bridgePush = await pushBridgesToBotdog(); } catch (e) { await log('warn', 'bridge-push:error', { error: String(e) }); }

    // Honest status. Up to 1.8.1 this was hardcoded 'ok' - a run with 49 scrape errors, or one
    // that ended in a Sales Nav 401 having filed nobody, still reported "ok", which is exactly
    // what let a dead system look alive for days. Derive it from what actually happened.
    const listCooling = (await salesNavCooldownLeft()) > 0;
    let status = 'ok';
    if (RUN_ERRORS > 0) status = 'error';
    else if (foundTotal > 0 && savedTotal === 0) status = 'error';
    else if (listCooling) status = 'degraded';
    await log('info', 'run:done', {
      version: EXT_VERSION,
      found: foundTotal, saved: savedTotal, listed: listedTotal,
      bridges: bridgesDone, pagesLeft: pageBudget.left,
      skippedNotConnected: notConnected.length,
      bridgeUrlsResolved: bridgeUrls.resolved, bridgeUrlsMissing: bridgeUrls.remaining,
      bridgesListed: bridgesListed,
      bridgesInvited: (bridgePush && (bridgePush.sent || 0)) || 0,
      errors: RUN_ERRORS, listCooling: listCooling,
      status: status
    });
    notify('Sync complete', savedTotal + ' new targets saved (' + foundTotal + ' found), ' + listedTotal + ' added to your Sales Nav list.', status === 'error' ? 'error' : undefined);
    return { status: status, found: foundTotal, saved: savedTotal, listed: listedTotal, errors: RUN_ERRORS, written: savedTotal, upserted: savedTotal };
  } finally {
    // Always clean up the dedicated background scrape window at the end of the run.
    await closeScrapeWindow();
    SYNC_RUNNING = false;
  }
}

// --- Hub reads (JSONP-style: hub wraps the JSON in a callback we strip) ---
async function fetchHubJsonp(action, extra) {
  const cb  = 'cb';
  let url = WEBAPP_URL + '?action=' + encodeURIComponent(action) + '&callback=' + cb + '&_=' + Date.now();
  if (extra) for (const k in extra) url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(extra[k]);
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

// ─── New prospects → dedicated Sales Navigator lead list ────────────────────
// Every new target is filed into Olivier's dedicated Sales Nav lead list (Settings → "Sales
// Navigator list URL", stored on the hub as `salesnav_list_url`) as soon as it is collected.
//
// HOW (discovered live 2026-08-15 by intercepting Sales Navigator's own XHR when clicking
// Lists → "Add <name> to <list> list" on a lead page):
//
//   POST https://www.linkedin.com/sales-api/salesApiLeads?action=bulkSaveByMembers
//   headers: content-type: application/json
//            csrf-token: <the JSESSIONID cookie value, quotes stripped>
//            x-restli-protocol-version: 2.0.0
//   body:    {"entities":["urn:li:fs_salesProfile:(<MEMBER_URN>,NAME_SEARCH,undefined)", ...],
//             "lists":["<numeric list id>"]}
//
// This is Sales Navigator's own BULK endpoint (the same one its "select all → Add to list"
// button uses), so:
//   * it takes many members in ONE call — no per-person work;
//   * it needs NO profile page visit, so it costs ZERO profile views (unlike the old
//     "open /in/<slug> and click Save in Sales Navigator" plan, which burned a view per person
//     and only reached My Saved Leads, never the named list);
//   * saving to a list implicitly saves the lead, so one call does both steps.
//
// The call must be made FROM a logged-in linkedin.com page (it needs the session cookies and a
// matching csrf token), so it is injected into a tab in the off-screen scrape window.
//
// Progress is tracked server-side on targets.salesnav_listed_at, so a prospect is never added
// twice and an interrupted run resumes exactly where it stopped. Because the hub returns
// newest-pending-first, brand new prospects reach the list on the very next sync while the
// historical backlog drains behind them at the same capped rate.
const SALESNAV_LIST_MAX_PER_RUN = 200;  // prospects filed per run (no profile views, so generous)
const SALESNAV_LIST_CHUNK       = 25;   // = Sales Nav's own page size for "select all → Add to list"

// Radar files into TWO Sales Navigator lists, and BOTH are guaranteed outputs. Botdog is an
// optional add-on layered on top, never a prerequisite (Olivier, 2026-08-28):
//   * PROSPECTS - the people found through a bridge's network. This is the product.
//   * BRIDGES   - the bridges discovered from Sources that we are NOT connected to. Sales Nav
//                 silently drops CONNECTION_OF for anyone but a 1st-degree connection, so those
//                 networks stay unreachable until we connect. Filing them into their own list
//                 turns them into a workable connection campaign, with or without Botdog.
// Both lists use the exact same bulkSaveByMembers call - a bridge has a Sales Nav member urn
// just like a prospect has a lead_id - so the whole phase below is shared between them.
const SALESNAV_BRIDGES_MAX_PER_RUN = 100;
const SALESNAV_KINDS = {
  prospects: {
    pendingAction: 'salesnavPending',
    markAction:    'markSalesnavListed',
    idsKey:        'lead_ids',
    logTag:        'salesnav-list',
    noun:          'prospect',
    listLabel:     'prospects',
    requiredList:  true,
    settingHint:   'Set Settings -> Sales Navigator -> Prospects list URL in the Radar dashboard',
    cap:           SALESNAV_LIST_MAX_PER_RUN
  },
  bridges: {
    pendingAction: 'salesnavBridgesPending',
    markAction:    'markSalesnavBridgesListed',
    idsKey:        'urns',
    logTag:        'salesnav-bridges',
    noun:          'bridge',
    listLabel:     'bridges',
    requiredList:  false,
    settingHint:   'Set Settings -> Sales Navigator -> Bridges list URL in the Radar dashboard',
    cap:           SALESNAV_BRIDGES_MAX_PER_RUN
  }
};

// Injected into a logged-in Sales Navigator tab. Adds ONE chunk of member urns to the list.
// Kept deliberately small and self-contained: the service worker drives the loop so that each
// chunk is a fresh extension API call, which keeps the MV3 worker alive across a long backlog.
// Resolves once Chrome reports the tab has finished loading (or the timeout elapses). The list
// phase used to sleep a flat 2s and then trust a probe that could not tell a blank tab from a
// loaded one; a background-tab fallback is throttled by Chrome and routinely needs much longer.
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (v) {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {}
      resolve(v);
    };
    function onUpd(id, info) { if (id === tabId && info.status === 'complete') finish(true); }
    try { chrome.tabs.onUpdated.addListener(onUpd); } catch (e) { return finish(false); }
    chrome.tabs.get(tabId, function (t) {
      if (chrome.runtime.lastError) return finish(false);
      if (t && t.status === 'complete') finish(true);
    });
    setTimeout(function () { finish(false); }, timeoutMs || 45000);
  });
}

async function salesNavCooldownLeft() {
  try {
    const r = await chrome.storage.local.get(SALESNAV_COOLDOWN_KEY);
    const t = r[SALESNAV_COOLDOWN_KEY] ? new Date(r[SALESNAV_COOLDOWN_KEY]).getTime() : 0;
    return Math.max(0, t - Date.now());
  } catch (e) { return 0; }
}
async function setSalesNavCooldown(ms) {
  try { const o = {}; o[SALESNAV_COOLDOWN_KEY] = new Date(Date.now() + ms).toISOString(); await chrome.storage.local.set(o); } catch (e) {}
}
async function clearSalesNavCooldown() {
  try { await chrome.storage.local.remove(SALESNAV_COOLDOWN_KEY); } catch (e) {}
}

// Injected. Confirms the tab really is an authenticated Sales Navigator page before we spend
// the backlog on it. A JSESSIONID cookie alone proves nothing - LinkedIn sets one for logged-out
// visitors too - so we also require an `ajax:` csrf shape and that we are not sitting on a
// login / checkpoint / authwall page.
async function salesNavSessionProbeInPage(listId) {
  const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1] || '';
  const path = location.pathname || '';
  const blocked = /\/(login|checkpoint|authwall|uas|signup)(\/|$)/i.test(path);
  const base = {
    csrf: !!csrf,
    csrfShape: csrf ? csrf.slice(0, 5) : '',
    blocked: blocked,
    path: path,
    readyState: document.readyState
  };
  if (!csrf || !/^ajax:/.test(csrf) || blocked) {
    return Object.assign({ ok: false, reason: blocked ? 'blocked-path' : 'no-session-cookie' }, base);
  }
  // The cookie and the URL are BOTH already true the instant the tab is created - the cookie is
  // domain-wide and location.pathname is set before a single byte of the page has loaded. That is
  // how, on 2026-08-28, a chunk fired 2.3s after the tab opened and came back
  // 403 SALES_SEAT_REQUIRED on a perfectly valid seat. Requiring a loaded document is necessary
  // but still not sufficient, so we PROVE the seat resolves from this exact page context by
  // making the real call with an EMPTY entity list: same endpoint, same headers, adds nobody.
  // (Verified live 2026-08-28 on a loaded list page: returns 200 {"value":[]}.)
  if (document.readyState !== 'complete') {
    return Object.assign({ ok: false, reason: 'page-not-loaded' }, base);
  }
  try {
    const r = await fetch('/sales-api/salesApiLeads?action=bulkSaveByMembers', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'csrf-token': csrf,
        'x-restli-protocol-version': '2.0.0'
      },
      body: JSON.stringify({ entities: [], lists: [String(listId)] })
    });
    const t = await r.text();
    const ok = r.status >= 200 && r.status < 300;
    return Object.assign({
      ok: ok,
      seatStatus: r.status,
      seatBody: String(t).slice(0, 120),
      reason: ok ? '' : 'seat-not-ready-' + r.status
    }, base);
  } catch (e) {
    return Object.assign({ ok: false, reason: 'seat-probe-threw', error: String(e) }, base);
  }
}

function salesNavAddChunkInPage(listId, urns) {
  const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1];
  if (!csrf) return Promise.resolve({ ok: false, error: 'no JSESSIONID cookie (not logged in to LinkedIn)' });
  return fetch('/sales-api/salesApiLeads?action=bulkSaveByMembers', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'csrf-token': csrf,
      'x-restli-protocol-version': '2.0.0'
    },
    body: JSON.stringify({
      entities: urns.map(function (u) { return 'urn:li:fs_salesProfile:(' + u + ',NAME_SEARCH,undefined)'; }),
      lists: [String(listId)]
    })
  }).then(function (r) {
    return r.text().then(function (t) {
      return { ok: r.status >= 200 && r.status < 300, status: r.status, body: String(t).slice(0, 160) };
    });
  }).catch(function (e) { return { ok: false, error: String(e) }; });
}

// Tell the hub which rows made it into the list. Stamps targets.salesnav_listed_at for
// prospects, bridges.salesnav_listed_at for bridges, so neither is ever filed twice and an
// interrupted run resumes exactly where it stopped.
async function markSalesNavListed(ids, kind) {
  if (!ids || !ids.length) return 0;
  const K = SALESNAV_KINDS[kind] || SALESNAV_KINDS.prospects;
  const body = { secret: INGEST_SECRET, action: K.markAction };
  body[K.idsKey] = ids;
  if (CURRENT_OWNER) body.owner = CURRENT_OWNER;
  const resp = await fetch(WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let out = null; try { out = await resp.json(); } catch (e) {}
  if (!resp.ok || (out && out.ok === false)) throw new Error('hub ' + resp.status + ': ' + ((out && out.error) || 'mark failed'));
  return (out && out.marked) || 0;
}

// Main phase, shared by BOTH lists. Safe to call on every run: if nothing is pending it does
// nothing and opens no tab.
async function fileIntoSalesNavList(kind) {
  const K   = SALESNAV_KINDS[kind] || SALESNAV_KINDS.prospects;
  const TAG = K.logTag;
  // Respect a cooldown set by an earlier 401/403 - retrying immediately just deepens the block.
  const cool = await salesNavCooldownLeft();
  if (cool > 0) {
    await log('info', TAG + ':cooldown', { minutes_left: Math.ceil(cool / 60000) });
    return { ok: true, added: 0, reason: 'cooldown' };
  }
  let pending = null;
  try {
    pending = await fetchHubJsonp(K.pendingAction, { cap: K.cap });
  } catch (err) {
    await log('warn', TAG + ':hub-error', { error: String(err) });
    return { ok: false, added: 0, reason: 'hub-error' };
  }

  const listId = (pending && pending.list_id) || '';
  const ids    = (pending && pending[K.idsKey]) || [];
  const total  = (pending && pending.pending_total) || ids.length;

  if (!listId) {
    // An unset list is only a failure for the PROSPECTS list, which is the product. The bridges
    // list is an add-on some users will never set up, so it is an info-level skip - never a
    // desktop error, and never something that makes an otherwise healthy run look broken.
    await log(K.requiredList ? 'warn' : 'info', TAG + ':not-configured', { hint: K.settingHint });
    if (K.requiredList) notify('Sales Nav list not set', 'New prospects cannot be filed — add your Prospects list URL in Radar Settings.', 'error');
    return { ok: false, added: 0, reason: 'no-list' };
  }
  if (!ids.length) {
    await log('info', TAG + ':nothing-pending');
    return { ok: true, added: 0 };
  }

  await log('info', TAG + ':start', { listId, thisRun: ids.length, pendingTotal: total });

  // Open the list itself in the off-screen scrape window: it is a normal Sales Nav page, so the
  // request carries exactly the cookies, origin and referer Sales Navigator's own UI would send.
  const listUrl = 'https://www.linkedin.com/sales/lists/people/' + listId;
  let tab = await openScrapeTab(listUrl);
  if (!tab) {
    // This phase does NOT need a rendered page — it only needs a logged-in linkedin.com origin
    // to fetch from. So when the dedicated background window is unavailable, fall back to a
    // plain BACKGROUND tab in the window the user already has open: no focus steal, and it
    // cannot be blocked by window-bounds validation. Filing prospects into the list is the
    // whole point of Radar — it must never be the thing that gets skipped.
    try {
      tab = await chrome.tabs.create({ url: listUrl, active: false });
      await log('warn', TAG + ':bg-tab-fallback', { reason: 'scrape window unavailable' });
    } catch (e) {
      tab = null;
    }
  }
  if (!tab) {
    await log('error', TAG + ':no-tab');
    notify('Sales Nav list blocked', 'Radar could not open a LinkedIn tab to file ' + ids.length + ' ' + K.noun + '(s). Keep Chrome open and logged in.', 'error');
    return { ok: false, added: 0, reason: 'no-tab' };
  }
  // Poll for a genuinely authenticated Sales Nav page rather than firing blind after a fixed
  // wait. A cold browser needs far longer than 7s, and firing early is what turns a healthy
  // backlog into a 401.
  // Wait for Chrome to report the tab actually loaded before probing at all. The background-tab
  // fallback below is throttled by Chrome, so it can take far longer than the old blind 2s sleep.
  await waitForTabComplete(tab.id, 45000);
  let probe = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(attempt < 5 ? 2000 : 4000);
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: salesNavSessionProbeInPage,
        args: [String(listId)]
      });
      probe = (out && out[0]) ? out[0].result : null;
    } catch (e) { probe = null; }
    if (probe && probe.ok) break;
    if (probe && attempt === 7) await log('info', TAG + ':still-waiting', { probe: probe });
  }
  if (!probe || !probe.ok) {
    try { chrome.tabs.remove(tab.id); } catch (e) {}
    await log('error', TAG + ':not-authenticated', { probe: probe || null,
      hint: 'Log in to Sales Navigator in Chrome, then run again.' });
    notify('Sales Nav not logged in', 'Radar could not confirm a logged-in Sales Navigator session - ' + ids.length + ' ' + K.noun + '(s) still queued.', 'error');
    await setSalesNavCooldown(30 * 60 * 1000);
    return { ok: false, added: 0, reason: 'not-authenticated' };
  }

  let added = 0;
  let seatRetried = false;
  const errors = [];
  try {
    for (let i = 0; i < ids.length; i += SALESNAV_LIST_CHUNK) {
      const batch = ids.slice(i, i + SALESNAV_LIST_CHUNK);
      let res = null;
      try {
        const out = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: salesNavAddChunkInPage,
          args: [String(listId), batch]
        });
        res = (out && out[0]) ? out[0].result : null;
      } catch (err) {
        res = { ok: false, error: String(err) };
      }

      if (res && res.ok) {
        // Stamp each chunk immediately, so an interrupted run never re-adds what already landed.
        try { await markSalesNavListed(batch, kind); } catch (err) { await log('warn', TAG + ':mark-failed', { error: String(err), n: batch.length }); }
        added += batch.length;
        if (added === batch.length) { try { await clearSalesNavCooldown(); } catch (e) {} }
        await log('info', TAG + ':chunk', { added: batch.length, runningTotal: added });
      } else {
        const msg = (res && (res.error || (res.status + ' ' + res.body))) || 'unknown error';
        errors.push(msg);
        await log('error', TAG + ':chunk-failed', { n: batch.length, error: msg });
        // A 401/403 means the Sales Nav session is gone — stop rather than hammer it.
        // A 403 SALES_SEAT_REQUIRED that arrives having filed NOBODY is the page-not-ready
        // signature, not a refused session: the seat is fine (the probe just proved it) and a
        // 6h cooldown would throw away the whole day over a slow tab. Retry it once, slowly,
        // in this same run. Only a repeat failure earns the long back-off.
        const seatErr = /SALES_SEAT_REQUIRED/i.test(msg);
        if (seatErr && added === 0 && !seatRetried) {
          seatRetried = true;
          await log('warn', TAG + ':seat-retry', {
            reason: 'SALES_SEAT_REQUIRED with nothing filed - page most likely not ready yet',
            waiting_seconds: 20
          });
          await sleep(20000);
          i -= SALESNAV_LIST_CHUNK;   // redo this same chunk
          continue;
        }
        if (res && (res.status === 401 || res.status === 403 || /not logged in/i.test(String(res.error || '')))) {
          // LinkedIn refused the session. Almost always this means the account has been asked to
          // slow down (a long scrape in the same session will do it). Back off for hours rather
          // than re-asking every run - and say so, instead of reporting a healthy run.
          await setSalesNavCooldown(SALESNAV_COOLDOWN_MS);
          await log('error', TAG + ':abort', {
            reason: (seatErr
              ? 'Sales Navigator refused the seat (403 SALES_SEAT_REQUIRED) even after a retry - backing off'
              : 'session refused (' + (res.status || '?') + ') - backing off'),
            seat_required: seatErr,
            cooldown_hours: SALESNAV_COOLDOWN_MS / 3600000,
            filed_before_abort: added
          });
          notify('Sales Nav paused', 'LinkedIn refused the session after ' + added + ' filed. Radar will retry in ' + (SALESNAV_COOLDOWN_MS / 3600000) + 'h.', 'error');
          break;
        }
      }
      await humanDelay(4000, 9000);
    }
  } finally {
    try { chrome.tabs.remove(tab.id); } catch (e) {}
  }

  const left = Math.max(0, total - added);
  await log('info', TAG + ':done', { added, remaining: left, errors: errors.slice(0, 5) });
  if (added) {
    notify('Added to Sales Navigator', added + ' new ' + K.noun + (added === 1 ? '' : 's') + ' filed into your ' + K.listLabel + ' list' + (left ? ' (' + left + ' still queued).' : '.'));
  } else if (errors.length) {
    notify('Sales Nav list failed', errors[0], 'error');
  }
  return { ok: !errors.length, added, remaining: left, errors: errors.slice(0, 5) };
}

// Thin wrappers so every call site reads plainly.
async function saveTargetsToSalesNavList() { return fileIntoSalesNavList('prospects'); }
async function saveBridgesToSalesNavList() { return fileIntoSalesNavList('bridges'); }

// ─── Bridge invites → dedicated Botdog campaign ─────────────────────────────
// Every sync, invite the bridges you are NOT connected to (not 1st-degree) into the
// dedicated "bridges" Botdog campaign, so they become 1st-degree and their networks
// open up. enricherPro fills the public /in/ URL when it's missing. Deduped via storage.
const BRIDGES_CAMPAIGN_ID_DEFAULT = '3e07e3ee-8144-4429-b73a-1751d1466d35';
const ENRICHER_BASE = 'https://enricherpro.com';
// Verified against Botdog's live OpenAPI spec (api.botdog.co/docs, 2026-07-28): host is
// api.botdog.CO (.io does not resolve), auth is the x-api-key header (NOT Bearer), and the
// add-to-campaign endpoint is /v1/leads/add_to_campaign with body {campaignId, leads:[{linkedinUrl}]}.
// (The old /v1/campaigns/contacts with {campaign_id, profiles} does NOT exist — it 404s.)
const BOTDOG_CONTACTS_URL = 'https://api.botdog.co/v1/leads/add_to_campaign';
// Adding contacts to a campaign is not the same as sending invites — Botdog paces the
// actual connection requests itself. So this cap only limits how many we enqueue per run.
const MAX_BRIDGE_PUSH_PER_RUN = 100;

// Strip LinkedIn status suffixes / trailing emoji from a name (for enricherPro lookups).
function cleanPersonName(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  const cut = s.match(/\s+(?:is|was)\s+(?:reachable|last active|open to work|a group member|hiring|online|out of office)\b/i);
  if (cut && cut.index >= 0) s = s.slice(0, cut.index);
  s = s.replace(/\s*[•·]\s*.*$/, '');
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}].*$/u, '');
  return s.replace(/\s+/g, ' ').replace(/^[\s.,;:•·\-]+|[\s.,;:•·\-]+$/g, '').trim();
}

// ---- Country -> primary business language -------------------------------------------
// Once we know a prospect's country we know which language to write to them in. This is a
// deliberate simplification: it returns the language you'd open in, not the person's mother
// tongue. Multilingual countries resolve to the dominant business language.
const COUNTRY_LANG = {
  'france':'French','belgium':'French','monaco':'French','luxembourg':'French','senegal':'French',
  "côte d'ivoire":'French','ivory coast':'French','morocco':'French','tunisia':'French','algeria':'French',
  'switzerland':'French','cameroon':'French','madagascar':'French','quebec':'French',
  'united states':'English','united kingdom':'English','ireland':'English','canada':'English',
  'australia':'English','new zealand':'English','singapore':'English','india':'English',
  'south africa':'English','nigeria':'English','kenya':'English','uae':'English',
  'united arab emirates':'English','hong kong':'English','philippines':'English','israel':'English',
  'spain':'Spanish','mexico':'Spanish','argentina':'Spanish','colombia':'Spanish','chile':'Spanish',
  'peru':'Spanish','venezuela':'Spanish','ecuador':'Spanish','uruguay':'Spanish','panama':'Spanish',
  'costa rica':'Spanish','guatemala':'Spanish','dominican republic':'Spanish',
  'germany':'German','austria':'German','deutschland':'German',
  'italy':'Italian','portugal':'Portuguese','brazil':'Portuguese',
  'netherlands':'Dutch','the netherlands':'Dutch',
  'sweden':'Swedish','norway':'Norwegian','denmark':'Danish','finland':'Finnish',
  'poland':'Polish','czechia':'Czech','czech republic':'Czech','romania':'Romanian','greece':'Greek',
  'turkey':'Turkish','russia':'Russian','ukraine':'Ukrainian','china':'Chinese','taiwan':'Chinese',
  'japan':'Japanese','south korea':'Korean','korea':'Korean','vietnam':'Vietnamese','thailand':'Thai',
  'indonesia':'Indonesian','malaysia':'Malay','saudi arabia':'Arabic','egypt':'Arabic','qatar':'Arabic'
};
function langFromCountry(country) {
  const c = String(country || '').trim().toLowerCase().replace(/\.$/, '');
  if (!c) return '';
  if (COUNTRY_LANG[c]) return COUNTRY_LANG[c];
  // tolerate "Greater Paris, France" style tails and common variants
  for (const k in COUNTRY_LANG) { if (c.endsWith(k) || c.indexOf(k) !== -1) return COUNTRY_LANG[k]; }
  return '';
}

// ---- Location from a lead's Sales Nav page --------------------------------------------
// The search-result CARD often omits location; the LEAD PAGE always shows it
// (e.g. "Région de Brest, France"). Verified live 2026-07-16: Sales Nav exposes
// data-anonymize="person-name|headline|job-title|company-name" but NOT location, and the
// location <p>'s classes are hashed and rotate — so anchor on person-name and pattern-match
// instead of relying on any class.
async function fetchLeadLocation(urn) {
  const url = 'https://www.linkedin.com/sales/lead/' + urn + ',NAME_SEARCH,undefined';
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await new Promise(r => setTimeout(r, 4500));
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const anchor = document.querySelector('[data-anonymize="person-name"]');
        if (!anchor) return '';
        let card = anchor;
        for (let i = 0; i < 8 && card; i++) {
          const ps = Array.from(card.querySelectorAll('p'))
            .map(p => (p.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(t => t && t.length > 2 && t.length < 70 && t.indexOf(',') !== -1);
          const hit = ps.find(t =>
            !/\b(chez|at|@)\b/i.test(t) &&            // not "Title chez Company"
            !/\d{4}/.test(t) &&                        // not a date range
            /^[A-Za-zÀ-ÿ0-9'’\-\.\s]+$/.test(t)        // plain place text
          );
          if (hit) return hit;
          card = card.parentElement;
        }
        return '';
      }
    });
    return (res && res.result) ? String(res.result) : '';
  } catch (e) {
    return '';
  } finally {
    // Always close the tab — no tab litter. (Olivier's standing complaint.)
    try { if (tab && tab.id) await chrome.tabs.remove(tab.id); } catch (e) {}
  }
}

// Fill in country/city/language for freshly collected targets that have no location yet.
// Capped per run so a sync never turns into hundreds of page loads.
const MAX_LOCATION_LOOKUPS_PER_RUN = 30;
async function enrichLocations(rows) {
  let done = 0;
  for (const r of rows) {
    if (done >= MAX_LOCATION_LOOKUPS_PER_RUN) break;
    if (!r || !r.lead_id) continue;
    if (r.country) { if (!r.language) r.language = langFromCountry(r.country); continue; }
    const loc = await fetchLeadLocation(r.lead_id);
    done++;
    if (!loc) continue;
    const segs = loc.split(',').map(s => s.trim()).filter(Boolean);
    r.location = loc;
    r.city = segs[0] || '';
    r.country = segs[segs.length - 1] || '';
    r.language = langFromCountry(r.country);
    await new Promise(res => setTimeout(res, 700));   // be gentle with LinkedIn
  }
  if (done) await log('info', 'location-enrich', { looked_up: done });
  return rows;
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

// Patch ONE bridge's public URL on the hub. Uses setBridgeMeta, NOT addBridges: addBridges is
// an upsert that rewrites `active` from its payload, so reusing it here would silently switch
// bridges off as a side effect of saving a URL.
async function saveBridgeUrl(urn, url) {
  const body = { secret: INGEST_SECRET, action: 'setBridgeMeta', urn: urn, linkedin_url: url };
  if (CURRENT_OWNER) body.owner = CURRENT_OWNER;
  const resp = await fetch(WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await resp.json().catch(() => null);
  if (!resp.ok || (out && out.ok === false)) throw new Error('hub ' + resp.status + ': ' + ((out && out.error) || 'save failed'));
  return true;
}

// Resolve public /in/ URLs for bridges that have none, so the invite campaign has something to
// work with. IMPORTANT: public-URL resolution degrades with network distance — for people well
// out of network the lead page often exposes no /in/ link at all. Failures here are EXPECTED and
// reported as counts, never as errors.
async function resolveBridgeUrls(cap) {
  let all = [];
  try { all = await getBridges(); } catch (e) { return { attempted: 0, resolved: 0, failed: 0, remaining: 0 }; }
  const missing = (all || []).filter(b => b && b.urn && !/linkedin\.com\/in\//i.test(String(b.linkedin_url || '')));
  const todo = missing.slice(0, cap || BRIDGE_URL_RESOLVE_PER_RUN);
  if (!todo.length) return { attempted: 0, resolved: 0, failed: 0, remaining: 0 };
  await log('info', 'bridge-url:start', { attempting: todo.length, missingTotal: missing.length });
  let resolved = 0, failed = 0;
  for (const b of todo) {
    let url = null;
    try { url = await resolveUrn(b.urn); } catch (e) {}
    if (url && /linkedin\.com\/in\//i.test(url)) {
      try { await saveBridgeUrl(b.urn, url); resolved++; }
      catch (e) { failed++; await log('warn', 'bridge-url:save-failed', { bridge: b.name, error: String(e) }); }
    } else {
      failed++;
    }
    await sleep(1200);
  }
  await log('info', 'bridge-url:done', {
    attempted: todo.length, resolved: resolved, unresolvable: failed,
    stillMissing: Math.max(0, missing.length - resolved),
    note: 'Unresolvable usually means the person is too far out of network for LinkedIn to expose a public profile URL.'
  });
  return { attempted: todo.length, resolved: resolved, failed: failed, remaining: Math.max(0, missing.length - resolved) };
}

async function pushBridgesToBotdog() {
  const cfg = await chrome.storage.local.get(['radar_botdog_key', 'radar_bridges_campaign', 'radar_bridges_pushed', 'radar_bridge_invite_skips']);
  const key = cfg.radar_botdog_key;
  const campaign = cfg.radar_bridges_campaign || BRIDGES_CAMPAIGN_ID_DEFAULT;
  // No key in local storage does NOT mean Botdog is unconfigured. The key lives on the hub
  // (config.botdog_api_key) and getConfig REDACTS every *_api_key, so the extension can never
  // receive it — which is why bridge-push logged "not configured" on every run since 2026-07-27
  // while a valid key sat on the hub and bridges.botdog_pushed stayed null for all 80 rows.
  // The hub already implements the push server-side, where the key actually is. Delegate.
  if (!key) {
    try {
      const body = { secret: INGEST_SECRET, action: 'pushBridges', cap: MAX_BRIDGE_PUSH_PER_RUN };
      if (CURRENT_OWNER) body.owner = CURRENT_OWNER;
      const resp = await fetch(WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await resp.json().catch(() => null);
      if (out && out.ok && (out.pushed || out.attempted)) {
        await log('info', 'bridge-push:via-hub', { pushed: out.pushed || 0, attempted: out.attempted || 0, campaign: out.campaign || null, errors: (out.errors || []).slice(0, 3) });
        if (out.pushed) notify('Bridges invited', out.pushed + ' bridge(s) added to your Botdog invite campaign.');
        return { ok: true, sent: out.pushed || 0, viaHub: true };
      }
      await log('info', 'bridge-push:skip', { reason: (out && out.error) || 'Botdog not configured on the hub — optional, Radar works without it', viaHub: true });
      return { ok: true, skipped: true, reason: 'no-key' };
    } catch (e) {
      await log('info', 'bridge-push:skip', { reason: 'hub push unavailable: ' + String(e) });
      return { ok: true, skipped: true, reason: 'hub-error' };
    }
  }
  const pushed = new Set(cfg.radar_bridges_pushed || []);
  // Invite EVERY not-yet-connected bridge into the dedicated bridges campaign,
  // except the ones explicitly unticked in the dashboard.
  const skips = new Set((cfg.radar_bridge_invite_skips || []).map(String));
  let bridges = [];
  try { bridges = await getBridges(); } catch (e) { return { ok: false, reason: 'bridges-fetch-failed' }; }
  const is1st = b => /1st|^1\b/i.test(String(b.connection || ''));
  const todo = bridges.filter(b => b && b.urn && !is1st(b) && !pushed.has(b.urn) && !skips.has(String(b.urn)));
  if (!todo.length) { await log('info', 'bridge-push:skip', { reason: 'every not-connected bridge is already invited' }); return { ok: true, sent: 0, candidates: 0, reason: 'all-done' }; }
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
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ campaignId: campaign, leads: [{ linkedinUrl: url.split('?')[0], name: cleanPersonName(b.name || '') || undefined, title: b.title || undefined }] })
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

// Resolve the bridges to COLLECT from: the ACTIVE bridges on this user's hub, nothing else.
// No bridges active → nothing to collect. The dashboard tells the user what to do about it
// (add a Source, discover its bridges, switch some on); the extension does not invent any.
// Returns objects shaped the way scrapeBridge expects: { bridge, source, category, urn }
async function resolveActiveBridges() {
  let hubBridges = [];
  try { hubBridges = await getBridges(); }
  catch (err) { await log('warn', 'bridges:fetch-failed', { error: String(err) }); }

  const active = (hubBridges || []).filter(b => b.active === true && b.urn);
  if (active.length > 0) {
    await log('info', 'bridges:active', { count: active.length });
    return active.map(b => ({
      bridge:     b.name || '',
      source:     b.source || '',
      category:   b.connection || 'partner',
      urn:        b.urn,
      connection: b.connection || '',   // '' = unknown, never assume "not connected"
      linkedin_url: b.linkedin_url || ''
    }));
  }

  // Nothing switched on: collect nothing. Never fabricate bridges.
  await log('warn', 'bridges:none-active', {
    found: (hubBridges || []).length,
    hint: 'Add a Source in Radar, run Find Bridges, then switch the bridges you want to ON.'
  });
  return [];
}

// --- Sales Nav organization id resolution ---
// A Source is added by pasting a LinkedIn COMPANY URL. Bridge discovery needs the numeric
// organization id that Sales Nav filters by (urn:li:organization:<id>). Asking the user to go
// find that id is asking them to do LinkedIn's job twice: the id is derivable from the very
// page they already pasted. So we resolve it here, once per source, from an authenticated tab,
// and save it back to the hub. Nothing in the UI should ever demand an Org ID again.
//
// Two ways, cheapest first:
//   1. voyager /organization/companies?q=universalName&universalName=<slug>  -> entityUrn
//   2. the company page HTML itself, which embeds urn:li:fsd_company:<id>
// A URL that already carries the number (…/company/1234 or …/organization/1234) needs neither.
function orgIdFromUrl(u) {
  const s = String(u || '').split('?')[0].replace(/\/+$/, '');
  const direct = s.match(/(?:organization|company)\/(\d+)(?:\/|$)/);
  if (direct) return { id: direct[1], slug: '' };
  const m = s.match(/linkedin\.com\/(?:company|showcase|school)\/([^\/]+)/i);
  let slug = '';
  if (m) { try { slug = decodeURIComponent(m[1]); } catch (e) { slug = m[1]; } }
  return { id: '', slug: slug };
}

// Injected into an authenticated linkedin.com tab. Resolves many slugs in one page.
async function resolveOrgIdsInPage(slugs) {
  const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1];
  if (!csrf) return { error: 'no JSESSIONID cookie', out: [] };
  const headers = { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' };
  const dig = function (t) {
    const m = String(t || '').match(/urn:li:(?:fs_normalized_company|fsd_company|organization|company):(\d+)/);
    return m ? m[1] : '';
  };
  const out = [];
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    let id = '', how = '', status = 0;
    try {
      const r = await fetch('/voyager/api/organization/companies?q=universalName&universalName=' + encodeURIComponent(slug),
                            { credentials: 'include', headers: headers });
      status = r.status;
      if (r.ok) { id = dig(await r.text()); if (id) how = 'voyager'; }
    } catch (e) {}
    if (!id) {
      // Fall back to the public company page: the id is embedded in its bootstrapped JSON.
      try {
        const r2 = await fetch('https://www.linkedin.com/company/' + encodeURIComponent(slug) + '/', { credentials: 'include' });
        if (!status) status = r2.status;
        if (r2.ok) { id = dig(await r2.text()); if (id) how = 'page'; }
      } catch (e) {}
    }
    out.push({ slug: slug, id: id, how: how, status: status });
    await new Promise(function (r) { setTimeout(r, 500 + Math.floor(Math.random() * 500)); });
  }
  return { out: out };
}

// Opens ONE tab and resolves every slug through it. Returns a Map slug -> org id.
async function resolveOrgIdsViaApi(slugs) {
  const result = new Map();
  if (!slugs || !slugs.length) return result;
  const tab = await openScrapeTab('https://www.linkedin.com/sales/homepage');
  if (!tab) {
    await log('warn', 'orgid:no-tab', { wanted: slugs.length });
    return result;
  }
  try {
    await waitForTabComplete(tab.id, 45000);
    // Same lesson as everywhere else here: a cookie is not a loaded page.
    await sleep(3000);
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: resolveOrgIdsInPage,
      args: [slugs]
    });
    const payload = (res && res[0]) ? res[0].result : null;
    const rows = (payload && payload.out) || [];
    if (payload && payload.error) await log('warn', 'orgid:page-error', { error: payload.error });
    for (const row of rows) {
      if (row.id) result.set(row.slug, row.id);
      else await log('warn', 'orgid:unresolved', { slug: row.slug, status: row.status });
    }
  } catch (e) {
    await log('warn', 'orgid:error', { error: String(e) });
  } finally {
    try { chrome.tabs.remove(tab.id); } catch (e) {}
  }
  return result;
}

// Save a resolved org id back to the hub WITHOUT touching the rest of the source row
// (addSource is an upsert and would rewrite columns the caller did not send).
async function saveSourceOrgId(name, orgId) {
  try {
    await fetch(WEBAPP_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: INGEST_SECRET, action: 'setSourceOrg', name: name, org_id: orgId })
    });
    return true;
  } catch (e) { return false; }
}

// Fill in org_id for every source that has a company URL but no id yet. Mutates and returns
// the sources array so discovery can use the ids in the SAME run.
async function resolveMissingOrgIds(sources) {
  const list = sources || [];
  const need = [];
  for (const s of list) {
    if (String(s.org_id || '').trim()) continue;
    const got = orgIdFromUrl(s.linkedin_url);
    if (got.id) {
      // The URL already carried the number — no network call needed.
      s.org_id = got.id;
      await saveSourceOrgId(s.name, got.id);
      await log('info', 'orgid:from-url', { source: s.name, org_id: got.id });
      continue;
    }
    if (got.slug) need.push({ src: s, slug: got.slug });
  }
  if (!need.length) return list;
  await log('info', 'orgid:resolve-start', { count: need.length, sources: need.map(n => n.src.name) });
  const map = await resolveOrgIdsViaApi(need.map(n => n.slug));
  let hit = 0;
  for (const n of need) {
    const id = map.get(n.slug);
    if (!id) continue;
    n.src.org_id = id;
    await saveSourceOrgId(n.src.name, id);
    hit++;
  }
  await log('info', 'orgid:resolve-done', { asked: need.length, resolved: hit });
  if (hit) notify('Source ready', hit + ' source(s) resolved — bridge discovery can run.');
  return list;
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
      // Resolve each new bridge's public /in/ URL from its lead page (via the stable fs_salesProfile
      // URN captured during discovery) so the bridge is pushable to Botdog and openable. Capped +
      // paced per source to stay human-like; unresolved ones can be retried on a later run.
      let _rb = 0;
      for (const b of trimmed) {
        if (_rb >= 12) break;
        if (b.linkedin_url && /linkedin\.com\/in\//i.test(b.linkedin_url)) continue;
        if (!b.urn) continue;
        try { const u = await resolveUrn(b.urn); if (u) b.linkedin_url = u; } catch (e) {}
        _rb++;
        await sleep(700);
      }
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
  // Chrome REJECTS windows.create() bounds that place a window entirely outside the visible
  // desktop ("Invalid value for bounds. Bounds must be at least 50% within visible screen
  // space."). That validation started biting on 2026-08-16 and silently killed EVERY page-open
  // in the extension — scraping AND the Sales Nav list phase (every run since logged
  // `salesnav-list:no-tab` and filed nobody). So: try off-screen first (nicest when allowed),
  // then fall back to on-screen-but-unfocused rather than giving up.
  const attempts = [
    { focused: false, state: 'normal', width: 1280, height: 900, top: -2000, left: -2000 },
    { focused: false, state: 'normal', width: 1280, height: 900, top: 0, left: 0 },
    { focused: false, state: 'normal' }
  ];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const win = await chrome.windows.create(attempts[i]);
      scrapeWindowId = win.id;
      if (i > 0) await log('warn', 'scrape-window:fallback', { attempt: i, error: String(lastErr) });
      // Best-effort nudge off-screen + unfocused; a rejection here is harmless (the window just
      // stays visible), and must NOT undo the successful create.
      try { await chrome.windows.update(scrapeWindowId, { focused: false, top: -2000, left: -2000 }); } catch (e) {}
      return scrapeWindowId;
    } catch (e) {
      lastErr = e;
    }
  }
  scrapeWindowId = null;
  await log('error', 'scrape-window:create-failed', { error: String(lastErr) });
  return scrapeWindowId;
}

// Open a scrape URL as an active tab INSIDE the unfocused background window (renders, no
// global focus steal). Returns the created tab (or null on failure).
async function openScrapeTab(url) {
  const winId = await getScrapeWindow();
  if (winId === null) return null;
  try {
    const tab = await chrome.tabs.create({ windowId: winId, url, active: true });
    // Re-assert off-screen + unfocused right after — adding a tab can nudge the window back.
    try { await chrome.windows.update(winId, { focused: false, top: -2000, left: -2000 }); } catch (e) {}
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
  // NEW (2026 Sales Nav DOM): result cards no longer contain /sales/lead/ links or
  // data-anonymize attributes. Each result wraps a
  //   <div data-scroll-into-view="urn:li:fs_salesProfile:(MEMBER_ID,NAME_SEARCH,ctx)">
  // and the person's name lives in <span class="a11y-text">Add {Name} to selection</span>.
  // Title/company/degree are no longer exposed in search results — they're resolved
  // downstream from the lead page (resolveUrn) / enricherPro.
  const harvest = () => {
    document.querySelectorAll('[data-scroll-into-view^="urn:li:fs_salesProfile"]').forEach(node => {
      try {
        const dsv = node.getAttribute('data-scroll-into-view') || '';
        const m = dsv.match(/fs_salesProfile:\(([^,]+),/);
        if (!m) return;
        const urn = m[1];
        if (byUrn.has(urn)) return;  // already captured this person
        const li = node.closest('li') || node.parentElement || node;
        const a11y = li.querySelector('span.a11y-text') || li.querySelector('.a11y-text');
        const name = a11y ? cleanName((a11y.textContent || '').replace(/^\s*Add\s+/i, '').replace(/\s+to selection\s*$/i, '')) : '';
        if (!name) return;
        // Capture the connection DEGREE here. Sales Nav's CONNECTION_OF filter only works for
        // your 1st-degree connections; for anyone else it is silently DROPPED and the search
        // returns a generic pool. Until now discovery hardcoded '' and threw the badge away, so
        // 69 of 75 bridges had no degree and every one had to be scraped to find out. The lead
        // scraper already reads this from the same card — do the same here. Best-effort: blank
        // when the badge is not rendered, which callers treat as "unknown", never as "not 1st".
        let degree = '';
        try {
          const card = li;
          let deg = (card.textContent || '').match(/(?:^|[·•\s])(1st|2nd|3rd)\b/i)
                 || (card.textContent || '').match(/\b(1st|2nd|3rd)\s+degree/i);
          if (!deg) {
            const al = Array.from(card.querySelectorAll('[aria-label]'))
              .map(e => e.getAttribute('aria-label') || '').join(' ');
            deg = al.match(/\b(1st|2nd|3rd)\b/i);
          }
          if (deg) degree = deg[1].toLowerCase();
        } catch (e) {}
        byUrn.set(urn, { name, title: '', urn, linkedin_url: '', connection: degree });
      } catch (e) {}
    });
  };

  // 1) Wait for the first result card to appear (poll up to ~15s, scrolling each pass).
  for (let _p = 0; _p < 15; _p++) {
    if (document.querySelectorAll('[data-scroll-into-view^="urn:li:fs_salesProfile"]').length > 0) break;
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

// ---- Dropped-filter guard -------------------------------------------------------------
// Sales Navigator does NOT error when it rejects a CONNECTION_OF filter (typically because the
// bridge is not one of YOUR 1st-degree connections, or the urn is not a real member urn). It
// silently runs the REST of the query and returns a generic result set. That reads as a perfect
// scrape ("found 324 / saved 324") while being nobody's network - and because every such bridge
// returns the SAME people, dedup then throws them all away and the bridge shows 0 forever.
//
// Detection: fingerprint each bridge's result set. If that exact set has already been returned
// by a DIFFERENT bridge, the filter was ignored. Fingerprints persist across runs.
const FP_STORE = 'radar_lead_fingerprints';
const FP_MAX   = 400;
const FP_MIN_LEADS = 8;   // below this a collision is plausible by chance

function leadSetFingerprint(leads) {
  const ids = (leads || []).map(l => l && l.lead_id).filter(Boolean).sort();
  if (ids.length < FP_MIN_LEADS) return '';
  const s = ids.length + ':' + ids.join(',');
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = ((h1 ^ s.charCodeAt(i)) >>> 0);
    h1 = (Math.imul(h1, 16777619) >>> 0);
    h2 = ((h2 + s.charCodeAt(i) * (i + 1)) >>> 0);
  }
  return ids.length + '-' + h1.toString(36) + h2.toString(36);
}

// Returns { fp, owner } when this exact result set already belongs to another bridge, else false.
async function filterWasIgnored(bridge, leads, scope) {
  const fp0 = leadSetFingerprint(leads);
  if (!fp0) return false;
  const fp = (scope || '') + fp0;
  let store = {};
  try { const r = await chrome.storage.local.get(FP_STORE); store = (r && r[FP_STORE]) || {}; } catch (e) {}
  const owner = store[fp];
  if (owner && owner !== bridge.bridge) return { fp: fp, owner: owner };
  if (!owner) {
    store[fp] = bridge.bridge;
    const keys = Object.keys(store);
    if (keys.length > FP_MAX) keys.slice(0, keys.length - FP_MAX).forEach(k => { delete store[k]; });
    try { const o = {}; o[FP_STORE] = store; await chrome.storage.local.set(o); } catch (e) {}
  }
  return false;
}

async function scrapeBridge(bridge, pageBudget) {
  const budget = pageBudget || { left: MAX_PAGES };
  const leads = [];
  const urn  = bridge.urn;
  const name = bridge.bridge.replace(/ /g, '%20');
  const query = '(filters:List((type:SENIORITY_LEVEL,values:List((id:320,text:Owner%20%2F%20Partner,selectionType:INCLUDED),(id:310,text:CXO,selectionType:INCLUDED))),(type:COMPANY_HEADCOUNT,values:List((id:C,text:11-50,selectionType:INCLUDED))),(type:CONNECTION_OF,values:List((id:' + urn + ',text:' + name + ',selectionType:INCLUDED))),(type:REGION,values:List((id:100506914,text:Europe,selectionType:INCLUDED))),(type:LEAD_INTERACTIONS,values:List((id:LIMP,text:Messaged,selectionType:EXCLUDED)))))';
  const baseUrl = 'https://www.linkedin.com/sales/search/people?query=' + encodeURIComponent(query);
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (budget.left <= 0) { await log('info', 'scrape:page-budget', { bridge: bridge.bridge, stoppedAtPage: page }); break; }
    budget.left--;
    const url = baseUrl + (page > 1 ? '&page=' + page : '');
    await log('info', 'scrape:page', { bridge: bridge.bridge, page });
    const pageLeads = await scrapePageInTab(url, bridge);
    if (!pageLeads || pageLeads.length === 0) { await log('info', 'scrape:page-empty', { bridge: bridge.bridge, page }); break; }
    leads.push(...pageLeads);
    await log('info', 'scrape:page-done', { bridge: bridge.bridge, page, count: pageLeads.length });
    // EARLY dropped-filter guard. Up to 1.8.1 this check only ran after the WHOLE bridge was
    // scraped, so a bridge whose CONNECTION_OF filter Sales Nav silently dropped still cost 25
    // page loads before its results were thrown away (2026-08-25: "Nicolas MILONAS" burned 25
    // pages to return the same 625 people as another bridge). Those wasted loads are what
    // exhausts the session the lead-list phase depends on. Check after page 1 instead.
    if (page === 1) {
      try {
        const dupEarly = await filterWasIgnored(bridge, pageLeads, 'p1:');
        if (dupEarly) {
          await log('warn', 'scrape:filter-ignored', {
            bridge: bridge.bridge,
            matched: dupEarly.owner,
            count: pageLeads.length,
            detectedOn: 'page-1',
            reason: 'Page 1 is identical to "' + dupEarly.owner + '" - Sales Nav dropped the CONNECTION_OF filter (this bridge is probably not a 1st-degree connection). Stopped after 1 page instead of ' + MAX_PAGES + '.'
          });
          notify('Bridge switched off', bridge.bridge + ' returns a generic search, not their network - switched off.', 'error');
          return [];
        }
      } catch (e) { await log('warn', 'filter-guard:error', { bridge: bridge.bridge, error: String(e) }); }
    }
    if (pageLeads.length < 25) break;
    await humanDelay(6000, 14000);
  }
  // Search cards frequently omit location. For anyone still missing a country, open their
  // lead page once to read it, then derive the language. Runs in the worker (not injected),
  // caps its own lookups, and closes every tab it opens.
  try { await enrichLocations(leads); } catch (e) { await log('warn', 'location-enrich:failed', { error: String(e) }); }
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
    // NEW (2026 Sales Nav DOM): anchor on data-scroll-into-view (carries the fs_salesProfile
    // URN) and read the name from the .a11y-text selection label. Title/company/location/degree
    // are no longer in the results DOM — they resolve downstream (lead page / enricherPro /
    // Pappers), so the card-scan below simply yields blanks now (kept for forward-compat).
    document.querySelectorAll('[data-scroll-into-view^="urn:li:fs_salesProfile"]').forEach(node => {
      try {
        const dsv = node.getAttribute('data-scroll-into-view') || '';
        const um = dsv.match(/fs_salesProfile:\(([^,]+),/);
        if (!um) return;
        const lead_id = um[1];
        if (byUrn.has(lead_id)) return;  // already captured this person
        const li = node.closest('li') || node.parentElement || node;
        const a11y = li.querySelector('span.a11y-text') || li.querySelector('.a11y-text');
        const name = a11y ? cleanName((a11y.textContent || '').replace(/^\s*Add\s+/i, '').replace(/\s+to selection\s*$/i, '')) : '';
        if (!name) return;
        const parts = name.split(' ');
        const card = li;
        // Every .a11y-text leaf in this card is screen-reader chrome ("Add <Name> to selection",
        // "Select <Name>", ...). It is NEVER a job title. Up to 1.8.1 the title picker simply
        // took the LONGEST text leaf, and on the 2026 Sales Nav DOM that leaf is the selection
        // label - which is why 1562 of 1722 targets collected on 2026-08-25 have
        // title = "Add <Name> to selection". Collect them so both pickers can exclude them.
        const a11yTexts = new Set();
        try {
          Array.from(card.querySelectorAll('.a11y-text')).forEach(e => {
            const v = (e.textContent || '').replace(/\s+/g, ' ').trim();
            if (v) a11yTexts.add(v);
          });
        } catch (e) {}
        // Sales Nav marketing / upsell copy that renders inside result cards and is likewise
        // never a title (e.g. "InMails get 5x more responses than emails").
        const PROMO_RE = /inmail|\bget \d+x more\b|responses than emails|upgrade|try sales navigator|learn more|start your free|premium/i;
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
          if (a11yTexts.has(t) || /\bto selection$/i.test(t) || PROMO_RE.test(tl)) continue;
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
          // The two fixes that matter (1.9.0): screen-reader labels and marketing copy are not titles.
          if (a11yTexts.has(t)) continue;
          if (/^add\s+.+\s+to selection$/i.test(t) || /\bto selection$/i.test(t) || /^select\s+/i.test(t)) continue;
          if (PROMO_RE.test(tl)) continue;
          if (t.length > title.length) title = t;  // keep the longest qualifying leaf
        }
        if (title.length > 200) title = title.slice(0, 200);

        // Language: left blank here on purpose. This function is INJECTED into the page, so it
        // cannot call langFromCountry() from the service-worker scope. enrichLocations() derives
        // language from country back in the worker after this returns.
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

  // 1) Wait for the first result card to appear (poll up to ~15s, scrolling each pass).
  for (let _p = 0; _p < 15; _p++) {
    if (document.querySelectorAll('[data-scroll-into-view^="urn:li:fs_salesProfile"]').length > 0) break;
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

// ─── Public /in/ URL resolution ─────────────────────────────────────────────────────────────
// Rewritten 2026-08-28. The old resolver opened a Sales Navigator LEAD PAGE per person and polled
// the DOM for an `a[href*="linkedin.com/in/"]`. Verified live on 2026-08-28 against three real
// leads: that anchor NO LONGER EXISTS. A fully rendered 2026 lead page has 107 anchors and not
// one of them contains `/in/`; `publicIdentifier` appears nowhere in the page source either. So
// the poll was never going to succeed - it burned a full page load (and a profile view) per
// person to return null, which is why only 90 of 2368 targets had a URL.
//
// Captured Sales Navigator's OWN request for a lead page and replayed it: the public URL is
// served by the API, in the `flagshipProfileUrl` field.
//
//   GET /sales-api/salesApiProfiles/(profileId:<URN>,authType:NAME_SEARCH,authToken:undefined)
//       ?decoration=(entityUrn,fullName,degree,flagshipProfileUrl)
//   headers: csrf-token, x-restli-protocol-version: 2.0.0
//
// Verified 2026-08-28 - all three test leads returned 200 with a real URL:
//   "https://www.linkedin.com/in/lafarge", ".../in/laurent-sayada", ".../in/jean-pierre-chess%C3%A9-62b7a521"
// This is one cheap GET, needs NO page render and costs NO profile view, so hundreds can be
// resolved per run where the old way managed a hundred page loads for nothing. The response also
// carries `degree`, which fills targets.connection and feeds the 1st-degree rules for free.
//
// NOTE: the decoration must be sent with parens/commas percent-encoded and nothing else; adding
// `defaultPosition` without a sub-projection makes LinkedIn answer 400 (observed while testing).
const RESOLVE_DECORATION = '%28entityUrn%2CfullName%2Cdegree%2CflagshipProfileUrl%29';
const RESOLVE_PACE_MS    = 400;

// Injected. Resolves MANY urns from one already-authenticated Sales Nav tab.
async function resolveUrnsInPage(urns, decoration, paceMs) {
  const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1];
  if (!csrf) return { error: 'no JSESSIONID cookie', out: [] };
  const out = [];
  for (let i = 0; i < urns.length; i++) {
    const urn = urns[i];
    try {
      const u = '/sales-api/salesApiProfiles/(profileId:' + urn +
                ',authType:NAME_SEARCH,authToken:undefined)?decoration=' + decoration;
      const r = await fetch(u, {
        credentials: 'include',
        headers: {
          'csrf-token': csrf,
          'x-restli-protocol-version': '2.0.0',
          'accept': 'application/json'
        }
      });
      if (r.status === 401 || r.status === 403 || r.status === 429) {
        out.push({ urn: urn, status: r.status, stop: true });
        break;
      }
      let j = null;
      try { j = JSON.parse(await r.text()); } catch (e) {}
      out.push({
        urn: urn,
        status: r.status,
        url: (j && j.flagshipProfileUrl) || null,
        degree: (j && typeof j.degree !== 'undefined') ? j.degree : null
      });
    } catch (e) {
      out.push({ urn: urn, error: String(e).slice(0, 80) });
    }
    await new Promise(function (r) { setTimeout(r, paceMs + Math.floor(Math.random() * paceMs)); });
  }
  return { out: out };
}

// Opens ONE Sales Nav tab and resolves every urn through it. Returns a Map urn -> {url, degree}.
async function resolveUrnsViaApi(urns) {
  const result = new Map();
  if (!urns || !urns.length) return result;
  const tab = await openScrapeTab('https://www.linkedin.com/sales/homepage');
  if (!tab) {
    await log('warn', 'resolve:no-tab', { wanted: urns.length });
    return result;
  }
  try {
    await waitForTabComplete(tab.id, 45000);
    // Same lesson as the list phase: a cookie is not a loaded page. Give the SPA a moment.
    await sleep(3000);
    let stopped = false;
    for (let i = 0; i < urns.length && !stopped; i += 50) {
      const batch = urns.slice(i, i + 50);
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: resolveUrnsInPage,
        args: [batch, RESOLVE_DECORATION, RESOLVE_PACE_MS]
      });
      const payload = (res && res[0]) ? res[0].result : null;
      const rows = (payload && payload.out) || [];
      for (const row of rows) {
        if (row.stop) {
          stopped = true;
          await log('warn', 'resolve:refused', { status: row.status, resolved_so_far: result.size });
          break;
        }
        if (row.url) result.set(row.urn, { url: row.url, degree: row.degree });
      }
    }
  } catch (e) {
    await log('warn', 'resolve:error', { error: String(e) });
  } finally {
    try { chrome.tabs.remove(tab.id); } catch (e) {}
  }
  return result;
}

async function resolvePublicUrls(leads, budget) {
  const state = budget || { left: MAX_RESOLVE_PER_RUN };
  const need = leads.filter(l => !l.linkedin_url && l.lead_id).slice(0, Math.max(0, state.left));
  if (!need.length) return leads;
  state.left -= need.length;
  const map = await resolveUrnsViaApi(need.map(l => l.lead_id));
  let hit = 0;
  for (const lead of need) {
    const got = map.get(lead.lead_id);
    if (got && got.url) {
      lead.linkedin_url = got.url;
      hit++;
      // The same call tells us the network distance - keep it, the 1st-degree rules need it.
      if (got.degree !== null && typeof got.degree !== 'undefined' && !lead.connection) {
        lead.connection = String(got.degree);
      }
    }
  }
  await log('info', 'resolve:urls', { asked: need.length, resolved: hit, budget_left: state.left });
  return leads;
}

// Single-urn convenience (bridges). Same API path, so it no longer opens a lead page for nothing.
async function resolveUrn(urn) {
  if (!urn) return null;
  const map = await resolveUrnsViaApi([urn]);
  const got = map.get(urn);
  return (got && got.url) || null;
}

async function postToHub(leads) {
  const resp = await fetch(WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: INGEST_SECRET, leads }) });
  let body = null;
  try { body = await resp.json(); } catch (e) { body = null; }
  // Treat an HTTP error OR an {ok:false} body as a real failure so the caller buffers + retries
  // and shows an error — instead of reading a missing save-count as "0 saved" (the bug that hid
  // a broken backend for weeks).
  if (!resp.ok || (body && body.ok === false)) {
    throw new Error('hub ' + resp.status + ': ' + ((body && body.error) || 'save failed'));
  }
  return body || {};
}

const BUFFER_KEY = 'radar_unsaved_leads';
async function bufferLeads(leads) {
  try {
    const s = await chrome.storage.local.get(BUFFER_KEY);
    const cur = s[BUFFER_KEY] || [];
    const seen = new Set(cur.map(l => l && l.lead_id));
    for (const l of leads) { if (l && l.lead_id && !seen.has(l.lead_id)) { cur.push(l); seen.add(l.lead_id); } }
    await chrome.storage.local.set({ [BUFFER_KEY]: cur.slice(-3000) });
  } catch (e) {}
}
async function flushBuffer() {
  try {
    const s = await chrome.storage.local.get(BUFFER_KEY);
    const cur = s[BUFFER_KEY] || [];
    if (!cur.length) return 0;
    const res = await postToHub(cur);
    const n = (res && (res.upserted != null ? res.upserted : res.written)) || 0;
    await log('info', 'buffer:flushed', { held: cur.length, saved: n });
    await chrome.storage.local.set({ [BUFFER_KEY]: [] });
    return n;
  } catch (e) { await log('warn', 'buffer:flush-failed', { error: String(e) }); return 0; }
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
const NOTIF_KEY = 'radarNotifLog';
const MAX_NOTIF_ENTRIES = 500;
// level: only 'error'/'alert' produce an on-screen desktop popup. Everything else is recorded
// silently to the in-app notification log (radarNotifLog) — visible in the popup / web app,
// but it never interrupts the user while they work.
function notify(title, message, level) {
  try {
    if (level === 'error' || level === 'alert') {
      chrome.notifications.create('radar_' + Date.now(), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Radar — ' + title,
        message: String(message || ''),
        priority: 1
      });
    }
  } catch (e) {}
  try {
    chrome.storage.local.get(NOTIF_KEY, d => {
      const arr = d[NOTIF_KEY] || [];
      arr.unshift({ ts: new Date().toISOString(), title: String(title || ''), message: String(message || ''), level: level || 'info' });
      chrome.storage.local.set({ [NOTIF_KEY]: arr.slice(0, MAX_NOTIF_ENTRIES) });
    });
  } catch (e) {}
}
