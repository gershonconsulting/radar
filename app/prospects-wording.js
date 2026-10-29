/* prospects-wording.js - Radar app v1.18.5 (nightly 2026-10-29; first written for v1.16.0, PR #5)
 * Olivier's vocabulary (2026-10-09): SOURCES > BRIDGES > PROSPECTS. The word "Targets" is renamed
 * "Prospects" everywhere it is shown (menu, headings, tiles, buttons, tooltips, placeholders,
 * empty states, charts' labels), without re-uploading the 260 KB app.html: the page is re-worded
 * in the browser, and anything the app renders later is re-worded as it appears.
 * NOT touched: ids, classes, view names, API fields, stored data, and the prospect rows themselves
 * (a company really called "Target" stays "Target"). "Daily lead target" (a goal, not a stage) keeps
 * its wording. Once app.html itself says "Prospects", this script finds nothing and does nothing.
 * v1.18.4: also leaves alone the company / person names of the Sources list and the Suggested by
 * Gershon panel (.src-nm, a.sug-nm, LinkedIn links) - they are data, like the prospect rows.
 */
(function () {
  'use strict';
  // Whole phrases first (where a word-for-word swap would read badly).
  var PHRASES = [
    [/Collect new targets \(prospects\)/g, 'Collect new prospects'],
    [/A Target is a prospect worth contacting/g, 'A Prospect is a person worth contacting'],
    [/connections as Targets/g, 'connections as Prospects']
  ];
  var WORD = /\b(Targets|Target|targets|target|TARGETS|TARGET)\b/g;
  var MAP = { Targets: 'Prospects', Target: 'Prospect', targets: 'prospects', target: 'prospect',
              TARGETS: 'PROSPECTS', TARGET: 'PROSPECT' };
  // "lead target", "daily target" = an objective, not the pipeline stage.
  var KEEP_BEFORE = /(lead|daily|weekly|monthly|your)\s+$/i;
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };
  var ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip', 'alt'];

  function reword(s) {
    if (!s || !/target/i.test(s)) return s;
    var out = s;
    for (var i = 0; i < PHRASES.length; i++) out = out.replace(PHRASES[i][0], PHRASES[i][1]);
    return out.replace(WORD, function (w, _g, off, all) {
      return KEEP_BEFORE.test(all.slice(Math.max(0, off - 12), off)) ? w : MAP[w];
    });
  }
  function skipped(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentNode) {
      if (SKIP_TAGS[e.tagName] || e.isContentEditable) return true;
      // An <option> without a value uses its text as the value: never change it.
      if (e.tagName === 'OPTION' && !e.hasAttribute('value')) return true;
      // Prospect rows are data (names, titles, companies) - leave them exactly as collected.
      if (e.tagName === 'TR' && e.parentNode && e.parentNode.id === 'targetsBody' && !e.querySelector('td.empty')) return true;
      if (e.hasAttribute && e.hasAttribute('data-keep-wording')) return true;
      // Company / person names (Sources list, Suggested panel, Bridges page links) are data too.
      if (e.classList && (e.classList.contains('src-nm') || e.classList.contains('sug-nm'))) return true;
      if (e.tagName === 'A' && /linkedin\.com\//i.test(e.getAttribute('href') || '')) return true;
    }
    return false;
  }
  function doText(t) {
    var v = t.nodeValue;
    if (!v || !/target/i.test(v) || skipped(t.parentNode)) return;
    var n = reword(v);
    if (n !== v) t.nodeValue = n;
  }
  function doEl(el) {
    if (skipped(el)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = el.getAttribute && el.getAttribute(ATTRS[i]);
      if (a && /target/i.test(a)) { var n = reword(a); if (n !== a) el.setAttribute(ATTRS[i], n); }
    }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { if (SKIP_TAGS[root.tagName]) return; doEl(root); }
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = tw.nextNode())) { if (node.nodeType === 3) doText(node); else doEl(node); }
  }
  function titleToo() { var t = document.title; var n = reword(t); if (n !== t) document.title = n; }

  function start() {
    walk(document.body); titleToo();
    if (!window.MutationObserver) return;
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') doEl(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true,
                                 attributes: true, attributeFilter: ATTRS });
  }
  window.radarReword = reword; // for tests
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
