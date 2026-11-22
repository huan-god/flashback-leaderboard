create view public.flashback_carry_ranking_by_group with (security_invoker = true) as
with entries as (
  select r.stage_id, r.group_code, r.team_key as lineup_key, r.carry_name, true as appeared
  from public.leaderboard_records r
  union all
  select s.stage_id, s.group_code, s.team_key, s.carry_name, true
  from public.record_history h join public.submissions s
    on s.id = h.submission_id and s.status = 'approved'
    and (s.stage_id, s.group_code, s.team_key) = (h.stage_id, h.group_code, h.team_key)
  union all
  select s.stage_id, s.group_code, s.team_key, s.carry_name, false
  from public.submissions s where s.status = 'approved' and s.archived_at is null
  union all
  select r.stage_id, r.group_code, r.lineup_key, array_to_string(r.carry_names, '/'), true
  from public.historical_records r where r.archived_at is null
)
select scope.version_id, e.group_code, min(btrim(c.name)) as carry_name,
  count(distinct (st.challenge_id, e.lineup_key)) filter (where e.appeared)::integer as appearance_count,
  count(distinct st.challenge_id)::integer as challenge_count
from entries e
join public.stages st on st.id = e.stage_id
cross join lateral regexp_split_to_table(e.carry_name, '[/／、]') c(name)
cross join lateral (values (st.version_id), (null::uuid)) scope(version_id)
where btrim(c.name) <> ''
group by scope.version_id, e.group_code, lower(btrim(normalize(c.name, NFKC)));

create view public.flashback_player_ranking_by_group with (security_invoker = true) as
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
  select participant_id, group_code, min(display_name) as display_name
  from approved_scores group by participant_id, group_code
), historical as (
  select s.participant_id, s.group_code,
    count(distinct (h.stage_id, h.team_key))::integer as historical_count
  from public.record_history h
  join approved_scores s on s.id = h.submission_id
    and (s.stage_id,s.group_code,s.team_key) = (h.stage_id,h.group_code,h.team_key)
  group by s.participant_id, s.group_code
), present as (
  select s.participant_id, s.group_code, count(*)::integer as current_count
  from public.leaderboard_records r join approved_scores s on s.id = r.id
  group by s.participant_id, s.group_code
)
select p.participant_id as player_id, p.group_code, p.display_name,
  coalesce(h.historical_count, 0) as historical_count, coalesce(c.current_count, 0) as current_count
from participants p
left join historical h using (participant_id, group_code)
left join present c using (participant_id, group_code)
where coalesce(h.historical_count, 0) > 0 or coalesce(c.current_count, 0) > 0;

revoke all on public.flashback_carry_ranking_by_group, public.flashback_player_ranking_by_group from public, anon, authenticated;
grant select on public.flashback_carry_ranking_by_group, public.flashback_player_ranking_by_group to anon, authenticated;
