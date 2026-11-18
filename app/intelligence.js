/* Radar "Intelligence" menu - client side (app v1.20.0, 2026-11-17)
 * Gershon Intelligence menu (same three tabs as Pulse): AI Analysis · AI Suggestions · AI Chat,
 * on Cloudflare Workers AI via /api/intelligence. Loaded into the app page by functions/_middleware.js
 * (item 8). The browser sends NO data: the server reads the signed-in account's own Radar data.
 * Adds a nav entry "Intelligence" in the Overview group (after Growth) and a view-intelligence section,
 * so the app's own showView('intelligence') switches to it like any other page.
 */
(function () {
  'use strict';
  var ENDPOINT = '/api/intelligence';
  var chat = [], cache = {}, busy = false;

  function el(tag, attrs, html) { var e = document.createElement(tag); for (var k in attrs || {}) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function md(s) {
    return esc(s).split('\n').map(function (l) {
      l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      if (/^#{1,4} /.test(l)) return '<h4>' + l.replace(/^#+ /, '') + '</h4>';
      if (/^\s*[-*•] /.test(l)) return '<li>' + l.replace(/^\s*[-*•] /, '') + '</li>';
      if (/^\s*\d+[.)] /.test(l)) return '<li>' + l.replace(/^\s*\d+[.)] /, '') + '</li>';
      return l.trim() ? '<p>' + l + '</p>' : '';
    }).join('').replace(/(<li>.*?<\/li>)+/g, function (m) { return '<ul>' + m + '</ul>'; });
  }
  async function ask(mode, messages) {
    var r = await fetch(ENDPOINT, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode, messages: messages }) });
    var j = await r.json().catch(function () { return { error: 'HTTP ' + r.status }; });
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    return j.text;
  }

  var CSS = '#view-intelligence .gi-wrap{max-width:980px}.gi-head h2{font-size:20px;font-weight:700;margin:0}.gi-head p{color:#6b7280;font-size:12px;margin:4px 0 16px}' +
    '.gi-tabs{display:flex;gap:6px;border-bottom:1px solid #e5e7eb;margin-bottom:16px;flex-wrap:wrap}.gi-tab{border:0;background:none;padding:10px 14px;font-weight:600;font-size:14px;color:#6b7280;cursor:pointer;border-bottom:2px solid transparent}' +
    '.gi-tab.on{color:#1d1d1f;border-color:#FE1B04}.gi-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;color:#1d1d1f;font-size:14px;line-height:1.55}' +
    '.gi-card h4{margin:14px 0 6px;font-size:15px}.gi-card h4:first-child{margin-top:0}.gi-card ul{margin:4px 0 8px 18px;padding:0}.gi-card p{margin:6px 0}' +
    '.gi-btn{background:#FE1B04;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;white-space:nowrap}.gi-btn:hover{background:#d11200}.gi-btn:disabled{opacity:.5;cursor:wait}' +
    '.gi-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px}.gi-muted{color:#6b7280;font-size:12px}' +
    '.gi-log{max-height:52vh;overflow:auto;display:flex;flex-direction:column;gap:10px;margin-bottom:12px}.gi-msg{padding:10px 14px;border-radius:12px;max-width:85%;font-size:14px;line-height:1.5}' +
    '.gi-msg.u{align-self:flex-end;background:#FE1B04;color:#fff}.gi-msg.a{align-self:flex-start;background:#f3f4f6;color:#1d1d1f}.gi-msg ul{margin:4px 0 4px 18px;padding:0}.gi-msg h4{margin:8px 0 4px}.gi-row{display:flex;gap:8px}' +
    '.gi-row textarea{flex:1;border:1px solid #d1d5db;border-radius:8px;padding:10px;font:inherit;resize:vertical;min-height:44px}.gi-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}' +
    '.gi-chip{border:1px solid #f3c4c4;background:#fff5f5;color:#d11200;border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer}.gi-err{color:#b91c1c}';

  var ICON = '<span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg></span>';

  function build() {
    if (document.getElementById('nav-intelligence')) return;
    var growth = document.getElementById('nav-growth'), anyView = document.querySelector('section.view');
    if (!growth || !anyView) return;
    document.head.appendChild(el('style', {}, CSS));

    var btn = el('button', { class: 'nav-item', id: 'nav-intelligence', type: 'button' }, ICON + ' Intelligence');
    growth.parentNode.insertBefore(btn, growth.nextSibling);

    var page = el('section', { id: 'view-intelligence', class: 'view' });
    page.innerHTML = '<div class="gi-wrap"><div class="gi-head"><h2>Intelligence</h2><p>AI on your own Radar data - sources, bridges and prospects ' +
      '&middot; Cloudflare Workers AI &middot; nothing leaves your account</p></div><div class="gi-tabs">' +
      '<button class="gi-tab on" data-t="analyze">AI Analysis</button><button class="gi-tab" data-t="suggest">AI Suggestions</button><button class="gi-tab" data-t="chat">AI Chat</button></div>' +
      '<div data-p="analyze"></div><div data-p="suggest" hidden></div><div data-p="chat" hidden></div></div>';
    anyView.parentNode.appendChild(page);

    ['analyze', 'suggest'].forEach(function (m) {
      page.querySelector('[data-p="' + m + '"]').innerHTML = '<div class="gi-bar"><span class="gi-muted" data-s="' + m + '">Not run yet</span>' +
        '<button class="gi-btn" data-run="' + m + '">' + (m === 'analyze' ? 'Analyse my Radar' : 'Suggest improvements') + '</button></div>' +
        '<div class="gi-card" data-o="' + m + '"><p class="gi-muted">Click the button to run.</p></div>';
    });
    page.querySelector('[data-p="chat"]').innerHTML = '<div class="gi-chips">' +
      ['Which bridges bring me the most ICP prospects?', 'Which sources should I add more bridges to?', 'Is my collection running well?', 'What should I do this week?']
        .map(function (q) { return '<button class="gi-chip" type="button">' + q + '</button>'; }).join('') +
      '</div><div class="gi-log"></div><div class="gi-row"><textarea placeholder="Ask about your sources, bridges, prospects or the suggested improvements..."></textarea>' +
      '<button class="gi-btn" data-send type="button">Send</button></div>';

    page.addEventListener('click', function (e) {
      var t = e.target.closest('.gi-tab, [data-run], [data-send], .gi-chip'); if (!t) return;
      if (t.classList.contains('gi-tab')) {
        page.querySelectorAll('.gi-tab').forEach(function (x) { x.classList.toggle('on', x === t); });
        page.querySelectorAll('[data-p]').forEach(function (p) { p.hidden = p.getAttribute('data-p') !== t.dataset.t; });
        if (t.dataset.t !== 'chat' && !cache[t.dataset.t]) runMode(t.dataset.t);
      } else if (t.dataset.run) runMode(t.dataset.run);
      else if (t.classList.contains('gi-chip')) { page.querySelector('textarea').value = t.textContent; send(); }
      else send();
    });
    page.querySelector('textarea').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

    async function runMode(m) {
      var out = page.querySelector('[data-o="' + m + '"]'), st = page.querySelector('[data-s="' + m + '"]'), b = page.querySelector('[data-run="' + m + '"]');
      if (b.disabled) return;
      b.disabled = true; st.textContent = 'Thinking...'; out.innerHTML = '<p class="gi-muted">Reading your Radar data...</p>';
      try { var txt = await ask(m); cache[m] = txt; out.innerHTML = md(txt); st.textContent = 'Updated ' + new Date().toLocaleTimeString(); }
      catch (err) { out.innerHTML = '<p class="gi-err">' + esc(err.message) + '</p>'; st.textContent = 'Failed'; }
      b.disabled = false;
    }
    function bubble(role, html) { var log = page.querySelector('.gi-log'); var d = el('div', { class: 'gi-msg ' + (role === 'user' ? 'u' : 'a') }, html); log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
    async function send() {
      var ta = page.querySelector('textarea'), q = ta.value.trim(); if (!q || busy) return;
      ta.value = ''; busy = true; chat.push({ role: 'user', content: q }); bubble('user', esc(q));
      var ctx = cache.suggest ? [{ role: 'assistant', content: 'Earlier suggestions:\n' + cache.suggest }] : [];
      var pending = bubble('assistant', '<span class="gi-muted">Thinking...</span>');
      try { var a = await ask('chat', ctx.concat(chat)); chat.push({ role: 'assistant', content: a }); pending.innerHTML = md(a); }
      catch (err) { chat.pop(); pending.innerHTML = '<span class="gi-err">' + esc(err.message) + '</span>'; }
      busy = false;
    }

    btn.addEventListener('click', function () {
      if (typeof window.showView === 'function') { try { window.showView('intelligence'); } catch (e) {} }
      else {
        document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
        document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('active'); });
        page.classList.add('active'); btn.classList.add('active');
      }
      var sb = document.querySelector('.sidebar'); if (sb) sb.classList.remove('open');
      if (!cache.analyze) runMode('analyze');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
