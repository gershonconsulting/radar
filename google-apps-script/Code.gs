// Radar — Apps Script hub (google-apps-script/Code.gs)
// DEPLOYED owner-isolation version (pulled from repo main). This is the correct BASE.
// POST receiver from Chrome extension → writes to Sheet
// GET server (JSONP) → serves data to web app
//
// ─── Multi-user / per-owner data isolation ───────────────────────────────────
// Every read/write is scoped to an `owner` value (LinkedIn OIDC `sub`).
// The `owner` and `secret` are injected server-side by the Cloudflare Pages
// hub proxy (functions/api/hub/[[path]].js) — the browser never supplies them.
// Migration: run migrateOwner('OLIVIER_SUB') once from the Apps Script editor.
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

function _auth(payload) {
  const valid = [
    RADAR_INGEST_SECRET,
    PropertiesService.getScriptProperties().getProperty('HUB_SECRET')
  ].filter(Boolean);
  return valid.includes(payload.secret);
}

function doGet(e) {
  const cb = (e && e.parameter && e.parameter.callback) || 'callback';
  const action = e && e.parameter && e.parameter.action;
  const secret = e && e.parameter && e.parameter.secret;
  const owner = e && e.parameter && e.parameter.owner;

  if (!_auth({ secret })) {
    return _jsonp(cb, { success: false, error: 'unauthorized' });
  }

  if (action === 'getConfig') {
    const props = PropertiesService.getScriptProperties();
    return _jsonp(cb, {
      success: true,
      botdog_key_set: !!props.getProperty('BOTDOG_API_KEY'),
      resend_key_set: !!props.getProperty('RESEND_API_KEY'),
      botdog_campaign_id: props.getProperty('BOTDOG_CAMPAIGN_ID') || BOTDOG_CAMPAIGN_ID,
      botdog_campaign_name: props.getProperty('BOTDOG_CAMPAIGN_NAME') || ''
    });
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
  if (action === 'getBotdogCampaigns') {
    return _jsonp(cb, _getBotdogCampaigns());
  }
  if (action === 'getUsers') {
    return _jsonp(cb, _getUsers());
  }

  // Default: return leads rows filtered by owner
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return _jsonp(cb, { success: true, service: 'radar-ingest', count: 0, rows: [] });

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const ownerIdx = headers.indexOf('owner');

  const rows = data
    .map(row => { const obj = {}; headers.forEach((h, i) => { obj[h] = row[i]; }); return obj; })
    .filter(row => {
      if (ownerIdx < 0) return true;
      return !row.owner || row.owner === owner;
    });

  return _jsonp(cb, { success: true, service: 'radar-ingest', count: rows.length, rows: rows });
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    if (!_auth(payload)) return _json({ success: false, error: 'unauthorized' });

    const owner = payload.owner || '';

    if (payload.action === 'setConfig') {
      const props = PropertiesService.getScriptProperties();
      if (payload.botdog_api_key) props.setProperty('BOTDOG_API_KEY', payload.botdog_api_key);
      if (payload.resend_api_key) props.setProperty('RESEND_API_KEY', payload.resend_api_key);
      if (payload.botdog_campaign_id) props.setProperty('BOTDOG_CAMPAIGN_ID', payload.botdog_campaign_id);
      if (payload.botdog_campaign_name) props.setProperty('BOTDOG_CAMPAIGN_NAME', payload.botdog_campaign_name);
      return _json({ success: true, action: 'setConfig', saved: true });
    }
    if (payload.action === 'addSource') {
      return _json(_addSource(payload, owner));
    }
    if (payload.action === 'deleteSource') {
      return _json(_deleteSource(payload, owner));
    }
    if (payload.action === 'clearDiscoverPending') {
      return _json(_clearDiscoverPending(payload, owner));
    }
    if (payload.action === 'setBridgeActive') {
      return _json(_setBridgeActive(payload, owner));
    }
    if (payload.action === 'deleteBridge') {
      return _json(_deleteBridge(payload, owner));
    }
    if (payload.action === 'upsertUser') {
      return _json(_upsertUser(payload));
    }
    if (payload.action === 'setUserStatus') {
      return _json(_setUserStatus(payload));
    }
    if (payload.action === 'setUserRole') {
      return _json(_setUserRole(payload));
    }
    if (payload.action === 'setUserFlag') {
      return _json(_setUserFlag(payload));
    }
    if (payload.action === 'logLogin') {
      return _json(_logLogin(payload));
    }

    // Default: ingest leads from Chrome extension (header-aware, owner-stamped)
    const leads = payload.leads || [];
    if (!leads.length) return _json({ success: true, service: 'radar-ingest', written: 0 });

    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);

    // Ensure the leads sheet has a header row with all required columns.
    const requiredCols = [
      'collected_date', 'first_name', 'last_name', 'title', 'company',
      'connection', 'language', 'country', 'city', 'linkedin_url',
      'radar_person', 'lead_id', 'botdog_pushed', 'source', 'owner'
    ];
    let headers;
    if (sheet.getLastRow() === 0) {
      headers = requiredCols.slice();
      sheet.appendRow(headers);
    } else {
      headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const missing = requiredCols.filter(c => headers.indexOf(c) < 0);
      if (missing.length) {
        sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
        headers = headers.concat(missing);
      }
    }

    const lastRow = sheet.getLastRow();
    const existingIds = new Set();
    if (lastRow >= 2) {
      const ci = headers.indexOf('lead_id') + 1;
      if (ci > 0) sheet.getRange(2, ci, lastRow - 1, 1).getValues().flat().forEach(id => { if (id) existingIds.add(String(id)); });
    }

    let written = 0;
    leads.forEach(lead => {
      if (existingIds.has(String(lead.lead_id))) return;
      const row = new Array(headers.length).fill('');
      const set = (col, val) => { const i = headers.indexOf(col); if (i >= 0) row[i] = val; };
      set('collected_date', lead.collected_date || new Date().toISOString());
      set('first_name', lead.first_name || '');
      set('last_name', lead.last_name || '');
      set('title', lead.title || '');
      set('company', lead.company || '');
      set('connection', lead.connection || '');
      set('language', lead.language || '');
      set('country', lead.country || '');
      set('city', lead.city || '');
      set('linkedin_url', lead.linkedin_url || '');
      set('radar_person', lead.radar_person || '');
      set('lead_id', lead.lead_id || '');
      set('botdog_pushed', '');
      set('source', lead.source || '');
      set('owner', owner);
      sheet.appendRow(row);
      existingIds.add(String(lead.lead_id));
      written++;
    });
    return _json({ success: true, service: 'radar-ingest', written: written });
  } catch (err) {
    return _json({ success: false, error: String(err) });
  }
}

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
    const requiredCols = [
      'name', 'linkedin_url', 'category', 'created_at',
      'org_id', 'discover_keyword', 'discover_pending', 'owner'
    ];
    if (!sheet) {
      sheet = ss.insertSheet('Sources');
      sheet.appendRow(requiredCols.slice());
    }
    // Ensure header row exists with all required columns (order-agnostic).
    let headers;
    if (sheet.getLastRow() === 0) {
      headers = requiredCols.slice();
      sheet.appendRow(headers);
    } else {
      headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const missing = requiredCols.filter(c => headers.indexOf(c) < 0);
      if (missing.length) {
        sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
        headers = headers.concat(missing);
      }
    }

    const nameIdx = headers.indexOf('name');
    const ownerIdx = headers.indexOf('owner');
    const discoverPending = payload.discover_now ? 'yes' : '';

    // Build a full row from the header layout.
    const buildRow = (existing) => {
      const row = existing ? existing.slice() : new Array(headers.length).fill('');
      const set = (col, val) => { const i = headers.indexOf(col); if (i >= 0) row[i] = val; };
      set('name', payload.name || '');
      set('linkedin_url', payload.linkedin_url || '');
      set('category', payload.category || 'partner');
      if (!existing) set('created_at', new Date().toISOString());
      set('org_id', payload.org_id || '');
      set('discover_keyword', payload.discover_keyword || '');
      set('discover_pending', discoverPending);
      if (!existing) set('owner', owner);
      return row;
    };

    // UPSERT by name + owner (blank owner or matching owner).
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
      for (let i = 0; i < data.length; i++) {
        const rowName = String(data[i][nameIdx] || '');
        const rowOwner = ownerIdx >= 0 ? data[i][ownerIdx] : '';
        if (rowName === String(payload.name || '') && (!rowOwner || rowOwner === owner)) {
          const updated = buildRow(data[i]);
          sheet.getRange(i + 2, 1, 1, headers.length).setValues([updated]);
          return { success: true, saved: true, updated: true };
        }
      }
    }
    sheet.appendRow(buildRow(null));
    return { success: true, saved: true };
  } catch(e) { return { success: false, error: String(e) }; }
}

