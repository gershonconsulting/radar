-- App v1.24.0 - NOT YET APPLIED (auto-mode refused the trigger on 2026-11-25; needs Olivier's OK).
-- The Bridges page grades bridges from config key icp_rules. Rows were copied once on 2026-11-25
-- for the 7 accounts with ICP rules. This trigger keeps the key in sync when icp_rules changes.
create or replace function public.radar_icp_rules_to_config() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    delete from public.config where owner_key = old.owner_key and key = 'icp_rules';
    return old;
  end if;
  insert into public.config(owner_key, key, value, updated_at)
  values (new.owner_key, 'icp_rules',
          json_build_object('role', new.role_regex, 'senior', new.senior_regex, 'bad', new.bad_regex)::text, now())
  on conflict (owner_key, key) do update set value = excluded.value, updated_at = excluded.updated_at;
  return new;
end $$;
drop trigger if exists trg_icp_rules_to_config on public.icp_rules;
create trigger trg_icp_rules_to_config after insert or update or delete on public.icp_rules
for each row execute function public.radar_icp_rules_to_config();
