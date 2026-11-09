// app/sources-list.js — Radar app v1.14.1 (nightly 2026-10-20)
// v1.14.1: Priority picker (High/Medium/Low, default Medium) on the "Add a Source" form.
// Sources view as a PRIORITY LIST: newest first, editable High/Medium/Low priority, and an
// Effectiveness status per source. Loaded into /app by functions/_middleware.js (same on-the-fly
// pattern already used for LATEST_EXT_VERSION) so the 260 KB app.html did not have to be
// re-uploaded. It REPLACES renderSources() and requestBridges() from app.html — global function
// declarations in a later classic script overwrite the earlier ones, and app.html calls them by
// name at run time. When app.html is next edited by hand, fold this file into it and drop the
// middleware injection.
(function(){
  // 1) Styles
  try {
    var st = document.createElement('style');
    st.id = 'radar-sources-list-css';
    st.textContent = '/* ---------- Sources priority list (v1.14.0) ---------- */\n:root{ --gershon-red:#FE1B04; }\n.src-list-controls{ margin-top:22px; }\n.src-table-wrap{ overflow-x:auto; }\n.src-table{ min-width:900px; }\n.src-table th, .src-table td{ padding:8px 9px; }\n.src-table td:nth-child(2){ min-width:170px; }\n.src-table td{ vertical-align:middle; }\n.src-table .src-nm{ font-weight:600; color:#1e293b; }\n.src-table .src-nm .dot{ display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:8px; vertical-align:middle; }\n.src-table .src-sub{ font-size:0.76rem; color:var(--muted); margin-top:2px; }\n.src-table .num{ font-variant-numeric:tabular-nums; text-align:right; }\n.src-table th.num{ text-align:right; }\n.src-table .muted{ color:#94a3b8; }\n.src-table .new-tag{ display:inline-block; margin-left:6px; padding:0 6px; border-radius:6px; font-size:0.66rem; font-weight:700; background:#fff1ef; color:var(--gershon-red); border:1px solid #ffc9c0; vertical-align:middle; }\n.prio-sel{ appearance:none; -webkit-appearance:none; border:1px solid; border-radius:12px; padding:3px 22px 3px 10px; font-size:0.74rem; font-weight:700; cursor:pointer; font-family:inherit;\n  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);\n  background-position:calc(100% - 11px) 50%, calc(100% - 7px) 50%; background-size:4px 4px; background-repeat:no-repeat; }\n.prio-sel.p-high{ background-color:#fff1ef; color:var(--gershon-red); border-color:#ffb3a6; }\n.prio-sel.p-medium{ background-color:#fff7ed; color:#b45309; border-color:#fed7aa; }\n.prio-sel.p-low{ background-color:#f1f5f9; color:#475569; border-color:#cbd5e1; }\n.prio-sel:disabled{ opacity:.6; cursor:wait; }\n.prio-msg{ display:block; font-size:0.7rem; margin-top:3px; }\n.prio-msg.ok{ color:#15803d; } .prio-msg.err{ color:#dc2626; }\n.eff{ display:inline-flex; align-items:center; gap:6px; padding:2px 10px; border-radius:12px; font-size:0.74rem; font-weight:700; border:1px solid; cursor:help; white-space:nowrap; }\n.eff::before{ content:""; width:7px; height:7px; border-radius:50%; background:currentColor; }\n.eff.e-strong{ background:#ecfdf5; color:#047857; border-color:#a7f3d0; }\n.eff.e-average{ background:#fffbeb; color:#b45309; border-color:#fde68a; }\n.eff.e-weak{ background:#fff1ef; color:var(--gershon-red); border-color:#ffb3a6; }\n.eff.e-none{ background:#f1f5f9; color:#64748b; border-color:#e2e8f0; }\n.eff-why{ display:block; font-size:0.72rem; color:var(--muted); margin-top:3px; min-width:170px; max-width:230px; line-height:1.35; }\n.src-rule{ font-size:0.78rem; color:var(--muted); margin:8px 2px 0; line-height:1.5; }\n.src-rule b{ color:#334155; }\n.src-table .btn-secondary{ padding:4px 10px; font-size:0.74rem; white-space:nowrap; }\n.src-table .src-bridge-note{ max-width:220px; }\n';
    document.head.appendChild(st);
  } catch(e){}
  // 2) Markup: swap the card grid for filter controls + a list container + the rule footer.
  try {
    var old = document.getElementById('sourcesBody');
    if (old && old.classList.contains('card-grid')) {
      var wrap = document.createElement('div');
      wrap.innerHTML = '<div class="table-controls src-list-controls">\n  <input type="text" id="srcSearch" placeholder="Search sources…" oninput="renderSources()">\n  <select id="srcPrioFilter" onchange="renderSources()" title="Filter by priority">\n    <option value="">All priorities</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>\n  </select>\n  <select id="srcEffFilter" onchange="renderSources()" title="Filter by effectiveness">\n    <option value="">All statuses</option><option value="strong">Strong</option><option value="average">Average</option><option value="weak">Weak</option><option value="none">No data yet</option>\n  </select>\n  <span class="result-count" id="srcCount"></span>\n</div>' + '<div id="sourcesBody"></div><p class="src-rule" id="srcRule"></p>';
      var parent = old.parentNode;
      while (wrap.firstChild) parent.insertBefore(wrap.firstChild, old);
      parent.removeChild(old);
    }
  } catch(e){}
  // 3) Build stamp
  try { var v = document.getElementById('sideVer'); if (v) v.textContent = 'v1.14.1'; } catch(e){}
  // 4) v1.14.1 — Priority picker on the "Add a Source" form (sits right under the URL field).
  try {
    var urlIn = document.getElementById('srcUrl');
    var urlField = urlIn && urlIn.closest('.field');
    if (urlField && !document.getElementById('srcPriority')) {
      var f = document.createElement('div');
      f.className = 'field';
      f.innerHTML = '<label>Priority</label>' +
        '<select id="srcPriority" title="How important this source is to you — you can change it later in the list">' +
          '<option value="high">High</option><option value="medium" selected>Medium</option><option value="low">Low</option>' +
        '</select>';
      urlField.parentNode.insertBefore(f, urlField.nextSibling);
      var ps = document.getElementById('srcPriority');
      ps.addEventListener('change', function(){ ps.setAttribute('data-touched', '1'); });
    }
  } catch(e){}
})();

