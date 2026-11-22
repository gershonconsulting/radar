# Priority 0 review evidence

Draft implementation, 2026-11-22. This is not a completion or deployment certificate. Priority 1 has not started.

## T0.1 — Versions

Inspected the app version module, extension manifest, cron package/config/source, and all tracked Supabase function sources. Added VERSIONS.md and replaced inline current versions in STATUS.md with its link. App source is bumped for the policy change; extension source is bumped for the consent behavior. There is no app/package.json to edit. The worker has no independent semantic version.

Acceptance correction: keep the published download marker separate from unreleased source. LATEST_EXT deliberately still points to the last published build. The proposed broad grep also matches unrelated app patch versions and historical source comments; use the authority table and release evidence rather than deleting accurate history to make that grep empty. Remaining occurrences outside VERSIONS/changelogs are the published marker, historical comments, a static app footer stamped by middleware, and a test fixture. These are documented exceptions requiring reviewer acceptance.

## T0.2 — Artifacts

Removed all 19 tracked ZIPs (17 in app/, two at root), and added *.zip to .gitignore. Icons remain runtime assets. This removes files from the current tree, not from git history. New releases should move to GitHub Releases; automation remains T1.4 after the Priority 0 merge gate.

**Merge blocker:** GitHub Releases currently returns an empty list. HEAD requests to both the last published build and the extension help page's build in the existing Supabase Storage fallback returned HTTP 400 with JSON content rather than a downloadable ZIP. Do not merge the removals until downloadable artifacts are migrated and the actual website installation links are verified. No artifact was published and no production download route was changed in this PR.

## T0.3 — Contributor guidance

Merged current operational guidance into CONTRIBUTING.md, retained previous status history in CHANGELOG.md, and removed ARIEL-HANDOFF.md, HANDOFF.txt and supabase/HANDOFF.txt. Kept the health-alert runbook as a focused technical reference. Historical deployment statements are explicitly not reverified; contradictory old handoffs no longer act as setup instructions.

## T0.4 — Permission audit

| Field | Entry before audit | Decision and justification |
| --- | --- | --- |
| permissions | alarms | Keep: daily collection and gate-resume scheduling |
| permissions | storage | Keep: local owner/settings, counters, buffered leads, diagnostics and consent timestamp |
| permissions | scripting | Keep: inject LinkedIn parsers and register the response capture script |
| permissions | tabs | Remove: tab creation/removal needs no broad tabs permission; all sensitive URL queries target the already granted LinkedIn host |
| permissions | notifications | Keep: native error/alert notifications in notify(); ordinary messages stay in local logs |
| host_permissions | https://www.linkedin.com/* | Keep: Sales Navigator, public profiles, organization pages and same-origin LinkedIn API calls; no wildcard subdomains needed |
| host_permissions | https://radar.gershon.ai/* | Remove: app relay uses explicit content_scripts.matches, not privileged worker requests to this host |
| host_permissions | https://radar.gershoncrm.com/* | Remove: same reason; legacy app content-script matching remains |
| host_permissions | https://pkzeeqehwmtnqxdpdesl.supabase.co/* | Keep: hub and shared gate requests |
| host_permissions | https://enricherpro.com/* | Keep: /api/enrich resolves missing public profile URLs |
| host_permissions | https://api.botdog.co/* | Keep: configured direct outreach to /v1/leads/add_to_campaign |
| optional_permissions / optional_host_permissions | absent | No optional permission entries before or after audit |

The two exact Radar origins remain in content_scripts.matches to support the app bridge. The extension needs backend hosts as well as LinkedIn; interpreting the task as literally LinkedIn-only would break its stated sync purpose. Optional enrichment/outreach hosts could become runtime-requested permissions in a later focused change.

Chrome documents host-based visibility of tab URL fields and permission-free basic tab manipulation: https://developer.chrome.com/docs/extensions/reference/api/tabs . Static content-script declarations do not require duplicate host_permissions: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions . Live Chrome regression testing of collection, tab queries and the relay is still required.

## T0.5 — Data-flow audit and consent

Searched every extension JS/HTML file for fetch, XMLHttpRequest and Supabase client creation: 29 textual call/interception sites across sync-core.js (25), capture.js (3) and invites.js (1). capture.js observes LinkedIn page fetch/XHR responses; it does not send a separate external request. background.js is deprecated and is not loaded by the manifest. No Supabase SDK client is initialized in the extension.

