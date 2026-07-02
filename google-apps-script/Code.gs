// Radar — Apps Script hub (google-apps-script/Code.gs)
// POST receiver from Chrome extension → writes to Sheet
// GET server (JSONP) → serves data to web app
// Daily report via Resend, daily Botdog push
//
// ─── Multi-user / per-owner data isolation ───────────────────────────────────
// Every read/write is scoped to an `owner` value (LinkedIn OIDC `sub`).
// The `owner` and `secret` are injected server-side by the Cloudflare Pages
// hub proxy (functions/api/hub/[[path]].js) — the browser never supplies them.
//
// Migration: stamp existing rows with Olivier's LinkedIn sub on first login.
// Run migrateOwner('OLIVIER_SUB_HERE') once from the Apps Script editor.
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_ID = '1FeEv-0ZHAvNWKx78OZSDzOBYC-EBZuFO-I-Cswo8GiA';
const SHEET_NAME = 'Untitled';
const RADAR_INGEST_SECRET = PropertiesService.getScriptProperties().getProperty('RADAR_INGEST_SECRET') || 'radar_7Kq3mZ9pX2vL8nT';
const REPORT_DRY_RUN = true;
const BOTDOG_DRY_RUN = true;
const BOTDOG_CAMPAIGN_ID = '343b1a9b-be69-4a09-bc4c-ccedd0d73a8c';
const BOTDOG_BRIDGE_FILTER = 'Elie Cohen';
const MAX_PUSH_PER_RUN = 50;
const REPORT_FROM = 'radar@gershoncrm.com';
const REPORT_TO = 'aina@gershonconsulting.com';

// ─── Auth helper ─────────────────────────────────────────────────────────────
function _auth(payload) {
  // Accept both the legacy hardcoded secret and the new env-var secret for
  // backward compat during transition. The proxy always sends the current secret.
  const valid = [
    RADAR_INGEST_SECRET,
    PropertiesService.getScriptProperties().getProperty('HUB_SECRET')
  ].filter(Boolean);
  return valid.includes(payload.secret);
}

// ─── doGet ───────────────────────────────────────────────────────────────────
function doGet(e) {
  const cb = (e && e.parameter && e.parameter.callback) || 'callback';
  const action = e && e.parameter && e.parameter.action;
  const secret = e && e.parameter && e.parameter.secret;
  const owner = e && e.parameter && e.parameter.owner;

  // Validate secret on all requests
  if (!_auth({ secret })) {
    return _jsonp(cb, { success: false, error: 'unauthorized' });
  }

  if (action === 'getConfig') {
    const props = PropertiesService.getScriptProperties();
    return _jsonp(cb, { success: true, botdog_key_set: !!props.getProperty('BOTDOG_API_KEY'), resend_key_set: !!props.getProperty('RESEND_API_KEY') });
  }

  if (action === 'keyStatus') {
    return _jsonp(cb, _keyStatus());
  }

  if (action === 'getSources') {
    return _jsonp(cb, _getSources(owner));
  }

  if (action === 'getBridges') {
    return _jsonp(cb, _getBridgesData(owner));
  }

  // Default: return leads rows filtered by owner
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return _jsonp(cb, { success: true, service: 'radar-ingest', count: 0, rows: [] });

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const ownerIdx = headers.indexOf('owner');

  const rows = data
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    })
    .filter(row => {
      // If no owner column yet, return all (migration phase)
      if (ownerIdx < 0) return true;
      // Filter by owner — blank rows are visible to all (legacy data before migration)
      return !row.owner || row.owner === owner;
    });

  return _jsonp(cb, { success: true, service: 'radar-ingest', count: rows.length, rows: rows });
}

