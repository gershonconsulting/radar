// app/suggestions.js - Radar app v1.18.2 (2026-10-28)
// v1.18.2: items switched ON can be switched OFF again (Olivier: "I turned on one but I cannot turn it off").
// "Suggested by Gershon - OFF" panel on the Sources page.
// Olivier 2026-10-27: place the pre-analysis (ICP, competitor sources, bridges) on each client's
// account as OFF; the client switches items ON for the campaign.
// Data: config key `preanalysis_suggestions` (JSON written by Gershon).
// v1.18.1 (2026-10-28, hub v24): suggestions are ALSO real rows now - sources with category
// 'suggested' (hub hides them from the extension) and bridges with active=false - so they show in
// the Sources / Bridges lists. Those count as OFF; switching ON flips the same row (same name / urn):
// addSource with category competitor + discover_now, addBridges with the same urn and active:true.
// Loaded by functions/_middleware.js (item 6), like sources-list.js.
(function(){
  if (window.__radarSuggest) return; window.__radarSuggest = true;
  var SECRET = 'radar_7Kq3mZ9pX2vL8nT';
  var SUG = null, busy = {};
  function n(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
  function e(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function slug(s){ return n(s).replace(/ /g,'-').slice(0,60) || ('b'+Date.now()); }
  function stored(){ try { return (typeof STORED_SOURCES!=='undefined' && STORED_SOURCES) || []; } catch(x){ return []; } }
  function bridges(){ try { return (typeof BRIDGES!=='undefined' && BRIDGES) || []; } catch(x){ return []; } }
  function isSug(x){ return x.category==='suggested' || x.suggested===true; }
  function srcOn(s){ var k=n(s.name); return stored().some(function(x){ return n(x.name)===k && !isSug(x); }); }
  function brOn(b){ var k=n(b.name); return bridges().some(function(x){ return n(x.name)===k && x.active!==false && String(x.active)!=='false'; }); }
  function brRow(b){ var k=n(b.name); return bridges().find(function(x){ return n(x.name)===k; }); }

  var css = document.createElement('style');
  css.textContent = '#sugPanel{margin:18px 0 6px;border:1px solid #f1d4d0;background:#fffaf9;border-radius:12px;padding:14px 16px}'+
    '#sugPanel h3{margin:0 0 4px;font-size:1rem;color:#1e293b}#sugPanel .sug-sub{font-size:.8rem;color:#64748b;margin:0 0 10px}'+
    '#sugPanel .sug-icp{font-size:.8rem;color:#334155;background:#fff;border:1px solid #eee;border-radius:8px;padding:8px 10px;margin-bottom:10px}'+
    '#sugPanel table{width:100%;border-collapse:collapse;font-size:.8rem;background:#fff}#sugPanel th,#sugPanel td{padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:left;vertical-align:middle}'+
    '#sugPanel th{color:#64748b;font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.03em}'+
    '#sugPanel h4{margin:12px 0 6px;font-size:.85rem;color:#1e293b}'+
    '.sug-sw{display:inline-flex;align-items:center;gap:6px;border:1px solid #cbd5e1;border-radius:14px;padding:2px 10px;font-size:.72rem;font-weight:700;cursor:pointer;background:#f1f5f9;color:#475569;white-space:nowrap}'+
    '.sug-sw.on{background:#ecfdf5;border-color:#a7f3d0;color:#047857}.sug-sw:disabled{opacity:.6;cursor:wait}'+
    '.sug-sw::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}'+
    '#sugPanel .sug-toggle{float:right;font-size:.75rem;color:#CC3333;cursor:pointer;background:none;border:0}'+
    '#sugPanel .muted{color:#94a3b8}#sugPanel .sug-msg{font-size:.7rem;margin-left:6px}#sugPanel .sug-msg.err{color:#dc2626}';
  document.head.appendChild(css);

  function link(u, t){ return u ? '<a href="'+e(u)+'" target="_blank" rel="noopener">'+t+'</a>' : '<span class="muted">-</span>'; }

  function render(){
    if (!SUG) return;
    var body = document.getElementById('sourcesBody'); if (!body) return;
    var host = document.getElementById('sugPanel');
    if (!host){
      host = document.createElement('div'); host.id = 'sugPanel';
      var anchor = document.querySelector('.src-list-controls') || body;
      anchor.parentNode.insertBefore(host, anchor);
    }
    var srcs = SUG.sources||[], brs = SUG.bridges||[];
    var offS = srcs.filter(function(s){return !srcOn(s);}).length, offB = brs.filter(function(b){return !brOn(b);}).length;
    var collapsed = host.getAttribute('data-collapsed')==='1';
    var h = '<button class="sug-toggle" data-act="collapse">'+(collapsed?'Show':'Hide')+'</button>'+
      '<h3>Suggested by Gershon</h3>'+
      '<p class="sug-sub">Prepared by Gershon from our research'+(SUG.added?' ('+e(SUG.added)+')':'')+'. Everything here is <b>OFF</b> and collects nothing until you switch it <b>ON</b>. '+
      offS+' source'+(offS===1?'':'s')+' and '+offB+' bridge'+(offB===1?'':'s')+' still OFF.</p>';
    if (!collapsed){
      if (SUG.icp) h += '<div class="sug-icp"><b>Proposed ICP:</b> '+e(SUG.icp)+'</div>';
      if (srcs.length){
        h += '<h4>Competitor sources</h4><table><thead><tr><th>Company</th><th>Website</th><th>LinkedIn</th><th></th></tr></thead><tbody>';
        srcs.forEach(function(s,i){ var on=srcOn(s);
          h += '<tr><td><b>'+e(s.name)+'</b></td><td>'+link(s.website,'site')+'</td><td>'+link(s.linkedin,'company page')+'</td><td>'+
            (on ? '<button class="sug-sw on" data-act="srcoff" data-i="'+i+'" title="Switch OFF: Radar stops using this source and its bridges">ON - switch OFF</button><span class="sug-msg"></span>' : '<button class="sug-sw" data-act="src" data-i="'+i+'" title="Add as a source: Radar finds its bridges on the next sync">OFF - switch ON</button><span class="sug-msg"></span>')+'</td></tr>'; });
        h += '</tbody></table>';
      }
      if (brs.length){
        h += '<h4>Bridges</h4><table><thead><tr><th>Name</th><th>Role</th><th>LinkedIn</th><th></th></tr></thead><tbody>';
        brs.forEach(function(b,i){ var on=brOn(b);
          h += '<tr><td><b>'+e(b.name)+'</b></td><td>'+e([b.title,b.company].filter(Boolean).join(', '))+'</td><td>'+
            (b.linkedin ? link(b.linkedin,'profile') : link('https://www.linkedin.com/search/results/people/?keywords='+encodeURIComponent(b.name+' '+(b.company||'')),'search'))+'</td><td>'+
            (on ? '<button class="sug-sw on" data-act="broff" data-i="'+i+'" title="Switch OFF: Radar stops collecting through this bridge">ON - switch OFF</button><span class="sug-msg"></span>' : '<button class="sug-sw" data-act="br" data-i="'+i+'" title="Add as an active bridge">OFF - switch ON</button><span class="sug-msg"></span>')+'</td></tr>'; });
        h += '</tbody></table>';
      }
    }
    host.innerHTML = h;
  }

  async function post(payload){
    var r = await fetch(CONFIG.WEBAPP_URL, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify(Object.assign({secret:SECRET}, payload)) });
    var d = await r.json().catch(function(){return {};});
    if (!r.ok || !(d && (d.saved || d.ok || d.success))) throw new Error((d && d.error) || ('HTTP '+r.status));
    return d;
  }

  document.addEventListener('click', async function(ev){
    var b = ev.target.closest && ev.target.closest('#sugPanel [data-act]'); if (!b) return;
    var act = b.getAttribute('data-act');
    if (act==='collapse'){ var p=document.getElementById('sugPanel'); p.setAttribute('data-collapsed', p.getAttribute('data-collapsed')==='1'?'0':'1'); render(); return; }
    var i = +b.getAttribute('data-i'), key = act+i; if (busy[key]) return; busy[key]=1;
    var off = /off$/.test(act);
    var msg = b.nextElementSibling; b.disabled = true; b.textContent = off ? 'Switching OFF...' : 'Switching ON...';
    try {
      if (act==='srcoff'){
        // OFF = back to a suggestion: hub v24 hides category 'suggested' from the extension,
        // and every bridge found under it is deactivated so nothing is collected through it.
        var so = SUG.sources[i], sk = n(so.name);
        var row0 = stored().find(function(x){ return n(x.name)===sk; });
        var realName = row0 ? row0.name : so.name;
        await post({ action:'addSource', name: realName, category:'suggested' });
        if (row0) { row0.category='suggested'; row0.suggested=true; }
        var under = bridges().filter(function(x){ return n(x.source)===sk && x.active!==false && String(x.active)!=='false'; });
        for (var j=0;j<under.length;j++){ await post({ action:'setBridgeActive', urn: under[j].urn, active:false }); under[j].active=false; }
      } else if (act==='broff'){
        var bo = brRow(SUG.bridges[i]);
        if (bo) { await post({ action:'setBridgeActive', urn: bo.urn, active:false }); bo.active=false; }
      } else if (act==='src'){
        var s = SUG.sources[i];
        var d = await post({ action:'addSource', name:s.name, linkedin_url: s.linkedin || s.website || '', website: s.website || '', priority:'high', category:'competitor', discover_now:true });
        // Bridges Radar had found under it before it was switched OFF come back ON with it
        // (hand-picked suggested bridges keep their own switch).
        var back = bridges().filter(function(x){ return n(x.source)===n(s.name) && !/^manual:/.test(x.urn||'') && (x.active===false || String(x.active)==='false'); });
        for (var k=0;k<back.length;k++){ await post({ action:'setBridgeActive', urn: back[k].urn, active:true }); back[k].active=true; }
        var ex = stored().find(function(x){ return n(x.name)===n(s.name); });
        if (ex) { ex.category='competitor'; ex.suggested=false; ex.priority='high'; ex.discover_pending=true; }
        else stored().push({ name:s.name, linkedin_url:d.linkedin_url||s.linkedin||'', website:s.website||'', priority:'high', category:'competitor', added_date:new Date().toISOString(), discover_pending:true });
      } else {
        var br = SUG.bridges[i];
        var urnSlug = (br.linkedin && (br.linkedin.match(/\/in\/([^/?#]+)/)||[])[1]) || slug(br.name+' '+(br.company||''));
        try { urnSlug = decodeURIComponent(urnSlug); } catch(x){}
        var src = (SUG.sources||[]).find(function(s){ return br.company && n(br.company).indexOf(n(s.name).split(' ')[0])===0; });
        var row = brRow(br);
        var urn = row ? row.urn : 'manual:'+urnSlug;
        var srcName = row ? row.source : ((src && src.name) || br.company || 'Suggested');
        await post({ action:'addBridges', source: srcName, bridges:[{ urn:urn, name:br.name, title:br.title||'', linkedin_url: br.linkedin||null, active:true }] });
        if (row) row.active = true;
        else bridges().push({ source:srcName, name:br.name, title:br.title||'', urn:urn, linkedin_url:br.linkedin||'', active:true });
      }
      render();
      try { if (typeof renderSources==='function') renderSources(); } catch(x){}
    } catch(err){
      b.disabled=false; b.textContent= off ? 'ON - switch OFF' : 'OFF - switch ON'; if (msg){ msg.textContent='Not saved: '+err.message; msg.className='sug-msg err'; }
    } finally { delete busy[key]; }
  });

  async function load(){
    try {
      var txt = await fetch(CONFIG.WEBAPP_URL + '?callback=_cb&action=getConfig&_=' + Date.now()).then(function(r){return r.text();});
      var cfg = JSON.parse(txt.replace(/^_cb\(/,'').replace(/\)$/,''));
      if (!cfg || !cfg.preanalysis_suggestions) return;
      SUG = JSON.parse(cfg.preanalysis_suggestions);
      render();
    } catch(x){}
  }
  var tries = 0, lastSig = '';
  var t = setInterval(function(){
    tries++;
    if (typeof CONFIG !== 'undefined' && CONFIG.WEBAPP_URL && !SUG && tries % 3 === 1) load();
    // Repaint only when the account's sources/bridges change (e.g. after the app reloads its data),
    // so a click is never interrupted by a redraw.
    if (SUG) { var sig = stored().length + ':' + bridges().length + ':' + !!document.getElementById('sugPanel');
      if (sig !== lastSig) { lastSig = sig; render(); } }
    if (tries > 400) clearInterval(t);
  }, 3000);
})();
