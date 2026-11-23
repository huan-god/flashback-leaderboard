-- Counts for the selected period and for all periods use visible leaderboard records.
create view public.flashback_player_rankings_by_scope with (security_invoker = true) as
with winners as (
  select coalesce(r.player_id, s.credited_profile_id) as participant_id,
    r.display_name, r.version_id, coalesce(st.challenge_id, st.id) as challenge_id,
    r.group_code, r.team_key
  from public.leaderboard_records r
  join public.submissions s on s.id = r.id
  join public.stages st on st.id = r.stage_id
)
select scope.version_id, w.participant_id as player_id, min(w.display_name) as display_name,
  count(distinct (w.challenge_id, w.group_code, w.team_key))::integer as appearance_count
from winners w
cross join lateral (values (w.version_id), (null::uuid)) scope(version_id)
where w.participant_id is not null
group by scope.version_id, w.participant_id;

revoke all on public.flashback_player_rankings_by_scope from public, anon, authenticated;
grant select on public.flashback_player_rankings_by_scope to anon, authenticated;

-- Clear counts still include valid clears. Appearance counts only use ranked results.
create or replace view public.carry_rankings_by_scope with (security_invoker = true) as
with entries as (
  select r.stage_id, r.group_code, r.team_key as lineup_key, r.carry_name, true as appeared
  from public.leaderboard_records r
  union all
  select s.stage_id, s.group_code, s.team_key, s.carry_name, false
  from public.submissions s where s.status = 'approved' and s.archived_at is null
  union all
  select r.stage_id, r.group_code, r.lineup_key, array_to_string(r.carry_names, '/'), false
  from public.historical_records r where r.archived_at is null
)
select scope.version_id, min(btrim(c.name)) as carry_name,
  count(distinct (st.challenge_id, e.group_code, e.lineup_key)) filter (where e.appeared)::integer as appearance_count,
  count(distinct st.challenge_id)::integer as challenge_count
from entries e
join public.stages st on st.id = e.stage_id
cross join lateral regexp_split_to_table(e.carry_name, '[/／、]') c(name)
cross join lateral (values (st.version_id), (null::uuid)) scope(version_id)
where btrim(c.name) <> ''
group by scope.version_id, lower(btrim(normalize(c.name, NFKC)));
