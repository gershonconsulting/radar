# Radar Platform Improvement Roadmap — Codex Task File

Repo: gershonconsulting/radar
Purpose: Ordered, verifiable task list for Codex (or any agent) to improve the platform.
Rule: Work top-to-bottom. Do not start Priority 1 until all Priority 0 tasks are merged.
Rule: Each task has Goal / Files / Steps / Acceptance / Verify. Produce written evidence in the PR.

---

## PRIORITY 0 — Blocking (do first, in order)

### T0.1 — Establish canonical versioning
Goal: One source of truth for every component's version.
Files: STATUS.md, root *.zip filenames, app/package.json, salesnav-radar-extension/manifest.json, CHANGELOG (if any)
Steps:
1. Determine actual current versions: app (appears v1.22.0), extension (ext 1.18.2), cron worker, functions.
2. Add VERSIONS.md at repo root with table: Component | Version | Source of truth.
3. Update STATUS.md to reference VERSIONS.md instead of inline version numbers.
Acceptance: `grep -rn "v1\.6\.8\|1\.18\.1\|1\.18\.2" .` returns only VERSIONS.md and release notes.
Verify: `cat VERSIONS.md` shows a consistent table.

### T0.2 — Remove committed release artifacts
Goal: No binaries in git.
Files: delete radar-extension-v1.6.8.zip, radar-extension.zip; .gitignore
Steps:
1. Add `*.zip` to .gitignore.
2. `git rm --cached` both zips and commit removal.
3. Note in PR that releases move to GitHub Releases (see T1.4).
Acceptance: `git ls-files | grep '\.zip$'` returns nothing.
Verify: `git ls-files | grep -c '\.zip$'` → 0.

### T0.3 — Consolidate handoff documentation
Goal: One entry point for new contributors.
Files: ARIEL-HANDOFF.md, HANDOFF.txt, STATUS.md, new CONTRIBUTING.md
Steps:
1. Create CONTRIBUTING.md with sections: Architecture, Local setup, Env vars, Release process, Where to find status.
2. Merge still-relevant content from ARIEL-HANDOFF.md and HANDOFF.txt.
3. Delete ARIEL-HANDOFF.md and HANDOFF.txt after merge.
4. STATUS.md remains as roadmap/status log; link it from CONTRIBUTING.md.
Acceptance: Only CONTRIBUTING.md and STATUS.md exist as onboarding docs.
Verify: `ls *.md *.txt` shows no HANDOFF* files.

### T0.4 — Audit extension manifest.json permissions
Goal: Confirm minimum viable permissions.
Files: salesnav-radar-extension/manifest.json
Steps:
1. List every entry in permissions, host_permissions, optional_permissions.
2. For each, write a one-line justification in the PR description.
3. Remove anything not strictly required to scrape the targeted LinkedIn profile pages.
4. Confirm host_permissions matches only LinkedIn domains actually used.
Acceptance: Every permission has a justification; unused permissions removed.
Verify: `jq '.host_permissions, .permissions' salesnav-radar-extension/manifest.json` compared against PR notes.

### T0.5 — Verify Chrome Web Store privacy disclosures
Goal: Privacy policy matches actual data flow.
Files: privacy policy referenced in manifest.json / store listing; extension first-run UI
Steps:
1. Trace every network call from the extension (grep for `fetch(`, `XMLHttpRequest`, Supabase client init).
2. Confirm the policy names: linkedin.com access, the Supabase project, the Botdog endpoint, and transmitted fields.
3. If no first-run consent screen exists, add a minimal modal (full version is T3.3).
Acceptance: PR description contains a data-flow table (field → destination → purpose) matching the policy text.
Verify: Manual review; attach screenshots of consent modal if added.

---

## PRIORITY 1 — High value, low effort

### T1.1 — Add ESLint + Prettier to CI
Files: .eslintrc.*, .prettierrc, .github/workflows/ci.yml, package.json scripts
Steps: Configure for extension JS, functions/, cron/, google-apps-script/. Add `lint` and `format:check` jobs.
Acceptance: CI fails on a deliberately introduced lint error; passes on main.
Verify: Push a branch with an unused variable → CI red; remove it → CI green.

