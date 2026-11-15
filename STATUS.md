# Radar - STATUS (updated 2026-11-15)

App: https://radar.gershoncrm.com/app/  - health: https://radar.gershoncrm.com/api/health
Version: 1.19.0 (single source: functions/_lib/version.js, which also holds the extension's LATEST_EXT)
Deploy route: Cloudflare Pages project "gershon-radar", Git-connected - merge to main auto-deploys
(branch previews at <branch>.gershon-radar.pages.dev). Supabase edge functions deploy separately (Ariel).

## Done
- ✅ v1.19.0 (PR #22, merged 2026-11-15): bridge ICP ranking panel on the Bridges page (/api/bridge-icp, own bridges only); panel links now brand red #FE1B04
- ✅ v1.18.9 (PR #28): one version source; /api/health no longer needs SUPABASE_URL binding
- ✅ v1.18.10 (PR #26): brand red #FE1B04 / #d11200 / #fff5f5 across app, landing, admin, extension popup, emails
- ✅ v1.18.11: app.html says Prospects/Prospect in all visible labels (56 strings); ids, classes, API fields, URLs unchanged

## Open
- ❌ /api/health needs the SUPABASE_SERVICE_KEY binding in Pages Production (Charles, Cloudflare dashboard)
- ❌ daily-report / health-check Supabase functions: redeploy so the email shows the new red (Ariel, verify_jwt OFF)
- ❌ PR #10 (EOD cron Worker) awaits Olivier; PR #16 superseded by #22 (can be closed)
- ❌ PR #1, #17 open (see HANDOFF.txt)
