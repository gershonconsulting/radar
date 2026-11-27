/* Radar "Personas" - client side (app v1.25.0, 2026-11-26)
 * ICP optimization: groups the people in the account's Sales Navigator "Recommended Leads" list into
 * personas and compares each one with what Radar actually collects (GET /api/personas, owner from the
 * session only). Loaded into the app page by functions/_middleware.js (item 9). Adds the nav entry
 * "Personas" in the Overview group (after Intelligence) and a view-personas section.
 * The list itself is read by the extension (1.19.0+) once a week; "Read them now" asks it to read now.
 */
(function () {
  'use strict';
  var ENDPOINT = '/api/personas';
  var loaded = false, busy = false;

  function el(tag, attrs, html) { var e = document.createElement(tag); for (var k in attrs || {}) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function md(s) {
    return esc(s).split('\n').map(function (l) {
      l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      if (/^\s*[-*•] /.test(l)) return '<li>' + l.replace(/^\s*[-*•] /, '') + '</li>';
      return l.trim() ? '<p>' + l + '</p>' : '';
    }).join('').replace(/(<li>.*?<\/li>)+/g, function (m) { return '<ul>' + m + '</ul>'; });
  }
  function chips(arr) { return (arr || []).map(function (x) { return '<span class="pe-chip">' + esc(x.label) + ' <b>' + x.pct + '%</b></span>'; }).join(''); }

  var VERDICT = {
    converts: ['pe-ok', 'Radar converts'], covered: ['pe-mid', 'Covered'], underserved: ['pe-warn', 'Under-reached'],
    gap: ['pe-bad', 'Gap - not collected'], off_icp: ['pe-warn', 'Off your ICP rule'], no_data: ['pe-mid', 'No Radar data yet']
  };

  var CSS = '#view-personas .pe-wrap{max-width:1040px}.pe-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px}' +
    '.pe-head h2{font-size:20px;font-weight:700;margin:0}.pe-head p{color:#6b7280;font-size:12px;margin:4px 0 0}' +
    '.pe-btn{background:#FE1B04;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;white-space:nowrap}.pe-btn:hover{background:#d11200}.pe-btn:disabled{opacity:.5;cursor:wait}' +
    '.pe-btn.ghost{background:#fff;color:#d11200;border:1px solid #f3c4c4}.pe-btn.ghost:hover{background:#fff5f5}' +
    '.pe-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;color:#1d1d1f;font-size:14px;line-height:1.5;margin-bottom:12px}' +
    '.pe-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}.pe-kpi{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px}' +
    '.pe-kpi b{display:block;font-size:22px}.pe-kpi span{color:#6b7280;font-size:12px}' +
    '.pe-top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}.pe-name{font-size:16px;font-weight:700}' +
    '.pe-size{color:#6b7280;font-size:13px;margin-left:6px;font-weight:500}.pe-badge{border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;white-space:nowrap}' +
    '.pe-ok{background:#e8f7ee;color:#137333}.pe-mid{background:#f3f4f6;color:#374151}.pe-warn{background:#fff7e6;color:#a15c00}.pe-bad{background:#fff5f5;color:#d11200}' +
    '.pe-row{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-top:8px}.pe-lab{color:#6b7280;font-size:12px;min-width:110px}' +
    '.pe-chip{display:inline-block;border:1px solid #e5e7eb;border-radius:999px;padding:2px 9px;font-size:12px;margin:0 4px 4px 0;background:#fafafa}' +
    '.pe-radar{margin-top:10px;padding:10px 12px;border-radius:8px;background:#fafafa;font-size:13px}.pe-filters{font-size:13px}.pe-filters code{background:#f3f4f6;border-radius:4px;padding:1px 5px;font-size:12px}' +
    '.pe-ex{margin-top:8px;font-size:12px;color:#374151}.pe-ex summary{cursor:pointer;color:#d11200;font-weight:600}.pe-ex li{margin:2px 0}.pe-muted{color:#6b7280;font-size:12px}' +
    '.pe-ai ul{margin:4px 0 4px 18px;padding:0}.pe-err{color:#b91c1c}';

  var ICON = '<span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.8 14.2c2.3.2 4 1.8 4.6 4.8"/></svg></span>';

  function render(page, d) {
    var body = page.querySelector('.pe-body');
    if (d.error) { body.innerHTML = '<div class="pe-card pe-err">' + esc(d.error) + '</div>'; return; }
    if (d.empty) {
      body.innerHTML = '<div class="pe-card"><p><b>No Recommended Leads read yet.</b></p><p>' + esc(d.message) + '</p>' +
        '<p class="pe-muted">Sales Navigator fills a list called "Recommended Leads" with about 100 people it suggests for you. ' +
        'Radar reads it (read-only, 4 calls, once a week) and groups those people into personas.</p></div>';
      page.querySelector('.pe-sub').textContent = 'Personas from your Sales Navigator "Recommended Leads"';
      return;
    }
    page.querySelector('.pe-sub').textContent = 'From your ' + d.total + ' ' + (d.list_name || 'Recommended Leads') + ' on Sales Navigator - read ' +
      String(d.at || '').slice(0, 10) + ' - compared with your ' + (d.radar_prospects || 0) + ' Radar prospects';
    var dims = d.dims || {}, deg = dims.degree || {};
    var warm = d.total ? Math.round(((deg.first || 0) + (deg.second || 0)) * 100 / d.total) : 0;
    var h = '<div class="pe-grid">' +
      '<div class="pe-kpi"><b>' + (d.personas || []).length + '</b><span>personas (' + d.grouped + ' of ' + d.total + ' people)</span></div>' +
      '<div class="pe-kpi"><b>' + (dims.founders_pct || 0) + '%</b><span>are founders</span></div>' +
      '<div class="pe-kpi"><b>' + warm + '%</b><span>1st or 2nd degree (warm reach)</span></div>' +
      '<div class="pe-kpi"><b>' + esc(((dims.regions || [])[0] || {}).label || '-') + '</b><span>top location</span></div>' +
      '<div class="pe-kpi"><b>' + esc(((dims.company_sizes || [])[0] || {}).label || '-') + '</b><span>top company size</span></div></div>';
    h += '<div class="pe-card pe-ai"><div class="pe-top"><b>What to do with it</b>' +
      (d.ai ? '<button class="pe-btn ghost" data-ai type="button">Ask Intelligence</button>' : '') + '</div><div data-ai-out class="pe-muted">' +
      (d.ai ? 'Click "Ask Intelligence" for a short recommendation.' : 'Look for personas marked "Gap" or "Under-reached": LinkedIn sees them as your buyers but Radar does not reach them yet - add sources or bridges where they work, or widen your ICP rule.') +
      '</div></div>';
    (d.personas || []).forEach(function (p) {
      var v = VERDICT[p.verdict] || VERDICT.covered, r = p.radar || {}, f = p.salesnav_filters || {};
      h += '<div class="pe-card"><div class="pe-top"><div class="pe-name">' + esc(p.name) + '<span class="pe-size">' + p.size + ' people · ' + p.share + '%</span></div>' +
        '<span class="pe-badge ' + v[0] + '" title="' + esc(p.verdict_text) + '">' + v[1] + '</span></div>' +
        '<div class="pe-row"><span class="pe-lab">Where</span><span>' + chips(p.regions) + '</span></div>' +
        '<div class="pe-row"><span class="pe-lab">Company size</span><span>' + chips(p.company_sizes) + '</span></div>' +
        (p.industries && p.industries.length ? '<div class="pe-row"><span class="pe-lab">Industries</span><span>' + chips(p.industries) + '</span></div>' : '') +
        '<div class="pe-row"><span class="pe-lab">Profile</span><span>' + p.founders_pct + '% founders · ' + p.warm_pct + '% 1st/2nd degree</span></div>' +
        '<div class="pe-radar"><b>In Radar:</b> ' + (r.prospects_same_role || 0) + ' prospects with this role (' + (r.share_of_your_prospects || 0) + '% of yours)' +
        (r.icp_rate != null ? ', ' + r.icp_match + ' of ' + r.icp_graded + ' graded are ICP A/B (' + r.icp_rate + '%)' : '') + '. ' + esc(p.verdict_text) + '</div>' +
        '<div class="pe-row pe-filters"><span class="pe-lab">Sales Nav search</span><span>' +
        ['seniority', 'function', 'industry', 'geography', 'headcount'].filter(function (k) { return f[k]; })
          .map(function (k) { return k.charAt(0).toUpperCase() + k.slice(1) + ': <code>' + esc(f[k]) + '</code>'; }).join(' · ') + '</span></div>' +
        '<details class="pe-ex"><summary>Examples</summary><ul>' + (p.examples || []).map(function (x) {
          return '<li><b>' + esc(x.name) + '</b> - ' + esc(x.title) + (x.company ? ' at ' + esc(x.company) : '') + (x.geo ? ' · ' + esc(x.geo) : '') + (x.degree ? ' · ' + esc(x.degree) : '') + '</li>';
        }).join('') + '</ul></details></div>';
    });
    if (d.others && d.others.size) h += '<p class="pe-muted">' + d.others.size + ' people fit no group of 3 or more and are left out.</p>';
    body.innerHTML = h;
  }

  async function load(page, withAi) {
    if (busy) return; busy = true;
    var body = page.querySelector('.pe-body');
    if (!withAi) body.innerHTML = '<div class="pe-card pe-muted">Building your personas...</div>';
    try {
      var r = await fetch(ENDPOINT + (withAi ? '?ai=1' : ''), { credentials: 'same-origin' });
      var j = await r.json().catch(function () { return { error: 'HTTP ' + r.status }; });
      if (!r.ok && !j.error) j.error = 'HTTP ' + r.status;
      if (withAi) {
        var out = page.querySelector('[data-ai-out]');
        if (out) out.innerHTML = j.summary ? md(j.summary) : '<span class="pe-muted">Intelligence gave no answer this time - try again in a minute.</span>';
      } else { render(page, j); loaded = true; }
    } catch (e) { body.innerHTML = '<div class="pe-card pe-err">' + esc(e.message) + '</div>'; }
    busy = false;
  }

  function refreshNow(page) {
    var btn = page.querySelector('[data-refresh]'), st = page.querySelector('.pe-sub');
    var hasExt = document.documentElement.hasAttribute('data-radar-ext');
    if (!hasExt) { st.textContent = 'The Radar Chrome extension is needed on this computer to read your Recommended Leads.'; return; }
    btn.disabled = true; st.textContent = 'Reading your Recommended Leads on Sales Navigator (about 30 seconds)...';
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; btn.disabled = false; st.textContent = 'Still working in the background - come back in a minute.'; } }, 120000);
    window.addEventListener('radar-ext-personas-done', function h(ev) {
      window.removeEventListener('radar-ext-personas-done', h);
      if (done) return; done = true; clearTimeout(timer); btn.disabled = false;
      var d = (ev && ev.detail) || {}, res = d.result || {};
      if (!d.ok) { st.textContent = 'Could not read them: ' + (d.error || 'unknown error') + ' (update the extension to 1.19.0 or later).'; return; }
      if (res.skipped === 'recent') st.textContent = 'Already read in the last 12 hours.';
      load(page, false);
    });
    window.dispatchEvent(new CustomEvent('radar-ext-refresh-personas'));
  }

  function build() {
    if (document.getElementById('nav-personas')) return;
    var after = document.getElementById('nav-intelligence') || document.getElementById('nav-growth'), anyView = document.querySelector('section.view');
    if (!after || !anyView) return;
    document.head.appendChild(el('style', {}, CSS));
    var btn = el('button', { class: 'nav-item', id: 'nav-personas', type: 'button' }, ICON + ' Personas');
    after.parentNode.insertBefore(btn, after.nextSibling);
    var page = el('section', { id: 'view-personas', class: 'view' });
    page.innerHTML = '<div class="pe-wrap"><div class="pe-head"><div><h2>Personas</h2><p class="pe-sub">Personas from your Sales Navigator "Recommended Leads"</p></div>' +
      '<button class="pe-btn" data-refresh type="button">Read them now</button></div><div class="pe-body"></div></div>';
    anyView.parentNode.appendChild(page);
    page.addEventListener('click', function (e) {
      if (e.target.closest('[data-refresh]')) refreshNow(page);
      else if (e.target.closest('[data-ai]')) { var o = page.querySelector('[data-ai-out]'); if (o) o.innerHTML = '<span class="pe-muted">Thinking...</span>'; load(page, true); }
    });
    btn.addEventListener('click', function () {
      if (typeof window.showView === 'function') { try { window.showView('personas'); } catch (e) {} }
      else {
        document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
        document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('active'); });
        page.classList.add('active'); btn.classList.add('active');
      }
      var sb = document.querySelector('.sidebar'); if (sb) sb.classList.remove('open');
      if (!loaded) load(page, false);
    });
  }
  // Intelligence (item 8) builds its nav entry on load too - wait for it so Personas sits right after it.
  function start() { if (document.getElementById('nav-intelligence') || !document.querySelector('script[src*="intelligence.js"]')) build(); else setTimeout(build, 0); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 0); }); else setTimeout(start, 0);
})();
