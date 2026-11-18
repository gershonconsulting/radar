// Radar 1.18.0 - bridge invites. Run: node tests/invites.test.js  (jsdom part runs when jsdom is installed)
const assert = require('assert');
const path = require('path');
const L = require('../salesnav-radar-extension/limits.js');
const I = require('../salesnav-radar-extension/invites.js');

const NOW = new Date('2026-11-18T15:00:00Z').getTime();
const DAY = 86400000;
const U = n => 'ACwAAA' + String(n).padStart(20, 'x');

// --- switch
assert.strictEqual(I.invitesEnabled({ bridge_invites: 'on' }), true);
assert.strictEqual(I.invitesEnabled({ bridge_invites: 'ON ' }), true);
assert.strictEqual(I.invitesEnabled({}), false);
assert.strictEqual(I.invitesEnabled({ bridge_invites: 'dry' }), false);

// --- candidates: only 2nd degree, real urn, not inactive, not already invited; high priority first
const bridges = [
  { bridge: 'A One', source: 'Low Co', urn: U(1), connection: '2nd' },
  { bridge: 'B Two', source: 'High Co', urn: U(2), connection: '2nd' },
  { bridge: 'C Three', source: 'High Co', urn: U(3), connection: '1st' },
  { bridge: 'D Four', source: 'High Co', urn: U(4), connection: '3rd' },
  { bridge: 'E Five', source: 'High Co', urn: 'manual:e-five', connection: '2nd' },
  { bridge: 'F Six', source: 'High Co', urn: U(6), connection: '2nd', active: false },
  { bridge: 'G Seven', source: 'High Co', urn: U(7), connection: '2nd' },
  { bridge: 'H Eight', source: 'Mid Co', urn: U(8), connection: '' },
];
const prio = { 'high co': 'high', 'low co': 'low', 'mid co': 'medium' };
let c = I.pickInviteCandidates(bridges, {}, prio, 10, NOW);
assert.deepStrictEqual(c.map(b => b.urn).sort(), [U(1), U(2), U(7)].sort(), 'only 2nd degree real active');
assert.strictEqual(c[c.length - 1].urn, U(1), 'low priority last');
c = I.pickInviteCandidates(bridges, { [U(2)]: { status: 'sent', at: new Date(NOW).toISOString() } }, prio, 10, NOW);
assert.ok(!c.find(b => b.urn === U(2)), 'never invited twice');
c = I.pickInviteCandidates(bridges, { [U(2)]: { status: 'failed', tries: 1, at: new Date(NOW - 8 * DAY).toISOString() } }, prio, 10, NOW);
assert.ok(c.find(b => b.urn === U(2)), 'one retry after a week');
c = I.pickInviteCandidates(bridges, { [U(2)]: { status: 'failed', tries: 2, at: new Date(NOW - 30 * DAY).toISOString() } }, prio, 10, NOW);
assert.ok(!c.find(b => b.urn === U(2)), 'no third try');
assert.strictEqual(I.pickInviteCandidates(bridges, {}, prio, 1, NOW).length, 1, 'n respected');

// --- acceptance checks
const led = {
  [U(1)]: { status: 'sent', at: new Date(NOW - 1 * DAY).toISOString() },             // too fresh
  [U(2)]: { status: 'sent', at: new Date(NOW - 3 * DAY).toISOString() },             // due
  [U(7)]: { status: 'sent', at: new Date(NOW - 5 * DAY).toISOString(), checkedAt: new Date(NOW - 1 * DAY).toISOString() }, // checked recently
  [U(8)]: { status: 'sent', at: new Date(NOW - 31 * DAY).toISOString() },            // expired
  [U(3)]: { status: 'sent', at: new Date(NOW - 4 * DAY).toISOString() },             // hub already says 1st
};
const by = { [U(3)]: { urn: U(3), connection: '1st' } };
const r = I.dueAcceptanceChecks(led, by, 10, NOW);
assert.deepStrictEqual(r.due, [U(2)]);
assert.deepStrictEqual(r.expired, [U(8)]);
assert.strictEqual(led[U(3)].status, 'accepted');
assert.strictEqual(led[U(8)].status, 'expired');
const st = I.inviteStats(led);
assert.strictEqual(st.accepted, 1); assert.strictEqual(st.expired, 1); assert.strictEqual(st.sent, 3);

// --- note
assert.strictEqual(I.renderInviteNote('', bridges[0]), '');
assert.strictEqual(I.renderInviteNote('Hi {first_name}, saw you at {company}.', { bridge: 'Anne Bougel', source: 'Tag' }), 'Hi Anne, saw you at Tag.');
assert.ok(I.renderInviteNote('x '.repeat(400), bridges[0]).length <= 280);

// --- limits: 5/day, 20/week, halved for new installs; week cap uses invites_per_week
const lim = L.effectiveLimits({}, NOW, null).limits;
assert.strictEqual(lim.invites_per_day, 5); assert.strictEqual(lim.invites_per_week, 20);
const half = L.effectiveLimits({}, NOW, new Date(NOW - 2 * DAY).toISOString()).limits;
assert.strictEqual(half.invites_per_day, 2); assert.strictEqual(half.invites_per_week, 10);
assert.strictEqual(L.effectiveLimits({ limit_invites_per_day: 999 }, NOW, null).limits.invites_per_day, 15, 'ceiling');
let ledg = L.freshLedger(null, NOW);
assert.strictEqual(L.limitRoom(ledg, lim, 'invites', NOW).left, 5);
for (let i = 0; i < 5; i++) ledg = L.limitSpend(ledg, 'invites', 1, NOW);
assert.strictEqual(L.limitRoom(ledg, lim, 'invites', NOW).reason, 'invites_day_cap');
ledg.weekCounts.invites = 20; ledg.dayCounts.invites = 0;
assert.strictEqual(L.limitRoom(ledg, lim, 'invites', NOW).reason, 'invites_week_cap');
assert.strictEqual(L.effectiveLimits({ limits_pause_until: new Date(NOW + DAY).toISOString() }, NOW, null).paused, true);