### T1.2 — Enable dependency vulnerability scanning
Files: .github/dependabot.yml, .github/workflows/ci.yml
Steps: Configure Dependabot for npm in every directory containing package.json. Add `npm audit --audit-level=high` as a CI step.
Acceptance: Dependabot PRs open automatically; CI surfaces audit failures.
Verify: Check the Dependabot tab after 24h.

### T1.3 — Add manifest permission diff guard in CI
Files: .github/workflows/ci.yml, scripts/check-manifest-permissions.js, manifest.permissions.baseline.json
Steps: Script compares current manifest.json permissions to a committed baseline. Fail if the set grows without the baseline being updated in the same PR.
Acceptance: A PR adding `tabs` permission fails CI until baseline file is updated.
Verify: Test locally with `node scripts/check-manifest-permissions.js`.

### T1.4 — GitHub Releases workflow
Files: .github/workflows/release-extension.yml
Steps: On push of a tag matching `ext-v*`, zip salesnav-radar-extension/, create a GitHub Release, attach zip named radar-extension-<tag>.zip.
Acceptance: Pushing `ext-v1.18.2` produces a Release with the correct attached artifact.
Verify: `gh release list` shows the release; unzip to confirm manifest.json version matches tag.

### T1.5 — Architecture README
Files: README.md
Steps: Add a Mermaid diagram and prose covering Extension → Supabase → Cron Worker → Apps Script → EOD report. Link to CONTRIBUTING.md for setup.
Acceptance: A new reader can explain the data flow after 5 minutes.
Verify: Render the Mermaid diagram on GitHub.

### T1.6 — Secrets and env documentation
Files: .env.example in each package, CONTRIBUTING.md section
Steps: Enumerate every env var (Supabase URL/anon/service keys, Botdog endpoints, Apps Script deployment IDs). Add one-line descriptions and where to obtain each.
Acceptance: A fresh clone can be configured without asking anyone.
Verify: Follow the doc on a clean machine/container.

---

## PRIORITY 2 — Medium effort (reliability & observability)

### T2.1 — DOM-change health detection in content script
Files: salesnav-radar-extension/ content script + popup
Steps:
1. Add healthCheck() running a lightweight selector validation against a known LinkedIn profile structure.
2. Run on load and every N minutes while active.
3. On failure: red banner in popup + POST to backend /health/scrape-failure with failure type (e.g., name_selector_missing).
Acceptance: Simulated DOM change shows banner and reports failure type.
Verify: In dev, rename a selector in a local fixture and confirm alert.

### T2.2 — Wire health-check alerts to a real channel
Files: HEALTH-CHECK-ALERTS.md, cron/ or functions/ alerting code
Steps: Ensure implementation sends to Slack/email. If only documented, implement it.
Acceptance: A synthetic failure triggers an actual alert.
Verify: Trigger test failure; confirm receipt.

### T2.3 — Exponential backoff + jitter
Files: extension scraper, cron/, functions/
Steps: Wrap all LinkedIn requests in a retry helper: max 3 attempts, backoff base * 2^n + random jitter. Apply to Supabase writes on transient errors too.
Acceptance: Unit test verifies backoff sequence.
Verify: `npm test` for the retry helper.

### T2.4 — Failed-scrape HTML snapshot logging
Files: scraper, Supabase Storage config
Steps: On parse failure, trim HTML (strip scripts, cap ~100KB), upload to Supabase Storage bucket scrape-failures/<date>/<uuid>.html, record metadata row.
Acceptance: A forced failure produces a stored snapshot retrievable by UUID.
Verify: Query the bucket after a test failure.

### T2.5 — Structured logging in Edge Functions / Cron Workers
Files: functions/, cron/
Steps: Emit JSON logs with requestId, targetUrl, durationMs, outcome, errorCode. No PII.
Acceptance: Logs queryable in Supabase logs; requestId traces a request end-to-end.
Verify: Inspect logs for a known requestId.

### T2.6 — Unit tests for scraper parsing + CI wiring
Files: tests/, .github/workflows/ci.yml
Steps: Add fixtures (trimmed HTML) for each scrape target; assert parsed objects. Ensure CI runs npm test.
Acceptance: Coverage of the parsing module; CI green.
Verify: `npm test` locally and in CI.