// ─── doPost ──────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    if (!_auth(payload)) return _json({ success: false, error: 'unauthorized' });

    const owner = payload.owner || '';

    if (payload.action === 'setConfig') {
      const props = PropertiesService.getScriptProperties();
      if (payload.botdog_api_key) props.setProperty('BOTDOG_API_KEY', payload.botdog_api_key);
      if (payload.resend_api_key) props.setProperty('RESEND_API_KEY', payload.resend_api_key);
      return _json({ success: true, action: 'setConfig', saved: true });
    }

    if (payload.action === 'addSource') {
      return _json(_addSource(payload, owner));
    }

    if (payload.action === 'setBridgeActive') {
      return _json(_setBridgeActive(payload, owner));
    }

    if (payload.action === 'deleteBridge') {
      return _json(_deleteBridge(payload, owner));
    }

    // Default: ingest leads from Chrome extension
    const leads = payload.leads || [];
    if (!leads.length) return _json({ success: true, service: 'radar-ingest', written: 0 });

    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const lastRow = sheet.getLastRow();
    const existingIds = new Set();
    if (lastRow >= 2) {
      const ci = _colIndex(sheet, 'lead_id');
      if (ci > 0) sheet.getRange(2, ci, lastRow - 1, 1).getValues().flat().forEach(id => { if (id) existingIds.add(String(id)); });
    }
    if (lastRow === 0) {
      sheet.appendRow(['collected_date','first_name','last_name','title','company','linkedin_url','radar_person','lead_id','botdog_pushed','source','owner']);
    }
    let written = 0;
    leads.forEach(lead => {
      if (existingIds.has(String(lead.lead_id))) return;
      sheet.appendRow([
        lead.collected_date || new Date().toISOString(),
        lead.first_name || '', lead.last_name || '', lead.title || '', lead.company || '',
        lead.linkedin_url || '', lead.radar_person || '', lead.lead_id || '', '',
        lead.source || '', owner
      ]);
      written++;
    });
    return _json({ success: true, service: 'radar-ingest', written: written });
  } catch (err) {
    return _json({ success: false, error: String(err) });
  }
}

// ─── Sources ──────────────────────────────────────────────────────────────────
function _getSources(owner) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName('Sources');
    if (!sheet) return { success: true, sources: [] };
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, sources: [] };
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const ownerIdx = headers.indexOf('owner');
    const sources = data
      .map(row => { const o = {}; headers.forEach((h, i) => { o[h] = row[i]; }); return o; })
      .filter(row => ownerIdx < 0 || !row.owner || row.owner === owner);
    return { success: true, sources };
  } catch(e) { return { success: false, error: String(e) }; }
}

function _addSource(payload, owner) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName('Sources');
    if (!sheet) {
      sheet = ss.insertSheet('Sources');
      sheet.appendRow(['name','linkedin_url','category','created_at','owner']);
    }
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['name','linkedin_url','category','created_at','owner']);
    }
    sheet.appendRow([payload.name || '', payload.linkedin_url || '', payload.category || 'partner', new Date().toISOString(), owner]);
    return { success: true, saved: true };
  } catch(e) { return { success: false, error: String(e) }; }
}

// ─── Bridges ──────────────────────────────────────────────────────────────────
function _getBridgesData(owner) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName('BridgeCandidates');
    if (!sheet) return { success: true, bridges: [] };
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, bridges: [] };
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const ownerIdx = headers.indexOf('owner');
    const bridges = data
      .map(row => { const o = {}; headers.forEach((h, i) => { o[h] = row[i]; }); return o; })
      .filter(row => ownerIdx < 0 || !row.owner || row.owner === owner)
      .map(row => ({
        urn: row.urn || '', name: row.name || '', title: row.title || '',
        source: row.source || '', linkedin_url: row.linkedin_url || '',
        connection: row.connection || '', active: row.active === true || row.active === 'TRUE'
      }));
    return { success: true, bridges };
  } catch(e) { return { success: false, error: String(e) }; }
}

