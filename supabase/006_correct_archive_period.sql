-- The source table's title said 3.9. Its owner confirmed it covers 4.1, period 7.
-- The table columns correspond to the existing 4.1 stages by stage number.
do $$
begin
  if exists (
    select from public.versions where code = '3.9' and archived_at is null
  ) and (
    select count(*) from public.stages st
    join public.versions v on v.id = st.version_id
    where v.code = '4.1' and v.archived_at is null and st.stage_no between 1 and 3
  ) <> 3 then
    raise exception 'The three active 4.1 stages must exist before moving the archive';
  end if;
end;
$$;

with source_rows as (
  select h.id, st.stage_no, dst.id as destination_id, h.lineup_label, h.group_code
  from public.historical_records h
  join public.stages st on st.id = h.stage_id
  join public.versions src on src.id = st.version_id and src.code = '3.9' and src.archived_at is null
  join public.versions dest on dest.code = '4.1' and dest.archived_at is null
  join public.stages dst on dst.version_id = dest.id and dst.stage_no = st.stage_no
  where h.archived_at is null
), shorthand(stage_no, original, display_lineup, team, sort_order) as (
  values
    (1, 'J石纸瑞', 'J石纸瑞', array['奠基石','J','纸信圈儿','小瑞安侬'], 1),
    (2, 'J石+瑞纸/瑞洛/纸洛', 'J石瑞纸', array['奠基石','J','小瑞安侬','纸信圈儿'], 1),
    (2, 'J石+瑞纸/瑞洛/纸洛', 'J石瑞洛', array['奠基石','J','小瑞安侬','洛佩拉'], 2),
    (2, 'J石+瑞纸/瑞洛/纸洛', 'J石纸洛', array['奠基石','J','纸信圈儿','洛佩拉'], 3),
    (3, 'J石纸瑞', 'J石纸瑞', array['奠基石','J','纸信圈儿','小瑞安侬'], 1)
), remaining as (
  select src.id,
    string_agg(m.display_lineup, '/' order by m.sort_order)
      filter (where existing.found is null) as lineup,
    count(existing.found) as duplicate_count
  from source_rows src
  join shorthand m on m.stage_no = src.stage_no and m.original = src.lineup_label
  left join lateral (
    select true as found from public.submissions s
    where s.stage_id = src.destination_id and s.group_code = src.group_code
      and s.archived_at is null and s.status in ('pending', 'approved')
      and s.team_key = public.canonical_team(m.team)
    limit 1
  ) existing on true
  group by src.id
)
update public.historical_records h
set stage_id = src.destination_id,
    carry_names = array_replace(h.carry_names, '莫基石', '奠基石'),
    lineup_label = case when r.duplicate_count > 0 then coalesce(r.lineup, h.lineup_label) else h.lineup_label end,
    archived_at = case when r.duplicate_count > 0 and r.lineup is null then transaction_timestamp() end
from source_rows src left join remaining r on r.id = src.id
where h.id = src.id;

-- Retire the empty period added solely for the mislabelled import.
update public.versions v set archived_at = transaction_timestamp()
where v.code = '3.9' and v.archived_at is null
  and not exists (
    select from public.stages st join public.historical_records h on h.stage_id = st.id
    where st.version_id = v.id and h.archived_at is null
  )
  and not exists (
    select from public.stages st join public.submissions s on s.stage_id = st.id
    where st.version_id = v.id and s.archived_at is null
  );
