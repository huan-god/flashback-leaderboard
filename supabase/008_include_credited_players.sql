-- Provision player profiles for credited table entries and include them in public player honors.
create table public.credited_player_profiles (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (char_length(btrim(display_name)) between 2 and 80),
  name_key text generated always as (lower(btrim(normalize(display_name, NFKC)))) stored unique,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.credited_player_profiles enable row level security;
revoke all on public.credited_player_profiles from anon, authenticated;
grant select on public.credited_player_profiles to anon, authenticated;

alter table public.submissions
  add column credited_profile_id uuid references public.credited_player_profiles(id);
create index submissions_credited_profile_idx
  on public.submissions(credited_profile_id) where credited_profile_id is not null;

create policy "participants with public results are readable" on public.credited_player_profiles
for select to anon, authenticated using (
  exists (
    select from public.submissions s where s.credited_profile_id = credited_player_profiles.id
      and s.status = 'approved' and s.archived_at is null
  )
);

insert into public.credited_player_profiles(display_name)
select min(s.credited_player) from public.submissions s
where s.source_history_id is not null
group by lower(btrim(normalize(s.credited_player, NFKC)));

update public.submissions s set credited_profile_id = p.id
from public.credited_player_profiles p
where s.source_history_id is not null and p.name_key = lower(btrim(normalize(s.credited_player, NFKC)));

alter table public.submissions add constraint submissions_credited_profile_check check (
  (source_history_id is null) = (credited_profile_id is null)
);

create function flashback_private.assign_credited_player_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.source_history_id is null then
    return new;
  end if;
  insert into public.credited_player_profiles as p(display_name)
  values (btrim(new.credited_player))
  on conflict (name_key) do update set display_name = p.display_name
  returning p.id into new.credited_profile_id;
  return new;
end;
$$;
revoke all on function flashback_private.assign_credited_player_profile() from public, anon, authenticated;
create trigger submissions_assign_credited_player_profile
before insert or update of credited_player on public.submissions
for each row execute function flashback_private.assign_credited_player_profile();

create or replace view public.player_ranking with (security_invoker = true) as
with approved_scores as (
  select s.id, s.stage_id, s.group_code, s.team_key,
    coalesce(s.player_id, s.credited_profile_id) as participant_id,
    coalesce(p.display_name, c.display_name) as display_name
  from public.submissions s
  join public.stages st on st.id = s.stage_id
  join public.versions v on v.id = st.version_id and v.archived_at is null
  left join public.profiles p on p.id = s.player_id
  left join public.credited_player_profiles c on c.id = s.credited_profile_id
  where s.status = 'approved' and s.archived_at is null
), participants as (
  select participant_id, min(display_name) as display_name
  from approved_scores group by participant_id
), historical as (
  select s.participant_id, count(distinct (h.stage_id, h.group_code, h.team_key))::integer as historical_count
  from public.record_history h
  join approved_scores s on s.id = h.submission_id and s.stage_id = h.stage_id
    and s.group_code = h.group_code and s.team_key = h.team_key
  group by s.participant_id
), present as (
  select s.participant_id, count(*)::integer as current_count
  from public.leaderboard_records r join approved_scores s on s.id = r.id
  group by s.participant_id
)
select p.participant_id as player_id, p.display_name,
  coalesce(h.historical_count, 0) as historical_count, coalesce(c.current_count, 0) as current_count
from participants p
left join historical h on h.participant_id = p.participant_id
left join present c on c.participant_id = p.participant_id
where coalesce(h.historical_count, 0) > 0 or coalesce(c.current_count, 0) > 0;
