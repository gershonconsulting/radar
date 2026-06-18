// Radar — Apps Script hub  (google-apps-script/Code.gs)
// POST receiver from Chrome extension → writes to Sheet
// GET server (JSONP) → serves data to web app
// Daily report via Resend, daily Botdog push

const SHEET_ID             = '1FeEv-0ZHAvNWKx78OZSDzOBYC-EBZuFO-I-Cswo8GiA';
const SHEET_NAME           = 'Untitled';
const RADAR_INGEST_SECRET  = 'radar_7Kq3mZ9pX2vL8nT';
const REPORT_DRY_RUN       = true;
const BOTDOG_DRY_RUN       = true;
const BOTDOG_CAMPAIGN_ID   = '343b1a9b-be69-4a09-bc4c-ccedd0d73a8c';
const BOTDOG_BRIDGE_FILTER = 'Elie Cohen';
const MAX_PUSH_PER_RUN     = 50;
const REPORT_FROM          = 'radar@gershoncrm.com';
const REPORT_TO            = 'aina@gershonconsulting.com';

function doGet(e) {
  const cb      = (e && e.parameter && e.parameter.callback) || 'callback';
  const sheet   = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return _jsonp(cb, { success: true, service: 'radar-ingest', count: 0, rows: [] });
  }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const data    = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const rows    = data.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
  return _jsonp(cb, { success: true, service: 'radar-ingest', count: rows.length, rows: rows });
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    if (payload.secret !== RADAR_INGEST_SECRET) return _json({ success: false, error: 'unauthorized' });
    const leads = payload.leads || [];
    if (!leads.length) return _json({ success: true, service: 'radar-ingest', written: 0 });
    const sheet   = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const lastRow = sheet.getLastRow();
    const existingIds = new Set();
    if (lastRow >= 2) {
      const ci = _colIndex(sheet, 'lead_id');
      if (ci > 0) sheet.getRange(2, ci, lastRow - 1, 1).getValues().flat().forEach(id => { if (id) existingIds.add(String(id)); });
    }
    if (lastRow === 0) {
      sheet.appendRow(['collected_date','first_name','last_name','title','company','linkedin_url','radar_person','lead_id','botdog_pushed']);
    }
    let written = 0;
    leads.forEach(lead => {
      if (existingIds.has(String(lead.lead_id))) return;
      sheet.appendRow([
        lead.collected_date || new Date().toISOString(),
        lead.first_name || '', lead.last_name || '', lead.title || '', lead.company || '',
        lead.linkedin_url || '', lead.radar_person || '', lead.lead_id || '', ''
      ]);
      written++;
    });
    return _json({ success: true, service: 'radar-ingest', written: written });
  } catch (err) {
    return _json({ success: false, error: String(err) });
  }
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
  const resp = UrlFetchApp.fetch('https://api.resend.com/emails', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify({ from: REPORT_FROM, to: [REPORT_TO],
      subject: 'Radar daily report — ' + newToday + ' new leads today',
      html: '<h2>Radar Daily Report</h2><p><strong>' + newToday + '</strong> new leads in last 24h. Total: <strong>' + count + '</strong></p><p><a href="https://radar.gershoncrm.com">Open Dashboard</a></p>'
    }),
    muteHttpExceptions: true
  });
  Logger.log('Resend: ' + resp.getResponseCode());
}

function pushToBotdog() {
  const key = PropertiesService.getScriptProperties().getProperty('BOTDOG_API_KEY');
  if (!key) { Logger.log('BOTDOG_API_KEY not set'); return; }
  const sheet   = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No leads'); return; }
  const headers   = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const data      = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const liIdx     = headers.indexOf('linkedin_url');
  const personIdx = headers.indexOf('radar_person');
  const pushedIdx = headers.indexOf('botdog_pushed');
  const toPush = [];
  data.forEach((row, i) => {
    const li     = String(row[liIdx] || '');
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
  Logger.log('Report trigger set for 07:00 daily');
}

function installDailyBotdogTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'pushToBotdog') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('pushToBotdog').timeBased().everyDays(1).atHour(8).create();
  Logger.log('Botdog trigger set for 08:00 daily');
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
