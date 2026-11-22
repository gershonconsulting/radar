// Offline integration checks against the actual service worker and consent module.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
let stored = {}, readFails = false, writesFail = false, requests = [], listeners = {}, tabs = [];
const chrome = {
  storage: { local: {
    async get(key) { if (readFails) throw new Error('storage unavailable'); return { [key]: stored[key] }; },
    async set(value) { if (writesFail) throw new Error('storage full'); Object.assign(stored, value); }
  } },
  runtime: {
    id: 'radar-test',
    getManifest: () => ({ version: '0.0.0-test' }),
    getURL: file => 'chrome-extension://radar-test/' + file,
    onMessage: { addListener(fn) { listeners.message = fn; } },
    onInstalled: { addListener(fn) { listeners.install = fn; } },
    onStartup: { addListener(fn) { listeners.startup = fn; } }
  },
  alarms: { onAlarm: { addListener(fn) { listeners.alarm = fn; } }, async clear() {}, create() {} },
  tabs: { async create(value) { tabs.push(value); return { id: 1 }; } }
};
const context = vm.createContext({ chrome, console, URL, Date, setTimeout, clearTimeout, fetch: async (...args) => { requests.push(args); return { ok: true }; } });
context.self = context;
context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, 'salesnav-radar-extension', file), 'utf8'), context));
vm.runInContext(fs.readFileSync(path.join(root, 'salesnav-radar-extension/sync-core.js'), 'utf8'), context);
function message(action, sender = {}) {
  return new Promise(resolve => listeners.message({ action, force: true }, sender, resolve));
}
async function main() {
  assert.equal(await context.RadarConsent.accepted(), false);
  await assert.rejects(context.fetch('https://example.invalid'), /collection-consent-required/);
  assert.equal((await context.runSync()).status, 'consent-required');
  assert.equal((await context.maybeAutoRun('startup')).status, 'consent-required');
  await listeners.startup();
  await listeners.install({ reason: 'install' });
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].url, chrome.runtime.getURL('popup.html'));
  for (const action of ['syncNow', 'discoverNow', 'pushBridgesNow', 'salesnavListNow', 'salesnavBridgesListNow', 'salesNavStatus']) {
    assert.equal((await message(action)).ok, false, action + ' must require consent');
  }
  assert.equal((await message('acceptConsent', { id: chrome.runtime.id, url: 'https://radar.gershon.ai/app' })).ok, false);
  assert.equal(await context.RadarConsent.accepted(), false);
  const popup = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') };
  writesFail = true;
  assert.equal((await message('acceptConsent', popup)).ok, false);
  writesFail = false;
  assert.equal(requests.length, 0);
  assert.equal((await message('acceptConsent', popup)).ok, true);
  assert.equal(await context.RadarConsent.accepted(), true);
  assert(Number.isFinite(Date.parse(stored.radar_collection_consent.acceptedAt)));
  await context.fetch('https://example.invalid');
  assert.equal(requests.length, 1);
  stored.radar_collection_consent.revision = 0;
  assert.equal(await context.RadarConsent.accepted(), false, 'outdated disclosure requires acceptance again');
  stored.radar_collection_consent = { revision: 1, acceptedAt: 'invalid' };
  assert.equal(await context.RadarConsent.accepted(), false);
  readFails = true;
  assert.equal(await context.RadarConsent.accepted(), false);
  await assert.rejects(context.fetch('https://example.invalid'), /collection-consent-required/);
  assert.equal(requests.length, 1);
  console.log('Consent: install/startup/manual/app paths blocked before acceptance; sender, timestamp, revision and storage failures verified.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
