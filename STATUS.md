# Radar - STATUS (updated 2026-11-14)

App: https://radar.gershoncrm.com/app/  - health: https://radar.gershoncrm.com/api/health
Version: 1.18.11 (single source: functions/_lib/version.js; extension version is LATEST_EXT in functions/_middleware.js)
Deploy route: Cloudflare Pages project "gershon-radar", Git-connected - merge to main auto-deploys
(branch previews at <branch>.gershon-radar.pages.dev). Supabase edge functions deploy separately (Ariel).

## Done
- ✅ v1.18.9 (PR #28): one version source; /api/health no longer needs SUPABASE_URL binding
- ✅ v1.18.10 (PR #26): brand red #FE1B04 / #d11200 / #fff5f5 across app, landing, admin, extension popup, emails
- ✅ v1.18.11: app.html says Prospects/Prospect in all visible labels (56 strings); ids, classes, API fields, URLs unchanged

## Open
- ❌ /api/health needs the SUPABASE_SERVICE_KEY binding in Pages Production (Charles, Cloudflare dashboard)
- ❌ daily-report / health-check Supabase functions: redeploy so the email shows the new red (Ariel, verify_jwt OFF)
- ❌ PR #22 (bridge ICP ranking, v1.19.0) and PR #10 (EOD cron Worker) await Olivier
- ❌ PR #1, #17 open (see HANDOFF.txt)
