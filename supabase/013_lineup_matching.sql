set local lock_timeout = '5s';

-- The submission array stores lineup slots. A slash inside a slot lists its alternatives.
create function public.flashback_valid_lineup(members text[])
returns boolean
language sql immutable
set search_path = ''
as $$
  with slots as (
    select regexp_split_to_array(normalize(value, NFKC), '/') as choices
    from unnest(members) as member(value)
  )
  select public.is_valid_team(members)
    and (select count(*) from slots where cardinality(choices) > 1) <= 1
    and (
      select count(*) = count(distinct lower(btrim(value)))
        and count(*) = count(*) filter (where btrim(value) <> '')
      from slots cross join lateral unnest(choices) as choice(value)
    );
$$;

alter table public.submissions add constraint flashback_explicit_lineup_check
  check (source_history_id is not null or public.flashback_valid_lineup(team));

create function public.flashback_lineup_variants(members text[])
returns table (characters text[], display_team text[])
language sql immutable
set search_path = ''
as $$
  with slots as (
    select slot, btrim(value) as label, regexp_split_to_array(value, '[/／]') as choices
    from unnest(members) with ordinality as member(value,slot)
  ), alternatives as (
    select btrim(value) as replacement
    from slots cross join lateral unnest(choices) as choice(value)
    where cardinality(choices) > 1
    union all
    select null where not exists (select from slots where cardinality(choices) > 1)
  ), variants as (
    select array_agg(case when cardinality(choices) > 1 then replacement else label end order by slot) as team
    from alternatives cross join slots
    where public.flashback_valid_lineup(members)
    group by replacement
  )
  select array(
    select lower(btrim(normalize(value, NFKC))) from unnest(team) as role(value) order by 1
  ), team
  from variants;
$$;

-- Compare concrete lineups, keeping old one-cell imports as opaque labels.
create view public.flashback_current_lineups with (security_invoker = true) as
with candidates as (
  select s.id, s.stage_id, s.group_code, s.team_key, s.rounds, s.created_at,
    variant.characters, coalesce(variant.display_team, s.team) as displayed
  from public.submissions s
  join public.stages st on st.id = s.stage_id
  join public.versions v on v.id = st.version_id and v.archived_at is null
  left join lateral public.flashback_lineup_variants(s.team) as variant
    on s.source_history_id is null or cardinality(s.team) > 1
  where s.status = 'approved' and s.archived_at is null
), best as (
  select distinct on (stage_id, group_code, characters, case when characters is null then team_key end) *
  from candidates
  order by stage_id, group_code, characters, case when characters is null then team_key end,
    rounds, created_at, id
), live as (
  select a.id, a.stage_id, a.group_code, a.displayed
  from best a
  where a.characters is null or not exists (
    select from best b
    where b.stage_id = a.stage_id and b.group_code = a.group_code
      and cardinality(b.characters) < cardinality(a.characters)
      and b.characters <@ a.characters
  )
), survivors as (
  select id, stage_id, group_code, slot, string_agg(distinct role, '/' order by role) as label
  from live cross join lateral unnest(displayed) with ordinality as member(role,slot)
  group by id, stage_id, group_code, slot
)
select id, stage_id, group_code, array_agg(label order by slot) as team
from survivors group by id, stage_id, group_code;

revoke all on public.flashback_current_lineups from public, anon, authenticated;
grant select on public.flashback_current_lineups to anon, authenticated;

create or replace view public.leaderboard_records with (security_invoker = true) as
select r.id, r.player_id, r.stage_id, r.group_code, w.team, r.team_key, r.carry_name,
  r.rounds, r.created_at, coalesce(r.credited_player, p.display_name) as display_name,
  st.stage_no, st.name as stage_name, st.version_id, v.label as version_name, r.related_url,
  r.resonance_ten
from public.flashback_current_lineups w
join public.submissions r on r.id = w.id
left join public.profiles p on p.id = r.player_id
join public.stages st on st.id = r.stage_id
join public.versions v on v.id = st.version_id;

create function flashback_private.reconcile_record_group(p_stage uuid, p_group text)
returns void
language sql
set search_path = ''
as $$
  with winners as materialized (
    select r.id, r.team_key, r.player_id
    from public.flashback_current_lineups w
    join public.submissions r on r.id = w.id
    where w.stage_id = p_stage and w.group_code = p_group
  ), closed as (
    update public.record_history h set lost_at = clock_timestamp()
    where h.stage_id = p_stage and h.group_code = p_group and h.lost_at is null
      and not exists (select from winners w where w.id = h.submission_id and w.team_key = h.team_key)
  )
  insert into public.record_history(stage_id, group_code, team_key, submission_id, player_id)
  select p_stage, p_group, w.team_key, w.id, w.player_id
  from winners w
  where not exists (
    select from public.record_history h
    where h.stage_id = p_stage and h.group_code = p_group and h.lost_at is null
      and h.submission_id = w.id and h.team_key = w.team_key
  );
