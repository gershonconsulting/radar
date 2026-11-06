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
// ===== LinkedIn gate (1.13.0) =====
// Radar asks the shared LinkedIn gate BEFORE every Sales Navigator search page, every bridge
// discovery search and every lead-page open, and STOPS when the gate says no. Up to 1.12.0 Radar
// only reported volume after the fact (a database trigger), so nothing could ever hold it back.
// 1 unit = 1 search results page (25 cards) or 1 lead page - not 1 row.
// Fails CLOSED: if the gate cannot be reached, Radar holds and retries later.
const GATE_URL = 'https://pkzeeqehwmtnqxdpdesl.supabase.co/functions/v1/radar-gate';
const GATE_MAX_PACING_WAIT_S = 420;   // wait in place for short pacing holds, stop for anything longer
const GATE_RESUME_KEY = 'radar_gate_resume';
let GATE_HELD = null;                 // set when this run was stopped by the gate
const MAX_PAGES     = 25;
// ===== Human rhythm + hidden collection (1.15.0) =====
// LinkedIn flags accounts on VOLUME and REGULARITY: long marathons of evenly spaced page loads.
// So: a daily page ceiling, the day split into short sessions with long breaks, irregular gaps
// between pages, office hours only for automatic runs, and a 24h stop at the first sign that
// LinkedIn is checking the account. The collection itself runs in a MINIMIZED window: the
// results are read from Sales Nav's own search API responses (capture.js), so nothing has to be
// visible. If that read ever fails, the window is shown (unfocused) for that page only.
const DAY_PAGE_CAP        = 120;          // Sales Nav search pages per local day, all sessions
const SESSION_PAGES_MIN   = 25;           // pages per session (random in [min,max])
const SESSION_PAGES_MAX   = 40;
const SESSION_BREAK_MIN_M = 45;           // break between sessions, minutes
const SESSION_BREAK_MAX_M = 110;
const WORK_DAYS           = [1, 2, 3, 4, 5];   // automatic runs Mon-Fri only (local time)
const WORK_START_MIN      = 8 * 60 + 30;       // 08:30 local
const WORK_END_MIN        = 19 * 60;           // 19:00 local
const LI_HOLD_KEY         = 'radar_li_hold_until';
const LI_CHALLENGE_HOLD_MS = 24 * 60 * 60 * 1000;
const DAY_STATE_KEY       = 'radar_day_state';
const SCRAPE_MODE_KEY     = 'radar_scrape_mode';   // { mode: 'hidden'|'visible', misses, since }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function localDayKey(d) { d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
async function getDayState() {
  let st = null;
  try { st = (await chrome.storage.local.get(DAY_STATE_KEY))[DAY_STATE_KEY] || null; } catch (e) {}
  if (!st || st.day !== localDayKey()) st = { day: localDayKey(), pages: 0, sessions: 0, done: [] };
  if (!Array.isArray(st.done)) st.done = [];
  return st;
}
async function saveDayState(st) { try { await chrome.storage.local.set({ [DAY_STATE_KEY]: st }); } catch (e) {} }
function inWorkWindow(d) {
  d = d || new Date();
  const m = d.getHours() * 60 + d.getMinutes();
  return WORK_DAYS.indexOf(d.getDay()) !== -1 && m >= WORK_START_MIN && m < WORK_END_MIN;
}
function nextWorkWindowStart(d) {
  const t = new Date((d || new Date()).getTime());
  for (let i = 0; i < 8; i++) {
    const c = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i, Math.floor(WORK_START_MIN / 60), WORK_START_MIN % 60, 0, 0);
    if (WORK_DAYS.indexOf(c.getDay()) !== -1 && c.getTime() > t.getTime()) return c;
  }
  return new Date(t.getTime() + 24 * 3600 * 1000);
}
async function liHoldLeft() {
  try { const r = await chrome.storage.local.get(LI_HOLD_KEY); const t = r[LI_HOLD_KEY] ? new Date(r[LI_HOLD_KEY]).getTime() : 0; return Math.max(0, t - Date.now()); } catch (e) { return 0; }
}
async function setLiHold(ms, why) {
  try { await chrome.storage.local.set({ [LI_HOLD_KEY]: new Date(Date.now() + ms).toISOString() }); } catch (e) {}
  await log('warn', 'linkedin:hold', { hours: Math.round(ms / 3600000), why: why || '' });
}
async function scheduleResumeAt(when, reason) {
  const ms = Math.max(60 * 1000, when.getTime() - Date.now());
  try {
    await chrome.storage.local.set({ [GATE_RESUME_KEY]: { at: new Date(Date.now() + ms).toISOString(), reason: reason } });
    chrome.alarms.create('gateResume', { delayInMinutes: ms / 60000 });
  } catch (e) {}
  await log('info', 'run:resume-scheduled', { at: new Date(Date.now() + ms).toISOString(), reason: reason });
}
async function humanPageGap() {
  let s = randInt(18, 55);
  if (Math.random() < 0.15) s += randInt(60, 180);
  await sleepKeepAlive(s * 1000);
}
async function humanBridgeGap() { await sleepKeepAlive(randInt(40, 120) * 1000); }
function isChallengeUrl(u) { return /linkedin\.com\/(checkpoint|authwall|uas\/login|login)|captcha|challenge/i.test(String(u || '')); }
const MAX_RESOLVE_PER_RUN = 400;  // API lookups now, not page loads - so this can be far higher
// How many of the STANDING backlog of URL-less prospects to drain per run. See
// backfillTargetUrls() for why a backlog existed at all. Same cheap API path as the in-run
// resolution (no profile views), so this can comfortably outpace what a run collects.
const BACKFILL_URLS_PER_RUN = 500;
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
// Automatic runs only (manual "Sync now" is never deferred): respect a LinkedIn hold and office hours.
async function deferAutoRun(trigger) {
  const hold = await liHoldLeft();
  if (hold > 0) { await scheduleResumeAt(new Date(Date.now() + hold + randInt(5, 40) * 60000), 'linkedin_hold'); return true; }
  if (!inWorkWindow(new Date())) {
    const at = new Date(nextWorkWindowStart(new Date()).getTime() + randInt(0, 40) * 60000);
    await log('info', 'run:deferred-outside-hours', { trigger: trigger, next: at.toISOString() });
    await scheduleResumeAt(at, 'office_hours');
    return true;
  }
  return false;
}
async function maybeAutoRun(trigger) {
  // A resume whose alarm was lost with a browser restart is still honoured on the next trigger.
  if (trigger !== 'gateResume') {
    try {
      const pr = (await chrome.storage.local.get(GATE_RESUME_KEY))[GATE_RESUME_KEY];
      if (pr && pr.at && new Date(pr.at).getTime() <= Date.now()) trigger = 'gateResume';
    } catch (e) {}
  }
  if (await deferAutoRun(trigger)) return { status: 'deferred' };
  if (trigger === 'gateResume') {
    // The gate held the previous run; it asked us to come back now. Not subject to the 20h rule.
    let pendingResume = null;
    try { pendingResume = (await chrome.storage.local.get(GATE_RESUME_KEY))[GATE_RESUME_KEY]; } catch (e) {}
    if (pendingResume) {
      try { await chrome.storage.local.remove(GATE_RESUME_KEY); } catch (e) {}
      const r0 = await runSync({ resume: true });
      try { await pushLog(); } catch (e) {}
      return r0;
    }
  }
  const lastAt = await getLastRunAt();
  const age = Date.now() - lastAt;
  // Once per LOCAL day (1.15.0): later sessions of the same day are resumes, not auto runs.
  if (lastAt && localDayKey(new Date(lastAt)) === localDayKey() && age < AUTO_MIN_MS) { await log('info', 'run:skip-auto', { trigger, ranHoursAgo: Math.round(age / 3600000) }); return { status: 'skipped-recent' }; }
  const r = await runSync();
  try { await pushLog(); } catch (e) {}
  return r;
}
chrome.runtime.onInstalled.addListener(async () => { await applySchedule(await getSchedule()); await log('info', 'Extension installed, schedule set'); });
// PRIMARY trigger: the first time Chrome opens each day (gated to once/day by maybeAutoRun).
chrome.runtime.onStartup.addListener(async () => { await applySchedule(await getSchedule()); await maybeAutoRun('startup'); });
// BACKUP: if Chrome stays open for many hours, the daily alarm still fires it (also gated).
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'dailySync') maybeAutoRun('alarm'); if (alarm.name === 'gateResume') maybeAutoRun('gateResume'); });

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
    GATE_HELD = null;
    discoverBridges().then(async r => { if (GATE_HELD) await scheduleGateResume(); await chrome.storage.local.set({ lastDiscoverAt: new Date().toISOString() }); await clearDiscoverPending([]); await closeScrapeWindow(); await pushLog(); sendResponse({ ok: true, result: r }); }).catch(async e => { await closeScrapeWindow(); await pushLog(); sendResponse({ ok: false, error: String(e) }); });
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
async function sleepKeepAlive(ms) {
  // An MV3 worker idles out after ~30s with no extension API activity - touch storage while waiting.
  const end = Date.now() + ms;
  while (Date.now() < end) { await sleep(Math.min(20000, end - Date.now())); try { await chrome.storage.local.get(GATE_RESUME_KEY); } catch (e) {} }
}
async function gateAsk(gateAction, units) {
  try {
    const body = { secret: INGEST_SECRET, gate_action: gateAction, units: units || 1, ext_version: EXT_VERSION };
    if (CURRENT_OWNER) body.owner = CURRENT_OWNER;
    const r = await fetch(GATE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    return (d && typeof d.allow === 'boolean') ? d : { allow: false, reason: 'gate_bad_response', retry_after_seconds: 900 };
  } catch (e) {
    return { allow: false, reason: 'gate_unreachable', retry_after_seconds: 900 };
  }
}
// Returns true when the action may go ahead. Short pacing holds are waited out in place;
// any other refusal marks the run as held (GATE_HELD) and returns false - the caller stops.
async function gateTake(gateAction, context) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const d = await gateAsk(gateAction, 1);
    if (d.allow) return true;
    const wait = Number(d.retry_after_seconds || 0);
    if (d.reason === 'pacing' && wait > 0 && wait <= GATE_MAX_PACING_WAIT_S) {
      await log('info', 'gate:pacing-wait', { action: gateAction, seconds: wait, context: context || '' });
      await sleepKeepAlive(wait * 1000);
      continue;
    }
    GATE_HELD = { action: gateAction, reason: d.reason || 'denied', retry_after_seconds: wait || 900, account: d.account || '', context: context || '' };
    await log('warn', 'gate:held', GATE_HELD);
    return false;
  }
  GATE_HELD = { action: gateAction, reason: 'pacing', retry_after_seconds: 600, context: context || '' };
  await log('warn', 'gate:held', GATE_HELD);
  return false;
}
async function scheduleGateResume() {
  if (!GATE_HELD) return;
  const secs = Math.min(Math.max(Number(GATE_HELD.retry_after_seconds) || 900, 300), 12 * 3600);
  try {
    await chrome.storage.local.set({ [GATE_RESUME_KEY]: { at: new Date(Date.now() + secs * 1000).toISOString(), reason: GATE_HELD.reason } });
    chrome.alarms.create('gateResume', { delayInMinutes: secs / 60 });
  } catch (e) {}
  await log('info', 'gate:resume-scheduled', { inMinutes: Math.round(secs / 60), reason: GATE_HELD.reason });
}

