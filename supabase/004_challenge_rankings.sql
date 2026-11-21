alter table public.versions
  add column archived_at timestamptz,
  add column archived_by uuid references auth.users(id);

alter table public.stages
  add column challenge_id uuid not null default gen_random_uuid();
create index stages_challenge_idx on public.stages(challenge_id);

alter table public.submissions
  add column archived_at timestamptz,
  add column archived_by uuid references auth.users(id);

alter policy "versions public read" on public.versions using (archived_at is null);
alter policy "stages public read" on public.stages using (
  exists (select from public.versions v where v.id = version_id and v.archived_at is null)
);
alter policy "approved or own or admin submissions readable" on public.submissions using (
  archived_at is null
  and exists (select from public.stages st where st.id = stage_id)
  and (status = 'approved' or player_id = (select auth.uid()) or (select public.is_admin()))
);

create or replace function public.team_has_carry(members text[], carry text)
returns boolean language sql immutable set search_path = '' as $$
  with names as (
    select lower(btrim(normalize(value, NFKC))) as name
    from regexp_split_to_table(carry, '[/／、]') as parts(value)
  )
  select count(*) between 1 and 4
    and count(distinct name) = count(*)
    and bool_and(name <> '' and exists (
      select from unnest(members) as team(value)
      where lower(btrim(normalize(value, NFKC))) = names.name
    ))
  from names
$$;

-- The stored row is an archival entry, which may describe alternatives and has no exact time.
create table public.historical_records (
  id uuid primary key default gen_random_uuid(),
  stage_id uuid not null references public.stages(id),
  group_code text not null check (group_code in ('zero', 'max')),
  display_order integer not null check (display_order > 0),
  carry_names text[] not null check (public.is_valid_team(carry_names)),
  lineup_label text not null check (char_length(btrim(lineup_label)) between 1 and 200),
  lineup_key text generated always as (
    lower(btrim(normalize(lineup_label, NFKC)))
  ) stored,
  credited_player text not null check (char_length(btrim(credited_player)) between 1 and 80),
  archived_at timestamptz,
  archived_by uuid references auth.users(id),
  unique (stage_id, group_code, lineup_key)
);

alter table public.historical_records enable row level security;
revoke all on public.historical_records from anon, authenticated;
grant select on public.historical_records to anon, authenticated;
create policy "public active historical records" on public.historical_records
for select to anon, authenticated using (
  archived_at is null and exists (select from public.stages st where st.id = stage_id)
);

-- Tie a status change or new entry to a live version, including when a page is stale.
create schema if not exists flashback_private;
revoke all on schema flashback_private from public, anon, authenticated;

create function flashback_private.check_submissions_active_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.archived_at := null;
    new.archived_by := null;
  end if;
  perform v.id from public.versions v
  join public.stages st on st.version_id = v.id
  where st.id = new.stage_id and v.archived_at is null
  for share of v;
  if not found then
    raise exception '此版本已删除，刷新后再操作';
  end if;
  return new;
end;
$$;
revoke all on function flashback_private.check_submissions_active_version() from public, anon, authenticated;
create trigger submissions_active_version
before insert or update of status on public.submissions
for each row execute function flashback_private.check_submissions_active_version();