function _deleteSource(payload, owner) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName('Sources');
    if (!sheet) return { success: false, error: 'No Sources sheet' };
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, deleted: 0 };
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const nameIdx = headers.indexOf('name');
    const ownerIdx = headers.indexOf('owner');
    if (nameIdx < 0) return { success: false, error: 'No name column' };
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    let deleted = 0;
    for (let i = data.length - 1; i >= 0; i--) {
      if (String(data[i][nameIdx] || '') === String(payload.name || '')) {
        const rowOwner = ownerIdx >= 0 ? data[i][ownerIdx] : '';
        if (rowOwner && rowOwner !== owner) continue;
        sheet.deleteRow(i + 2);
        deleted++;
      }
    }
    return { success: true, deleted };
  } catch(e) { return { success: false, error: String(e) }; }
}

function _clearDiscoverPending(payload, owner) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName('Sources');
    if (!sheet) return { success: false, error: 'No Sources sheet' };
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, cleared: 0 };
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const nameIdx = headers.indexOf('name');
    const pendingIdx = headers.indexOf('discover_pending');
    const ownerIdx = headers.indexOf('owner');
    if (pendingIdx < 0) return { success: false, error: 'No discover_pending column' };
    const names = Array.isArray(payload.names) ? payload.names.map(String) : [];
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    let cleared = 0;
    for (let i = 0; i < data.length; i++) {
      const rowOwner = ownerIdx >= 0 ? data[i][ownerIdx] : '';
      if (rowOwner && rowOwner !== owner) continue;
      const rowName = String(data[i][nameIdx] || '');
      const matchName = names.length ? names.indexOf(rowName) >= 0 : true;
      if (!matchName) continue;
      // Only clear rows that are actually pending.
      if (!String(data[i][pendingIdx] || '')) continue;
      sheet.getRange(i + 2, pendingIdx + 1).setValue('');
      cleared++;
    }
    return { success: true, cleared };
  } catch(e) { return { success: false, error: String(e) }; }
}