async function runSync(opts) {
  opts = opts || {};
  if (SYNC_RUNNING) { await log('warn', 'run:already-running'); return { status: 'already-running' }; }
  SYNC_RUNNING = true;
  // Stamp the run time up front so a near-simultaneous trigger (e.g. the +1min alarm) is gated out.
  const DAY = await getDayState();
  const firstSessionToday = DAY.sessions === 0;
  if (firstSessionToday || !opts.resume) { try { await chrome.storage.local.set({ radar_last_run_at: new Date().toISOString() }); } catch (e) {} }
  DAY.sessions++;
  await saveDayState(DAY);
  await clearLog();
  GATE_HELD = null;
  await log('info', 'run:start', { version: EXT_VERSION, session: DAY.sessions, dayPages: DAY.pages, dayCap: DAY_PAGE_CAP, resume: !!opts.resume });
  try { await ensureCaptureScript(); } catch (e) {}
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
      const dres = await discoverBridges(pending);
      // Only clear the sources that were actually searched - a gate hold leaves the rest pending.
      const doneNames = (dres && dres.processed) ? dres.processed : [];
      if (doneNames.length) await clearDiscoverPending(doneNames);
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
    // Hand-added bridges first: swap their placeholder 'manual:' urn for the real Sales Nav
    // member urn so they are collected from in THIS run instead of being switched off.
    let manualStats = { pending: 0, resolved: 0, unresolved: 0 };
    try { manualStats = await resolveManualBridges(MANUAL_BRIDGE_RESOLVE_PER_RUN); }
    catch (e) { await log('warn', 'manual-bridge:phase-error', { error: String(e) }); }
    // v1.17.0: Source PRIORITY. High-priority sources' bridges go first, then Medium, then Low;
    // order is still randomized INSIDE each tier so the access pattern keeps varying.
    let prioMap = {};
    try { prioMap = await sourcePriorityMap(); } catch (e) { prioMap = {}; }
    const allBridges = byPriority(await resolveActiveBridges(), b => prioMap[_normName(b.source)]);
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
    const doneToday = new Set(DAY.done);
    const bridges = eligible.filter(b => !doneToday.has(String(b.urn || ''))).slice(0, MAX_BRIDGES_PER_RUN);
    await log('info', 'scrape:bridges', {
      count: bridges.length,
      eligible: eligible.length,
      of: allBridges.length,
      skippedNotConnected: notConnected.length,
      deferred: Math.max(0, eligible.length - bridges.length),
      cap: MAX_BRIDGES_PER_RUN,
      order: 'priority-then-random',
      priorities: bridges.reduce((m, b) => { const p = prioMap[_normName(b.source)] || 'medium'; m[p] = (m[p] || 0) + 1; return m; }, {})
    });

    if (!WEBAPP_URL || WEBAPP_URL === '__WEBAPP_URL__') { await log('warn', 'WEBAPP_URL not set'); return { status: 'no-webapp-url' }; }

    // First, flush anything a previous (interrupted) run scraped but couldn't save.
    let savedTotal = 0, foundTotal = 0;
    try { const f = await flushBuffer(); savedTotal += f; if (f) await pushLog(); } catch (e) { await log('warn', 'buffer:flush-error', { error: String(e) }); }

    // Shared URL-resolution budget for the whole run (resolving opens a tab per lead).
    const resolveState = { left: MAX_RESOLVE_PER_RUN };
    // Shared page-load budget: the hard ceiling on how much Sales Navigator this run touches.
    const sessionPages = Math.max(0, Math.min(randInt(SESSION_PAGES_MIN, SESSION_PAGES_MAX), MAX_PAGES_PER_RUN, DAY_PAGE_CAP - DAY.pages));
    const pageBudget = { left: sessionPages };
    await log('info', 'session:budget', { session: DAY.sessions, pages: sessionPages, dayPagesSoFar: DAY.pages, dayCap: DAY_PAGE_CAP, doneToday: DAY.done.length });
    let bridgesDone = 0;

    // CRITICAL: write EACH bridge's leads to the hub as soon as they're scraped. Previously the
    // run hoarded all ~80 bridges' leads in memory and wrote once at the very end - with dozens of
    // active bridges that end never arrives (the MV3 service worker is killed first), so nothing
    // saved even though every bridge popped "found N". Per-bridge writes = data lands immediately
    // and an interrupted run keeps everything up to the point it stopped.
    for (const bridge of bridges) {
      if (GATE_HELD) {
        await log('warn', 'scrape:gate-held', { scraped: bridgesDone, skipped: bridges.length - bridgesDone, reason: GATE_HELD.reason });
        break;
      }
      if (pageBudget.left <= 0) {
        // End of a SESSION, not of the day: take a long break and come back, unless today's cap is spent.
        if (DAY.pages < DAY_PAGE_CAP) {
          GATE_HELD = { action: 'session', reason: 'session_break', retry_after_seconds: randInt(SESSION_BREAK_MIN_M, SESSION_BREAK_MAX_M) * 60 };
          await log('info', 'session:break', { minutes: Math.round(GATE_HELD.retry_after_seconds / 60), remaining: bridges.length - bridgesDone });
        } else {
          await log('info', 'session:day-cap-reached', { dayPages: DAY.pages, cap: DAY_PAGE_CAP });
        }
        await log('warn', 'scrape:budget-reached', {
          cap: sessionPages,
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
      const leftBefore = pageBudget.left;
      try {
        await log('info', 'scrape:start', { bridge: bridge.bridge });
        leads = await scrapeBridge(bridge, pageBudget);
        await log('info', 'scrape:done', { bridge: bridge.bridge, leadCount: leads.length });
      } catch (err) { await log('error', 'scrape:error', { bridge: bridge.bridge, error: String(err) }); leads = []; }
      DAY.pages += Math.max(0, leftBefore - pageBudget.left);
      if (!GATE_HELD && pageBudget.left > 0) DAY.done.push(String(bridge.urn || ''));
      await saveDayState(DAY);

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
          notify('New prospects', leads.length + ' found via ' + bridge.bridge + ' - ' + nn + ' saved.');
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
      if (!GATE_HELD && pageBudget.left > 0) await humanBridgeGap();
    }
    // More bridges still waiting today and budget left for the day -> come back after a break.
    if (!GATE_HELD) {
      const doneNow = new Set(DAY.done);
      const waiting = eligible.filter(b => !doneNow.has(String(b.urn || '')) && /^ACwAA/.test(String(b.urn || ''))).length;
      if (waiting > 0 && DAY.pages < DAY_PAGE_CAP) {
        GATE_HELD = { action: 'session', reason: 'session_break', retry_after_seconds: randInt(SESSION_BREAK_MIN_M, SESSION_BREAK_MAX_M) * 60 };
        await log('info', 'session:break', { minutes: Math.round(GATE_HELD.retry_after_seconds / 60), waitingBridges: waiting });
      }
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

    // Drain the standing backlog of prospects still missing a public /in/ URL. Runs on EVERY
    // sync - a run that collects nothing still has yesterday's overflow to catch up on, and that
    // catching up is exactly what never happened before.
    let urlBackfill = { asked: 0, resolved: 0, remaining: 0 };
    if (firstSessionToday) try { urlBackfill = await backfillTargetUrls(BACKFILL_URLS_PER_RUN); }
    catch (e) { await log('warn', 'backfill:error', { error: String(e) }); }

    // Give the invite campaign something to work with: resolve a few missing bridge URLs.
    let bridgeUrls = { attempted: 0, resolved: 0, remaining: 0 };
    if (firstSessionToday) try { bridgeUrls = await resolveBridgeUrls(BRIDGE_URL_RESOLVE_PER_RUN); }
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
    if (GATE_HELD && status === 'ok' && GATE_HELD.reason !== 'session_break') status = 'degraded';
    if (GATE_HELD) await scheduleGateResume();
    await log('info', 'run:done', {
      version: EXT_VERSION,
      found: foundTotal, saved: savedTotal, listed: listedTotal,
      bridges: bridgesDone, pagesLeft: pageBudget.left,
      skippedNotConnected: notConnected.length,
      manualBridgesResolved: manualStats.resolved, manualBridgesPending: Math.max(0, manualStats.pending - manualStats.resolved),
      bridgeUrlsResolved: bridgeUrls.resolved, bridgeUrlsMissing: bridgeUrls.remaining,
      bridgesListed: bridgesListed,
      urlsBackfilled: urlBackfill.resolved, urlsMissing: urlBackfill.remaining,
      bridgesInvited: (bridgePush && (bridgePush.sent || 0)) || 0,
      errors: RUN_ERRORS, listCooling: listCooling,
      gateHeld: GATE_HELD ? GATE_HELD.reason : null,
      session: DAY.sessions, dayPages: DAY.pages, dayCap: DAY_PAGE_CAP, bridgesDoneToday: DAY.done.length,
      status: status
    });
    notify('Sync complete', savedTotal + ' new prospects saved (' + foundTotal + ' found), ' + listedTotal + ' added to your Sales Nav list.', status === 'error' ? 'error' : undefined);
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
    if (GATE_HELD) break;
    if (!(await gateTake('profile_view', 'location'))) break;
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
// --- Manual bridges: /in/ URL -> real Sales Nav member urn (v1.14.0) ---
// A bridge typed in by hand from a profile link is stored as urn 'manual:<slug>'. That is not a
// Sales Nav member urn, so no CONNECTION_OF search can ever be built for it: up to 1.13.0 the run
// logged scrape:invalid-urn, the hub switched the bridge off, and a person the user explicitly
// asked for collected NOTHING, forever. (2026-09-23: Serge Saxonov, added by Amos Lee.)
// Now, before collection, every manual bridge is resolved in two API calls from a Sales Nav tab:
//   1. voyager identity: /in/<slug> -> urn:li:fsd_profile:ACoAA...   (LinkedIn member id)
//   2. salesApiProfiles(profileId:ACoAA...) -> urn:li:fs_salesProfile:(ACwAA...,…)  (Sales Nav id)
// and the hub swaps the urn in place (setBridgeUrn), switches the bridge ON and records the degree.
// No page loads, no profile views. Unresolved ones stay manual and are retried next run.
const MANUAL_BRIDGE_RESOLVE_PER_RUN = 10;

function slugFromProfileUrl(u) {
  const m = String(u || '').split('?')[0].match(/linkedin\.com\/in\/([^\/#]+)/i);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

// Injected into an authenticated linkedin.com tab.
async function resolveManualBridgesInPage(items) {
  const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1];
  if (!csrf) return { error: 'no JSESSIONID cookie', out: [] };
  const H = { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' };
  const pause = function () { return new Promise(function (r) { setTimeout(r, 600 + Math.floor(Math.random() * 600)); }); };
  // Find the fsd_profile urn that belongs to THIS slug (never the viewer's own profile).
  const findMember = function (obj, slug) {
    let hit = '';
    const want = String(slug).toLowerCase();
    const walk = function (o) {
      if (hit || !o || typeof o !== 'object') return;
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      const pid = String(o.publicIdentifier || '').toLowerCase();
      const urn = String(o.entityUrn || o['*profile'] || '');
      if (pid && pid === want) {
        const m = urn.match(/fsd_profile:(ACoA[\w-]+)/) || JSON.stringify(o).match(/fsd_profile:(ACoA[\w-]+)/);
        if (m) { hit = m[1]; return; }
      }
      for (const k in o) walk(o[k]);
    };
    walk(obj);
    return hit;
  };
  const out = [];
  for (const it of items) {
    const row = { old_urn: it.urn, slug: it.slug, member: '', urn: '', name: '', title: '', degree: null, step: '', status: 0 };
    try {
      // 1. slug -> LinkedIn member id (ACoAA…)
      const r1 = await fetch('/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=' + encodeURIComponent(it.slug), { credentials: 'include', headers: H });
      row.status = r1.status;
      if (r1.status === 401 || r1.status === 403 || r1.status === 429) { row.step = 'voyager'; row.stop = true; out.push(row); break; }
      if (r1.ok) { try { row.member = findMember(JSON.parse(await r1.text()), it.slug); } catch (e) {} }
      if (!row.member) {
        // Fallback: the old identity endpoint keyed directly by slug.
        const r1b = await fetch('/voyager/api/identity/profiles/' + encodeURIComponent(it.slug), { credentials: 'include', headers: H });
        if (r1b.ok) { const t = await r1b.text(); const m = t.match(/fs(?:d)?_profile:(ACoA[\w-]+)/); if (m) row.member = m[1]; }
      }
      if (!row.member) { row.step = 'no-member-id'; out.push(row); await pause(); continue; }
      await pause();
      // 2. member id -> Sales Nav member urn (ACwAA…), plus name / headline / degree.
      const u = '/sales-api/salesApiProfiles/(profileId:' + row.member + ',authType:NAME_SEARCH,authToken:undefined)' +
                '?decoration=%28entityUrn%2CobjectUrn%2CfullName%2Cheadline%2Cdegree%29';
      const r2 = await fetch(u, { credentials: 'include', headers: H });
      row.status = r2.status;
      if (r2.status === 401 || r2.status === 403 || r2.status === 429) { row.step = 'salesapi'; row.stop = true; out.push(row); break; }
      const t2 = await r2.text();
      const m2 = t2.match(/fs_salesProfile:\((ACwA[\w-]+)/) || t2.match(/(ACwA[\w-]{20,})/);
      if (m2) row.urn = m2[1];
      try { const j = JSON.parse(t2); row.name = j.fullName || ''; row.title = j.headline || ''; row.degree = (typeof j.degree !== 'undefined') ? j.degree : null; } catch (e) {}
      row.step = row.urn ? 'ok' : 'no-salesnav-urn';
    } catch (e) { row.step = 'error'; row.error = String(e).slice(0, 80); }
    out.push(row);
    await pause();
  }
  return { out: out };
}

function degreeLabel(d) {
  const n = Number(d);
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return '';
}

async function resolveManualBridges(cap) {
  const stats = { pending: 0, resolved: 0, unresolved: 0 };
  let all = [];
  try { all = await getBridges(); } catch (e) { return stats; }
  const todo = (all || [])
    .filter(b => /^manual:/i.test(String(b.urn || '')) && slugFromProfileUrl(b.linkedin_url))
    .map(b => ({ urn: b.urn, slug: slugFromProfileUrl(b.linkedin_url), name: b.name || '' }));
  stats.pending = todo.length;
  if (!todo.length) return stats;
  if (GATE_HELD) { await log('info', 'manual-bridge:skip', { reason: 'gate held', pending: todo.length }); return stats; }
  const batch = todo.slice(0, cap || MANUAL_BRIDGE_RESOLVE_PER_RUN);
  await log('info', 'manual-bridge:resolve-start', { count: batch.length, pending: todo.length, who: batch.map(b => b.name).slice(0, 10) });
  const tab = await openScrapeTab('https://www.linkedin.com/sales/homepage');
  if (!tab) { await log('warn', 'manual-bridge:no-tab', { wanted: batch.length }); return stats; }
  try {
    await waitForTabComplete(tab.id, 45000);
    await sleep(3000);
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: resolveManualBridgesInPage, args: [batch] });
    const payload = (res && res[0]) ? res[0].result : null;
    if (payload && payload.error) await log('warn', 'manual-bridge:page-error', { error: payload.error });
    for (const row of ((payload && payload.out) || [])) {
      if (row.stop) { await log('warn', 'manual-bridge:refused', { step: row.step, status: row.status }); break; }
      if (!row.urn) {
        stats.unresolved++;
        await log('warn', 'manual-bridge:unresolved', { slug: row.slug, step: row.step, status: row.status });
        continue;
      }
      const body = { secret: INGEST_SECRET, action: 'setBridgeUrn', old_urn: row.old_urn, urn: row.urn,
                     name: row.name || '', title: row.title || '', connection: degreeLabel(row.degree) };
      if (CURRENT_OWNER) body.owner = CURRENT_OWNER;
      try {
        const resp = await fetch(WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await resp.json().catch(() => null);
        if (resp.ok && d && d.ok) { stats.resolved++; await log('info', 'manual-bridge:resolved', { slug: row.slug, name: row.name, degree: body.connection || 'unknown', merged: !!d.merged }); }
        else { stats.unresolved++; await log('warn', 'manual-bridge:save-failed', { slug: row.slug, status: resp.status, error: d && d.error }); }
      } catch (e) { stats.unresolved++; await log('warn', 'manual-bridge:save-failed', { slug: row.slug, error: String(e) }); }
    }
  } catch (e) {
    await log('warn', 'manual-bridge:error', { error: String(e) });
  } finally {
    try { chrome.tabs.remove(tab.id); } catch (e) {}
  }
  if (stats.resolved) notify('Bridges ready', stats.resolved + ' bridge(s) you added by hand are now searchable — prospects will be collected in this run.');
  return stats;
}

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
  const processed = [];
  for (const src of byPriority(sources, s => s.priority)) {
    const orgId = (src.org_id || '').toString().trim();
    if (!orgId) { continue; }
    if (GATE_HELD) break;
    if (!(await gateTake('bridge_discovery', src.name))) break;
    processed.push(src.name);
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
  await log('info', 'discover:done', { totalCandidates, held: !!GATE_HELD });
  return { status: GATE_HELD ? 'held' : 'ok', totalCandidates, processed };
}

// --- Dedicated background scrape window ---
// 1.15.0: the window is created MINIMIZED, so collection is invisible. A minimized window does
// not paint, and Sales Nav's virtualized result list only renders while painted - so results are
// read from Sales Nav's own search API responses instead (capture.js, MAIN world, document_start).
// Only if that read comes back empty is the window restored (never focused) for that one page and
// the DOM scroll-extractor used, exactly as before 1.15.0. Three misses in a row switch this
// browser to 'visible' mode for 3 days, then it retries hidden automatically.
let scrapeWindowId = null;
let SCRAPE_MODE = null;
async function getScrapeMode() {
  if (SCRAPE_MODE) return SCRAPE_MODE;
  let m = null;
  try { m = (await chrome.storage.local.get(SCRAPE_MODE_KEY))[SCRAPE_MODE_KEY] || null; } catch (e) {}
  if (!m || (m.mode === 'visible' && Date.now() - new Date(m.since || 0).getTime() > 3 * 86400000)) m = { mode: 'hidden', misses: 0, since: new Date().toISOString() };
  SCRAPE_MODE = m;
  return m;
}
async function noteCapture(ok, domCount) {
  const m = await getScrapeMode();
  if (ok) m.misses = 0;
  else if (domCount > 0) {
    m.misses = (m.misses || 0) + 1;
    if (m.misses >= 3 && m.mode === 'hidden') { m.mode = 'visible'; m.since = new Date().toISOString(); await log('warn', 'scrape-mode:visible', { reason: 'capture missed 3 pages in a row - showing the window (unfocused) for 3 days' }); }
  }
  SCRAPE_MODE = m;
  try { await chrome.storage.local.set({ [SCRAPE_MODE_KEY]: m }); } catch (e) {}
}
async function ensureCaptureScript() {
  try {
    const ex = await chrome.scripting.getRegisteredContentScripts({ ids: ['radar-capture'] });
    if (ex && ex.length) return true;
    await chrome.scripting.registerContentScripts([{ id: 'radar-capture', matches: ['https://www.linkedin.com/sales/search/*'], js: ['capture.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true }]);
    await log('info', 'capture:registered');
    return true;
  } catch (e) { await log('warn', 'capture:register-failed', { error: String(e) }); return false; }
}

async function getScrapeWindow() {
  if (scrapeWindowId !== null) {
    try { await chrome.windows.get(scrapeWindowId); return scrapeWindowId; }
    catch (e) { scrapeWindowId = null; }
  }
  const mode = await getScrapeMode();
  // Chrome rejects bounds that are not at least 50% on screen, so the old "off-screen" trick is
  // gone for good. Minimized is the invisible option; unfocused-normal is the fallback.
  const attempts = [];
  if (mode.mode === 'hidden') attempts.push({ focused: false, state: 'minimized' });
  attempts.push({ focused: false, state: 'normal', width: 1280, height: 900, top: 0, left: 0 });
  attempts.push({ focused: false, state: 'normal' });
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const win = await chrome.windows.create(attempts[i]);
      scrapeWindowId = win.id;
      await log('info', 'scrape-window:open', { state: attempts[i].state, mode: mode.mode });
      return scrapeWindowId;
    } catch (e) { lastErr = e; }
  }
  scrapeWindowId = null;
  await log('error', 'scrape-window:create-failed', { error: String(lastErr) });
  return scrapeWindowId;
}
async function hideScrapeWindow() {
  if (scrapeWindowId === null) return;
  const mode = await getScrapeMode();
  if (mode.mode !== 'hidden') return;
  try { await chrome.windows.update(scrapeWindowId, { state: 'minimized' }); } catch (e) {}
}
async function showScrapeWindowUnfocused() {
  if (scrapeWindowId === null) return;
  try { await chrome.windows.update(scrapeWindowId, { state: 'normal', focused: false }); } catch (e) {}
}

// Open a URL as the active tab of the scrape window (active so it loads like a real visit).
async function openScrapeTab(url) {
  const winId = await getScrapeWindow();
  if (winId === null) return null;
  try {
    const tab = await chrome.tabs.create({ windowId: winId, url, active: true });
    await hideScrapeWindow();   // a new tab can restore a minimized window on some platforms
    return tab;
  } catch (e) {
    return null;
  }
}

async function closeScrapeWindow() {
  if (scrapeWindowId !== null) {
    try { await chrome.windows.remove(scrapeWindowId); } catch (e) {}
    scrapeWindowId = null;
  }
}

// Read what capture.js kept from the page's own search API calls.
async function readCapturedSearch(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId: tabId }, world: 'MAIN', func: () => { const c = window.__radarCap; return c ? c.items.map(i => i.t) : null; } });
    return (r && r[0] && r[0].result) || null;
  } catch (e) { return null; }
}
// Parse Sales Nav search API JSON (plain or normalized) into profiles, keyed by member urn.
function parseSearchProfiles(texts) {
  const out = new Map();
  const degOf = d => (d === 1 || d === '1' || d === 'FIRST' || d === 'DISTANCE_1') ? '1st' : (d === 2 || d === '2' || d === 'SECOND' || d === 'DISTANCE_2') ? '2nd' : (d === 3 || d === '3' || d === 'THIRD' || d === 'DISTANCE_3') ? '3rd' : '';
  (texts || []).forEach(t => {
    let j = null; try { j = JSON.parse(t); } catch (e) { return; }
    const pool = [];
    const add = a => { if (Array.isArray(a)) a.forEach(x => pool.push(x)); };
    if (j) { add(j.elements); add(j.included); if (j.data) add(j.data.elements); }
    pool.forEach(e => {
      if (!e || typeof e !== 'object') return;
      const urn = String(e.entityUrn || e.objectUrn || '');
      const m = urn.match(/fs_salesProfile:\((ACwAA[^,)]+)/);
      if (!m || out.has(m[1])) return;
      const pos = (Array.isArray(e.currentPositions) && e.currentPositions[0]) || (Array.isArray(e.positions) && e.positions[0]) || {};
      const first = e.firstName || '', last = e.lastName || '';
      const full = (e.fullName || [first, last].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
      if (!full) return;
      out.set(m[1], { urn: m[1], first: first, last: last, full: full, title: String(pos.title || '').slice(0, 200), company: String(pos.companyName || ''), location: String(e.geoRegion || ''), degree: degOf(e.degree) });
    });
  });
  return Array.from(out.values());
}
// Load a search page in the scrape window and return its profiles WITHOUT showing it.
// Returns { profiles, challenged, tab }. profiles === null means the capture did not work.
async function loadSearchHidden(url) {
  const tab = await openScrapeTab(url);
  if (!tab) throw new Error('scrape window/tab unavailable');
  let profiles = null, via = '', refetchOk = true, lastErr = '';
  for (let i = 0; i < 16; i++) {
    await sleep(i === 0 ? 4000 : 1500);
    let cur = null; try { cur = await chrome.tabs.get(tab.id); } catch (e) {}
    if (cur && isChallengeUrl(cur.url)) return { profiles: null, challenged: true, tab: tab };
    const texts = await readCapturedSearch(tab.id);
    if (texts && texts.length) {
      const p = parseSearchProfiles(texts);
      if (p.length) { profiles = p; via = 'capture'; await sleep(1500); const more = parseSearchProfiles((await readCapturedSearch(tab.id)) || []); if (more.length > p.length) profiles = more; break; }
    }
    // 1.16.0: capture missed it - re-issue the page's own search request once it has been made.
    if (refetchOk && i >= 1) {
      const rf = await refetchSearch(tab.id);
      if (rf && rf.text) {
        const p = parseSearchProfiles([rf.text]);
        if (p.length) { profiles = p; via = 'api'; break; }
        refetchOk = false; lastErr = 'api-empty';
      } else if (rf && rf.err && rf.err !== 'no-entry') { refetchOk = false; lastErr = rf.err; }
    }
  }
  if (!profiles && lastErr) await log('warn', 'scrape:api-refetch-failed', { error: lastErr });
  return { profiles: profiles, challenged: false, tab: tab, via: via };
}
async function onChallenge(where) {
  await setLiHold(LI_CHALLENGE_HOLD_MS, 'LinkedIn showed a check page on ' + where);
  GATE_HELD = { action: 'linkedin', reason: 'linkedin_challenge', retry_after_seconds: 12 * 3600, context: where };
  notify('Radar paused 24h', 'LinkedIn asked for a verification. Radar stopped all collection for 24 hours to protect the account.', 'error');
}
function closeTabLater(tab) { setTimeout(() => { try { chrome.tabs.remove(tab.id); } catch (e) {} }, 3500 + Math.floor(Math.random() * 5000)); }
function runExtractor(tab, func, args) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: func, args: args || [] }, results => {
      const out = (results && results[0]) ? (results[0].result || []) : [];
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      resolve(out);
    });
  });
}

// Discovery search: hidden capture first, visible DOM extraction as the fallback.
async function scrapeDiscoveryInTab(url) {
  const r = await loadSearchHidden(url);
  if (r.challenged) { await onChallenge('discovery'); closeTabLater(r.tab); return []; }
  if (r.profiles && r.profiles.length) {
    await noteCapture(true, 0);
    await log('info', 'scrape:capture', { kind: 'discovery', count: r.profiles.length, visible: false });
    closeTabLater(r.tab);
    return r.profiles.map(p => ({ name: cleanPersonName(p.full), title: p.title, urn: p.urn, linkedin_url: '', connection: p.degree }));
  }
  await showScrapeWindowUnfocused();
  await sleep(2500);
  let out = [];
  try { out = await runExtractor(r.tab, extractCandidatesFromPage); } finally { closeTabLater(r.tab); await hideScrapeWindow(); }
  (out || []).forEach(b => { b.name = cleanPersonName(b.name); if (b.title && CTA_RE.test(b.title)) b.title = ''; });
  await noteCapture(false, out.length);
  await log('info', 'scrape:capture', { kind: 'discovery', count: out.length, visible: true });
  return out;
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
    // 1.16.0: translated status suffixes ("ist erreichbar", "est joignable", ...)
    s = s.replace(/\s+(?:ist|war|est|était|está|è|is nu|jest|är)\s+(?:erreichbar|joignable|disponible|raggiungibile|bereikbaar|osiągalny|nåbar|zuletzt aktiv|online)\b.*$/i, '');
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
        const name = a11y ? cleanName((a11y.textContent || '').replace(/^\s*(?:Add|Hinzufügen|Ajouter|Añadir|Agregar|Aggiungi|Adicionar|Toevoegen|Dodaj)\s+/i, '').replace(/\s+(?:to selection|zur Auswahl hinzufügen|zur Auswahl|à la sélection|a la selección|alla selezione|à seleção|aan selectie(?: toevoegen)?|do zaznaczenia)\s*$/i, '')) : '';
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


// ---- 1.16.0 - per-account ICP --------------------------------------------------------------
// The account's ICP is the Sales Navigator search URL it saved in Settings (config key
// salesnav_search_template). We lift its filters:List(...) items as-is (they are already in
// Sales Nav's own query syntax), drop the two that conflict with a bridge search
// (CONNECTION_OF - we add our own - and RELATIONSHIP), and append CONNECTION_OF <bridge>.
// No template -> the legacy default, so existing accounts keep working unchanged.
const LEGACY_ICP_FILTERS = '(type:SENIORITY_LEVEL,values:List((id:320,text:Owner%20%2F%20Partner,selectionType:INCLUDED),(id:310,text:CXO,selectionType:INCLUDED))),(type:COMPANY_HEADCOUNT,values:List((id:C,text:11-50,selectionType:INCLUDED))),(type:REGION,values:List((id:100506914,text:Europe,selectionType:INCLUDED)))';
const ICP_TTL_MS = 10 * 60 * 1000;
let ICP_CACHE = null;
function splitTopLevel(inner) {
  const items = []; let d = 0, st = -1;
  for (let j = 0; j < inner.length; j++) {
    const ch = inner[j];
    if (ch === '(') { if (d === 0) st = j; d++; }
    else if (ch === ')') { d--; if (d === 0 && st >= 0) { items.push(inner.slice(st, j + 1)); st = -1; } }
  }
  return items;
}
function icpFiltersFromTemplate(tpl) {
  if (!tpl) return null;
  let q = '';
  try { q = new URL(String(tpl).trim()).searchParams.get('query') || ''; } catch (e) { return null; }
  const key = 'filters:List(';
  const k = q.indexOf(key);
  if (k < 0) return null;
  let i = k + key.length, depth = 1; const start = i;
  for (; i < q.length && depth > 0; i++) { if (q[i] === '(') depth++; else if (q[i] === ')') depth--; }
  if (depth !== 0) return null;
  const items = splitTopLevel(q.slice(start, i - 1));
  const DROP = /^\(type:(CONNECTION_OF|RELATIONSHIP)\b/;
  const kept = items.filter(x => /^\(type:[A-Z_]+/.test(x) && !DROP.test(x));
  // An ICP must target something - a template made only of exclusions is not an ICP.
  const targeting = kept.filter(x => !/^\(type:(LEAD_LIST|LEAD_INTERACTIONS|ACCOUNT_LIST|PERSONA)\b/.test(x) || /selectionType:INCLUDED/.test(x));
  if (!targeting.length) return null;
  const km = q.match(/(?:^\(|,)keywords:([^,()]+)/);
  return {
    filters: kept.join(','),
    keywords: km ? km[1] : '',
    kept: kept.map(x => (x.match(/^\(type:([A-Z_]+)/) || [])[1]),
    dropped: items.length - kept.length,
    hasInteractions: kept.some(x => /^\(type:LEAD_INTERACTIONS\b/.test(x))
  };
}
async function loadIcpFilters(force) {
  if (!force && ICP_CACHE && (Date.now() - ICP_CACHE.at) < ICP_TTL_MS) return ICP_CACHE;
  let tpl = '';
  try { const c = await fetchHubJsonp('getConfig'); tpl = (c && c.salesnav_search_template) || ''; } catch (e) {}
  const parsed = icpFiltersFromTemplate(tpl);
  ICP_CACHE = parsed
    ? Object.assign({ source: 'account', at: Date.now() }, parsed)
    : { source: tpl ? 'default (template unreadable)' : 'default (no template)', filters: LEGACY_ICP_FILTERS, keywords: '', kept: ['SENIORITY_LEVEL', 'COMPANY_HEADCOUNT', 'REGION'], dropped: 0, hasInteractions: false, at: Date.now() };
  return ICP_CACHE;
}
function buildBridgeQuery(icp, urn, encodedName) {
  const parts = [icp.filters, '(type:CONNECTION_OF,values:List((id:' + urn + ',text:' + encodedName + ',selectionType:INCLUDED)))'];
  if (!icp.hasInteractions) parts.push('(type:LEAD_INTERACTIONS,values:List((id:LIMP,text:Messaged,selectionType:EXCLUDED)))');
  return '(' + (icp.keywords ? 'keywords:' + icp.keywords + ',' : '') + 'filters:List(' + parts.join(',') + '))';
}

// ---- 1.16.0 - language-proof names and titles ----------------------------------------------
// LinkedIn's screen-reader labels and call-to-action copy are translated. The DOM fallback only
// knew the English ones, so on a German Sales Nav every name came back as "X zur Auswahl
// hinzufügen" and every "title" as "Speichern Sie diesen Lead in Ihrer Liste...".
const A11Y_PREFIX_RE = /^\s*(?:Add|Hinzufügen|Ajouter|Añadir|Agregar|Aggiungi|Adicionar|Toevoegen|Dodaj|Lägg till|Tilføj|Legg til)\s+/i;
const A11Y_SUFFIX_RE = /\s+(?:to selection|zur Auswahl hinzufügen|zur Auswahl|à la sélection|a la selección|alla selezione|à seleção|aan selectie(?: toevoegen)?|do zaznaczenia|till urval)\s*$/i;
const STATUS_TAIL_RE = /\s+(?:is|was|ist|war|est|était|está|estaba|è|era|is nu|jest|är)\s+(?:reachable|erreichbar|joignable|disponible|raggiungibile|bereikbaar|osiągalny|nåbar|last active|zuletzt aktiv|online|hiring|open to work)\b.*$/i;
const CTA_RE = /save this lead|get alerts|speichern sie diesen lead|erhalten dann aktuelle|enregistrez ce lead|guarde este lead|guarda este lead|salva questo lead|sla deze lead op|zapisz tego leada|inmail|zur auswahl|to selection|premium|sales navigator/i;
function cleanPersonName(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  s = s.replace(A11Y_PREFIX_RE, '').replace(A11Y_SUFFIX_RE, '').replace(STATUS_TAIL_RE, '').trim();
  return s;
}
// Titles that are UI chrome: translated CTAs, or the same string repeated across a page's cards.
function sanitizeDomLeads(leads) {
  const counts = new Map();
  (leads || []).forEach(l => { const t = String(l.title || '').trim(); if (t) counts.set(t, (counts.get(t) || 0) + 1); });
  (leads || []).forEach(l => {
    const t = String(l.title || '').trim();
    if (t && (CTA_RE.test(t) || (counts.get(t) || 0) >= 3)) l.title = '';
    if (l.first_name || l.last_name) {
      const full = cleanPersonName([l.first_name, l.last_name].filter(Boolean).join(' '));
      const parts = full.split(' ');
      l.first_name = parts[0] || ''; l.last_name = parts.slice(1).join(' ');
    }
    const c = String(l.country || '');
    if (/^(?:PhD|Ph\.?D\.?|MBA|EMBA|LL\.?M\.?|MD|CEO|CTO|COO|CBO|Founder|Co-?founder|Gründer|Partner|Director)\b/i.test(c) || c.length > 40) { l.country = ''; l.city = ''; l.location = ''; }
  });
  return leads;
}

// ---- 1.16.0 - read results from Sales Nav's own search API ---------------------------------
// capture.js (1.15.0) never caught the search response on real accounts (every page logged
// scrape:capture-fallback), so all data came from the rendered cards. Instead, re-issue the
// exact salesApiLeadSearch request the page itself just made (same query, same page, same
// decoration) from inside the page, and parse the JSON - title, company and location come back
// as data, identical in every UI language.
async function refetchLeadSearchInPage() {
  try {
    const ents = performance.getEntriesByType('resource').filter(e => /\/sales-api\/salesApiLeadSearch/.test(e.name));
    if (!ents.length) return { err: 'no-entry' };
    const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1];
    if (!csrf) return { err: 'no-csrf' };
    const r = await fetch(ents[ents.length - 1].name, { credentials: 'include', headers: { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' } });
    if (!r.ok) return { err: 'status-' + r.status };
    return { text: await r.text() };
  } catch (e) { return { err: String(e).slice(0, 120) }; }
}
async function refetchSearch(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId: tabId }, world: 'MAIN', func: refetchLeadSearchInPage });
    return (r && r[0] && r[0].result) || { err: 'no-result' };
  } catch (e) { return { err: String(e).slice(0, 120) }; }
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
  // 1.16.0: the search is built from THIS ACCOUNT's ICP (Settings -> Sales Nav search template),
  // not from a hard-coded profile. Up to 1.15.0 every account searched Owner/CXO at 11-50 people
  // companies in EUROPE - Gershon's own ICP - whatever ICP the user had entered (2026-10-09:
  // 0 of David Liese's 2,378 prospects matched his US pharma/chemical R&D ICP).
  const icp = await loadIcpFilters();
  const query = buildBridgeQuery(icp, urn, name);
  if (!scrapeBridge.__logged) { scrapeBridge.__logged = true; await log('info', 'icp:search', { source: icp.source, filters: icp.kept || [], dropped: icp.dropped || 0 }); }
  const baseUrl = 'https://www.linkedin.com/sales/search/people?query=' + encodeURIComponent(query);
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (budget.left <= 0) { await log('info', 'scrape:page-budget', { bridge: bridge.bridge, stoppedAtPage: page }); break; }
    if (!(await gateTake('salesnav_search_page', bridge.bridge + ' p' + page))) break;
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
    if (GATE_HELD) break;
    await humanPageGap();
  }
  // Search cards frequently omit location. For anyone still missing a country, open their
  // lead page once to read it, then derive the language. Runs in the worker (not injected),
  // caps its own lookups, and closes every tab it opens.
  try { await enrichLocations(leads); } catch (e) { await log('warn', 'location-enrich:failed', { error: String(e) }); }
  return leads;
}

async function scrapePageInTab(url, bridge) {
  const r = await loadSearchHidden(url);
  if (r.challenged) { await onChallenge('bridge ' + bridge.bridge); closeTabLater(r.tab); return []; }
  if (r.profiles && r.profiles.length) {
    await noteCapture(true, 0);
    if (r.via) await log('info', 'scrape:data', { via: r.via, count: r.profiles.length, withTitle: r.profiles.filter(p => p.title).length });
    closeTabLater(r.tab);
    const now = new Date().toISOString();
    return r.profiles.map(p => {
      let country = '', city = '';
      if (p.location.indexOf(',') !== -1) { const segs = p.location.split(',').map(x => x.trim()).filter(Boolean); if (segs.length) { city = segs[0]; country = segs[segs.length - 1]; } }
      const parts = p.full.split(' ');
      return {
        first_name: p.first || parts[0] || '', last_name: p.last || parts.slice(1).join(' ') || '',
        title: p.title, company: p.company, connection: p.degree, location: p.location, country: country, city: city,
        language: '', radar_person: bridge.bridge, source: bridge.source || '', lead_id: p.urn, collected_date: now, linkedin_url: ''
      };
    });
  }
  // Fallback: show the window (unfocused) for this page only and read the rendered cards.
  await showScrapeWindowUnfocused();
  await sleep(2500);
  let out = [];
  try { out = await runExtractor(r.tab, extractLeadsFromPage, [bridge.bridge, bridge.category, bridge.source]); }
  finally { closeTabLater(r.tab); await hideScrapeWindow(); }
  await noteCapture(false, out.length);
  sanitizeDomLeads(out);
  if (out.length) await log('info', 'scrape:capture-fallback', { bridge: bridge.bridge, dom: out.length });
  return out;
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
    // 1.16.0: translated status suffixes ("ist erreichbar", "est joignable", ...)
    s = s.replace(/\s+(?:ist|war|est|était|está|è|is nu|jest|är)\s+(?:erreichbar|joignable|disponible|raggiungibile|bereikbaar|osiągalny|nåbar|zuletzt aktiv|online)\b.*$/i, '');
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
        const name = a11y ? cleanName((a11y.textContent || '').replace(/^\s*(?:Add|Hinzufügen|Ajouter|Añadir|Agregar|Aggiungi|Adicionar|Toevoegen|Dodaj)\s+/i, '').replace(/\s+(?:to selection|zur Auswahl hinzufügen|zur Auswahl|à la sélection|a la selección|alla selezione|à seleção|aan selectie(?: toevoegen)?|do zaznaczenia)\s*$/i, '')) : '';
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
          if (/save this lead|get alerts|save to list|add to list|change jobs, post|speichern sie|erhalten dann|enregistrez|guarde este|guarda este|salva questo|sla deze|zapisz/i.test(tl)) continue;
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

// --- Public /in/ URL backfill -------------------------------------------------------------
// THE BUG THIS FIXES (2026-09-09). Resolution used to happen ONLY in memory, only on the leads of
// the run that scraped them, under a shared MAX_RESOLVE_PER_RUN budget of 400. A run collects
// 1000+. Everything past the budget was posted with a blank linkedin_url and was never looked at
// again by anything - there was no backfill anywhere in the system. The shortfall compounded every
// single day until 2150 of 2676 prospects (80%) had no URL, and since Botdog addresses people BY
// public profile URL, those prospects could never be delivered either. One defect, both symptoms.
// The resolver was never at fault (on 2026-09-09 it was asked for 132 and returned 132); nothing
// ever asked it a second time. This phase is that second ask: it pulls the standing backlog from
// the hub and drains a slice of it on EVERY run, including runs that collect nothing new.
async function backfillTargetUrls(cap) {
  const want = Math.max(0, cap || BACKFILL_URLS_PER_RUN);
  if (!want) return { asked: 0, resolved: 0, remaining: 0 };
  let data = null;
  try {
    data = await fetchHubJsonp('resolvePending', { cap: Math.min(want, 1000) });
  } catch (e) {
    await log('warn', 'backfill:error', { error: String(e) });
    return { asked: 0, resolved: 0, remaining: 0 };
  }
  const ids = (data && data.lead_ids) || [];
  const total = (data && data.pending_total != null) ? data.pending_total : ids.length;
  if (!ids.length) { await log('info', 'backfill:none', { pending_total: total }); return { asked: 0, resolved: 0, remaining: total }; }

  await log('info', 'backfill:start', { asked: ids.length, pending_total: total });
  const map = await resolveUrnsViaApi(ids);
  const urls = [];
  for (const id of ids) {
    const got = map.get(id);
    if (got && got.url) urls.push({ lead_id: id, linkedin_url: got.url, connection: (got.degree != null ? String(got.degree) : '') });
  }
  if (urls.length) {
    try {
      const body = { secret: INGEST_SECRET, action: 'setTargetUrls', urls: urls };
      if (CURRENT_OWNER) body.owner = CURRENT_OWNER;
      const r = await fetch(WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('hub ' + r.status);
    } catch (e) {
      await log('warn', 'backfill:save-error', { error: String(e), resolved: urls.length });
      return { asked: ids.length, resolved: 0, remaining: total };
    }
  }
  const remaining = Math.max(0, total - urls.length);
  await log('info', 'backfill:done', { asked: ids.length, resolved: urls.length, remaining: remaining });
  return { asked: ids.length, resolved: urls.length, remaining: remaining };
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

// v1.17.0 — Source priority (high / medium / low, set per Source in the Radar app).
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
function byPriority(arr, getPrio) {
  const tiers = [[], [], []];
  for (const x of (arr || [])) {
    const r = PRIORITY_RANK[String(getPrio(x) || 'medium').toLowerCase()];
    tiers[r === undefined ? 1 : r].push(x);
  }
  return [].concat(shuffle(tiers[0]), shuffle(tiers[1]), shuffle(tiers[2]));
}
async function sourcePriorityMap() {
  const m = {};
  for (const s of (await getSources())) m[_normName(s.name)] = String(s.priority || 'medium').toLowerCase();
  return m;
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