console.log('invites.js logic: all assertions passed');

// --- in-page function on simulated Sales Nav lead pages (jsdom)
let JSDOM; try { ({ JSDOM } = require(process.env.JSDOM_PATH || 'jsdom')); } catch (e) { console.log('jsdom not installed - skipped DOM tests'); process.exit(0); }
async function page(html, note, dry, onSend) {
  const dom = new JSDOM('<!doctype html><body>' + html + '</body>', { url: 'https://www.linkedin.com/sales/lead/x', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { get() { return this.closest('[hidden]') ? null : w.document.body; } });
  w.eval('window.__send = ' + (onSend ? onSend.toString() : 'function(){}'));
  w.eval(I.sendInviteInPage.toString());
  w.setTimeout = (f, ms) => setTimeout(f, Math.min(ms, 5));
  return { r: await w.eval('sendInviteInPage(' + JSON.stringify(note) + ',' + !!dry + ')'), w };
}
// Real page (2026-11-18) also has role="dialog" tooltips - the invite form is the .artdeco-modal.
const NAME = '<span data-anonymize="person-name">Jane Doe</span><div role="dialog" class="_tooltip-content_leb3qf"><button aria-label="Dismiss">x</button></div>';
const MODAL = '<div role="dialog" class="artdeco-modal" id="dlg"><button onclick="this.closest(\'[role=dialog]\').remove()">Cancel</button><textarea></textarea><button onclick="window.__sent=document.querySelector(\'#dlg textarea\').value;this.closest(\'[role=dialog]\').remove()">Send Invitation</button><button aria-label="Dismiss" onclick="this.closest(\'[role=dialog]\').remove()">x</button></div>';
(async () => {
  // Connect inside the overflow menu, note filled, sent
  let html = NAME + '<button aria-label="Open actions overflow menu" onclick="document.getElementById(\'m\').hidden=false">…</button>' +
    '<ul role="menu" id="m" hidden><li><button onclick="document.body.insertAdjacentHTML(\'beforeend\', window.__modal)">Connect</button></li></ul>';
  let dom = new JSDOM('');
  let { r, w } = await (async () => {
    const d = new JSDOM('<!doctype html><body>' + html + '</body>', { url: 'https://www.linkedin.com/sales/lead/x', runScripts: 'dangerously', pretendToBeVisual: true });
    const w = d.window;
    Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { get() { return this.closest('[hidden]') ? null : w.document.body; } });
    w.__modal = MODAL;
    w.eval(I.sendInviteInPage.toString());
    return { r: await w.eval('sendInviteInPage("Hi Jane", false)'), w };
  })();
  assert.strictEqual(r.status, 'sent', JSON.stringify(r));
  assert.strictEqual(w.__sent, 'Hi Jane');
  // Dry run stops before Send
  const mk = (body) => { const d = new JSDOM('<!doctype html><body>' + body + '</body>', { url: 'https://www.linkedin.com/sales/lead/x', runScripts: 'dangerously', pretendToBeVisual: true }); const w = d.window; Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { get() { return this.closest('[hidden]') ? null : w.document.body; } }); w.__modal = MODAL; w.eval(I.sendInviteInPage.toString()); return w; };
  w = mk(NAME + '<button onclick="document.body.insertAdjacentHTML(\'beforeend\', window.__modal)">Connect</button>');
  r = await w.eval('sendInviteInPage("Hi", true)');
  assert.strictEqual(r.status, 'dry-ok', JSON.stringify(r)); assert.strictEqual(w.__sent, undefined, 'dry never sends');
  // Pending
  w = mk(NAME + '<button>Pending</button>');
  r = await w.eval('sendInviteInPage("", false)'); assert.strictEqual(r.status, 'already');
  // French UI
  w = mk(NAME + '<button aria-label="Plus d’actions" onclick="document.getElementById(\'m\').hidden=false">…</button><ul role="menu" id="m" hidden><li><button onclick="document.body.insertAdjacentHTML(\'beforeend\', window.__modal.replace(\'Send Invitation\',\'Envoyer\'))">Se connecter</button></li></ul>');
  r = await w.eval('sendInviteInPage("", false)'); assert.strictEqual(r.status, 'sent', JSON.stringify(r));
  // No connect offered
  w = mk(NAME + '<button aria-label="Open actions overflow menu" onclick="document.getElementById(\'m\').hidden=false">…</button><ul role="menu" id="m" hidden><li><button>Copy LinkedIn.com URL</button></li></ul>');
  r = await w.eval('sendInviteInPage("", false)'); assert.strictEqual(r.status, 'no-connect');
  // Weekly limit dialog
  w = mk(NAME + '<button onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<div role=dialog class=artdeco-modal>You have reached the weekly invitation limit <button aria-label=Dismiss>x</button></div>\')">Connect</button>');
  r = await w.eval('sendInviteInPage("", false)'); assert.strictEqual(r.status, 'li-limit');
  console.log('sendInviteInPage DOM: all assertions passed');
})().catch(e => { console.error(e); process.exit(1); });