// v1.14.1 — send the picked priority with addSource. Hub v23's addSource writes `priority` on
// create (same upsert row), so no second call is needed. addSource is an UPSERT: for a source
// that already exists, the priority is only sent if the picker was actually changed, so re-adding
// an existing High source does not silently reset it to Medium.
(function(){
  if (window.__srcPrioWrap) return;
  window.__srcPrioWrap = true;
  var _f = window.fetch;
  window.fetch = function(input, init){
    var pick = null;
    try {
      var u = (typeof input === 'string') ? input : (input && input.url) || '';
      var sel = document.getElementById('srcPriority');
      if (sel && init && typeof init.body === 'string' && typeof CONFIG !== 'undefined' && u.indexOf(CONFIG.WEBAPP_URL) === 0) {
        var b = JSON.parse(init.body);
        if (b && b.action === 'addSource' && b.priority === undefined) {
          var exists = (typeof STORED_SOURCES !== 'undefined' && STORED_SOURCES || []).some(function(s){ return _norm(s.name) === _norm(b.name); });
          if (!exists || sel.getAttribute('data-touched') === '1') {
            b.priority = SRC_PRIO_LABEL[sel.value] ? sel.value : 'medium';
            init = Object.assign({}, init, { body: JSON.stringify(b) });
          }
          pick = sel;
        }
      }
    } catch(e){}
    var p = _f.call(this, input, init);
    if (pick) {
      p.then(function(r){ return r.clone().json(); }).then(function(d){
        if (d && d.saved) { pick.value = 'medium'; pick.removeAttribute('data-touched'); }
      }).catch(function(){});
    }
    return p;
  };
})();

