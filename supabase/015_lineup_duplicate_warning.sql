set local lock_timeout = '5s';

-- Compare concrete lineups only. The public check reads approved entries through RLS.
create function public.flashback_existing_lineup(
  p_stage_id uuid, p_group_code text, p_team text[], p_rounds integer,
  p_submitted_at timestamptz default null
)
returns table (matched_team text[], incumbent_rounds integer)
language sql stable security invoker
set search_path = ''
as $$
  select proposed.display_team, s.rounds
  from public.submissions s
  cross join lateral public.flashback_lineup_variants(s.team) as incumbent
  join public.flashback_lineup_variants(p_team) as proposed
    on proposed.characters = incumbent.characters
  where s.stage_id = p_stage_id and s.group_code = p_group_code
    and s.status = 'approved' and s.archived_at is null
    and (s.source_history_id is null or cardinality(s.team) > 1)
    and cardinality(s.team) = cardinality(p_team)
    and (s.rounds < p_rounds
      or (s.rounds = p_rounds and (p_submitted_at is null or s.created_at <= p_submitted_at)))
  order by s.rounds, s.created_at, s.id, proposed.display_team
  limit 1;
$$;

revoke all on function public.flashback_existing_lineup(uuid,text,text[],integer,timestamptz) from public, anon, authenticated;
grant execute on function public.flashback_existing_lineup(uuid,text,text[],integer,timestamptz) to authenticated;

create function flashback_private.check_new_lineup_conflict()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  conflict record;
  submitted_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    if old.status is distinct from 'pending' or new.status is distinct from 'approved' then
      return new;
    end if;
    submitted_at := new.created_at;
  end if;

  if new.source_history_id is not null and cardinality(new.team) = 1 then
    return new;
  end if;

  select * into conflict from public.flashback_existing_lineup(
    new.stage_id, new.group_code, new.team, new.rounds, submitted_at
  );

  if found then
    raise exception '已有该队伍：%（% 回合）。请提交更少回合，或移除重复的备选角色。',
      array_to_string(conflict.matched_team,'、'), conflict.incumbent_rounds
      using errcode = '23514';
  end if;

  -- Keep the earlier submission's priority if approvals arrive out of order.
  if tg_op = 'UPDATE' then
    select proposed.display_team, s.rounds into conflict
    from public.submissions s
    cross join lateral public.flashback_lineup_variants(s.team) as incumbent
    join public.flashback_lineup_variants(new.team) as proposed
      on proposed.characters = incumbent.characters
    where s.stage_id = new.stage_id and s.group_code = new.group_code
      and s.status = 'pending' and s.archived_at is null
      and (s.created_at,s.id) < (new.created_at,new.id)
      and (s.source_history_id is null or cardinality(s.team) > 1)
      and cardinality(s.team) = cardinality(new.team) and s.rounds <= new.rounds
    order by s.created_at, s.id, proposed.display_team
    limit 1;

    if found then
      raise exception '同一队伍有更早的待审核投稿：%（% 回合）。请先处理较早的投稿。',
        array_to_string(conflict.display_team,'、'), conflict.rounds
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function flashback_private.check_new_lineup_conflict() from public, anon, authenticated;

-- Future submissions can use alternatives again. Existing rows and ranking history are untouched.
drop trigger submissions_require_single_character_slots on public.submissions;
drop function flashback_private.require_single_character_slots();

create trigger submissions_verify_lineup_conflict
before insert or update of status on public.submissions
for each row execute function flashback_private.check_new_lineup_conflict();
