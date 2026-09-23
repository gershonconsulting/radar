// functions/_middleware.js (2026-09-23)
// 1) Serves extension builds that live in Supabase Storage (public bucket radar-releases) at the
//    usual /radar-extension-vX.Y.Z.zip path, so a release no longer needs a binary commit.
//    A zip committed to app/ still wins.
// 2) Keeps the download links / "outdated extension" checks on / and /app pointing at LATEST_EXT
//    without re-uploading the 260 KB app.html: an older LATEST_EXT_VERSION in the page is raised
//    to LATEST_EXT on the fly (never lowered). Bump LATEST_EXT here for the next release.
const LATEST_EXT = '1.15.0';
const RELEASES = 'https://pkzeeqehwmtnqxdpdesl.supabase.co/storage/v1/object/public/radar-releases/';
const HTML_PATHS = new Set(['/', '/index.html', '/app', '/app.html']);

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
    const m = html.match(/LATEST_EXT_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/);
    if (!m || cmpVer(m[1], LATEST_EXT) >= 0) return res;
    const old = m[1];
    const out = html
      .replace(/(LATEST_EXT_VERSION\s*=\s*')\d+\.\d+\.\d+(')/g, '$1' + LATEST_EXT + '$2')
      .split('/radar-extension-v' + old + '.zip').join('/radar-extension-v' + LATEST_EXT + '.zip');
    const h = new Headers(res.headers);
    h.delete('content-length'); h.delete('etag');
    h.set('cache-control', 'no-cache');
    return new Response(out, { status: 200, headers: h });
  } catch (e) { return res; }
}
