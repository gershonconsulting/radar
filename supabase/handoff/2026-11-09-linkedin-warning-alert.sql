-- 2026-11-09 (ext 1.17.2): email report@gershonconsulting.com as soon as an extension logs a
-- LinkedIn warning (401/403/429/check page). Before this, David's 401s ran 9 days unnoticed.
-- NOT YET APPLIED: needs Olivier's "deploy the LinkedIn warning alert to production".
create table if not exists public.radar_li_alerts (
  id bigserial primary key, owner_key text not null, at timestamptz not null default now(),
  detail jsonb, emailed boolean default false);
create index if not exists radar_li_alerts_owner_at on public.radar_li_alerts(owner_key, at desc);
alter table public.radar_li_alerts enable row level security;

create or replace function public.radar_alert_linkedin_warning() returns trigger
language plpgsql security definer set search_path = public as $$
declare w jsonb; who text; k text; html text; aid bigint;
begin
  if new.action <> 'sync_log' or position('linkedin:warning' in new.detail::text) = 0 then return new; end if;
  if exists (select 1 from radar_li_alerts where owner_key = new.owner_key and at > now() - interval '12 hours') then return new; end if;
  select e into w from jsonb_array_elements(coalesce(new.detail->'log','[]'::jsonb)) e where e->>'msg' = 'linkedin:warning' limit 1;
  select coalesce(nullif(display_name,''), email) into who from users where owner_key = new.owner_key limit 1;
  if who is null then
    select coalesce(detail->>'name', detail->>'email') into who from activity_log where owner_key = new.owner_key and action = 'login' order by at desc limit 1;
  end if;
  insert into radar_li_alerts(owner_key, detail) values (new.owner_key, w) returning id into aid;
  select value into k from config where key = 'resend_api_key' and value <> '' limit 1;
  if k is null then return new; end if;
  html := '<p><b>LinkedIn warned a Radar account.</b> Radar stopped ALL LinkedIn activity on it for '
       || coalesce(w->'data'->>'holdHours','48') || ' hours.</p><p>Account: ' || coalesce(who,'(unknown)')
       || ' - owner ' || new.owner_key || '<br>Where: ' || coalesce(w->'data'->>'where','?')
       || '<br>Signal: ' || coalesce(w->'data'->>'status','?') || '<br>Time: ' || coalesce(w->>'ts', now()::text)
       || '</p><p>Check the account owner can still use LinkedIn before it resumes.</p>';
  perform net.http_post(url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization','Bearer '||k,'Content-Type','application/json'),
    body := jsonb_build_object('from','Radar <radar@gershoncrm.com>','to',jsonb_build_array('report@gershonconsulting.com'),
      'subject','Radar: LinkedIn warning on '||coalesce(who,new.owner_key)||' - paused 48h','html',html));
  update radar_li_alerts set emailed = true where id = aid;
  return new;
exception when others then return new;
end $$;
drop trigger if exists trg_radar_linkedin_warning on public.activity_log;
create trigger trg_radar_linkedin_warning after insert on public.activity_log
for each row execute function public.radar_alert_linkedin_warning();
