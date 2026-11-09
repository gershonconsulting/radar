-- supabase/handoff/2026-11-06-targets-first-seen.sql
-- NOT APPLIED. Needs Ariel: Supabase dashboard -> project radar (pkzeeqehwmtnqxdpdesl) -> SQL editor
-- -> paste this whole file -> Run (it is one transaction; it either all lands or nothing does).
--
-- WHY (nightly 2026-11-06 data-quality investigation)
-- The hub ingest upserts targets with on_conflict=owner_key,lead_id + resolution=merge-duplicates and
-- sends collected_date = now() for every lead, so every time a prospect is collected AGAIN its
-- collected_date is moved to today. radar_daily_stats counts "new prospects" on collected_date, so:
--   * the 2026-11-03 email said +154 for Nov 2 and the 2026-11-04 email +37 for Nov 3, but the same
--     query on 2026-11-06 returns 47 and 0 (owner xTVW0K1qKi) - those prospects were re-collected on
--     Nov 5 and "moved" there;
--   * Nov 5 counts 633 "new" for that owner although only ~47 have no earlier trace;
--   * 2,791 targets were pushed to Botdog and 7,718 were put on a Sales Nav list BEFORE their own
--     collected_date - impossible unless collected_date was overwritten.
--
-- WHAT THIS DOES
-- 1. targets.first_seen_at: the first time Radar saw the prospect. Backfilled from the earliest date we
--    still hold for the row: least(collected_date, botdog_pushed, salesnav_listed_at). That is a
--    best-effort LOWER BOUND - rows that were never pushed/listed keep their (possibly bumped)
--    collected_date, because the original value is gone. Preview (read-only, 2026-11-06) for
--    xTVW0K1qKi: Nov 2 = 85 (was 47; email said 154), Nov 3 = 12 (was 0; email said 37),
--    Nov 5 = 47 (was 633).
-- 2. Trigger: first_seen_at is set once on INSERT and can NEVER be changed by an UPDATE (including the
--    UPDATE half of an upsert), whatever the payload says.
-- 3. radar_daily_stats counts on first_seen_at instead of collected_date (so daily-report,
--    and anything else using the RPC, gets stable numbers that cannot shrink later).
-- Nothing is deleted. collected_date is kept; with hub v26 it also stops being overwritten.

begin;

-- 1. column + backfill
alter table public.targets add column if not exists first_seen_at timestamptz;

-- trg_radar_icp_score only fires on UPDATE OF title/country/city/owner_key, so this backfill
-- (first_seen_at only) does not re-score anything.
update public.targets
   set first_seen_at = least(collected_date,
                             coalesce(botdog_pushed,      collected_date),
                             coalesce(salesnav_listed_at, collected_date))
 where first_seen_at is null;

alter table public.targets alter column first_seen_at set default now();
alter table public.targets alter column first_seen_at set not null;

create index if not exists targets_owner_first_seen_idx on public.targets (owner_key, first_seen_at);

-- 2. never overwritten
create or replace function public.targets_keep_first_seen()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    new.first_seen_at := coalesce(new.first_seen_at, new.collected_date, now());
  else
    new.first_seen_at := old.first_seen_at;   -- immutable after insert, even on upsert
  end if;
  return new;
end;
$$;

drop trigger if exists trg_targets_keep_first_seen on public.targets;
create trigger trg_targets_keep_first_seen
  before insert or update on public.targets
  for each row execute function public.targets_keep_first_seen();

-- 3. radar_daily_stats counts on first_seen_at.
-- Rewrites the LIVE definition (not a copy pasted here, so nothing else in the RPC can drift):
-- every collected_date in it (t_y, t_p, t_7, t_30 windows and last_capture) becomes first_seen_at.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.radar_daily_stats(text,timestamptz,timestamptz)'::regprocedure);
  if position('collected_date' in d) = 0 then
    raise exception 'radar_daily_stats no longer mentions collected_date - check it by hand';
  end if;
  execute replace(d, 'collected_date', 'first_seen_at');
  if position('collected_date' in pg_get_functiondef('public.radar_daily_stats(text,timestamptz,timestamptz)'::regprocedure)) > 0 then
    raise exception 'radar_daily_stats still counts on collected_date';
  end if;
end $$;

commit;

-- CHECK AFTERWARDS (read-only):
--   select (first_seen_at at time zone 'America/New_York')::date d, count(*)
--     from targets where owner_key = 'xTVW0K1qKi' and first_seen_at >= '2026-11-01'
--    group by 1 order by 1;
--   -> expect about Nov 2: 85, Nov 3: 12, Nov 5: 47.
--   select count(*) from targets where first_seen_at > least(collected_date,
--     coalesce(botdog_pushed, collected_date), coalesce(salesnav_listed_at, collected_date));
--   -> expect 0.