| Field or request data | Destination | Purpose |
| --- | --- | --- |
| Names, titles, companies, locations, LinkedIn URLs, member/lead IDs, connection degree, source/bridge associations | pkzeeqehwmtnqxdpdesl.supabase.co/functions/v1/hub | Store and associate business profiles with the Radar account |
| Owner/account key, shared client ingest credential, configuration values, list IDs, source org IDs, active/listed states and timestamps | Same hub endpoint | Scope/configure collection and record progress |
| Extension version, gate action, units, account identifier | pkzeeqehwmtnqxdpdesl.supabase.co/functions/v1/radar-gate | Shared action limits and pacing |
| Run logs: counts, timestamps, errors and sometimes business-profile names, IDs or URLs | Hub pushLog action | Diagnostics and activity display; logs are not guaranteed free of personal data |
| firstName, lastName, company, title | enricherpro.com/api/enrich | Resolve a missing public profile URL |
| campaignId; leads containing linkedinUrl, name, title; x-api-key authentication | api.botdog.co/v1/leads/add_to_campaign | Configured outreach; also performed indirectly by the hub with server-stored keys |
| Member/org IDs, search filters, pagination, list IDs, lead IDs and configured invitation note; LinkedIn session/CSRF headers | www.linkedin.com Sales Navigator/Voyager endpoints and page actions | Search/read profiles, save configured lists, resolve degree, send configured invitations; LinkedIn session credentials are not sent to Radar |
| Version, status and local logs relayed through extension messages/DOM events | The two configured Radar app origins | Dashboard integration; no independent content-script fetch to these origins |
| Disclosure revision and acceptance timestamp | chrome.storage.local only | Remember explicit local consent; not uploaded |

The policy and popup now describe these destinations and data. The previous policy claim that every Botdog push honors the dashboard toggle was inaccurate: hub fallback paths can still push with server-stored keys. The revised disclosure records that limitation rather than certifying unimplemented enforcement. This behavior deserves an urgent follow-up before consent is represented as granular outreach control.

Service-worker fetches and collection entry points now fail closed without consent. Only an extension popup sender can grant acceptance; dashboard relays cannot. Missing, stale or malformed consent, storage read/write failures, startup, install and manual/app action paths are tested offline against the actual worker. On install/update without consent, the local disclosure page opens; closing it leaves collection blocked.

**Still required:** actual Chrome popup screenshot and fresh-install/update network inspection; live collection/tab regression with reduced permissions; actual Chrome Web Store listing/privacy-form review. The store listing URL and publisher-session evidence are not in this repository. No store submission or legal compliance certification was performed.

## Verification

- Node 24: all ten existing offline test files pass, plus tests/consent.test.cjs. Optional jsdom invite DOM cases report skipped because jsdom is not installed.
- Two existing report tests initially failed on Windows because they imported C: paths as module URLs; changed only those dynamic imports to pathToFileURL, then both passed.
- Extension syntax checks and git diff --check pass.
- Added a small Priority 0 CI workflow for offline suites, consent checks, syntax and tracked-ZIP absence. Full lint/format/audit/manifest-baseline jobs remain Priority 1 tasks, not claimed complete here.
- No external mail, outreach, database writes, deployments or release publication were performed.

## Suggested roadmap amendments

1. Put authenticated owner binding, tenant isolation and a complete credential inventory in Priority 0. Client-visible shared credentials and client-supplied owner selectors require review before relying on database isolation statements. Do not assume RLS protects requests performed using a server service role.
2. Move staging ahead of alert delivery, snapshot storage and write integration tests. Keep synthetic failures and notifications away from production.
3. Specify artifact migration and download continuity as prerequisites for deleting committed ZIPs. Add release tag/manifest validation, immutable artifacts and rollback to T1.4.
4. Require validation and redaction before retry/logging/storage work; snapshot retention, restricted access and size limits belong in T2.4 from its first implementation.
5. Restrict retries to transient, safely retryable operations; use idempotency for writes/outreach, honor Retry-After and stop on authentication/LinkedIn challenge signals.
6. Fix Botdog disable enforcement before treating the toggle as reliable outreach consent.
7. Split TypeScript by module, preserving behavior and build verification. Add measurable acceptance criteria and dependencies for Priority 4 before implementation.
8. Replace calendar-week promises and weak acceptance items with evidence gates: clean-machine setup, deterministic offline fixtures, verified releases and explicit deployment receipts.
