# Radar - STATUS (updated 2026-11-23)

App: https://radar.gershon.ai/app (new address, 2026-11-18) - old https://radar.gershoncrm.com still served by the same Pages project - health: /api/health
Version: 1.23.0 (branch onboarding-page) / 1.22.1 on main (ext 1.18.2) (#35 Intelligence menu 1.20.0, then #34 Botdog switch 1.21.0) (single source: functions/_lib/version.js, which also holds the extension's LATEST_EXT)
Deploy route: Cloudflare Pages project "gershon-radar", Git-connected - merge to main auto-deploys
(branch previews at <branch>.gershon-radar.pages.dev). Supabase edge functions deploy separately (Ariel).

## Done
- ✅ v1.23.0 (2026-11-23, branch onboarding-page): checklist removed from the Dashboard; menu "Setup" renamed "Onboarding"; page = 1 ICP link (input, inline save) - 2 Radar list in Sales Nav (output, inline save; Bridges list optional) - 3 Chrome extension (auto-detected, re-checked every 3 s while the page is open, no manual confirm) - 4 Sources & Bridges. Inline saves reuse saveIcpTemplate / saveSalesNavList
- ✅ v1.22.1 + ext 1.18.2 (2026-11-19, branch cws-prep): Chrome Web Store prep - extension renamed "Radar — Prospect Collector" (app/landing/health-check texts updated), new description + homepage_url, host permissions cut to linkedin, radar hosts, Radar Supabase project, enricherpro, api.botdog.co; /privacy page (app/privacy.html) + footer link
- ✅ v1.22.0 + ext 1.18.1 (2026-11-18, branch move-to-radar-gershon-ai): move to radar.gershon.ai. functions/_lib/hosts.js (PRIMARY_HOST, REDIRECT_LEGACY=false); LinkedIn login uses https://radar.gershon.ai/api/auth/linkedin/callback on the new host, env LINKEDIN_REDIRECT_URI elsewhere; login/logout return to the host the user is on; links in landing, app footer, extension page, Intelligence prompt, EOD worker, daily-report, health-check, Code.gs point to the new address; hub APP_ORIGIN_RE accepts radar.gershon.ai; ext 1.18.1 adds the new host (content script + host permission). Emails still sent from radar@gershoncrm.com (Resend domain). tests/hosts.test.mjs
- ✅ ext 1.18.0 (2026-11-18, branch ext-1.18.0-bridge-invites): bridge invites for client accounts (invites.js, OFF by default; config bridge_invites=on|dry, bridge_invite_note, limit_invites_per_day 5 / _per_week 20) + empty-discovery sources rest 30 days. Root cause of Valos / Altavia / Flying Secoya = 0 leads: their bridges are 2nd/3rd degree and nothing invited them; Flying Secoya also burned its pages re-searching 2 empty sources. Live dry test on Sales Nav OK. tests/invites.test.js
- ✅ v1.21.0 Botdog ON/OFF switch (2026-11-17, branch botdog-toggle): Settings "Use Botdog for outreach" saved per account (config botdog_enabled via /api/botdog-setting, owner from session). OFF hides every Botdog column, filter, KPI, action, invite button/chip, onboarding step, campaigns card and key field. Default when unset = ON only if a Botdog key exists (only Olivier has one)
- ✅ v1.20.0 Intelligence menu (2026-11-17, branch feature/intelligence-menu): sidebar Overview > Intelligence with AI Analysis / AI Suggestions / AI Chat on Cloudflare Workers AI. functions/api/intelligence.js builds the account summary server-side from Supabase for the session owner only (sources, bridges, prospects aggregated, ICP grades, bridge verdicts, 7-day activity); app/intelligence.js injected by _middleware item 8; tests/intelligence.test.mjs
- ✅ v1.19.3 (2026-11-18, branch nightly/2026-11-18-prospects-wording): landing page index.html says Prospects instead of Target(s) (6 visible strings). admin.html, sources-list.js had no visible Target text left; app.html untouched, prospects-wording.js shim kept.
- ✅ v1.19.2 (2026-11-17, branch admin-campaigns): /admin = "All campaigns" master view of every account (status healthy/slowing/stalled/paused/not started, sources, bridges, prospects, 7-day, ICP share, Sales Nav list, Botdog, last collection, details, CSV). Admin only via /api/admin-campaigns (read-only, same admin rule as /api/admin-users). User management moved to /admin-users. tests/admin-campaigns.test.mjs
- ✅ health-check v4 (2026-11-17, branch nightly/2026-11-17-radar-health-weekend): 36 h "stopped collecting" threshold counts working hours only (Sat/Sun ET excluded) - no more Monday-morning false alert; ?dry=1 dry run; tests/health-check.test.mjs
- ✅ v1.19.1 + daily-report v9.3 (PR #31, merged 2026-11-16; site v1.19.1 live; EOD Worker deploy fails - GitHub secret RADAR_HUB_SECRET missing; Supabase daily-report still v9.2 until redeployed): Resend sends retry 429/5xx/network 3x (1s/4s/10s) with the same Idempotency-Key - daily-report (_shared/resend.ts) and EOD Worker (cron/resend.js)
- ✅ v1.19.0 (PR #22, merged 2026-11-15): bridge ICP ranking panel on the Bridges page (/api/bridge-icp, own bridges only); panel links now brand red #FE1B04
- ✅ v1.18.9 (PR #28): one version source; /api/health no longer needs SUPABASE_URL binding
- ✅ v1.18.10 (PR #26): brand red #FE1B04 / #d11200 / #fff5f5 across app, landing, admin, extension popup, emails
- ✅ v1.18.11: app.html says Prospects/Prospect in all visible labels (56 strings); ids, classes, API fields, URLs unchanged

## Open
- ❌ Chrome Web Store: fill listing (screenshots 1280x800, promo 440x280, permission justifications, privacy practices + Limited Use, test notes, unlisted) and submit ext 1.18.2
- ✅ radar.gershon.ai live (custom domain attached; LinkedIn redirect URL added 2026-11-19)

- ✅ hub v26.1 deployed 2026-11-19 (Supabase version 27): radar.gershon.ai sees suggested sources
- ❌ Redeploy Supabase daily-report + health-check (new links)
- ❌ After client desktops run ext 1.18.1: set REDIRECT_LEGACY = true in functions/_lib/hosts.js
- ❌ 1.18.0: load the new extension on the Valos, Altavia and Flying Secoya desktops, then set bridge_invites=on + the note Olivier approves (config, per account)
- ❌ Intelligence needs the Workers AI binding `AI` on Pages project gershon-radar (Settings > Bindings, Production + Preview) - without it the page says "being switched on"
- ✅ v1.19.2 /admin campaigns PR #36: merged 2026-11-18, live 1.19.3 (live data still needs the SUPABASE_SERVICE_KEY binding in Pages Production, Charles). Not built: "View as" a client (needs login changes) and "draft email to client".
- ❌ Hub push (pushTargetsFor / pushBridges) does not yet read botdog_enabled - only matters if Olivier turns his own Botdog OFF (clients have no key, so nothing is pushed for them)
- ❌ daily-report v9.3: needs a Supabase function redeploy (Ariel, verify_jwt OFF); monthly-report keeps its own 429-only retry; health-check function + Code.gs send once
- ❌ /api/health needs the SUPABASE_SERVICE_KEY binding in Pages Production (Charles, Cloudflare dashboard)
- ❌ daily-report Supabase function: redeploy so the email shows the new red (Ariel, verify_jwt OFF) - health-check done with v4
- ❌ PR #10 (EOD cron Worker) awaits Olivier; PR #16 superseded by #22 (can be closed)
- ❌ PR #1, #17 open (see HANDOFF.txt)