function _getBotdogCampaigns() {
  try {
    const key = PropertiesService.getScriptProperties().getProperty('BOTDOG_API_KEY');
    if (!key) return { success: false, campaigns: [] };
    const resp = UrlFetchApp.fetch('https://api.botdog.io/v1/campaigns', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + key },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) return { success: false, campaigns: [] };
    const parsed = JSON.parse(resp.getContentText());
    const list = Array.isArray(parsed) ? parsed
      : (Array.isArray(parsed.campaigns) ? parsed.campaigns
        : (Array.isArray(parsed.data) ? parsed.data : []));
    const campaigns = list.map(c => ({
      id: c.id || c.campaignId || c._id || '',
      name: c.name || c.title || c.campaignName || ''
    }));
    return { success: true, campaigns };
  } catch(e) { return { success: false, campaigns: [] }; }
}

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

// Run ONCE from the Apps Script editor after Olivier's first login.
function migrateOwner(ownerSub) {
  if (!ownerSub) throw new Error('Pass Olivier\'s LinkedIn sub as argument');
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (sheet && sheet.getLastRow() >= 2) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    let ownerIdx = headers.indexOf('owner') + 1;
    if (!ownerIdx) { sheet.getRange(1, headers.length + 1).setValue('owner'); ownerIdx = headers.length + 1; }
    const lastRow = sheet.getLastRow();
    const ownerCol = sheet.getRange(2, ownerIdx, lastRow - 1, 1).getValues();
    ownerCol.forEach((row, i) => { if (!row[0]) sheet.getRange(i + 2, ownerIdx).setValue(ownerSub); });
  }
  const srcSheet = ss.getSheetByName('Sources');
  if (srcSheet && srcSheet.getLastRow() >= 2) {
    const headers = srcSheet.getRange(1, 1, 1, srcSheet.getLastColumn()).getValues()[0];
    let ownerIdx = headers.indexOf('owner') + 1;
    if (!ownerIdx) { srcSheet.getRange(1, headers.length + 1).setValue('owner'); ownerIdx = headers.length + 1; }
    const lastRow = srcSheet.getLastRow();
    for (let i = 2; i <= lastRow; i++) { if (!srcSheet.getRange(i, ownerIdx).getValue()) srcSheet.getRange(i, ownerIdx).setValue(ownerSub); }
  }
  const bridgeSheet = ss.getSheetByName('BridgeCandidates');
  if (bridgeSheet && bridgeSheet.getLastRow() >= 2) {
    const headers = bridgeSheet.getRange(1, 1, 1, bridgeSheet.getLastColumn()).getValues()[0];
    let ownerIdx = headers.indexOf('owner') + 1;
    if (!ownerIdx) { bridgeSheet.getRange(1, headers.length + 1).setValue('owner'); ownerIdx = headers.length + 1; }
    const lastRow = bridgeSheet.getLastRow();
    for (let i = 2; i <= lastRow; i++) { if (!bridgeSheet.getRange(i, ownerIdx).getValue()) bridgeSheet.getRange(i, ownerIdx).setValue(ownerSub); }
  }
  Logger.log('Migration complete for owner: ' + ownerSub);
}

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
  const campaignId = PropertiesService.getScriptProperties().getProperty('BOTDOG_CAMPAIGN_ID') || BOTDOG_CAMPAIGN_ID;
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
      payload: JSON.stringify({ campaign_id: campaignId, profiles: [{ linkedin_url: item.linkedinUrl }] }),
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

