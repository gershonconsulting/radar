/* Radar - Team access (app v1.27.0, 2026-11-26)
 * Settings > Team: the account owner (or a Full member) gives other people access to this Radar account.
 * Each person: name, LinkedIn profile link, email (the one on their LinkedIn account), access Full / Semi / Viewer.
 * They sign in at radar.gershon.ai with "Sign in with LinkedIn" and land on this account.
 *
 * Also, for people signed in as a member:
 *  - a role pill in the sidebar + an account switcher when they can open more than one Radar
 *  - write guard: hub writes their role does not allow are stopped in the browser (server checks on
 *    /api/team and /api/botdog-setting too) and the matching buttons are hidden
 *  - their Chrome extension is never linked to the account (app.html skips the owner relay for members)
 * Loaded into the app page by functions/_middleware.js (item 10). Server: /api/team, functions/_lib/team.js.
 */
(function () {
  'use strict';
  var API = '/api/team';
  var HUB = 'functions/v1/hub';
  var SEMI_ACTIONS = { addSource: 1, addBridges: 1, setBridgeActive: 1, setSourcePriority: 1, queueDiscover: 1, feedback: 1, logLogin: 1 };
  var VIEWER_ACTIONS = { feedback: 1, logLogin: 1, pushLog: 1 };
  var LABEL = { owner: 'Owner', full: 'Full', semi: 'Semi', viewer: 'Viewer' };
  var HELP = {
    full: 'Everything the owner can do, including Settings and this Team list.',
    semi: 'Works the campaign: adds sources and bridges, switches bridges on/off, excludes prospects. No Settings, no deleting.',
    viewer: 'Read only: sees the dashboard, sources, bridges and prospects, and can export.'
  };

  function role() { return window.__ROLE || 'owner'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(tag, attrs, html) { var e = document.createElement(tag); for (var k in attrs || {}) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }

  // ---------- write guard (same rules as functions/_lib/team.js canHubWrite) ----------
  function allowed(r, body) {
    if (r === 'owner' || r === 'full') return true;
    var a = body && body.action ? String(body.action) : '';
    if (r === 'viewer') return !!VIEWER_ACTIONS[a];
    if (r === 'semi') {
      if (a === 'setConfig') {
        var keys = Object.keys(body).filter(function (k) { return ['action', 'secret', 'owner'].indexOf(k) < 0; });
        return keys.length > 0 && keys.every(function (k) { return k === 'excluded_leads'; });
      }
      return !!SEMI_ACTIONS[a];
    }
    return false;
  }
  function toast(msg) {
    var t = document.getElementById('rtToast');
    if (!t) { t = el('div', { id: 'rtToast' }); document.body.appendChild(t); }
    t.textContent = msg; t.className = 'show';
    clearTimeout(t._h); t._h = setTimeout(function () { t.className = ''; }, 3500);
  }
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var r = role();
      if (r !== 'owner' && r !== 'full') {
        var u = typeof input === 'string' ? input : (input && input.url) || '';
        var method = (init && init.method ? init.method : 'GET').toUpperCase();
        if (method !== 'GET' && u.indexOf(HUB) !== -1 && init && typeof init.body === 'string') {
          var b = {}; try { b = JSON.parse(init.body); } catch (e) {}
          if (!allowed(r, b)) {
            toast('Your access is ' + LABEL[r] + ': this change is for the account owner.');
            return Promise.resolve(new Response(JSON.stringify({ ok: false, saved: false, error: 'not allowed for ' + r }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
          }
        }
      }
    } catch (e) {}
    return _fetch.apply(this, arguments);
  };

  // ---------- styles ----------
  var CSS =
    '#rtToast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1d1d1f;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:9999}#rtToast.show{opacity:1}' +
    '.rt-pill{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px;background:#fff5f5;color:#d11200;border:1px solid #f3c4c4;margin-left:6px;white-space:nowrap}' +
    '.rt-acct{font-size:12px;color:#6b7280;padding:6px 12px 0}.rt-acct select{width:100%;margin-top:4px;border:1px solid #d1d5db;border-radius:8px;padding:5px 6px;font:inherit;font-size:12px}' +
    '#rtTeam .rt-tw{overflow-x:auto;margin-top:12px}#rtTeam table{width:100%;border-collapse:collapse;font-size:13px}#rtTeam th{text-align:left;color:#6b7280;font-weight:600;padding:6px 8px;border-bottom:1px solid #e5e7eb}' +
    '#rtTeam td select{min-width:96px}#rtTeam td{padding:8px 6px;border-bottom:1px solid #f1f5f9;vertical-align:middle}#rtTeam td a{color:#d11200;text-decoration:none}' +
    '#rtTeam .rt-form{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px;align-items:end}#rtTeam .rt-form .rt-go{grid-column:1/-1}' +
    '#rtTeam .rt-form label{font-size:12px;color:#6b7280;display:block}#rtTeam .rt-form input,#rtTeam .rt-form select,#rtTeam td select{width:100%;border:1px solid #d1d5db;border-radius:8px;padding:7px 8px;font:inherit;font-size:13px;box-sizing:border-box}' +
    '#rtTeam .rt-btn{background:#FE1B04;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;white-space:nowrap}#rtTeam .rt-btn:hover{background:#d11200}#rtTeam .rt-btn:disabled{opacity:.5}' +
    '#rtTeam .rt-link{background:none;border:0;color:#b91c1c;cursor:pointer;font-size:12px;padding:0}#rtTeam .rt-copy{background:none;border:1px solid #e5e7eb;border-radius:6px;cursor:pointer;font-size:12px;padding:3px 8px;white-space:nowrap}' +
    '#rtTeam .rt-roles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}#rtTeam .rt-roles div{border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:12px;color:#4b5563}#rtTeam .rt-roles b{display:block;color:#1d1d1f;margin-bottom:2px}' +
    '#rtTeam .rt-msg{font-size:12px;margin-top:8px}#rtTeam .rt-msg.err{color:#b91c1c}#rtTeam .rt-msg.ok{color:#15803d}' +
    '#rtTeam .rt-st{display:inline-block;margin-top:3px;font-size:11px;border-radius:999px;padding:2px 8px;white-space:nowrap}#rtTeam .rt-st.invited{background:#fef3c7;color:#92400e}#rtTeam .rt-st.active{background:#dcfce7;color:#166534}' +
    '.rt-locked{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;font-size:13px;color:#475569;margin-bottom:12px}' +
    '@media(max-width:760px){#rtTeam .rt-form{grid-template-columns:1fr}#rtTeam .rt-roles{grid-template-columns:1fr}}' +
    // hidden for members: extension-driving buttons (their extension is not linked to this account)
    'body.rt-member [onclick^="triggerSync("],body.rt-member [onclick^="extRunSync("],body.rt-member [onclick^="fileBridgesNow("],body.rt-member [onclick^="triggerBridgePush("],body.rt-member [onclick^="triggerBridgeList("],body.rt-member #nav-extension{display:none!important}' +
    // semi + viewer: settings saves; viewer: every add / remove
    'body.rt-semi [onclick^="saveSettings("],body.rt-semi [onclick^="saveCampaign("],body.rt-semi [onclick^="saveSalesNavList("],body.rt-semi [onclick^="saveIcpTemplate("],body.rt-semi [onclick^="saveLeadTarget("],body.rt-semi [onclick^="saveSchedule("],body.rt-semi [onclick^="testAllKeys("],body.rt-semi [onclick^="onBridgeRemove("],body.rt-semi [onclick^="obSaveIcp("],body.rt-semi [onclick^="obSaveLists("],body.rt-semi [onclick^="obSaveBotdog("]{display:none!important}' +
    'body.rt-viewer [onclick^="addSource("],body.rt-viewer [onclick^="addBridgeManual("],body.rt-viewer [onclick^="requestBridges("]{display:none!important}';

  // ---------- team card ----------
  var state = { data: null };

  function memberRow(m, canManage) {
    var st = m.status === 'active' ? '<span class="rt-st active">Signed in</span>' : '<span class="rt-st invited">Invited</span>';
    var roleCell = canManage
      ? '<select data-id="' + esc(m.id) + '" class="rt-role">' + ['full', 'semi', 'viewer'].map(function (r) { return '<option value="' + r + '"' + (m.role === r ? ' selected' : '') + '>' + LABEL[r] + '</option>'; }).join('') + '</select>'
      : esc(LABEL[m.role]);
    return '<tr><td><b>' + esc(m.name || '-') + '</b><br>' + st + '</td><td>' + esc(m.email) + '</td>' +
      '<td>' + (m.linkedin_url ? '<a href="' + esc(m.linkedin_url) + '" target="_blank" rel="noopener">Profile&nbsp;&#8599;</a>' : '-') + '</td>' +
      '<td>' + roleCell + '</td>' +
      '<td style="text-align:right">' + (canManage ? '<div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end"><button class="rt-copy" data-copy="' + esc(m.id) + '">Copy invite</button><button class="rt-link" data-remove="' + esc(m.id) + '">Remove</button></div>' : '') + '</td></tr>';
  }

  function inviteText(m) {
    var acct = state.data && state.data.account ? state.data.account.name : '';
    return 'Hi ' + ((m.name || '').split(' ')[0] || '') + ',\n\nYou now have ' + LABEL[m.role] + ' access to ' + (acct ? acct + "'s " : 'our ') +
      'Radar by Gershon.AI.\n\n1. Open https://radar.gershon.ai/app\n2. Click "Sign in with LinkedIn" and use the LinkedIn account of ' + m.email +
      '\n\nNo Chrome extension is needed on your side.';
  }

  function render() {
    var card = document.getElementById('rtTeam');
    if (!card) return;
    var d = state.data;
    if (!d) { card.innerHTML = '<h2>Team</h2><p>Loading…</p>'; return; }
    var r = d.role;
    var head = '<h2>Team <span style="color:#94a3b8;font-weight:400;font-size:0.8rem">(people who can open this Radar)</span></h2>';
    if (!d.can_manage) {
      card.innerHTML = head + '<p>You have <strong>' + esc(LABEL[r]) + '</strong> access to <strong>' + esc(d.account.name) + '</strong>&rsquo;s Radar. ' + esc(HELP[r] || '') +
        ' The account owner manages this list.</p>';
      return;
    }
    var rows = d.members.length ? d.members.map(function (m) { return memberRow(m, true); }).join('')
      : '<tr><td colspan="5" style="color:#6b7280">Nobody else has access yet.</td></tr>';
    card.innerHTML = head +
      '<p>Give colleagues access to this Radar account. They sign in with <strong>their own LinkedIn</strong> at radar.gershon.ai &mdash; ' +
      'use the email of their LinkedIn account. Collection keeps running on the owner&rsquo;s LinkedIn; their Chrome extension is never used.</p>' +
      '<div class="rt-roles"><div><b>Full</b>' + HELP.full + '</div><div><b>Semi</b>' + HELP.semi + '</div><div><b>Viewer</b>' + HELP.viewer + '</div></div>' +
      '<div class="rt-tw"><table><thead><tr><th>Name</th><th>Email</th><th>LinkedIn</th><th>Access</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="rt-form"><div><label>Name</label><input id="rtName" placeholder="Jane Doe"></div>' +
      '<div><label>LinkedIn profile</label><input id="rtLi" placeholder="https://www.linkedin.com/in/…"></div>' +
      '<div><label>Email of their LinkedIn account</label><input id="rtEmail" type="email" placeholder="jane@company.com"></div>' +
      '<div><label>Access</label><select id="rtRole"><option value="viewer">Viewer</option><option value="semi">Semi</option><option value="full">Full</option></select></div>' +
      '<div class="rt-go"><button class="rt-btn" id="rtAdd">Give access</button></div></div>' +
      '<div class="rt-msg" id="rtMsg"></div>';
    wire(card);
  }

  function msg(text, ok) { var m = document.getElementById('rtMsg'); if (m) { m.textContent = text; m.className = 'rt-msg ' + (ok ? 'ok' : 'err'); } }

  async function call(body) {
    var r = await _fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var j = await r.json().catch(function () { return { success: false, error: 'HTTP ' + r.status }; });
    if (!j.success) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  function wire(card) {
    var add = document.getElementById('rtAdd');
    if (add) add.onclick = async function () {
      add.disabled = true;
      try {
        var j = await call({ op: 'invite', name: document.getElementById('rtName').value, linkedin_url: document.getElementById('rtLi').value,
          email: document.getElementById('rtEmail').value, role: document.getElementById('rtRole').value });
        state.data.members = j.members; render();
        try { await navigator.clipboard.writeText(inviteText(j.member)); msg('Access given. Invitation text copied - paste it in an email or LinkedIn message.', true); }
        catch (e) { msg('Access given. Use "Copy invite" to get the invitation text.', true); }
      } catch (e) { msg(e.message, false); add.disabled = false; }
    };
    card.querySelectorAll('select.rt-role').forEach(function (s) {
      s.onchange = async function () {
        try { var j = await call({ op: 'update', id: s.getAttribute('data-id'), role: s.value }); state.data.members = j.members; render(); msg('Access updated.', true); }
        catch (e) { msg(e.message, false); }
      };
    });
    card.querySelectorAll('[data-remove]').forEach(function (b) {
      b.onclick = async function () {
        var m = state.data.members.find(function (x) { return x.id === b.getAttribute('data-remove'); });
        if (!m || !window.confirm('Remove access for ' + (m.name || m.email) + '? They will be signed out of this Radar.')) return;
        try { var j = await call({ op: 'remove', id: m.id }); state.data.members = j.members; render(); msg('Access removed.', true); }
        catch (e) { msg(e.message, false); }
      };
    });
    card.querySelectorAll('[data-copy]').forEach(function (b) {
      b.onclick = async function () {
        var m = state.data.members.find(function (x) { return x.id === b.getAttribute('data-copy'); });
        try { await navigator.clipboard.writeText(inviteText(m)); msg('Invitation text copied.', true); }
        catch (e) { window.prompt('Copy this invitation:', inviteText(m)); }
      };
    });
  }

  // ---------- sidebar: role pill + account switcher ----------
  function sidebar(d) {
    var chip = document.getElementById('userChip');
    if (!chip || document.getElementById('rtAcct')) return;
    var multi = d.workspaces && d.workspaces.length > 1;
    if (d.role === 'owner' && !multi) return;
    var box = el('div', { id: 'rtAcct', class: 'rt-acct' });
    var html = d.role !== 'owner' ? esc(d.account.name) + '<span class="rt-pill">' + esc(LABEL[d.role]) + '</span>' : '';
    if (multi) {
      html += '<select id="rtSwitch" title="Switch Radar account">' + d.workspaces.map(function (w) {
        return '<option value="' + esc(w.owner_key) + '"' + (w.current ? ' selected' : '') + '>' + esc(w.name) + (w.role !== 'owner' ? ' (' + LABEL[w.role] + ')' : '') + '</option>';
      }).join('') + '</select>';
    }
    box.innerHTML = html;
    chip.parentNode.insertBefore(box, chip);
    var sw = document.getElementById('rtSwitch');
    if (sw) sw.onchange = async function () {
      try { await call({ op: 'switch', owner_key: sw.value }); window.location.reload(); }
      catch (e) { toast(e.message); }
    };
  }

  // ---------- settings: lock for semi / viewer ----------
  function lockSettings(r) {
    if (r === 'owner' || r === 'full') return;
    var view = document.getElementById('view-settings');
    if (!view || document.getElementById('rtLocked')) return;
    var head = view.querySelector('.page-head');
    var note = el('div', { id: 'rtLocked', class: 'rt-locked' }, 'You have <strong>' + LABEL[r] + '</strong> access: Settings are managed by the account owner and are shown read only.');
    if (head) head.parentNode.insertBefore(note, head.nextSibling);
    view.querySelectorAll('.settings-card').forEach(function (c) {
      if (c.id === 'rtTeam') return;
      if (/Collecting session/.test((c.querySelector('h2') || {}).textContent || '')) { c.style.display = 'none'; return; }
      c.querySelectorAll('input,select,textarea,button').forEach(function (x) { x.disabled = true; });
    });
  }

  function build() {
    var view = document.getElementById('view-settings');
    if (!view || document.getElementById('rtTeam')) return;
    document.head.appendChild(el('style', {}, CSS));
    var card = el('div', { class: 'settings-card', id: 'rtTeam' });
    var head = view.querySelector('.page-head');
    if (head) head.parentNode.insertBefore(card, head.nextSibling); else view.appendChild(card);
    render();
  }

  async function load() {
    try {
      var r = await _fetch(API, { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return;
      var d = await r.json();
      if (!d.success) return;
      state.data = d;
      window.__ROLE = d.role;
      document.body.classList.toggle('rt-member', d.role !== 'owner');
      document.body.classList.toggle('rt-semi', d.role === 'semi' || d.role === 'viewer');
      document.body.classList.toggle('rt-viewer', d.role === 'viewer');
      render(); sidebar(d); lockSettings(d.role);
    } catch (e) {}
  }

  function start() {
    build();
    // wait until the app has signed in (initAuth sets window.__ME), then load the team
    var tries = 0;
    (function wait() {
      if (window.__ME && window.__ME.ok) return load();
      if (++tries < 120) setTimeout(wait, 250);
    })();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