$$;

revoke all on function flashback_private.reconcile_record_group(uuid,text) from public, anon, authenticated;

-- Lock before selecting a submission FOR UPDATE, since another lineup in the group
-- can gain or lose its record during the same review.
CREATE OR REPLACE FUNCTION public.review_submission(p_submission_id uuid, p_decision text, p_note text DEFAULT ''::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r public.submissions%rowtype;
begin
  if not public.is_admin() then raise exception '仅管理员可以审核';end if;
  if p_decision not in ('approved','rejected') then raise exception '审核状态无效';end if;
  perform pg_advisory_xact_lock(hashtextextended('flashback submissions moderation', 0));
  select * into r from public.submissions where id=p_submission_id for update;
  if not found then raise exception '投稿不存在';end if;
  if r.status <> 'pending' then raise exception '仅可审核待审投稿；移除已通过成绩请使用移除功能';end if;
  update public.submissions
     set status=p_decision,reviewed_by=auth.uid(),reviewed_at=clock_timestamp(),review_note=nullif(btrim(p_note),'')
   where id=p_submission_id;
  if p_decision = 'approved' then
    perform flashback_private.reconcile_record_group(r.stage_id, r.group_code);
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.remove_submission(p_submission_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r public.submissions%rowtype;
begin
  if not public.is_admin() then raise exception '仅管理员可以移除成绩'; end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 2 and 200 then
    raise exception '移除原因必须是2到200字';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('flashback submissions moderation', 0));
  select * into r from public.submissions where id=p_submission_id for update;
  if not found then raise exception '记录不存在'; end if;
  if r.status <> 'approved' then raise exception '只能移除已通过审核的记录'; end if;
  update public.submissions
  set status='removed',reviewed_by=auth.uid(),reviewed_at=clock_timestamp(),review_note=btrim(p_reason)
  where id=p_submission_id;
  insert into public.moderation_actions(submission_id,admin_id,action,reason)
  values(p_submission_id,auth.uid(),'remove',btrim(p_reason));

  perform flashback_private.reconcile_record_group(r.stage_id, r.group_code);
end;
$function$;

CREATE OR REPLACE FUNCTION public.edit_submission(p_id uuid, p_stage_id uuid, p_group text, p_team text[], p_carry text, p_rounds integer, p_credited_player text, p_related_url text, p_resonance_ten boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  old_record public.submissions%rowtype;
begin
  if not (select public.is_admin()) then raise exception '仅管理员可以编辑成绩'; end if;
  perform pg_advisory_xact_lock(hashtextextended('flashback submissions moderation', 0));
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
  update public.submissions set stage_id = p_stage_id, group_code = p_group, team = p_team,
    carry_name = btrim(p_carry), rounds = p_rounds,
    resonance_ten = p_group = 'zero' and coalesce(p_resonance_ten, old_record.resonance_ten),
    credited_player = nullif(btrim(p_credited_player), ''), related_url = nullif(btrim(p_related_url), '')
  where id = p_id;
  if old_record.status = 'approved' then
    perform flashback_private.reconcile_record_group(old_record.stage_id, old_record.group_code);
    if (old_record.stage_id, old_record.group_code) is distinct from (p_stage_id, p_group) then
      perform flashback_private.reconcile_record_group(p_stage_id, p_group);
    end if;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.archive_submission(p_submission_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_status text;
begin
  if not (select public.is_admin()) then raise exception '仅管理员可以删除成绩'; end if;
  perform pg_advisory_xact_lock(hashtextextended('flashback submissions moderation', 0));
  select status into current_status from public.submissions
  where id = p_submission_id and archived_at is null for update;
  if not found then return; end if;
  if current_status = 'approved' then
    perform public.remove_submission(p_submission_id, '管理员删除成绩');
  elsif current_status = 'pending' then
    update public.submissions set status = 'removed' where id = p_submission_id;
  end if;
  update public.submissions set archived_at = clock_timestamp(), archived_by = auth.uid()
  where id = p_submission_id;
end;
$function$;

-- Keep prior valid honors and synchronize which entries currently occupy the board.
select flashback_private.reconcile_record_group(active_groups.stage_id, active_groups.group_code)
from (
  select stage_id, group_code from public.submissions where status = 'approved' and archived_at is null
  union
  select stage_id, group_code from public.record_history where lost_at is null
) as active_groups
join public.stages st on st.id = active_groups.stage_id
join public.versions v on v.id = st.version_id and v.archived_at is null;
