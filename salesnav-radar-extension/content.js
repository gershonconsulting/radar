(function () {
  try {
    var V = chrome.runtime.getManifest().version;
    var root = document.documentElement;
    function announce(salesNav) {
      root.setAttribute('data-radar-ext', V);
      if (salesNav !== undefined && salesNav !== null) root.setAttribute('data-radar-salesnav', salesNav ? '1' : '0');
      window.dispatchEvent(new CustomEvent('radar-ext-ready', { detail: { version: V, salesNav: (salesNav === undefined ? null : salesNav) } }));
    }
    function queryAndAnnounce() {
      announce();  // presence immediately
      try {
        chrome.runtime.sendMessage({ action: 'salesNavStatus' }, function (resp) {
          if (chrome.runtime.lastError) return;
          announce(!!(resp && resp.ok));
        });
      } catch (e) {}
    }
    queryAndAnnounce();
    // let the page trigger a recheck
    window.addEventListener('radar-ext-ping', queryAndAnnounce);
    // let the Radar web app read the current schedule (to populate Settings).
    window.addEventListener('radar-ext-get-schedule', function () {
      try {
        chrome.runtime.sendMessage({ action: 'getSchedule' }, function (resp) {
          var detail = (!chrome.runtime.lastError && resp && resp.ok) ? { ok: true, schedule: resp.schedule } : { ok: false };
          window.dispatchEvent(new CustomEvent('radar-ext-schedule', { detail: detail }));
        });
      } catch (e) { window.dispatchEvent(new CustomEvent('radar-ext-schedule', { detail: { ok: false } })); }
    });
    // let the Radar web app save a new schedule (when + how often to update targets/bridges).
    window.addEventListener('radar-ext-set-schedule', function (ev) {
      try {
        chrome.runtime.sendMessage({ action: 'setSchedule', schedule: (ev && ev.detail) || {} }, function (resp) {
          var detail = (!chrome.runtime.lastError && resp && resp.ok) ? { ok: true, schedule: resp.schedule } : { ok: false, error: (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) };
          window.dispatchEvent(new CustomEvent('radar-ext-schedule-saved', { detail: detail }));
        });
      } catch (e) { window.dispatchEvent(new CustomEvent('radar-ext-schedule-saved', { detail: { ok: false, error: String(e) } })); }
    });
    // let the Radar web app trigger a collection run without opening the popup.
    window.addEventListener('radar-ext-sync', function () {
      try {
        chrome.runtime.sendMessage({ action: 'syncNow' }, function (resp) {
          var detail;
          if (chrome.runtime.lastError) {
            detail = { ok: false, error: chrome.runtime.lastError.message };
          } else if (!resp || !resp.ok) {
            detail = { ok: false, error: (resp && resp.error) || 'unknown' };
          } else {
            detail = { ok: true, result: resp.result || {} };
          }
          window.dispatchEvent(new CustomEvent('radar-ext-sync-result', { detail: detail }));
        });
      } catch (e) {
        window.dispatchEvent(new CustomEvent('radar-ext-sync-result', { detail: { ok: false, error: String(e) } }));
      }
    });
  } catch (e) {}
})();