### T2.7 — Staging Supabase project
Files: .env.example, CONTRIBUTING.md, CI secrets
Steps: Create staging project; add SUPABASE_URL_STAGING etc. Document promotion flow (migrations applied to staging first, then prod).
Acceptance: Staging deploy succeeds independently; prod untouched.
Verify: Run migration on staging; confirm prod schema unchanged.

---

## PRIORITY 3 — Higher effort (architecture & data quality)

### T3.1 — Migrate extension + functions to TypeScript
Files: salesnav-radar-extension/, functions/
Steps: Incremental migration: add tsconfig, rename .js → .ts file-by-file, keep build output path stable. Do not change behavior in the same PR.
Acceptance: `tsc --noEmit` passes; extension builds identically (behavior verified by tests).
Verify: `npm run build` + existing unit tests pass.

### T3.2 — Zod schema validation at boundaries
Files: scraper output, Supabase write layer, functions
Steps: Define schemas for each scraped entity. Validate before write. On failure: log + reject record, do not crash batch.
Acceptance: Malformed fixture is rejected with a typed error; batch continues.
Verify: Add a fixture missing a required field; test asserts rejection.

### T3.3 — First-run consent modal (full version)
Files: extension popup/options
Steps: On first install, show modal listing data collected, destination (Supabase project name/URL), purpose. Require explicit accept before any network call. Store consent with timestamp.
Acceptance: No network calls fire before consent.
Verify: Fresh install → no requests until accept; inspect DevTools Network tab.

### T3.4 — Snapshot diffing instead of raw blob storage
Files: Supabase schema migration, scraper write path, diff generation job
Steps:
1. Add profile_snapshots and profile_events tables.
2. On each scrape, compute field-level diff vs. latest snapshot.
3. Write an event row per changed field (job_title_changed, company_changed, endorsements_delta).
Acceptance: Re-scraping an unchanged profile produces zero events; a changed title produces one event.
Verify: Integration test with two fixtures (same / changed).

### T3.5 — RLS policy tests
Files: tests/rls/
Steps: For each table, test: tenant A cannot read tenant B's rows; anon key cannot read anything privileged; service role can read all.
Acceptance: All RLS tests pass in CI against staging.
Verify: `npm run test:rls` against staging.

### T3.6 — Data-quality dashboard
Files: app/
Steps: Surface scrape success rate (24h), selector failure rate, records rejected by validation, stale profiles (>N days). Backed by a simple aggregation query.
Acceptance: Dashboard renders on staging with real numbers.
Verify: Manual inspection; numbers reconcile with logs.

### T3.7 — End-to-end pipeline test
Files: tests/e2e/
Steps: Fixture HTML → parse → validate → write to staging Supabase → diff generation → report render. Assert final report contents.
Acceptance: Runs in CI against staging; deterministic.
Verify: `npm run test:e2e`.

---

## PRIORITY 4 — New features (after foundation)

- T4.1 Change alerting UI — "3 contacts changed jobs this week" instead of raw JSON.
- T4.2 Selector versioning with fallbacks — per-field ordered selector lists; auto-fallback when primary fails.
- T4.3 Self-serve re-auth flow — detect expired LinkedIn session; prompt to reconnect.
- T4.4 Team audit log — record who viewed/exported which competitor data.
- T4.5 Public extension changelog page — linked from store listing.
- T4.6 Per-user rate-limit dashboard — prevent accidental account flags.

---

## Definition of Done (every task)

1. PR description includes the task ID and verification evidence (command output or screenshot).
2. CI is green (lint, tests, manifest guard).
3. No secrets or binaries committed.
4. CONTRIBUTING.md or VERSIONS.md updated if the change affects setup or versioning.
5. Reviewer signs off on acceptance criteria, not just code style.

---

## Suggested sequence

Week 1:   T0.1 → T0.5
Week 2:   T1.1 → T1.6
Week 3-4: T2.1 → T2.7
Week 5-8: T3.1 → T3.7
Ongoing:  T4.x, prioritized by user feedback

Highest-leverage single fix: T0.1 + T0.2 + T1.4 together — they eliminate the version/release chaos that makes every other improvement untrustworthy.
