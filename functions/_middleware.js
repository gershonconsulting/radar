// functions/_middleware.js (2026-09-23)
// 1) Serves extension builds that live in Supabase Storage (public bucket radar-releases) at the
//    usual /radar-extension-vX.Y.Z.zip path, so a release no longer needs a binary commit.
//    A zip committed to app/ still wins.
// 2) Keeps the download links / "outdated extension" checks on / and /app pointing at LATEST_EXT
//    without re-uploading the 260 KB app.html: an older LATEST_EXT_VERSION in the page is raised
//    to LATEST_EXT on the fly (never lowered). Bump LATEST_EXT here for the next release.
//    ⚑ 2026-10-26: LATEST_EXT had been left at 1.15.0 when 1.16.0/1.17.0 shipped (only Supabase
//    config latest_ext_version was bumped), so new users downloaded 1.15.0. Bump it HERE too.
// 3) (2026-10-20, app v1.14.1) Loads app/sources-list.js into the app page - Sources as a priority
//    list, newest first, with an effectiveness status, plus a Priority picker on Add a Source - and stamps the sidebar version, again
//    without re-uploading app.html. Only applies to a page that still has the old card grid
//    (`id="sourcesBody"` + `card-grid`) and does not already load the script, so it switches itself
//    off once the list is folded into app.html.
// 4) (2026-10-21, app v1.15.0) Unified Gershon design: links app/unified-theme.css (served at
//    /unified-theme.css) into the app page AND the landing page, so Radar looks like Linalysis
//    (the master design: white sidebar, solid-red active pill, white 12px cards) in the Gershon.ai
//    red #CC3333 - again without re-uploading app.html. Inserted once, before </head>, and only if
//    the page does not already reference unified-theme.css (so it switches itself off once the
//    theme is folded into the HTML). The sidebar version stamp is raised to APP_VERSION here too.
//    4b) Chart colours: the charts' colours live in app.html's JavaScript, so CSS cannot reach them.
//    CHART_RED swaps those exact literals (each unique in app.html) for the Gershon red family:
//    Dashboard trend line + 'targets per bridge' bars (PRIMARY/ACCENT), Home 'new prospects' trend,
//    Home 'top bridges' bars. Stage colours (Growth charts: sources green / bridges orange /
//    targets blue), ICP-grade colours and the per-source palette are deliberately NOT touched.
//    Exact-string swaps are idempotent: once replaced, the old literal is gone.
// 6) (2026-10-27, app v1.18.0) Loads app/suggestions.js into the app page: the "Suggested by
//    Gershon" panel on Sources (pre-analysis ICP, competitor sources and bridges, all OFF, each
//    with an ON switch). Only on the app page (has id="sourcesBody"), once.
//    v1.18.1 (2026-10-28): suggestions are real OFF rows too (hub v24). v1.18.2: ON items can be switched OFF.
//    v1.18.3: company / person names are clickable LinkedIn links (panel, Sources list, Bridges page).
// 7) (2026-10-29, app v1.19.0) Loads app/bridge-icp.js into the app page: "Which bridges bring your ICP"
//    panel on the Bridges page + a verdict badge per bridge (Focus / Keep / Slow down / Not enough data),
//    from /api/bridge-icp (owner from the session only - each account sees only its own bridges).
const LATEST_EXT = '1.17.0';
const RELEASES = 'https://pkzeeqehwmtnqxdpdesl.supabase.co/storage/v1/object/public/radar-releases/';
const HTML_PATHS = new Set(['/', '/index.html', '/app', '/app.html', '/app/app', '/app/app.html']);
const APP_VERSION = '1.19.0';
// Pages serves the app/ folder at the site root, so app/sources-list.js is /sources-list.js.
const SOURCES_LIST_SRC = '/sources-list.js?v=' + APP_VERSION;
const SUGGESTIONS_SRC = '/suggestions.js?v=' + APP_VERSION;
const BRIDGE_ICP_SRC = '/bridge-icp.js?v=' + APP_VERSION;
const THEME_HREF = '/unified-theme.css?v=' + APP_VERSION;
const CHART_RED = [
  // Dashboard (renderCharts): trend line colour + 'targets per bridge' bar colour
  ["const PRIMARY='#1e40af', ACCENT='#3b82f6';", "const PRIMARY='#a8281f', ACCENT='#CC3333';"],
  ["backgroundColor:'rgba(59,130,246,0.12)'", "backgroundColor:'rgba(204,51,51,0.12)'"],
  // Home: 'new prospects' trend line
  ["data:counts, borderColor:'#2563eb',", "data:counts, borderColor:'#CC3333',"],
  ["backgroundColor:'rgba(37,99,235,.12)'", "backgroundColor:'rgba(204,51,51,.12)'"],
  ["pointBackgroundColor:'#2563eb'", "pointBackgroundColor:'#CC3333'"],
  // Home: 'top bridges' leaderboard bars
  ["lbRows(topBrg, (()=> '#6366f1')", "lbRows(topBrg, (()=> '#CC3333')"]
];

