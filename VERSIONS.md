# Component versions

These are repository source versions, inspected on 2026-11-22. They do not certify what is deployed. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for releases and [STATUS.md](STATUS.md) for deployment work.

| Component | Version | Source of truth |
| --- | --- | --- |
| Pages app and Pages Functions | 1.22.2 | `APP_VERSION` in `functions/_lib/version.js`; no `app/package.json` exists |
| Extension source | 1.18.3 | `version` in `salesnav-radar-extension/manifest.json` |
| Published extension download marker | 1.18.2 | `LATEST_EXT` in `functions/_lib/version.js`; advance only after publishing the matching artifact |
| EOD cron Worker | Git commit of `cron/` | No independent semantic version; `cron/package.json` declares module type only |
| Supabase hub | 26.1 | Source header in `supabase/functions/hub/index.ts`; deployment revision numbers are separate |
| Supabase daily-report | v9.4 | `REPORT_VERSION` in `supabase/functions/daily-report/index.ts` |
| Supabase health-check | v4-working-hours | Response `version` in `supabase/functions/health-check/index.ts` |
| Supabase monthly-report | v1 | Source header in `supabase/functions/monthly-report/index.ts`; required `report.js` is absent from this repo |
| Legacy Apps Script | Git commit of `google-apps-script/` | No independent version declaration; separate deployment |

The extension source and the published download marker describe different states deliberately: never advertise an unpublished build. Previous extension source was 1.18.2; previous app source was 1.22.1. Historical versions belong in changelogs, not the current status page. ZIP filenames are release artifacts, never version authorities.

When changing a component, bump its source authority and update this table in the same PR. For unversioned components, record the release commit in the GitHub Release/deployment record; do not invent a semantic version from old handoff notes.
