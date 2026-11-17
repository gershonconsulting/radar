# Radar - STATUS (updated 2026-11-17)

App: https://radar.gershoncrm.com/app/  - health: https://radar.gershoncrm.com/api/health
Version: 1.19.1 on main, 1.20.0 in PR (Intelligence menu) (single source: functions/_lib/version.js, which also holds the extension's LATEST_EXT)
Deploy route: Cloudflare Pages project "gershon-radar", Git-connected - merge to main auto-deploys
(branch previews at <branch>.gershon-radar.pages.dev). Supabase edge functions deploy separately (Ariel).

## Done
- ✅ v1.20.0 Intelligence menu (2026-11-17, branch feature/intelligence-menu): sidebar Overview > Intelligence with AI Analysis / AI Suggestions / AI Chat on Cloudflare Workers AI. functions/api/intelligence.js builds the account summary server-side from Supabase for the session owner only (sources, bridges, prospects aggregated, ICP grades, bridge verdicts, 7-day activity); app/intelligence.js injected by _middleware item 8; tests/intelligence.test.mjs
- ✅ health-check v4 (2026-11-17, branch nightly/2026-11-17-radar-health-weekend): 36 h "stopped collecting" threshold counts working hours only (Sat/Sun ET excluded) - no more Monday-morning false alert; ?dry=1 dry run; tests/health-check.test.mjs
- ✅ v1.19.1 + daily-report v9.3 (PR #31, merged 2026-11-16; site v1.19.1 live; EOD Worker deploy fails - GitHub secret RADAR_HUB_SECRET missing; Supabase daily-report still v9.2 until redeployed): Resend sends retry 429/5xx/network 3x (1s/4s/10s) with the same Idempotency-Key - daily-report (_shared/resend.ts) and EOD Worker (cron/resend.js)
- ✅ v1.19.0 (PR #22, merged 2026-11-15): bridge ICP ranking panel on the Bridges page (/api/bridge-icp, own bridges only); panel links now brand red #FE1B04
- ✅ v1.18.9 (PR #28): one version source; /api/health no longer needs SUPABASE_URL binding
- ✅ v1.18.10 (PR #26): brand red #FE1B04 / #d11200 / #fff5f5 across app, landing, admin, extension popup, emails
- ✅ v1.18.11: app.html says Prospects/Prospect in all visible labels (56 strings); ids, classes, API fields, URLs unchanged

## Open
- ❌ Intelligence needs the Workers AI binding `AI` on Pages project gershon-radar (Settings > Bindings, Production + Preview) - without it the page says "being switched on"
- ❌ daily-report v9.3: needs a Supabase function redeploy (Ariel, verify_jwt OFF); monthly-report keeps its own 429-only retry; health-check function + Code.gs send once
- ❌ /api/health needs the SUPABASE_SERVICE_KEY binding in Pages Production (Charles, Cloudflare dashboard)
- ❌ daily-report Supabase function: redeploy so the email shows the new red (Ariel, verify_jwt OFF) - health-check done with v4
- ❌ PR #10 (EOD cron Worker) awaits Olivier; PR #16 superseded by #22 (can be closed)
- ❌ PR #1, #17 open (see HANDOFF.txt)