// ===== Sources: priority list, newest first, effectiveness status (v1.14.0) =====
// Olivier 2026-10-14: "Sources should carry a priority (High / Medium / Low), shown as a LIST
// (not cards) with the NEWEST source first, each with a status reflecting how effective that
// source has been." Priority is stored in sources.priority (hub v23: getSources returns it,
// setSourcePriority saves it). Effectiveness is computed here from data already loaded:
// targets (ROWS) attributed to the source, active bridges (BRIDGES), last 30 days.
const SRC_PRIO_LABEL = { high:'High', medium:'Medium', low:'Low' };
const SRC_PRIO_RANK  = { high:3, medium:2, low:1 };
const SRC_EFF_LABEL  = { strong:'Strong', average:'Average', weak:'Weak', none:'No data yet' };
const SRC_EFF_RANK   = { strong:4, average:3, weak:2, none:1 };
const SRC_EFF_STRONG = 15;   // prospects per active bridge in the last 30 days
const SRC_EFF_AVG    = 5;
const SRC_EFF_GRACE_DAYS = 14;   // a source this young with nothing collected is "No data yet", not "Weak"
const SRC_EFF_RULE =
  'Effectiveness = prospects collected in the last 30 days per active bridge in that source. ' +
  'Strong: ' + SRC_EFF_STRONG + '+ per bridge. Average: ' + SRC_EFF_AVG + '–' + (SRC_EFF_STRONG - 1) + ' per bridge. ' +
  'Weak: under ' + SRC_EFF_AVG + ' per bridge, nothing in 30 days, or bridges but no prospects after ' + SRC_EFF_GRACE_DAYS + ' days. ' +
  'No data yet: no bridges and no prospects, or added less than ' + SRC_EFF_GRACE_DAYS + ' days ago with nothing collected.';
let SRC_SORT = { key:'added', dir:-1 };   // newest first by default
try { const sv = JSON.parse(localStorage.getItem('radar_src_sort') || 'null'); if (sv && sv.key) SRC_SORT = sv; } catch(e){}

function srcPriority(name){
  const s = (STORED_SOURCES || []).find(x => _norm(x.name) === _norm(name));
  const p = s && String(s.priority || '').toLowerCase();
  return SRC_PRIO_LABEL[p] ? p : 'medium';   // column default is 'medium'
}
function _daysAgo(d){ const t = d ? new Date(d).getTime() : NaN; return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000); }

// One record per source with everything the list shows.
function sourceListRows(){
  const now = Date.now(), d30 = now - 30*86400000;
  const recs = {};
  const ensure = name => (recs[_norm(name)] = recs[_norm(name)] || { name: name, stored: null, added: '', bridgesAll: 0, bridgesActive: 0, leads: 0, leads30: 0, last: '' });
  (STORED_SOURCES || []).forEach(s => { const r = ensure(s.name); r.stored = s; r.added = s.added_date || ''; });
  (BRIDGES || []).forEach(b => {
    if (!b || !b.source) return;
    const k = _norm(b.source); if (!recs[k]) return;   // only count bridges under tracked sources
    recs[k].bridgesAll++; if (b.active) recs[k].bridgesActive++;
  });
  (ROWS || []).forEach(row => {
    const src = leadSource(row) || 'Unassigned';
    const r = ensure(src);
    r.leads++;
    const t = row.collected_date ? new Date(row.collected_date).getTime() : NaN;
    if (!isNaN(t)) {
      if (t >= d30) r.leads30++;
      if (!r.last || t > new Date(r.last).getTime()) r.last = row.collected_date;
    }
  });
  // Bridges that produced targets but are not in BRIDGES (older data) still count as bridges.
  const byBridge = bridgeCounts();
  Object.keys(byBridge).forEach(b => {
    if (!b || b === '—') return;
    const k = _norm(bridgeSource(b)); const r = recs[k];
    if (r && r.bridgesAll === 0) r.bridgesFromTargets = (r.bridgesFromTargets || 0) + 1;
  });
  return Object.values(recs)
    .filter(r => r.stored || (r.leads > 0 && r.name))
    .map(r => {
      r.priority = r.stored ? srcPriority(r.name) : '';
      r.bridges = r.bridgesActive || r.bridgesAll || r.bridgesFromTargets || 0;
      r.perBridge = r.bridges ? r.leads30 / r.bridges : r.leads30;
      Object.assign(r, sourceEffectiveness(r));
      return r;
    });
}

