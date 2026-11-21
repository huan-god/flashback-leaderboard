-- Register the corrected 4.1 table through the same ranking as player submissions.
-- An imported result credits its listed player without creating an account or proof file.
alter table public.submissions
  alter column player_id drop not null,
  alter column evidence_path drop not null,
  add column credited_player text check (char_length(btrim(credited_player)) between 2 and 80),
  add column source_history_id uuid unique references public.historical_records(id),
  drop constraint submissions_check,
  add constraint submissions_source_check check (
    (source_history_id is null and player_id is not null and evidence_path is not null
      and public.team_has_carry(team, carry_name))
    or
    (source_history_id is not null and player_id is null and evidence_path is null
      and credited_player is not null
      and public.is_valid_team(regexp_split_to_array(carry_name, '[/／、]')))
  );
alter table public.record_history alter column player_id drop not null;

alter policy "player creates pending own submission" on public.submissions with check (
  player_id = (select auth.uid()) and status = 'pending'
  and source_history_id is null and credited_player is null
  and evidence_path like ((select auth.uid())::text || '/%')
  and reviewed_at is null and reviewed_by is null and review_note is null
);

create or replace view public.leaderboard_records with (security_invoker = true) as
select r.id, r.player_id, r.stage_id, r.group_code, r.team, r.team_key,
  r.carry_name, r.rounds, r.created_at, coalesce(r.credited_player, p.display_name) as display_name,
  st.stage_no, st.name as stage_name, st.version_id, v.label as version_name, r.related_url
from (
  select distinct on (s.stage_id, s.group_code, s.team_key) s.*
  from public.submissions s
  where s.status = 'approved' and s.archived_at is null
  order by s.stage_id, s.group_code, s.team_key, s.rounds, s.created_at, s.id
) r
left join public.profiles p on p.id = r.player_id
join public.stages st on st.id = r.stage_id
join public.versions v on v.id = st.version_id;

create or replace view public.player_ranking with (security_invoker = true) as
with historical as (
  select h.player_id, count(distinct (h.stage_id, h.group_code, h.team_key))::integer as historical_count
  from public.record_history h
  join public.submissions s on s.id = h.submission_id and s.status = 'approved'
    and s.stage_id = h.stage_id and s.group_code = h.group_code and s.team_key = h.team_key
  group by h.player_id
), present as (
  select player_id, count(*)::integer as current_count from public.leaderboard_records group by player_id
)
select p.id as player_id, p.display_name, coalesce(h.historical_count, 0) as historical_count,
  coalesce(c.current_count, 0) as current_count
from public.profiles p
left join historical h on h.player_id = p.id
left join present c on c.player_id = p.id
where coalesce(h.historical_count, 0) > 0 or coalesce(c.current_count, 0) > 0;

create function flashback_private.reconcile_record_slot(p_stage uuid, p_group text, p_team_key text)
returns void language plpgsql set search_path = '' as $$
declare
  winner uuid;
  winner_player uuid;
begin
  select id, player_id into winner, winner_player from public.submissions
  where stage_id = p_stage and group_code = p_group and team_key = p_team_key
    and status = 'approved' and archived_at is null
  order by rounds, created_at, id limit 1;

  update public.record_history set lost_at = clock_timestamp()
  where stage_id = p_stage and group_code = p_group and team_key = p_team_key and lost_at is null
    and submission_id is distinct from winner;
  if winner is not null and not exists (
    select from public.record_history
    where stage_id = p_stage and group_code = p_group and team_key = p_team_key
      and lost_at is null and submission_id = winner
  ) then
    insert into public.record_history(stage_id, group_code, team_key, submission_id, player_id)
    values (p_stage, p_group, p_team_key, winner, winner_player);
  end if;
end;
$$;
revoke all on function flashback_private.reconcile_record_slot(uuid,text,text) from public, anon, authenticated;

