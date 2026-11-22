-- Reject alternative slots on new or changed lineups without rewriting existing records.
create function flashback_private.require_single_character_slots()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.team is not distinct from old.team then
      return new;
    end if;
  end if;

  if exists (
    select from unnest(new.team) as slot(name)
    where strpos(normalize(slot.name, NFKC), '/') > 0
  ) then
    raise exception '每个出战位置只能填一名角色，请用顿号或逗号分隔不同位置。'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function flashback_private.require_single_character_slots() from public, anon, authenticated;

create trigger submissions_require_single_character_slots
before insert or update of team on public.submissions
for each row execute function flashback_private.require_single_character_slots();