// ─── Users store (platform user directory) ──────────────────────────────────
// A `Users` tab keyed by email. Created on demand, header-aware. Distinct from
// the per-owner leads/sources/bridges data — this is the platform-level roster
// of who may sign in. The admin gate lives in the Cloudflare Function; the proxy
// has already validated the secret before any of these actions are reached.

const USERS_COLS = [
  'email', 'name', 'linkedin_sub', 'status', 'role',
  'sales_nav_ok', 'botdog_ok', 'extension_ok',
  'created_at', 'last_login', 'onboarded_at', 'invited_by'
];

// Return { sheet, headers } for the Users tab, creating it (header-aware) if
// needed and appending any missing required columns.
function _usersSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName('Users');
  let headers;
  if (!sheet) {
    sheet = ss.insertSheet('Users');
    headers = USERS_COLS.slice();
    sheet.appendRow(headers);
  } else if (sheet.getLastRow() === 0) {
    headers = USERS_COLS.slice();
    sheet.appendRow(headers);
  } else {
    headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const missing = USERS_COLS.filter(c => headers.indexOf(c) < 0);
    if (missing.length) {
      sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
      headers = headers.concat(missing);
    }
  }
  return { sheet, headers };
}

function _getUsers() {
  try {
    const { sheet, headers } = _usersSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, users: [] };
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const users = data.map(row => {
      const o = {};
      headers.forEach((h, i) => { o[h] = row[i]; });
      return o;
    });
    return { success: true, users };
  } catch(e) { return { success: false, error: String(e) }; }
}

// Find the 1-based sheet row for an email (case-insensitive), or -1.
function _findUserRow(sheet, headers, email) {
  const emailIdx = headers.indexOf('email');
  if (emailIdx < 0) return -1;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const col = sheet.getRange(2, emailIdx + 1, lastRow - 1, 1).getValues();
  const target = String(email || '').trim().toLowerCase();
  for (let i = 0; i < col.length; i++) {
    if (String(col[i][0] || '').trim().toLowerCase() === target) return i + 2;
  }
  return -1;
}

// Read a single user row as an object, or null.
function _readUser(sheet, headers, rowNum) {
  if (rowNum < 2) return null;
  const row = sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).getValues()[0];
  const o = {};
  headers.forEach((h, i) => { o[h] = row[i]; });
  return o;
}

function _upsertUser(payload) {
  try {
    const email = String(payload.email || '').trim();
    if (!email) return { success: false, error: 'email required' };
    const { sheet, headers } = _usersSheet();
    const set = (row, col, val) => { const i = headers.indexOf(col); if (i >= 0) row[i] = val; };
    const rowNum = _findUserRow(sheet, headers, email);
    const now = new Date().toISOString();

    if (rowNum < 0) {
      // Insert new user.
      const row = new Array(headers.length).fill('');
      set(row, 'email', email);
      set(row, 'name', payload.name || '');
      set(row, 'linkedin_sub', payload.linkedin_sub || '');
      set(row, 'status', payload.status || 'invited');
      set(row, 'role', payload.role || 'user');
      set(row, 'invited_by', payload.invited_by || '');
      set(row, 'created_at', now);
      sheet.appendRow(row);
      return { success: true, saved: true, created: true };
    }

    // Update provided fields only.
    const row = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
    if (payload.name !== undefined) set(row, 'name', payload.name);
    if (payload.linkedin_sub !== undefined) set(row, 'linkedin_sub', payload.linkedin_sub);
    if (payload.status !== undefined) set(row, 'status', payload.status);
    if (payload.role !== undefined) set(row, 'role', payload.role);
    if (payload.invited_by !== undefined) set(row, 'invited_by', payload.invited_by);
    sheet.getRange(rowNum, 1, 1, headers.length).setValues([row]);
    return { success: true, saved: true, created: false };
  } catch(e) { return { success: false, error: String(e) }; }
}

