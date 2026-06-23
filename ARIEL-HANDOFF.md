# Radar — Ariel Handoff
## What needs doing: update the local Chrome extension files

Olivier does not use Terminal. Your job is to copy the latest files from GitHub onto his machine so the extension updates from v1.2.0 to v1.3.0.

---

## Context

The Radar Chrome extension is loaded **unpacked** from a local folder on Olivier's Windows machine (Developer mode in chrome://extensions).

When we update files in GitHub, Chrome does NOT auto-update — you have to overwrite the local files and click Reload in chrome://extensions.

We just shipped two changes that need to land locally:

| File | What changed |
|------|-------------|
| `salesnav-radar-extension/sync-core.js` | Added full structured logging to `chrome.storage.local` so the Radar dashboard can read every step of a sync run |
| `salesnav-radar-extension/manifest.json` | Version bumped 1.2.0 → 1.3.0 |

---

## Step 1 — Find the local extension folder

Ask Olivier: "Where is the radar folder on your computer?"

It will be something like:
- `C:\Users\oattia\Documents\radar`
- `C:\Users\oattia\Desktop\radar`

If he doesn't know, open `chrome://extensions` in Chrome, turn on Developer mode, find **Radar — Sales Nav Collector**, and look at the path shown under the extension name. It ends in `salesnav-radar-extension`.

---

## Step 2 — Overwrite sync-core.js

1. Open this URL in Chrome and save the file (Ctrl+S or right-click → Save as):

   ```
   https://raw.githubusercontent.com/gershonconsulting/radar/main/salesnav-radar-extension/sync-core.js
   ```

2. Save it into the local `salesnav-radar-extension` folder, overwriting the existing file.

---

## Step 3 — Overwrite manifest.json

Same thing:

1. Open:
   ```
   https://raw.githubusercontent.com/gershonconsulting/radar/main/salesnav-radar-extension/manifest.json
   ```

2. Save into the local `salesnav-radar-extension` folder, overwriting the existing file.

---

## Step 4 — Reload the extension

1. Go to `chrome://extensions`
2. Find **Radar — Sales Nav Collector**
3. Click the **↺ reload** icon
4. Click the Radar icon in the toolbar — popup should show **v1.3.0** in the top-right

---

## Step 5 — Get the extension ID

While you're on `chrome://extensions` with Developer mode ON, copy the **ID** shown under the Radar extension (32-character string like `abcdefghijklmnopabcdefghijklmnop`).

Then:
1. Go to `https://radar.gershoncrm.com`
2. Click the **Live Log** tab
3. Paste the extension ID into the input box and click **Connect**

From that point, the dashboard can trigger syncs and show the full step-by-step log for every run.

---

## What the new sync-core.js logs

Every sync run now writes entries like these to `chrome.storage.local` under key `radarLog`:

```
[INFO]  run:start
[INFO]  login-check          { loggedIn: true }
[INFO]  scrape:start         { bridge: "Elie Cohen" }
[INFO]  scrape:page          { bridge: "Elie Cohen", page: 1 }
[INFO]  scrape:page-done     { bridge: "Elie Cohen", page: 1, count: 25 }
[INFO]  scrape:done          { bridge: "Elie Cohen", leadCount: 55 }
[INFO]  scrape:total         { totalLeads: 726 }
[INFO]  resolve:start        { toResolve: 100 }
[INFO]  resolve:done         { resolvedCount: 87 }
[INFO]  ingest:start         { leads: 726 }
[INFO]  run:done             { written: 143, status: "ok" }
```

If anything fails, you'll see `[ERROR]` with the exact message.

---

## Repo
`https://github.com/gershonconsulting/radar`

## Dashboard
`https://radar.gershoncrm.com`

## Version rule going forward
Every time any extension file (`sync-core.js`, `manifest.json`, `popup.html`) is changed in GitHub, bump the version in `manifest.json` (patch = bug fix, minor = new feature) so Olivier knows to reload.