function sourceEffectiveness(r){
  const age = _daysAgo(r.added);
  const lastAgo = _daysAgo(r.last);
  const pb = Math.round(r.perBridge * 10) / 10;
  const per = r.bridges ? (pb + ' per active bridge') : (r.leads30 + ' collected');
  if (!r.bridges && !r.leads) return { eff:'none', why:'No bridges found and nothing collected yet.' };
  if (!r.leads && age !== null && age < SRC_EFF_GRACE_DAYS) return { eff:'none', why:'Added ' + age + ' day' + (age===1?'':'s') + ' ago — ' + r.bridges + ' bridge' + (r.bridges===1?'':'s') + ', first collection still to come.' };
  if (!r.leads) return { eff:'weak', why: r.bridges + ' bridge' + (r.bridges===1?'':'s') + ' but no prospects collected' + (age !== null ? ' in ' + age + ' days.' : '.') };
  if (!r.leads30) return { eff:'weak', why:'Nothing collected in the last 30 days' + (lastAgo !== null ? ' (last ' + lastAgo + ' days ago).' : '.') };
  if (r.perBridge >= SRC_EFF_STRONG) return { eff:'strong', why: r.leads30 + ' prospects in 30 days — ' + per + '.' };
  if (r.perBridge >= SRC_EFF_AVG)    return { eff:'average', why: r.leads30 + ' prospects in 30 days — ' + per + '.' };
  return { eff:'weak', why:'Only ' + r.leads30 + ' prospect' + (r.leads30===1?'':'s') + ' in 30 days — ' + per + '.' };
}

function setSourceSort(key){
  if (SRC_SORT.key === key) SRC_SORT.dir = -SRC_SORT.dir;
  else SRC_SORT = { key: key, dir: (key === 'name') ? 1 : -1 };
  try { localStorage.setItem('radar_src_sort', JSON.stringify(SRC_SORT)); } catch(e){}
  renderSources();
}