function _setBridgeActive(payload, owner) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName('BridgeCandidates');
    if (!sheet) return { success: false, error: 'No BridgeCandidates sheet' };
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'No rows' };
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const urnIdx = headers.indexOf('urn') + 1;
    const activeIdx = headers.indexOf('active') + 1;
    const ownerIdx = headers.indexOf('owner') + 1;
    if (!urnIdx || !activeIdx) return { success: false, error: 'Missing columns' };
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][urnIdx - 1]) === String(payload.urn)) {
        // Verify owner
        if (ownerIdx && data[i][ownerIdx - 1] && data[i][ownerIdx - 1] !== owner) continue;
        sheet.getRange(i + 2, activeIdx).setValue(payload.active ? true : false);
        return { success: true, saved: true };
      }
    }
    return { success: false, error: 'Not found' };
  } catch(e) { return { success: false, error: String(e) }; }
}

function _deleteBridge(payload, owner) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName('BridgeCandidates');
    if (!sheet) return { success: false, error: 'No BridgeCandidates sheet' };
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'No rows' };
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const urnIdx = headers.indexOf('urn') + 1;
    const ownerIdx = headers.indexOf('owner') + 1;
    if (!urnIdx) return { success: false, error: 'No urn column' };
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    for (let i = data.length - 1; i >= 0; i--) {
      if (String(data[i][urnIdx - 1]) === String(payload.urn)) {
        if (ownerIdx && data[i][ownerIdx - 1] && data[i][ownerIdx - 1] !== owner) continue;
        sheet.deleteRow(i + 2);
        return { success: true, deleted: true };
      }
    }
    return { success: false, error: 'Not found' };
  } catch(e) { return { success: false, error: String(e) }; }
}

// ─── Key status ───────────────────────────────────────────────────────────────
function _keyStatus() {
  const props = PropertiesService.getScriptProperties();
  const botdogKey = props.getProperty('BOTDOG_API_KEY');
  const resendKey = props.getProperty('RESEND_API_KEY');
  const testedAt = props.getProperty('KEY_STATUS_TESTED_AT');
  return {
    success: true,
    botdog_set: !!botdogKey, botdog_valid: !!botdogKey,
    resend_set: !!resendKey, resend_valid: !!resendKey,
    tested_at: testedAt || null
  };
}

// ─── One-time migration ───────────────────────────────────────────────────────
// Run this ONCE from the Apps Script editor after Olivier's first login.
// Pass Olivier's LinkedIn `sub` (shown in /api/me after first sign-in).
function migrateOwner(ownerSub) {
  if (!ownerSub) throw new Error('Pass Olivier\'s LinkedIn sub as argument');
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // Migrate main leads sheet
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (sheet && sheet.getLastRow() >= 2) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    let ownerIdx = headers.indexOf('owner') + 1;
    if (!ownerIdx) {
      sheet.getRange(1, headers.length + 1).setValue('owner');
      ownerIdx = headers.length + 1;
    }
    const lastRow = sheet.getLastRow();
    const ownerCol = sheet.getRange(2, ownerIdx, lastRow - 1, 1).getValues();
    ownerCol.forEach((row, i) => {
      if (!row[0]) sheet.getRange(i + 2, ownerIdx).setValue(ownerSub);
    });
    Logger.log('Migrated ' + (lastRow - 1) + ' lead rows');
  }

  // Migrate Sources sheet
  const srcSheet = ss.getSheetByName('Sources');
  if (srcSheet && srcSheet.getLastRow() >= 2) {
    const headers = srcSheet.getRange(1, 1, 1, srcSheet.getLastColumn()).getValues()[0];
    let ownerIdx = headers.indexOf('owner') + 1;
    if (!ownerIdx) { srcSheet.getRange(1, headers.length + 1).setValue('owner'); ownerIdx = headers.length + 1; }
    const lastRow = srcSheet.getLastRow();
    for (let i = 2; i <= lastRow; i++) {
      if (!srcSheet.getRange(i, ownerIdx).getValue()) srcSheet.getRange(i, ownerIdx).setValue(ownerSub);
    }
    Logger.log('Migrated Sources');
  }

  // Migrate BridgeCandidates sheet
  const bridgeSheet = ss.getSheetByName('BridgeCandidates');
  if (bridgeSheet && bridgeSheet.getLastRow() >= 2) {
    const headers = bridgeSheet.getRange(1, 1, 1, bridgeSheet.getLastColumn()).getValues()[0];
    let ownerIdx = headers.indexOf('owner') + 1;
    if (!ownerIdx) { bridgeSheet.getRange(1, headers.length + 1).setValue('owner'); ownerIdx = headers.length + 1; }
    const lastRow = bridgeSheet.getLastRow();
    for (let i = 2; i <= lastRow; i++) {
      if (!bridgeSheet.getRange(i, ownerIdx).getValue()) bridgeSheet.getRange(i, ownerIdx).setValue(ownerSub);
    }
    Logger.log('Migrated BridgeCandidates');
  }

  Logger.log('Migration complete for owner: ' + ownerSub);
}

