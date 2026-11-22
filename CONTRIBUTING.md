# Contributing to Radar

## Architecture

Radar collects business profiles visible in a user's signed-in LinkedIn Sales Navigator session. `salesnav-radar-extension/` contains the Manifest V3 background worker, injected LinkedIn parsers, and the Radar app bridge. It posts to the Supabase `radar` project (`pkzeeqehwmtnqxdpdesl`), primarily `/functions/v1/hub`, with `/functions/v1/radar-gate` enforcing shared collection limits. The gate's source is not in this repository.

`app/` is the static dashboard; `functions/` contains Cloudflare Pages middleware, sign-in and API routes. Supabase Edge Function sources and SQL handoff migrations live in `supabase/`. `cron/` is a separate Cloudflare Worker that still calls the legacy Apps Script hub to prepare an EOD email through Resend. `google-apps-script/Code.gs` is that legacy integration; do not assume every report uses the Supabase hub. Supabase daily, monthly and health emails are separate from the EOD Worker.

## Local setup

Use Node.js 22.18 or newer (native TypeScript stripping is needed by the offline report tests). Clone the repository and run each `tests/*.test.js`, `tests/*.test.mjs` and `cron/worker.test.mjs` with Node. They stub external services; no production credentials are needed. The optional DOM invite cases require jsdom; the test reports when they are skipped.

For the website, use Cloudflare Wrangler Pages development with `app/` as the static asset directory and repository-root `functions/` as Pages Functions. Configure preview credentials before testing authenticated APIs; serving static HTML alone does not exercise middleware or sign-in. Preview sign-in needs a matching LinkedIn redirect URI.

For Chrome, open Extensions, enable Developer mode and load the entire `salesnav-radar-extension/` folder unpacked. After source changes, reload its extension card. Updates from GitHub do not update an unpacked installation automatically. Accept the collection disclosure in the popup before collection, then sign in to Radar and LinkedIn in the same browser. The Radar page bridge announces the extension version and passes the current owner's key; never add demo bridges or fall back to another account.

## Env vars

Configure Cloudflare Pages Production and Preview separately in the project `gershon-radar`. Obtain service keys from the Radar Supabase project settings, LinkedIn credentials from its developer app, and email keys from Resend. Use local `.dev.vars` only for local development; never commit real keys.

| Runtime | Configuration | Purpose |
| --- | --- | --- |
| Pages | `SESSION_SECRET` | Session signing secret; generate a private random value |
| Pages | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI` | LinkedIn OpenID sign-in and approved callback |
| Pages | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Backend URL and server-only service-role key; several routes require an explicit URL even though others have a default |
| Pages | `ADMIN_EMAILS`, `ALLOWLIST` | Comma-separated admin and permitted-login emails |
| Pages | `HUB_SECRET` | Legacy admin hub authentication |
| Pages | `BOTDOG_API_KEY`, `BOTDOG_CAMPAIGN_ID` | Optional outreach credentials/campaign |
| Pages | `RESEND_API_KEY`, `PAPPERS_API_KEY` | Email/company enrichment where enabled |
| Pages | Workers AI binding `AI` | Intelligence menu model access; configure in both environments |
| EOD Worker | `RADAR_HUB_SECRET`, `RESEND_API_KEY` | Legacy Apps Script hub access and EOD delivery |
| GitHub Actions | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RADAR_HUB_SECRET`, `RESEND_API_KEY` | EOD deploy workflow credentials |
| Supabase functions | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, optional `RESEND_API_KEY` | Backend database and report transport; configured as Edge Function secrets |

Some third-party keys are also read from owner-specific Supabase `config` rows. The extension has compile-time hub/gate URLs and an existing shared ingest credential, not environment-variable substitution. That existing client credential is not a server secret and must not be treated as authentication for privileged data. Never put a Supabase service key into the extension. Botdog is optional; the hub may perform outreach with server-stored configuration even without a local extension key.

## Release process

Read [VERSIONS.md](VERSIONS.md) before bumping a version. App/Pages versions are stamped from `functions/_lib/version.js`; extension UI reads its manifest. Extension code changes require a manifest version bump. Keep `LATEST_EXT` at the last published downloadable build until the new ZIP has been published and checked.

Changes go through a PR with task IDs, test evidence, permission explanations where relevant, and reviewer acceptance. Merging to `main` auto-deploys the Git-connected Cloudflare Pages project; branch previews use `<branch>.gershon-radar.pages.dev`. The EOD workflow deploys only on changes to `cron/` or its workflow. Supabase Edge Functions and Apps Script deploy separately; do not infer deployment from a source merge. Apply SQL migrations before deploying code that requires them and verify owner isolation. Report functions historically use `verify_jwt=false`; preserve the intended invocation/authentication model rather than changing it incidentally.

ZIP artifacts are excluded from git at all paths, including `app/`. New artifacts belong in GitHub Releases. The automated `ext-v*` release workflow is roadmap task T1.4 and must wait until Priority 0 is merged. Existing versioned download routes retain their Supabase Storage fallback during that transition. Before merging artifact removal, verify the published download is available outside git. Before advertising a new extension build, unzip the release asset and compare its manifest version; never update the marker first.

For reporting changes, inspect Supabase function source against the deployed function before redeploying. The monthly report is incomplete locally because its imported `report.js` is not tracked. The first-seen migration in `supabase/handoff/` preserves prospect creation dates; ingest must not rewrite `first_seen_at`. Dry report endpoints support inspection without sending mail; see the function source and tests before use.

## Where to find status

[STATUS.md](STATUS.md) is the current roadmap and deployment checklist. [CHANGELOG.md](CHANGELOG.md) preserves previous status history; the extension has its own [changelog](salesnav-radar-extension/CHANGELOG.md). [HEALTH-CHECK-ALERTS.md](HEALTH-CHECK-ALERTS.md) explains the watchdog pattern; current executable behavior is in `supabase/functions/health-check/`.

Collection mode is per computer (`radar_collecting` in browser local storage), never per account. Viewers still see stale-data notices, but their UI must not tell them to install a collector unnecessarily. Supabase scheduled reports distinguish working days from weekends. Keep source-version, published-artifact and live-deployment evidence separate.