function renderSources(){
  const sBody = document.getElementById('sourcesBody');
  if (!sBody) return;
  const rule = document.getElementById('srcRule');
  if (rule) rule.innerHTML = '<b>How the status is worked out:</b> ' + esc(SRC_EFF_RULE);
  const all = sourceListRows();
  const countEl = document.getElementById('srcCount');
  if (!all.length) {
    if (countEl) countEl.textContent = '';
    if (rule) rule.style.display = 'none';
    sBody.innerHTML =
    '<div class="coach">' +
      '<h3>No sources yet — this is where Radar starts</h3>' +
      '<p>A <strong>Source</strong> is an organization whose network is full of your buyers. Not a company you want to sell to — a company whose <em>people already know</em> the people you want to sell to.</p>' +
      '<ul>' +
        '<li>A consulting or advisory firm that serves your market</li>' +
        '<li>An accelerator, incubator, or investor whose portfolio is full of your buyers</li>' +
        '<li>A trade association, chamber, or club your customers belong to</li>' +
        '<li>A partner who sells alongside you — or a competitor, whose network is by definition your market</li>' +
      '</ul>' +
      '<p>Paste its LinkedIn company URL in the box above. Radar names it, finds the senior people inside it (your <strong>bridges</strong>), and starts collecting the prospects in their networks.</p>' +
      '<button class="btn-secondary" onclick="openTour(1)">See how Radar works →</button>' +
    '</div>';
    return;
  }
  if (rule) rule.style.display = '';

  const q  = _norm((document.getElementById('srcSearch') || {}).value || '');
  const fp = (document.getElementById('srcPrioFilter') || {}).value || '';
  const fe = (document.getElementById('srcEffFilter') || {}).value || '';
  let list = all.filter(r =>
    (!q || _norm(r.name).indexOf(q) >= 0) &&
    (!fp || r.priority === fp) &&
    (!fe || r.eff === fe));

  const k = SRC_SORT.key, dir = SRC_SORT.dir;
  const val = r => {
    switch (k) {
      case 'name':     return _norm(r.name);
      case 'priority': return SRC_PRIO_RANK[r.priority] || 0;
      case 'eff':      return (SRC_EFF_RANK[r.eff] || 0) * 1e6 + r.perBridge;
      case 'bridges':  return r.bridges;
      case 'leads30':  return r.leads30;
      case 'leads':    return r.leads;
      case 'per':      return r.perBridge;
      case 'last':     return r.last ? new Date(r.last).getTime() : 0;
      default:         return r.added ? new Date(r.added).getTime() : 0;   // 'added'
    }
  };
  list.sort((a, b) => {
    // Pseudo-sources with no stored record (e.g. "Unassigned") always sit at the bottom.
    if (!!a.stored !== !!b.stored) return a.stored ? -1 : 1;
    const va = val(a), vb = val(b);
    if (va < vb) return -dir; if (va > vb) return dir;
    return (new Date(b.added || 0).getTime() - new Date(a.added || 0).getTime()) || _norm(a.name).localeCompare(_norm(b.name));
  });
  if (countEl) countEl.textContent = list.length + (list.length === all.length ? '' : ' of ' + all.length) + ' source' + (all.length===1?'':'s');

  const th = (key, label, cls, tip) =>
    '<th class="sortable' + (SRC_SORT.key === key ? ' sorted' : '') + (cls ? ' ' + cls : '') + '"' + (tip ? ' title="' + esc(tip) + '"' : '') +
    ' onclick="setSourceSort(\'' + key + '\')">' + label + ' <span class="arrow">' + (SRC_SORT.key === key ? (SRC_SORT.dir < 0 ? '▼' : '▲') : '↕') + '</span></th>';

  const rows = list.map(r => {
    const s = r.name, st = r.stored || {};
    const age = _daysAgo(r.added);
    const link = st.linkedin_url ? '<a href="' + esc(st.linkedin_url) + '" target="_blank" rel="noopener">↗ company</a>'
               : (st.website ? '<a href="' + esc(st.website) + '" target="_blank" rel="noopener">↗ website</a>' : '');
    const cat = st.category ? '<span class="pill ' + esc(st.category) + '">' + esc(st.category) + '</span>' : '';
    const sub = [link, cat].filter(Boolean).join(' · ');
    const prio = r.stored
      ? '<select class="prio-sel p-' + r.priority + '" data-src="' + esc(s) + '" onchange="onSourcePriority(this)" title="Priority for ' + esc(s) + '">' +
          ['high','medium','low'].map(p => '<option value="' + p + '"' + (p === r.priority ? ' selected' : '') + '>' + SRC_PRIO_LABEL[p] + '</option>').join('') +
        '</select><span class="prio-msg"></span>'
      : '<span class="muted" title="Not a tracked source — prospects whose bridge has no source">—</span>';
    const effTip = SRC_EFF_LABEL[r.eff] + ': ' + r.why + '\n\n' + SRC_EFF_RULE;
    const eff = '<span class="eff e-' + r.eff + '" title="' + esc(effTip) + '">' + SRC_EFF_LABEL[r.eff] + '</span><span class="eff-why">' + esc(r.why) + '</span>';
    const added = r.added
      ? '<span title="' + esc(new Date(r.added).toLocaleString()) + '">' + esc(fmtDate(r.added)) + '</span>' + (age !== null && age < 7 ? '<span class="new-tag">NEW</span>' : '')
      : '<span class="muted">—</span>';
    const btn = r.stored ? '<button class="btn-secondary" title="Queue bridge discovery for this source on the next sync" onclick="requestBridges(this,\'' + jsq(s) + '\')">🧭 Find</button><div class="src-bridge-note" data-note style="display:none"></div>' : '';
    return '<tr data-src="' + esc(s) + '">' +
      '<td>' + added + '</td>' +
      '<td><div class="src-nm"><span class="dot" style="background:' + sourceColor(s) + '"></span>' + esc(s) + '</div>' + (sub ? '<div class="src-sub">' + sub + '</div>' : '') + '</td>' +
      '<td>' + prio + '</td>' +
      '<td>' + eff + '</td>' +
      '<td class="num"><a href="#" onclick="statGo(\'bridges\',\'\');return false" title="Active bridges in ' + esc(s) + '">' + r.bridges + '</a></td>' +
      '<td class="num">' + r.leads30 + '</td>' +
      '<td class="num"><a href="#" onclick="homeGoSource(\'' + jsq(s) + '\');return false" title="Open Prospects filtered on ' + esc(s) + '">' + r.leads + '</a></td>' +
      '<td class="num">' + (r.bridges ? (Math.round(r.perBridge * 10) / 10) : '<span class="muted">—</span>') + '</td>' +
      '<td>' + (r.last ? esc(fmtDate(r.last)) : '<span class="muted">never</span>') + '</td>' +
      '<td>' + btn + '</td>' +
    '</tr>';
  }).join('');

  sBody.innerHTML =
    '<div class="table-wrap src-table-wrap"><table class="src-table" id="srcTable"><thead><tr>' +
      th('added', 'Added', '', 'Date the source was added — newest first by default') +
      th('name', 'Source') +
      th('priority', 'Priority', '', 'High / Medium / Low — change it in the row; it is saved to your account') +
      th('eff', 'Effectiveness', '', SRC_EFF_RULE) +
      th('bridges', 'Bridges', 'num', 'Active bridges in this source') +
      th('leads30', 'Prospects 30d', 'num', 'Prospects collected in the last 30 days') +
      th('leads', 'Prospects', 'num', 'All prospects ever collected via this source') +
      th('per', 'Per bridge', 'num', 'Prospects in the last 30 days ÷ active bridges') +
      th('last', 'Last collected') +
      '<th></th>' +
    '</tr></thead><tbody>' +
    (rows || '<tr><td colspan="10" class="muted" style="text-align:center;padding:18px">No source matches these filters.</td></tr>') +
    '</tbody></table></div>';
}

