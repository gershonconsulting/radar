# Radar status

Updated 2026-11-22. See [VERSIONS.md](VERSIONS.md) for component versions and [CONTRIBUTING.md](CONTRIBUTING.md) for setup, architecture and deployment.

Production app: https://radar.gershon.ai/app. The legacy radar.gershoncrm.com host remains supported. Health: /api/health. Pages deploys from main; Edge Functions and Apps Script deploy separately. Historical completion notes are in [CHANGELOG.md](CHANGELOG.md).

## Improvement roadmap

- Priority 0 draft: version inventory (T0.1), remove tracked ZIPs (T0.2), consolidate contributor guidance (T0.3), permission audit (T0.4), privacy disclosure and collection consent (T0.5).
- Before merge: confirm published extension artifacts are available outside git, inspect the consent UI in Chrome, verify collection/tab operations with reduced permissions, and compare the actual Chrome Web Store listing with the policy/data-flow evidence.
- Keep the published extension marker unchanged until the new source build has a verified release artifact. Source changes do not certify deployment.
- Priority 1 stays blocked until all Priority 0 acceptance criteria are reviewed and merged. Linting, dependency scanning, the manifest baseline guard, automated GitHub Releases, architecture README and complete environment examples follow in that order.
- Later: establish staging before tests that write records/send alerts; redact and restrict any future HTML snapshots; split TypeScript migration into small behavior-preserving PRs.

## Existing deployment follow-ups (not reverified by this PR)

- Chrome Web Store: complete screenshots, promotional image, permission explanations, privacy practices, Limited Use and test notes before submission.
- Check whether Supabase daily-report and health-check need redeployment for updated links; inspect deployed source first.
- Keep legacy redirects disabled until collecting desktops have the new-host extension support; then evaluate REDIRECT_LEGACY in functions/_lib/hosts.js.
- Roll out the source build to client collectors before enabling approved bridge invitations per account.
- Verify Workers AI binding AI and SUPABASE_SERVICE_KEY in Pages Production and Preview. Historical notes report these missing; no live configuration check was performed here.
- The hub outreach push does not consistently honor botdog_enabled. Treat disabling outreach as an unresolved behavior issue, and describe this caveat in privacy disclosures.
- EOD deployment needs the configured GitHub Actions secrets; confirm successful delivery before retiring any older scheduled report.
- Reconcile older PR references and deployment claims against GitHub/live services before taking action; historical handoff statements are not current approval.