function _setUserStatus(payload) {
  try {
    const { sheet, headers } = _usersSheet();
    const rowNum = _findUserRow(sheet, headers, payload.email);
    if (rowNum < 0) return { success: false, error: 'user not found' };
    const idx = headers.indexOf('status');
    if (idx < 0) return { success: false, error: 'no status column' };
    sheet.getRange(rowNum, idx + 1).setValue(payload.status || '');
    return { success: true };
  } catch(e) { return { success: false, error: String(e) }; }
}

function _setUserRole(payload) {
  try {
    const { sheet, headers } = _usersSheet();
    const rowNum = _findUserRow(sheet, headers, payload.email);
    if (rowNum < 0) return { success: false, error: 'user not found' };
    const idx = headers.indexOf('role');
    if (idx < 0) return { success: false, error: 'no role column' };
    sheet.getRange(rowNum, idx + 1).setValue(payload.role || '');
    return { success: true };
  } catch(e) { return { success: false, error: String(e) }; }
}

function _setUserFlag(payload) {
  try {
    const allowed = ['sales_nav_ok', 'botdog_ok', 'extension_ok', 'onboarded_at'];
    const flag = String(payload.flag || '');
    if (allowed.indexOf(flag) < 0) return { success: false, error: 'invalid flag' };
    const { sheet, headers } = _usersSheet();
    const rowNum = _findUserRow(sheet, headers, payload.email);
    if (rowNum < 0) return { success: false, error: 'user not found' };
    const idx = headers.indexOf(flag);
    if (idx < 0) return { success: false, error: 'no ' + flag + ' column' };
    let val = payload.value;
    if (flag === 'onboarded_at') {
      // Store an ISO date; accept a supplied value or default to now.
      val = (val === undefined || val === null || val === '') ? new Date().toISOString() : val;
    }
    sheet.getRange(rowNum, idx + 1).setValue(val === undefined ? '' : val);
    return { success: true };
  } catch(e) { return { success: false, error: String(e) }; }
}

function _logLogin(payload) {
  try {
    const email = String(payload.email || '').trim();
    if (!email) return { success: false, error: 'email required' };
    const { sheet, headers } = _usersSheet();
    const set = (row, col, val) => { const i = headers.indexOf(col); if (i >= 0) row[i] = val; };
    const now = new Date().toISOString();
    let rowNum = _findUserRow(sheet, headers, email);

    if (rowNum < 0) {
      // Upsert: create the user on first login (unknown = invited, not active).
      const row = new Array(headers.length).fill('');
      set(row, 'email', email);
      set(row, 'name', payload.name || '');
      set(row, 'linkedin_sub', payload.linkedin_sub || '');
      set(row, 'status', 'invited');
      set(row, 'role', 'user');
      set(row, 'created_at', now);
      set(row, 'last_login', now);
      sheet.appendRow(row);
      rowNum = sheet.getLastRow();
    } else {
      // Update identity fields if provided, stamp last_login. Do NOT auto-activate:
      // approval is manual, so a blank/'invited' status is left untouched here.
      const row = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
      if (payload.name) set(row, 'name', payload.name);
      if (payload.linkedin_sub) set(row, 'linkedin_sub', payload.linkedin_sub);
      set(row, 'last_login', now);
      sheet.getRange(rowNum, 1, 1, headers.length).setValues([row]);
    }

    const user = _readUser(sheet, headers, rowNum);
    return { success: true, user: user };
  } catch(e) { return { success: false, error: String(e) }; }
}

function _jsonp(cb, obj) {
  return ContentService.createTextOutput(cb + '(' + JSON.stringify(obj) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
}
function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function _colIndex(sheet, name) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].indexOf(name) + 1;
}