// Save a source's priority (hub v23 action setSourcePriority). Optimistic; reverts on failure.
async function onSourcePriority(sel){
  const name = sel.getAttribute('data-src');
  const pr = sel.value;
  const src = (STORED_SOURCES || []).find(x => _norm(x.name) === _norm(name));
  const prev = src ? (src.priority || 'medium') : 'medium';
  const msg = sel.parentNode.querySelector('.prio-msg');
  const say = (t, c) => { if (msg) { msg.textContent = t; msg.className = 'prio-msg' + (c ? ' ' + c : ''); } };
  sel.className = 'prio-sel p-' + pr;
  sel.disabled = true; say('Saving…', '');
  try {
    const resp = await fetch(CONFIG.WEBAPP_URL, { method:'POST', headers:{ 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret:'radar_7Kq3mZ9pX2vL8nT', action:'setSourcePriority', name: name, priority: pr }) });
    const d = await resp.json().catch(() => ({}));
    if (!resp.ok || !(d && (d.saved || d.ok))) throw new Error((d && d.error) || ('HTTP ' + resp.status));
    if (src) src.priority = pr;
    say('✓ Saved', 'ok');
    setTimeout(() => { if (SRC_SORT.key === 'priority' || ((document.getElementById('srcPrioFilter')||{}).value)) renderSources(); else say('', ''); }, 1200);
  } catch(e) {
    sel.value = prev; sel.className = 'prio-sel p-' + prev;
    say('Not saved: ' + e.message, 'err');
  } finally { sel.disabled = false; }
}


// Per-source "Find Bridges" (same behaviour as app.html; the note now lives in the table cell).
async function requestBridges(btnEl, sourceName){
  const card = btnEl.closest('.entity-card') || btnEl.closest('td');
  const note = card ? card.querySelector('[data-note]') : null;
  const setNote = (msg, cls) => {
    if (!note) return;
    note.style.display = 'block';
    note.className = 'src-bridge-note' + (cls ? ' ' + cls : '');
    note.textContent = msg;
  };
  const src = STORED_SOURCES.find(s => _norm(s.name) === _norm(sourceName));
  const orgId = src && src.org_id ? String(src.org_id).trim() : '';
  const url = src && src.linkedin_url ? String(src.linkedin_url).trim() : '';
  const kw = src && src.discover_keyword ? String(src.discover_keyword).trim() : '';
  if (!orgId && !url) { setNote('Add this source’s LinkedIn company URL first', 'warn'); return; }
  btnEl.disabled = true;
  setNote('Queuing…', '');
  try {
    const resp = await fetch(CONFIG.WEBAPP_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: 'radar_7Kq3mZ9pX2vL8nT', action: 'queueDiscover', name: sourceName, discover_keyword: kw })
    });
    const d = await resp.json();
    if (d && (d.saved || d.success)) {
      setNote(orgId
        ? '✓ Queued — bridges will be collected on the next sync (or click Find New Bridges in the extension).'
        : '✓ Queued — Radar resolves this company’s Sales Nav ID from its LinkedIn page on the next sync, then collects its bridges.', 'ok');
    } else {
      setNote('Error: ' + JSON.stringify(d), 'err');
      btnEl.disabled = false;
    }
  } catch(e) {
    setNote('Error: ' + e.message, 'err');
    btnEl.disabled = false;
  }
}

// If app.html already painted the Sources view before this file loaded, repaint it as a list.
try { if (typeof STORED_SOURCES !== 'undefined' && (STORED_SOURCES.length || (typeof ROWS !== 'undefined' && ROWS.length))) renderSources(); } catch(e){}
