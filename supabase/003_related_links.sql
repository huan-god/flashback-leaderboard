alter table public.submissions
  add column related_url text
  constraint submissions_related_url_web check (
    char_length(related_url) between 1 and 2048
    and position(chr(92) in related_url) = 0
    and related_url ~ '^https?://[^/?#@[:space:][:cntrl:]]+([/?#][^[:space:][:cntrl:]]*)?$'
  );

create or replace view public.leaderboard_records with (security_invoker = true) as
select r.id,r.player_id,r.stage_id,r.group_code,r.team,r.team_key,
       r.carry_name,r.rounds,r.created_at,p.display_name,
       st.stage_no,st.name as stage_name,st.version_id,
       v.label as version_name,r.related_url
from (
  select s.*,row_number() over(
    partition by s.stage_id,s.group_code,s.team_key
    order by s.rounds asc,s.created_at asc,s.id asc
  ) as rn
  from public.submissions s where s.status='approved'
) r
join public.profiles p on p.id=r.player_id
join public.stages st on st.id=r.stage_id
join public.versions v on v.id=st.version_id
where r.rn=1;