// ─── Scheduled jobs ───────────────────────────────────────────────────────────
function sendDailyReport() {
  const key = PropertiesService.getScriptProperties().getProperty('RESEND_API_KEY');
  if (!key) { Logger.log('RESEND_API_KEY not set'); return; }
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const count = Math.max(0, sheet.getLastRow() - 1);
  let newToday = 0;
  if (count > 0) {
    const yesterday = new Date(Date.now() - 86400000);
    sheet.getRange(2, 1, count, 1).getValues().flat().forEach(d => {
      const dt = d instanceof Date ? d : new Date(d);
      if (dt >= yesterday) newToday++;
    });
  }
  if (REPORT_DRY_RUN) { Logger.log('DRY RUN — would email ' + newToday + ' leads to ' + REPORT_TO); return; }
  UrlFetchApp.fetch('https://api.resend.com/emails', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify({ from: REPORT_FROM, to: [REPORT_TO],
      subject: 'Radar daily report — ' + newToday + ' new leads today',
      html: '<h2>Radar Daily Report</h2><p><strong>' + newToday + '</strong> new leads in last 24h. Total: <strong>' + count + '</strong></p><p><a href="https://radar.gershoncrm.com">Open Dashboard</a></p>'
    }), muteHttpExceptions: true
  });
}

function pushToBotdog() {
  const key = PropertiesService.getScriptProperties().getProperty('BOTDOG_API_KEY');
  if (!key) { Logger.log('BOTDOG_API_KEY not set'); return; }
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No leads'); return; }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const liIdx = headers.indexOf('linkedin_url');
  const personIdx = headers.indexOf('radar_person');
  const pushedIdx = headers.indexOf('botdog_pushed');
  const toPush = [];
  data.forEach((row, i) => {
    const li = String(row[liIdx] || '');
    const person = String(row[personIdx] || '');
    const pushed = String(row[pushedIdx] || '');
    if (!li.includes('linkedin.com/in/')) return;
    if (BOTDOG_BRIDGE_FILTER && !person.includes(BOTDOG_BRIDGE_FILTER)) return;
    if (pushed) return;
    toPush.push({ rowIndex: i + 2, linkedinUrl: li });
  });
  if (BOTDOG_DRY_RUN) { Logger.log('DRY RUN — would push ' + toPush.length + ' leads to Botdog'); return; }
  let pushed = 0;
  toPush.slice(0, MAX_PUSH_PER_RUN).forEach(item => {
    const resp = UrlFetchApp.fetch('https://api.botdog.io/v1/campaigns/contacts', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + key },
      payload: JSON.stringify({ campaign_id: BOTDOG_CAMPAIGN_ID, profiles: [{ linkedin_url: item.linkedinUrl }] }),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() < 300) {
      sheet.getRange(item.rowIndex, pushedIdx + 1).setValue(new Date().toISOString());
      pushed++;
    }
    Utilities.sleep(500);
  });
  Logger.log('Pushed ' + pushed + ' leads to Botdog');
}

function installDailyReportTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'sendDailyReport') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendDailyReport').timeBased().everyDays(1).atHour(7).create();
}

function installDailyBotdogTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'pushToBotdog') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('pushToBotdog').timeBased().everyDays(1).atHour(8).create();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _jsonp(cb, obj) {
  return ContentService.createTextOutput(cb + '(' + JSON.stringify(obj) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
}
function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function _colIndex(sheet, name) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].indexOf(name) + 1;
}
