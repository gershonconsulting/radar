// Radar popup — talks to the sync-core.js service worker via messages.
const installedVersion = chrome.runtime.getManifest().version;
document.getElementById("ver").textContent = "v" + installedVersion;

const statusEl = document.getElementById("status");
const lastEl = document.getElementById("last-captured");

function show(msg, kind) {
  statusEl.innerHTML = '<div class="status ' + kind + '">' + msg + '</div>';
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function relTime(ts) {
  if (!ts) return "";
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

// Render the latest run from the radarLog the service worker writes.
function renderLog() {
  chrome.runtime.sendMessage({ action: "getLog" }, function (resp) {
    if (chrome.runtime.lastError || !resp || !resp.ok) { lastEl.innerHTML = ""; return; }
    const logArr = resp.log || [];
    if (!logArr.length) { lastEl.innerHTML = ""; return; }
    const done = logArr.find(function (e) { return e.msg === "run:done"; });
    const start = logArr[logArr.length - 1];
    let head = "";
    if (done) {
      const nw = (done.data && done.data.newLeads) || 0;
      const wr = (done.data && done.data.written) || 0;
      head = "Last run " + relTime(start && start.ts) + " · " + nw + " new · " + wr + " written";
    } else {
      head = "Last run " + relTime(start && start.ts);
    }
    let html = head +
      '<details style="margin-top:8px;border-top:1px solid #f3f4f6;padding-top:8px;">' +
      '<summary style="cursor:pointer;font-size:11px;color:#3b82f6;">View log (' + logArr.length + ' steps)</summary>' +
      '<div style="margin-top:6px;max-height:240px;overflow-y:auto;font-family:ui-monospace,monospace;font-size:10px;line-height:1.4;background:#f9fafb;padding:6px;border-radius:4px;">';
    for (const ev of logArr) {
      const t = (ev.ts || "").slice(11, 19);
      const color = ev.level === "error" ? "#dc2626" : (ev.msg === "run:done" ? "#059669" : "#374151");
      html += '<div style="margin-bottom:4px;"><span style="color:#9ca3af;">' + t + '</span> ' +
        '<strong style="color:' + color + ';">' + escapeHtml(ev.msg) + '</strong>';
      if (ev.data) html += '<div style="margin-left:12px;color:#6b7280;">' + escapeHtml(JSON.stringify(ev.data)) + '</div>';
      html += '</div>';
    }
    html += '</div></details>';
    lastEl.innerHTML = html;
  });
}

document.getElementById("sync-now").addEventListener("click", function (e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  show("Sync running in background…", "info");
  chrome.runtime.sendMessage({ action: "syncNow" }, function (response) {
    btn.disabled = false;
    if (chrome.runtime.lastError) { show("Sync failed: " + chrome.runtime.lastError.message, "err"); renderLog(); return; }
    if (!response || !response.ok) { show("Sync error: " + ((response && response.error) || "unknown"), "err"); renderLog(); return; }
    const r = response.result || {};
    if (r.status && r.status !== "ok" && r.status !== undefined && r.written == null) {
      show("Finished: " + r.status, r.status === "not-logged-in" ? "err" : "info");
    } else {
      show("✓ Sync complete", "ok");
    }
    renderLog();
  });
});

renderLog();
