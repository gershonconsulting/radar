// Shared by the service worker and popup. Storage errors fail closed.
(function (root) {
  const key = 'radar_collection_consent';
  const revision = 1;
  root.RadarConsent = {
    async accepted() {
      try {
        const value = (await chrome.storage.local.get(key))[key];
        return !!(value && value.revision === revision && value.acceptedAt &&
          Number.isFinite(Date.parse(value.acceptedAt)));
      } catch (_) { return false; }
    },
    async accept() {
      await chrome.storage.local.set({ [key]: { revision, acceptedAt: new Date().toISOString() } });
    }
  };
})(globalThis);
