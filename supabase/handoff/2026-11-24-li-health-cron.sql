-- HANDOFF (nightly 2026-11-24). NOT APPLIED. Run once in the SQL editor of project "radar"
-- (pkzeeqehwmtnqxdpdesl) AFTER the li-health function is deployed and its secrets are set.
-- Schedules the two LinkedIn safety reports that were Claude scheduled tasks #39 and #11.
-- No table is created or changed. pg_cron runs in UTC:
--   #39 daily  18:41 New York (EST) = 23:41 UTC  (19:41 New York during daylight saving)
--   #11 weekly Monday 15:00 UTC (same cron as the scheduled task: "0 15 * * 1")
--
-- Prerequisite (Vault, once): the cron job reads the shared secret from Vault, so it never sits in cron.job.
--   select vault.create_secret('<same value as the LI_HEALTH_CRON_SECRET function secret>', 'li_health_cron_secret');

select cron.schedule('li-health-daily-39', '41 23 * * *', $$
  select net.http_post(
    url := 'https://pkzeeqehwmtnqxdpdesl.supabase.co/functions/v1/li-health',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('mode','daily','secret',(select decrypted_secret from vault.decrypted_secrets where name='li_health_cron_secret' limit 1)),
    timeout_milliseconds := 60000);
$$);

select cron.schedule('li-health-weekly-11', '0 15 * * 1', $$
  select net.http_post(
    url := 'https://pkzeeqehwmtnqxdpdesl.supabase.co/functions/v1/li-health',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('mode','weekly','secret',(select decrypted_secret from vault.decrypted_secrets where name='li_health_cron_secret' limit 1)),
    timeout_milliseconds := 120000);
$$);

-- Verify:   select jobname, schedule from cron.job where jobname like 'li-health-%';
-- Rollback: select cron.unschedule('li-health-daily-39'); select cron.unschedule('li-health-weekly-11');