create function public.edit_submission(
  p_id uuid, p_stage_id uuid, p_group text, p_team text[],
  p_carry text, p_rounds integer, p_credited_player text, p_related_url text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  old_record public.submissions%rowtype;
  new_key text := public.canonical_team(p_team);
  slot_lock bigint;
begin
  if not (select public.is_admin()) then raise exception '仅管理员可以编辑成绩'; end if;
  select * into old_record from public.submissions where id = p_id and archived_at is null for update;
  if not found then raise exception '成绩已删除或不存在'; end if;
  if not public.is_valid_team(p_team) then raise exception '请填写 1—4 项有效配队内容'; end if;
  if not public.is_valid_team(regexp_split_to_array(p_carry, '[/／、]')) then
    raise exception '请填写有效的主 C，共同主 C 用 / 分隔';
  end if;
  if old_record.source_history_id is null and not public.team_has_carry(p_team, p_carry) then
    raise exception '主 C 必须出现在配队中';
  end if;
  perform v.id from public.versions v
  where v.archived_at is null and exists (
    select from public.stages st where st.version_id = v.id and st.id in (old_record.stage_id, p_stage_id)
  ) order by v.id for share;
  if not exists (
    select from public.stages st join public.versions v on v.id = st.version_id
    where st.id = p_stage_id and v.archived_at is null
  ) or not exists (
    select from public.stages st join public.versions v on v.id = st.version_id
    where st.id = old_record.stage_id and v.archived_at is null
  ) then
    raise exception '关卡不存在或版本已删除';
  end if;
  for slot_lock in
    select distinct key from (values
      (hashtextextended(old_record.stage_id::text || old_record.group_code || old_record.team_key, 0)),
      (hashtextextended(p_stage_id::text || p_group || new_key, 0))
    ) as locks(key) order by key
  loop
    perform pg_advisory_xact_lock(slot_lock);
  end loop;
  update public.submissions set stage_id = p_stage_id, group_code = p_group, team = p_team,
    carry_name = btrim(p_carry), rounds = p_rounds,
    credited_player = nullif(btrim(p_credited_player), ''), related_url = nullif(btrim(p_related_url), '')
  where id = p_id;
  if old_record.status = 'approved' then
    perform flashback_private.reconcile_record_slot(old_record.stage_id, old_record.group_code, old_record.team_key);
    if (old_record.stage_id, old_record.group_code, old_record.team_key) is distinct from (p_stage_id, p_group, new_key) then
      perform flashback_private.reconcile_record_slot(p_stage_id, p_group, new_key);
    end if;
  end if;
end;
$$;
revoke all on function public.edit_submission(uuid,uuid,text,text[],text,integer,text,text) from public, anon, authenticated;
grant execute on function public.edit_submission(uuid,uuid,text,text[],text,integer,text,text) to authenticated;

insert into public.submissions(stage_id, group_code, team, carry_name, rounds, credited_player, source_history_id)
select h.stage_id, h.group_code,
  case when h.lineup_label = 'J石纸洛' then array['J','奠基石','纸信圈儿','洛佩拉'] else array[h.lineup_label] end,
  array_to_string(h.carry_names, '/'), 6, h.credited_player, h.id
from public.historical_records h
join public.stages st on st.id = h.stage_id
join public.versions v on v.id = st.version_id
where v.code = '4.1' and v.archived_at is null and h.archived_at is null
order by st.stage_no, h.display_order
on conflict (source_history_id) do nothing;

update public.submissions set status = 'approved', reviewed_at = transaction_timestamp()
where source_history_id is not null and status = 'pending';

do $$
declare slot record;
begin
  for slot in select distinct s.stage_id, s.group_code, s.team_key from public.submissions s
    where s.source_history_id is not null and s.status = 'approved' and s.archived_at is null
  loop
    perform flashback_private.reconcile_record_slot(slot.stage_id, slot.group_code, slot.team_key);
  end loop;
end;
$$;

update public.historical_records h set archived_at = transaction_timestamp()
where h.archived_at is null
  and exists (select from public.submissions s where s.source_history_id = h.id and s.status = 'approved');

create view public.carry_rankings_by_scope with (security_invoker = true) as
with entries as (
  select r.stage_id, r.group_code, r.team_key as lineup_key, r.carry_name, true as appeared
  from public.leaderboard_records r
  union all
  select s.stage_id, s.group_code, s.team_key, s.carry_name, true
  from public.record_history h
  join public.submissions s on s.id = h.submission_id and s.status = 'approved'
    and s.stage_id = h.stage_id and s.group_code = h.group_code and s.team_key = h.team_key
  union all
  select s.stage_id, s.group_code, s.team_key, s.carry_name, false
  from public.submissions s where s.status = 'approved' and s.archived_at is null
  union all
  select r.stage_id, r.group_code, r.lineup_key, array_to_string(r.carry_names, '/'), true
  from public.historical_records r where r.archived_at is null
)
select scope.version_id, min(btrim(c.name)) as carry_name,
  (count(distinct (st.challenge_id, e.group_code, e.lineup_key)) filter (where e.appeared))::integer as appearance_count,
  count(distinct st.challenge_id)::integer as challenge_count
from entries e
join public.stages st on st.id = e.stage_id
cross join lateral regexp_split_to_table(e.carry_name, '[/／、]') as c(name)
cross join lateral (values (st.version_id), (null::uuid)) as scope(version_id)
where btrim(c.name) <> ''
group by scope.version_id, lower(btrim(normalize(c.name, NFKC)));

grant select on public.carry_rankings_by_scope to anon, authenticated;
create or replace view public.carry_ranking with (security_invoker = true) as
select carry_name, appearance_count, challenge_count from public.carry_rankings_by_scope where version_id is null;