create function public.save_version(
  p_version_id uuid, p_code text, p_label text,
  p_stage_names text[], p_challenges uuid[]
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  version_id uuid := p_version_id;
begin
  if not (select public.is_admin()) then raise exception '仅管理员可以管理版本'; end if;
  if cardinality(p_stage_names) is distinct from 3
    or cardinality(p_challenges) is distinct from 3 then
    raise exception '请设置三个关卡';
  end if;
  if exists (
    select from unnest(p_challenges) as selected(id) where selected.id is not null
    and not exists (select from public.stages st where st.challenge_id = selected.id)
  ) then
    raise exception '重复关卡不存在，请刷新后重选';
  end if;
  if version_id is null then
    insert into public.versions (code, label)
    values (btrim(p_code), btrim(p_label)) returning id into version_id;
  else
    update public.versions v set code = btrim(p_code), label = btrim(p_label)
    where v.id = version_id and v.archived_at is null;
    if not found then raise exception '版本已删除或不存在'; end if;
  end if;
  insert into public.stages (version_id, stage_no, name, challenge_id)
  select version_id, i, btrim(p_stage_names[i]), coalesce(p_challenges[i], gen_random_uuid())
  from generate_series(1, 3) as items(i)
  on conflict on constraint stages_version_id_stage_no_key
  do update set name = excluded.name, challenge_id = excluded.challenge_id;
  return version_id;
end;
$$;

create function public.archive_version(p_version_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (select public.is_admin()) then raise exception '仅管理员可以删除版本'; end if;
  update public.versions set archived_at = clock_timestamp(), archived_by = auth.uid()
  where id = p_version_id and archived_at is null;
end;
$$;

create function public.archive_submission(p_submission_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  current_status text;
begin
  if not (select public.is_admin()) then raise exception '仅管理员可以删除成绩'; end if;
  select status into current_status from public.submissions
  where id = p_submission_id and archived_at is null for update;
  if not found then return; end if;
  if current_status = 'approved' then
    perform public.remove_submission(p_submission_id, '管理员删除成绩');
  elsif current_status <> 'removed' then
    update public.submissions set status = 'removed' where id = p_submission_id;
  end if;
  update public.submissions set archived_at = clock_timestamp(), archived_by = auth.uid()
  where id = p_submission_id;
end;
$$;

create function public.archive_historical_record(p_record_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (select public.is_admin()) then raise exception '仅管理员可以删除历史档案'; end if;
  update public.historical_records set archived_at = clock_timestamp(), archived_by = auth.uid()
  where id = p_record_id and archived_at is null;
end;
$$;

revoke all on function public.save_version(uuid,text,text,text[],uuid[]),
  public.archive_version(uuid), public.archive_submission(uuid), public.archive_historical_record(uuid)
  from public, anon, authenticated;
grant execute on function public.save_version(uuid,text,text,text[],uuid[]),
  public.archive_version(uuid), public.archive_submission(uuid), public.archive_historical_record(uuid)
  to authenticated;

create view public.carry_ranking with (security_invoker = true) as
with appearances as (
  select st.challenge_id, r.group_code, r.team_key as lineup_key, c.name
  from public.leaderboard_records r
  join public.stages st on st.id = r.stage_id
  cross join lateral regexp_split_to_table(r.carry_name, '[/／、]') as c(name)
  union all
  select st.challenge_id, s.group_code, s.team_key, c.name
  from public.record_history h
  join public.submissions s on s.id = h.submission_id and s.status = 'approved'
  join public.stages st on st.id = s.stage_id
  cross join lateral regexp_split_to_table(s.carry_name, '[/／、]') as c(name)
  union all
  select st.challenge_id, r.group_code, r.lineup_key, c.name
  from public.historical_records r
  join public.stages st on st.id = r.stage_id
  cross join lateral unnest(r.carry_names) as c(name)
), appearances_by_carry as (
  select lower(btrim(normalize(name, NFKC))) as name_key,
         count(distinct (challenge_id, group_code, lineup_key))::integer as appearance_count
  from appearances
  where btrim(name) <> ''
  group by 1
), clears as (
  select st.challenge_id, c.name
  from public.submissions s
  join public.stages st on st.id = s.stage_id
  cross join lateral regexp_split_to_table(s.carry_name, '[/／、]') as c(name)
  where s.status = 'approved'
  union all
  select st.challenge_id, c.name
  from public.historical_records r
  join public.stages st on st.id = r.stage_id
  cross join lateral unnest(r.carry_names) as c(name)
), clears_by_carry as (
  select lower(btrim(normalize(name, NFKC))) as name_key,
         min(btrim(name)) as carry_name,
         count(distinct challenge_id)::integer as challenge_count
  from clears
  where btrim(name) <> ''
  group by 1
)
select c.carry_name, coalesce(a.appearance_count, 0) as appearance_count, c.challenge_count
from clears_by_carry c left join appearances_by_carry a using (name_key);

grant select on public.carry_ranking to anon, authenticated;
