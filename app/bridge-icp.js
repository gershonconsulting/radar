// app/bridge-icp.js - Radar app v1.19.0 (2026-10-29)
// + source company of each bridge, and a 'best source companies' table (Olivier 2026-10-29).
// "Which bridges bring your ICP" panel on the Bridges page + a verdict badge on each bridge row.
// Olivier 2026-10-28/29: Radar must learn which bridges bring ICP prospects and push those harder;
// the report is PER USER - each account sees only its own bridges (owner from the session, server-side).
// Data: GET /api/bridge-icp (functions/api/bridge-icp.js). Loaded by functions/_middleware.js (item 7).
(function(){
  if (window.__radarBridgeIcp) return; window.__radarBridgeIcp = true;
  var DATA = null, LOADING = false, OPEN = true;
  try { OPEN = localStorage.getItem('radar_icp_panel') !== 'closed'; } catch (x) {}
  var V = {
    focus:      ['icp-focus', 'Focus \u2014 high intensity'],
    normal:     ['icp-keep',  'Keep normal'],
    slow:       ['icp-slow',  'Slow down'],
    cant_judge: ['icp-cant',  'Not enough data yet']
  };
  function e(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function n(s){ return String(s||'').replace(/\s+was last active.*$/i,'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
  function src(r){ var x = String(r.source||''); return x==='Manual' ? 'Added by hand' : (x || 'Unknown source'); }
  function pct(r){ return r.scorable ? Math.round(100*r.icp/r.scorable)+'%' : '\u2014'; }

  var css = document.createElement('style');
  css.textContent =
    '#icpPanel{margin:0 0 16px;border:1px solid #eee;background:#fff;border-radius:12px;padding:14px 16px}'+
    '#icpPanel h3{margin:0 0 2px;font-size:1rem;color:#1e293b}#icpPanel .icp-sub{font-size:.8rem;color:#64748b;margin:0 0 12px}'+
    '#icpPanel .icp-kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px}#icpPanel .icp-kpis div{flex:1;min-width:120px;background:#fafafa;border-radius:10px;padding:8px 10px;font-size:.75rem;color:#64748b}'+
    '#icpPanel .icp-kpis b{display:block;font-size:1.25rem;color:#1e293b}'+
    '#icpPanel .icp-todo{font-size:.82rem;color:#334155;margin:0 0 10px;padding-left:18px}#icpPanel .icp-todo li{margin:3px 0}'+
    '#icpPanel .icp-tw{overflow-x:auto}#icpPanel table{width:100%;border-collapse:collapse;font-size:.8rem}'+
    '#icpPanel th,#icpPanel td{padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:left;white-space:nowrap}'+
    '#icpPanel th{color:#64748b;font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.03em}#icpPanel .r{text-align:right}'+
    '#icpPanel .icp-toggle{float:right;font-size:.75rem;color:#CC3333;cursor:pointer;background:none;border:0}'+
    '#icpPanel .icp-more{font-size:.75rem;color:#CC3333;cursor:pointer;background:none;border:0;padding:6px 0 0}'+
    '.icp-b{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.68rem;font-weight:700;white-space:nowrap;vertical-align:middle}'+
    '.icp-focus{background:#e3f6e8;color:#1a7a35}.icp-keep{background:#eef1f6;color:#3b4a63}.icp-slow{background:#fde8e8;color:#b02a2a}.icp-cant{background:#f3f3f3;color:#777}'+
    '.bridge-row .icp-b{margin-left:6px}#icpPanel .muted{color:#94a3b8;font-size:.72rem}';
  document.head.appendChild(css);

  function load(){
    if (LOADING || DATA) return; LOADING = true;
    fetch('/api/bridge-icp', { credentials: 'same-origin', cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){ DATA = d && d.success ? d : { success:false, error:(d&&d.error)||'unavailable' }; })
      .catch(function(err){ DATA = { success:false, error:String(err) }; })
      .then(function(){ LOADING = false; paint(); });
  }

  function panelHtml(){
    if (!DATA) return '<h3>Which bridges bring your ICP</h3><p class="icp-sub">Loading\u2026</p>';
    if (!DATA.success) return '<h3>Which bridges bring your ICP</h3><p class="icp-sub">Not available right now ('+e(DATA.error)+').</p>';
    var rows = DATA.bridges || [], t = DATA.totals || {};
    var head = '<button class="icp-toggle" id="icpToggle">'+(OPEN?'Hide':'Show')+'</button><h3>Which bridges bring your ICP</h3>'+
      '<p class="icp-sub">'+(DATA.icp ? 'Your ICP: '+e(DATA.icp)+'. ' : '')+'Radar grades every prospect against your ICP and ranks your bridges by how many ICP prospects they bring.</p>';
    if (!OPEN) return head;
    if (!rows.length) return head + '<p class="icp-sub">No prospects collected yet - the ranking appears once your bridges start bringing prospects.</p>';
    var foc = rows.filter(function(r){ return r.verdict==='focus'; });
    var slow = rows.filter(function(r){ return r.verdict==='slow'; });
    var cant = rows.filter(function(r){ return r.verdict==='cant_judge' && r.prospects>=20; });
    var todo = [];
    if (foc.length) todo.push('<b>High intensity:</b> '+foc.slice(0,6).map(function(r){ return e(r.bridge)+' \u00b7 '+e(src(r))+' ('+r.icp+' ICP)'; }).join(', ')+' - their networks match your ICP best.');
    else todo.push('<b>No bridge has proven itself yet</b> - a bridge needs 10+ prospects with a job title and a 60%+ hit rate.');
    if (slow.length) todo.push('<b>Slow down:</b> '+slow.map(function(r){ return e(r.bridge)+' \u00b7 '+e(src(r))+' ('+r.icp+' of '+r.scorable+')'; }).join(', ')+' - their connections rarely match your ICP.');
    if (cant.length) todo.push('<b>'+cant.length+' bridge(s) not judged yet</b> - most of their older prospects have no job title. New collections always include it, so they will get a verdict soon.');
    var agg = {}; rows.forEach(function(r){ var k = src(r); var a = agg[k] || (agg[k] = {n:0,p:0,s:0,i:0}); a.n++; a.p += +r.prospects||0; a.s += +r.scorable||0; a.i += +r.icp||0; });
    var srcRows = Object.keys(agg).map(function(k){ return [k, agg[k]]; }).sort(function(x,y){ return (y[1].i - x[1].i) || (y[1].p - x[1].p); }).slice(0, 8);
    var srcTbl = '<h4 style="margin:12px 0 6px;font-size:.85rem;color:#1e293b">Your best source companies</h4><div class="icp-tw"><table><thead><tr><th>Source company</th><th class="r">Bridges</th><th class="r">Prospects</th><th class="r">ICP</th><th class="r">Hit rate</th></tr></thead><tbody>' +
      srcRows.map(function(x){ var a = x[1]; return '<tr><td>'+e(x[0])+'</td><td class="r">'+a.n+'</td><td class="r">'+a.p+'</td><td class="r"><b>'+a.i+'</b></td><td class="r">'+(a.s?Math.round(100*a.i/a.s)+'%':'\u2014')+'</td></tr>'; }).join('') + '</tbody></table></div><h4 style="margin:12px 0 6px;font-size:.85rem;color:#1e293b">Your bridges</h4>';
    var shown = window.__icpAll ? rows : rows.slice(0, 15);
    var tr = shown.map(function(r){
      var v = V[r.verdict] || V.cant_judge;
      return '<tr><td>'+e(String(r.bridge).replace(/\s+was last active.*$/i,''))+'</td><td>'+e(src(r))+'</td><td class="r">'+r.prospects+'</td><td class="r">'+r.scorable+'</td><td class="r"><b>'+r.icp+'</b></td><td class="r">'+pct(r)+'</td><td><span class="icp-b '+v[0]+'">'+v[1]+'</span></td></tr>';
    }).join('');
    return head +
      '<div class="icp-kpis"><div><b>'+(t.prospects||0).toLocaleString()+'</b>prospects</div><div><b>'+(t.scorable||0).toLocaleString()+'</b>with a job title</div>'+
      '<div><b>'+(t.icp||0).toLocaleString()+'</b>match your ICP</div><div><b>'+(t.scorable?Math.round(100*t.icp/t.scorable):0)+'%</b>hit rate</div></div>'+
      '<ul class="icp-todo">'+todo.map(function(x){ return '<li>'+x+'</li>'; }).join('')+'</ul>'+srcTbl+
      '<div class="icp-tw"><table><thead><tr><th>Bridge</th><th>Source company</th><th class="r">Prospects</th><th class="r">With title</th><th class="r">ICP</th><th class="r">Hit rate</th><th>Verdict</th></tr></thead><tbody>'+tr+'</tbody></table></div>'+
      (rows.length>15 ? '<button class="icp-more" id="icpMore">'+(window.__icpAll?'Show top 15':'Show all '+rows.length+' bridges')+'</button>' : '')+
      '<p class="muted">Focus = 60%+ hit rate with 10+ ICP prospects \u00b7 Slow down = under 30% \u00b7 Not enough data yet = fewer than 10 prospects with a job title.</p>';
  }

  function badgeRows(){
    if (!DATA || !DATA.success) return;
    var map = {}; (DATA.bridges||[]).forEach(function(r){ map[n(r.bridge)] = r; });
    document.querySelectorAll('#bridgesBody .bridge-row').forEach(function(row){
      if (row.querySelector('.icp-b')) return;
      var nm = row.querySelector('.nm'); if (!nm) return;
      var r = map[n(nm.textContent.replace(/\u2197/g,''))]; if (!r) return;
      var v = V[r.verdict] || V.cant_judge;
      var b = document.createElement('span'); b.className = 'icp-b '+v[0];
      b.textContent = r.verdict==='cant_judge' ? 'ICP: not enough data' : (v[1].split(' \u2014')[0]+' \u00b7 '+pct(r)+' ICP');
      b.title = r.icp+' ICP prospects out of '+r.scorable+' with a job title ('+r.prospects+' collected)';
      nm.appendChild(b);
    });
  }

  function paint(){
    var body = document.getElementById('bridgesBody'); if (!body) return;
    var p = document.getElementById('icpPanel');
    if (!p) { p = document.createElement('div'); p.id = 'icpPanel'; var ctl = body.parentNode.querySelector('.bridges-controls') || body; ctl.parentNode.insertBefore(p, ctl); }
    p.innerHTML = panelHtml();
    var tg = document.getElementById('icpToggle');
    if (tg) tg.onclick = function(){ OPEN = !OPEN; try { localStorage.setItem('radar_icp_panel', OPEN?'open':'closed'); } catch(x){} paint(); };
    var mo = document.getElementById('icpMore');
    if (mo) mo.onclick = function(){ window.__icpAll = !window.__icpAll; paint(); };
    badgeRows();
  }

  function tick(){
    var body = document.getElementById('bridgesBody');
    if (!body || !body.offsetParent) return;      // Bridges page not visible
    if (!DATA) { load(); if (!document.getElementById('icpPanel')) paint(); return; }
    if (!document.getElementById('icpPanel')) paint(); else badgeRows();
  }
  setInterval(tick, 1200);
  if (document.readyState !== 'loading') tick(); else document.addEventListener('DOMContentLoaded', tick);
})();
