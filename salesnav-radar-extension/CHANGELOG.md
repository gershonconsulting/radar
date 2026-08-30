## 1.11.0 - 2026-08-28
The Org ID stops being the user's problem.

- **NEW: Radar resolves a Source's Sales Navigator organization id itself.** A Source is added by
  pasting a LinkedIn **company URL**; bridge discovery needs the numeric
  `urn:li:organization:<id>` that Sales Nav filters by. Until now the app said "add a Sales Nav
  Org ID to enable bridge discovery" and simply stopped - asking the user to go and look up a
  number that is derivable from the page they had already pasted. Businesseurope sat that way:
  URL saved, `org_id` null, zero bridges, `discovered=false`, forever.
- **How.** Each run, every source with a URL and no id is resolved once, in one authenticated tab:
  voyager `organization/companies?q=universalName&universalName=<slug>` first, and if that answers
  nothing, the company page HTML itself (it embeds `urn:li:fsd_company:<id>`). A URL that already
  carries the number (`/company/1234`, `/organization/1234`) needs no call at all.
- **Same run, not the next one.** Resolution happens immediately before the discovery decisions,
  so a source added minutes ago is discovered in the very same run rather than waiting a cycle.
- **Saved without collateral damage.** The id goes back through a new hub action `setSourceOrg`
  (a PATCH of `org_id` alone). `addSource` is an upsert that rewrites every column in its payload,
  which is how `linkedin_url` got nulled on 17 of 21 sources - never reuse it to patch one field.

## 1.10.0 - 2026-08-28
Two Sales Navigator lists. Botdog is an add-on, not a prerequisite.

