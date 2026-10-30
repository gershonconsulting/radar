-- HANDOFF (nightly 2026-10-27). NOT APPLIED. Run by hand after Olivier approves.
-- Project: Supabase "Cookie" zywlzopoxhkbblembkja (LinkedIn Access Gate), NOT the radar project.
--
-- Why: on 2026-09-23 17:15 UTC the olivier-primary row was raised to 150/day, 600/week, 45/hour
-- ("soft caps for Radar ext 1.15.0"). The runbook ceiling is 80/day and 400/week, and the row's own
-- notes say "80 steady (runbook ceiling)". The gate is enforcing (radar config gate_enforce='true';
-- the ledger shows app_daily_budget_spent / account_weekly_cap_spent denials). It is enforcing 150.
-- Ledger for olivier-primary (all app radar): 20 Oct 150, 21 Oct 150, 22 Oct 150, 23 Oct 18 + weekly-cap
-- deny (600/600 spent), 26 Oct 150.
--
-- The one-row change:
update li_gate_accounts
   set daily_cap = 80, weekly_cap = 400, updated_at = now(),
       notes = notes || ' | 2026-10-27: restored runbook ceiling 80/day 400/week (was 150/600 since 2026-09-23)'
 where account_key = 'olivier-primary';

-- Verify:
-- select account_key, daily_cap, weekly_cap, hourly_cap from li_gate_accounts where account_key = 'olivier-primary';
--
-- The account cap binds before the per-app budget, so Radar's 150/day override in li_gate_app_budgets
-- ('olivier-primary','radar') and li_gate_apps.radar.daily_budget=150 no longer matter once this runs.
-- To make the numbers agree, also lower them to <= 80. That is optional and not required for the cap.
-- Rollback: set daily_cap = 150, weekly_cap = 600.
