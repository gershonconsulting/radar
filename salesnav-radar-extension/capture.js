// capture.js (1.15.0) — runs in the PAGE (MAIN world) at document_start on Sales Nav search pages.
// Keeps a copy of Sales Navigator's own search API responses so Radar can read the 25 results of
// a page WITHOUT the page having to be visible and scrolled. This is what lets collection run in a
// minimized window. Read-only: it never changes a request or a response.
(function () {
  if (window.__radarCap) return;
  var cap = window.__radarCap = { items: [], n: 0 };
  var M = /sales-api\/salesApi\w*Search|salesApiLeadSearch|salesApiPeopleSearch/i;
  function keep(url, text) {
    try {
      if (!text || !M.test(String(url || ''))) return;
      cap.items.push({ url: String(url).slice(0, 300), t: String(text).slice(0, 3000000) });
      cap.n++;
      if (cap.items.length > 6) cap.items.shift();
    } catch (e) {}
  }
  try {
    var of = window.fetch;
    if (typeof of === 'function') {
      window.fetch = function (input) {
        var url = '';
        try { url = (typeof input === 'string') ? input : ((input && input.url) || String(input || '')); } catch (e) {}
        var p = of.apply(this, arguments);
        try {
          if (M.test(url)) p.then(function (r) { try { r.clone().text().then(function (t) { keep(url, t); }).catch(function () {}); } catch (e) {} }).catch(function () {});
        } catch (e) {}
        return p;
      };
    }
  } catch (e) {}
  try {
    var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { try { this.__radarUrl = String(u || ''); } catch (e) {} return oo.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      try {
        if (M.test(this.__radarUrl || '')) {
          this.addEventListener('load', function () {
            var t = '';
            try {
              if (this.responseType === '' || this.responseType === 'text') t = this.responseText;
              else if (this.responseType === 'json') t = JSON.stringify(this.response);
            } catch (e) {}
            keep(this.__radarUrl, t);
          });
        }
      } catch (e) {}
      return os.apply(this, arguments);
    };
  } catch (e) {}
})();