- **NEW: a dedicated Sales Navigator BRIDGES list.** Radar now files into two lists, and both are
  guaranteed outputs whether or not Botdog is connected: **Prospects** (`salesnav_list_url`, the
  people found through a bridge's network) and **Bridges** (`salesnav_bridges_list_url`). The
  bridges list carries the bridges discovered from Sources that we are **not connected to** -
  Sales Nav silently drops `CONNECTION_OF` for anyone but a 1st-degree connection, so those
  networks are unreachable until we connect. Filed into their own list, they become a workable
  connection campaign instead of a dead end.
- **Same call, no new risk.** A bridge has a Sales Nav member urn exactly like a prospect has a
  `lead_id`, so the bridges list reuses `bulkSaveByMembers` verbatim: one bulk call per 25, zero
  profile views, no public `/in/` URL needed. That last point matters - `pushBridges` needs an
  `/in/` URL and **0 of 75 bridges had one**, which is why the invite loop never closed. The list
  path does not need one at all.
- **Eligibility: every bridge whose degree is not positively 1st.** Only 6 of 80 bridges have a
  recorded degree, so a stricter rule would file nobody. An already-connected bridge costs one
  extra line in a list; a missed one costs a whole network.
- **Shared phase.** `saveTargetsToSalesNavList()` and the new `saveBridgesToSalesNavList()` are
  both thin wrappers over `fileIntoSalesNavList(kind)` - same tab handling, same seat probe, same
  cooldown, same chunked marking. Bridges are capped at 100/run and tracked server-side on
  `bridges.salesnav_listed_at` (hub v16), so nobody is filed twice.
- **An unset bridges list is not an error.** It logs `salesnav-bridges:not-configured` at info
  level and moves on. Only the prospects list, which is the product, still raises a desktop
  error when it is missing.
- Manual trigger: message `salesnavBridgesListNow`, or the page event
  `radar-ext-salesnav-bridges` -> `radar-ext-salesnav-bridges-result`.
- `run:done` now reports `bridgesListed`.

## 1.9.2 - 2026-08-28
The Sales Navigator list phase was firing before the page it fires from had loaded.

- **FIX: `403 SALES_SEAT_REQUIRED` was never a seat problem.** On 2026-08-28 the list phase logged
  `salesnav-list:start` at 06:58:59.370, `scrape-window:fallback` at 06:58:59.534 and
  `chunk-failed 403 SALES_SEAT_REQUIRED` at 06:59:01.825 - the chunk fired **2.3 seconds** after
  the tab was created. Verified live the same afternoon: the identical call, same headers, from a
  loaded list page returns **200**. The seat was active the whole time.
- **Root cause: the session probe could not tell a blank tab from a loaded one.** It checked only
  the `JSESSIONID` cookie (domain-wide, present immediately) and `location.pathname` (set before
  a single byte loads). Both are true at t=0, so the probe passed on the first attempt, ~2s in,
  and the backlog was spent against a page LinkedIn had not yet established a Sales Nav session
  for. `document.readyState` was never consulted.
- **The probe now proves the seat, not the cookie.** It requires `readyState === 'complete'` and
  then makes the real `bulkSaveByMembers` call with an **empty** entity list - same endpoint, same
  headers, adds nobody - and requires a 2xx. A 403 there just means "not ready yet", so it keeps
  polling instead of burning the backlog.
- **Waits for the tab to actually load.** New `waitForTabComplete()` (`tabs.onUpdated` status
  `complete`, 45s cap) replaces the blind 2s sleep. This matters most on the background-tab
  fallback taken when the off-screen scrape window is rejected for bounds - Chrome throttles
  background tabs, so they routinely need far longer than 2s.
- **A 403 having filed nobody no longer costs six hours.** That is the page-not-ready signature,
  so it retries the same chunk once after 20s (`salesnav-list:seat-retry`). Only a repeat failure
  sets the long cooldown, and the abort now says the seat was refused rather than blaming the
  session - the old copy told the user to log in again, which can never fix this.

- **FIX: only 90 of 2368 prospects had a public LinkedIn URL.** The resolver opened a Sales Nav
  lead page per person and polled the DOM for `a[href*="linkedin.com/in/"]`. Checked live against
  three real leads on 2026-08-28: **that anchor no longer exists.** A fully rendered lead page has
  107 anchors, none containing `/in/`, and no `publicIdentifier` anywhere in the source. The 1.9.0
  "poll for ~13s" fix could never have worked - it just polled longer for something absent, at the
  cost of a page load and a profile view each.
- **The URL comes from the API instead.** Captured Sales Navigator's own lead-page request:
  `GET /sales-api/salesApiProfiles/(profileId:<URN>,authType:NAME_SEARCH,authToken:undefined)`
  with `decoration=(entityUrn,fullName,degree,flagshipProfileUrl)` returns the public URL in
  `flagshipProfileUrl`. Verified 200 on three leads. No page render, **no profile view**, so
  `MAX_RESOLVE_PER_RUN` goes 100 -> 400 and all lookups share ONE tab.
  The same response carries `degree`, which now fills `connection` for free - the 1st-degree rules
  used to need a separate scrape to learn it.

## 1.9.1 - 2026-08-26
Stop scraping bridges we are not connected to, instead of discovering it by scraping them.

- **Discovery now records the connection DEGREE.** `extractCandidatesFromPage()` hardcoded
  `connection: ''`, so 69 of 75 bridges had no degree and every one had to be scraped to find out
  whether Sales Nav would honour its `CONNECTION_OF` filter. It now reads the degree badge from
  the same card the lead scraper already reads it from. Blank still means UNKNOWN, never "not connected".
- **Pre-flight skip.** A bridge whose degree is positively known to be non-1st is never scraped:
  `CONNECTION_OF` only works for your 1st-degree connections, and for anyone else Sales Nav
  silently drops the filter and returns a generic pool. Logs `scrape:skip-not-connected` with the
  count and the page loads saved. Unknown degree stays eligible and falls through to the cheap
  page-1 fingerprint guard. The per-run cap is applied AFTER this filter, so the budget is never
  spent on bridges we skip anyway.
- **Bridge URLs + invites (the loop that never closed).** 0 of 75 bridges had a public `/in/` URL,
  and the hub's `pushBridges` requires one — so the bridges campaign could never invite anyone and
  `botdog_pushed` was null for all 75. `resolveBridgeUrls()` now resolves up to
  `BRIDGE_URL_RESOLVE_PER_RUN` (10) per run and saves them via the new hub `setBridgeMeta` action.
  Deliberately NOT `addBridges`: that is an upsert which rewrites `active` from its payload, so
  reusing it to save a URL would silently switch bridges off.
  Public-URL resolution degrades with network distance, so some bridges are simply unresolvable —
  reported as `unresolvable` counts, never as errors.
- **Reporting.** `run:done` now also carries `skippedNotConnected`, `bridgeUrlsResolved`,
  `bridgeUrlsMissing` and `bridgesInvited`.
- Hub v15: `readBridges` returns `linkedin_url`, `health` and `botdog_pushed`; `setBridgeMeta`
  patches url/degree without touching `active`, marks a known non-1st bridge `not_connected`, and
  RE-ENABLES a bridge that has become 1st-degree.

## 1.9.0 - 2026-08-26
Audit of the 2026-08-25 run found collection working (3446 found / 3444 saved on 1.8.1) while
everything downstream of it was broken. Five fixes, all traced to that one run's logs.

- **FIX: the Sales Navigator 401.** That run filed 200 prospects perfectly at 08:16, then scraped
  for SEVEN HOURS and was refused with a 401 at 14:53. The list phase was never broken — the
  scrape burned the session it depends on. Runs are now bounded (`MAX_BRIDGES_PER_RUN` 15,
  `MAX_PAGES_PER_RUN` 150, order still randomized so the pool rotates across runs), the list
  phase runs every 4 bridges instead of only at the ends, chunk pacing is 4–9s, and a 401/403
  sets a 6h cooldown (`salesnav-list:cooldown`) instead of re-asking every run.
- **The list phase now proves the session before spending the backlog.** It polls for a genuinely
  authenticated Sales Nav page (`ajax:` csrf shape, not on a login/checkpoint/authwall path)
  rather than firing blind after a fixed 7s. A cold browser needs far longer than 7s, and firing
  early is what turns a healthy backlog into a 401. Logs `salesnav-list:not-authenticated`.
- **FIX: `title` was the screen-reader label.** 1562 of the 1722 targets collected on 2026-08-25
  have `title = "Add <Name> to selection"`. The title picker took the longest text leaf in the
  card, and on the 2026 Sales Nav DOM that leaf is the `.a11y-text` selection label. Every
  `.a11y-text` leaf is now excluded, as is Sales Nav marketing copy (one row's title was
  "InMails get 5x more responses than emails"). Same exclusion applied to the location picker.
- **FIX: `linkedin_url` was empty on all 1722 rows.** `resolveUrn()` read the `/in/` anchor once,
  2500ms after opening a Sales Nav lead page — an SPA that has essentially never rendered it by
  then, so it returned null every time. It now polls inside the page (~13s).
- **FIX: Botdog had never run.** The extension reads the key from `chrome.storage.local`, but the
  key lives on the hub and `getConfig` redacts every `*_api_key`, so it could never arrive —
  `bridge-push:skip "not configured"` on every run since 2026-07-27 while a valid key sat on the
  hub and `bridges.botdog_pushed` stayed null for all 80 rows. With no local key the extension
  now delegates to the hub's server-side `pushBridges`, where the key actually is.
- **The dropped-filter guard now fires after page 1, not after 25.** "Nicolas MILONAS" cost 25
  page loads to return the same 625 people as another bridge. Those wasted loads are precisely
  what exhausts the session. Page-1 fingerprints use their own scope (`p1:`).
- **`run:done.status` is derived, not hardcoded.** A run with 49 scrape errors, or one that ended
  in a 401 having filed nobody, used to report `status:"ok"` — which is what let a dead system
  look alive for days. Status is now `error` on any error-level log or found>0/saved==0, and
  `degraded` while the Sales Nav cooldown is active. `run:done` also carries `errors`,
  `bridges`, `pagesLeft` and `listCooling`.

## 1.8.1 - 2026-08-24
- **FIX: nothing had been filed into the Sales Navigator lead list since 2026-08-15.** Every run
  logged `salesnav-list:start` and then `salesnav-list:no-tab` — 1853 prospects sat pending.
  Root cause: Chrome now rejects `windows.create()` bounds that put a window fully outside the
  visible desktop, so the dedicated off-screen scrape window failed to open and EVERY page-open
  in the extension failed with it (bridge scraping too — `scrape window/tab unavailable`).
  `getScrapeWindow()` now tries off-screen, then on-screen-unfocused, and logs the real error
  instead of swallowing it (`scrape-window:create-failed` / `scrape-window:fallback`).
- **The list phase no longer depends on that window at all.** Filing needs a logged-in
  linkedin.com origin to fetch from, not a rendered page, so it falls back to a plain background
  tab in the user's own window (`salesnav-list:bg-tab-fallback`). It cannot be silently skipped.
- **The list phase now runs FIRST, before scraping, and again at the end.** Getting prospects
  into the dedicated lead list is the product; scraping is only how the list gets fed. A slow or
  killed scrape can no longer starve it. It still no-ops when nothing is pending.
- **Botdog is explicitly optional.** No key = an info-level skip that reports success, never an
  error. Radar is complete without Botdog.

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
