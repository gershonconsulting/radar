## 1.8.0 - 2026-08-22
- **Dropped-filter guard.** Sales Navigator silently ignores a `CONNECTION_OF` filter it
  rejects (bridge not 1st-degree, or not a real member urn) and returns a GENERIC result set
  instead. That read as a successful scrape while being nobody's network, and because every
  affected bridge returned the same people, dedup threw them all away - 54 of 88 bridges sat
  at zero. Each bridge's result set is now fingerprinted; if the identical set already came
  from another bridge, the run logs `scrape:filter-ignored`, ingests nothing, and the hub
  switches that bridge off.
- Bridges without a real `ACwAA...` urn are skipped up front (`scrape:invalid-urn`).
- Bridge health (runs, last yield, verdict) is now tracked server-side from the sync log.

## 1.7.4 - 2026-08-21
### Removed
- **The hardcoded "The Triana Group" seed bridges are gone.** Up to 1.7.3 the extension shipped
  six real bridges belonging to one account and, whenever `getBridges()` returned no ACTIVE
  bridge, pushed them into that user's hub via `addBridges('The Triana Group', ...)` and then
  scraped them. On a brand-new account that meant a stranger's organization appeared in their
  Sources and their network got collected. `BRIDGES` is now `[]` and `resolveActiveBridges()`
  returns `[]` when nothing is switched on — it logs `bridges:none-active` with a hint instead
  of inventing work. Never reintroduce a seed list.

## 1.7.3 - 2026-08-20
### Added
- **The extension now reports its own build number to the server.** `EXT_VERSION` is read from
  the manifest and stamped into the `run:start` and `run:done` entries of the run log, which
  `pushLog()` already forwards to the hub (`activity_log.action = 'sync_log'`).
- This is what powers the "old Chrome extension still installed" warning in the daily report
  (`daily-report` edge function v2). The report compares the reported version against the
  `latest_ext_version` config key; if no version is reported at all, the installed build is
  older than 1.7.3 and the report says so.
- Version is stamped on BOTH `run:start` and `run:done` because `pushLog()` only forwards the
  most recent 150 log entries, and a long multi-bridge run can push `run:start` past that cut.

## 1.7.2 - 2026-08-15
### Added
- **New prospects are now filed automatically into the dedicated Sales Navigator lead list.**
  Every sync ends with a `salesnav-list` phase that adds newly collected targets to the list
  configured in Settings -> "Sales Navigator list URL" (`salesnav_list_url` on the hub).
- Uses Sales Navigator's own bulk endpoint
  `POST /sales-api/salesApiLeads?action=bulkSaveByMembers`
  with `{entities:["urn:li:fs_salesProfile:(<urn>,NAME_SEARCH,undefined)"], lists:["<listId>"]}`
  and a `csrf-token` header taken from the JSESSIONID cookie. 25 prospects per call,
  200 per run, **zero profile views** - saving to a list also saves the lead, so the old
  "open the /in/ profile and click Save in Sales Navigator" two-step is no longer needed.
- Progress is stamped server-side on `targets.salesnav_listed_at` (hub v13,
  `?action=salesnavPending` + `{action:'markSalesnavListed'}`), so nobody is ever added twice
  and an interrupted run resumes where it stopped. Newest prospects go first, so the historical
  backlog drains behind them without ever delaying a fresh lead.
- Manual trigger: `salesnavListNow` message / `radar-ext-salesnav-list` page event.

# Radar — Sales Nav Connections — Changelog

Version lives in `manifest.json` (`"version"`), is shown in the popup (top-right), and is
stamped on every collected row via the `source` field (`radar-ext-vX.Y.Z`). Bump it in
`manifest.json` on every release and add an entry here. (Bump the source tag in
`sync-core.js` too if you want collected rows to record the new version.)

## v1.3.1 — 2026-06-19  (reconciliation)
- **Merged the GitHub `main` (v1.3.0) lineage with the local lineage** — the two had forked.
  Kept from GitHub: **background service worker** (`sync-core.js` is now the worker; `background.js`
  deprecated), **`radarLog` dashboard logging** + `getLog`/`clearLog`/`syncNow` message API,
  the **deployed hub URL**, and the **6 bridges + Europe/11-50/exclude-messaged** targeting.
  Kept from local: **new-connection notifications** (+ click-to-open), **cookie `li_at` login
  check**, the **validated lead-anchor scraper** (GitHub's `data-anonymize` selectors were the
  stale ones), and **source/bridge/category** fields in the payload.
- Popup now drives the worker via messages and shows the live `radarLog`.
- **Process rule going forward:** GitHub `main` is the single source of truth. Every agent
  (Ariel, Charles, …) branches from it and commits back — no more private local forks. Bump
  `manifest.json` on every change (patch = fix, minor = feature) so the local copy gets reloaded.

## v1.2.0 — 2026-06-17
- **Desktop notifications**: pops "{name} from {company} is a new connection of {bridge}" for
  each genuinely-new connection found (capped per run; clicking opens the LinkedIn profile).
  Adds the `notifications` permission.
- Shared "known leads" lookup (`fetchKnownLeadIds`) powers both new-lead detection and the
  resolve-skip, so profiles are never re-opened.

## v1.1.0 — 2026-06-17
- New **radar icon** (16/48/128).
- **Rebuilt scraper** against current Sales Navigator markup (no longer relies on
  `data-anonymize`/class names; anchors on `/sales/lead/` cards). Captures name, title,
  company, **location**, and the Sales Nav lead URN.
- **Public LinkedIn URL resolver**: opens each lead, reads the public `/in/` URL (required by
  Botdog). Capped at 100 profile-views/run; **skips already-resolved leads**.
- **Source column** added end to end (each bridge tagged with its origin list/network).
- Per-bridge config simplified to `{ bridge, category, source, urn }` with a shared filter
  template (CXO/Owner · France · 11–50).

## v1.0.0 — 2026-06-16
- Initial build: daily alarm + manual "Sync Now"; scrape a bridge's Sales Nav connections;
  POST to the Google Apps Script ingest endpoint → Google Sheet. (Original `data-anonymize`
  selectors — superseded in v1.1.0.)

## Backlog (likely next versions)
- Backend-driven bridge list + ICP filters (edit in the app instead of code).
- URN resolution at scale for onboarding many bridges (~150 contacts).
- Resume/region tuning, per-bridge campaign routing.