function cmpVer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  if (url.pathname.startsWith('/api/')) return ctx.next();

  const zip = url.pathname.match(/^\/radar-extension-v(\d+\.\d+\.\d+)\.zip$/);
  if (zip) {
    const res = await ctx.next();
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.indexOf('text/html') === -1) return res;   // committed static zip
    try {
      const r = await fetch(RELEASES + 'radar-extension-v' + zip[1] + '.zip');
      if (!r.ok) return res;
      return new Response(r.body, { status: 200, headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="radar-extension-v' + zip[1] + '.zip"',
        'Cache-Control': 'no-cache'
      } });
    } catch (e) { return res; }
  }

  const res = await ctx.next();
  if (!HTML_PATHS.has(url.pathname) || res.status !== 200) return res;
  if ((res.headers.get('content-type') || '').indexOf('text/html') === -1) return res;
  try {
    const html = await res.clone().text();
    let out = html;
    const m = html.match(/LATEST_EXT_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/);
    if (m && cmpVer(m[1], LATEST_EXT) < 0) {
      const old = m[1];
      out = out
        .replace(/(LATEST_EXT_VERSION\s*=\s*')\d+\.\d+\.\d+(')/g, '$1' + LATEST_EXT + '$2')
        .split('/radar-extension-v' + old + '.zip').join('/radar-extension-v' + LATEST_EXT + '.zip');
    }
    // 3) Sources priority list (app v1.14.x)
    if (/id="sourcesBody"/.test(out) && /class="card-grid" id="sourcesBody"/.test(out)
        && out.indexOf('sources-list.js') === -1 && out.lastIndexOf('</body>') !== -1) {
      const at = out.lastIndexOf('</body>');
      // sources-list.js stamps 'v1.14.1' at run time; the inline line after it puts APP_VERSION back.
      out = out.slice(0, at) + '<script src="' + SOURCES_LIST_SRC + '"></script>\n'
        + '<script>try{var sv=document.getElementById("sideVer");if(sv)sv.textContent="v' + APP_VERSION + '";}catch(e){}</script>\n'
        + out.slice(at);
      out = out.replace(/(id="sideVer">)v\d+\.\d+\.\d+(<)/, (all, a, b) => a + 'v' + APP_VERSION + b);
    }
    // 6) Suggested by Gershon - OFF panel (app v1.18.x); after sources-list.js so it sits above the list
    if (/id="sourcesBody"/.test(out) && out.indexOf('suggestions.js') === -1 && out.lastIndexOf('</body>') !== -1) {
      const at = out.lastIndexOf('</body>');
      out = out.slice(0, at) + '<script src="' + SUGGESTIONS_SRC + '"></script>\n' + out.slice(at);
    }
    // 7) Bridge ICP ranking panel (app v1.19.0) - app page only (has id="bridgesBody"), once
    if (/id="bridgesBody"/.test(out) && out.indexOf('bridge-icp.js') === -1 && out.lastIndexOf('</body>') !== -1) {
      const at = out.lastIndexOf('</body>');
      out = out.slice(0, at) + '<script src="' + BRIDGE_ICP_SRC + '"></script>\n' + out.slice(at);
    }
    // 4) Unified Gershon design (app v1.15.0)
    if (out.indexOf('unified-theme.css') === -1 && out.indexOf('</head>') !== -1) {
      const at = out.indexOf('</head>');
      out = out.slice(0, at) + '<link rel="stylesheet" href="' + THEME_HREF + '">\n' + out.slice(at);
    }
    // 4b) Chart colours -> Gershon red (app page only: it is the one that builds charts)
    if (out.indexOf('id="appShell"') !== -1 && out.indexOf('new Chart(') !== -1) {
      for (const [from, to] of CHART_RED) out = out.split(from).join(to);
    }
    out = out.replace(/(id="sideVer">)v(\d+\.\d+\.\d+)(<)/, (all, a, v, b) =>
      cmpVer(v, APP_VERSION) < 0 ? a + 'v' + APP_VERSION + b : all);
    if (out === html) return res;
    const h = new Headers(res.headers);
    h.delete('content-length'); h.delete('etag');
    h.set('cache-control', 'no-cache');
    return new Response(out, { status: 200, headers: h });
  } catch (e) { return res; }
}
