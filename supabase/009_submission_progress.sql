alter table public.submissions
  add column resonance_ten boolean not null default false,
  add constraint submissions_resonance_ten_zero check (not resonance_ten or group_code = 'zero');

create or replace view public.leaderboard_records with (security_invoker = true) as
 SELECT r.id,
    r.player_id,
    r.stage_id,
    r.group_code,
    r.team,
    r.team_key,
    r.carry_name,
    r.rounds,
    r.created_at,
    COALESCE(r.credited_player, p.display_name) AS display_name,
    st.stage_no,
    st.name AS stage_name,
    st.version_id,
    v.label AS version_name,
    r.related_url,
    r.resonance_ten
   FROM ( SELECT DISTINCT ON (s.stage_id, s.group_code, s.team_key) s.id,
            s.player_id,
            s.stage_id,
            s.group_code,
            s.team,
            s.team_key,
            s.carry_name,
            s.rounds,
            s.evidence_path,
            s.status,
            s.created_at,
            s.reviewed_at,
            s.reviewed_by,
            s.review_note,
            s.related_url,
            s.archived_at,
            s.archived_by,
            s.credited_player,
            s.source_history_id,
            s.resonance_ten
           FROM public.submissions s
          WHERE s.status = 'approved'::text AND s.archived_at IS NULL
          ORDER BY s.stage_id, s.group_code, s.team_key, s.rounds, s.created_at, s.id) r
     LEFT JOIN public.profiles p ON p.id = r.player_id
     JOIN public.stages st ON st.id = r.stage_id
     JOIN public.versions v ON v.id = st.version_id;

-- Preserve access to a player's own review result when a submission is archived.
create policy "players read their own submission status"
on public.submissions for select to authenticated
using (player_id = (select auth.uid()));

create index submissions_player_created_idx
  on public.submissions (player_id, created_at desc, id desc) where player_id is not null;

create table public.submission_contacts (
  submission_id uuid unique references public.submissions(id) on delete cascade,
  mane_entry_id uuid unique references public.mane_entries(id) on delete cascade,
  contact text not null check (char_length(btrim(contact)) between 1 and 120),
  check (num_nonnulls(submission_id, mane_entry_id) = 1)
);
alter table public.submission_contacts enable row level security;
revoke all on table public.submission_contacts from public, anon, authenticated;
grant select, insert on table public.submission_contacts to authenticated;

create policy "admins read submission contacts"
on public.submission_contacts for select to authenticated
using ((select public.is_admin()));

create policy "players supply contact for their own pending submission"
on public.submission_contacts for insert to authenticated
with check (
  exists (
    select from public.submissions s
    where s.id = submission_contacts.submission_id
      and s.player_id = (select auth.uid()) and s.status = 'pending' and s.archived_at is null
  ) or exists (
    select from public.mane_entries e
    where e.id = submission_contacts.mane_entry_id
      and e.player_id = (select auth.uid()) and e.status = 'pending' and e.archived_at is null
  )
);

-- Store a result and its optional private contact in the same transaction.
create function public.submit_flashback_result(p_record jsonb, p_contact text default null)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  result_id uuid;
  contact_text text := nullif(btrim(p_contact), '');
begin
  insert into public.submissions (player_id, stage_id, group_code, team, carry_name,
                                  rounds, evidence_path, related_url, resonance_ten)
  select auth.uid(), stage_id, group_code, team, carry_name, rounds, evidence_path,
         related_url, coalesce(resonance_ten, false)
  from jsonb_to_record(p_record) as r(stage_id uuid, group_code text, team text[],
      carry_name text, rounds integer, evidence_path text, related_url text, resonance_ten boolean)
  returning id into result_id;

  if contact_text is not null then
    insert into public.submission_contacts (submission_id, contact) values (result_id, contact_text);
  end if;
end;
$$;

create function public.submit_mane_result(p_record jsonb, p_contact text default null)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  result_id uuid;
  contact_text text := nullif(btrim(p_contact), '');
begin
  insert into public.mane_entries (player_id, map_id, division, display_name, team,
                                  carry, score, evidence_path, related_url)
  select auth.uid(), map_id, division, display_name, team, carry, score, evidence_path, related_url
  from jsonb_to_record(p_record) as r(map_id uuid, division text, display_name text, team text[],
      carry text, score bigint, evidence_path text, related_url text)
  returning id into result_id;

  if contact_text is not null then
    insert into public.submission_contacts (mane_entry_id, contact) values (result_id, contact_text);
  end if;
end;
$$;

revoke execute on function public.submit_flashback_result(jsonb, text) from public, anon;
revoke execute on function public.submit_mane_result(jsonb, text) from public, anon;
grant execute on function public.submit_flashback_result(jsonb, text) to authenticated;
grant execute on function public.submit_mane_result(jsonb, text) to authenticated;

CREATE OR REPLACE FUNCTION public.edit_submission(p_id uuid, p_stage_id uuid, p_group text, p_team text[], p_carry text, p_rounds integer, p_credited_player text, p_related_url text, p_resonance_ten boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    resonance_ten = p_group = 'zero' and coalesce(p_resonance_ten, old_record.resonance_ten),
    credited_player = nullif(btrim(p_credited_player), ''), related_url = nullif(btrim(p_related_url), '')
  where id = p_id;
  if old_record.status = 'approved' then
    perform flashback_private.reconcile_record_slot(old_record.stage_id, old_record.group_code, old_record.team_key);
    if (old_record.stage_id, old_record.group_code, old_record.team_key) is distinct from (p_stage_id, p_group, new_key) then
      perform flashback_private.reconcile_record_slot(p_stage_id, p_group, new_key);
    end if;
  end if;
end;
$function$
;

-- Require a reason for new rejections, while keeping legacy rejections editable.
create function flashback_private.require_rejection_reason()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'rejected' and old.status is distinct from new.status
    and coalesce(char_length(btrim(new.review_note)), 0) not between 2 and 200 then
    raise exception '拒绝理由需要 2–200 个字符';
  end if;
  return new;
end;
$$;

create trigger submissions_require_rejection_reason
before update of status on public.submissions
for each row execute function flashback_private.require_rejection_reason();

create trigger mane_entries_require_rejection_reason
before update of status on public.mane_entries
for each row execute function flashback_private.require_rejection_reason();
revoke execute on function public.edit_submission(uuid,uuid,text,text[],text,integer,text,text,boolean) from public, anon;
grant execute on function public.edit_submission(uuid,uuid,text,text[],text,integer,text,text,boolean) to authenticated;

create or replace function public.edit_submission(p_id uuid, p_stage_id uuid, p_group text,
  p_team text[], p_carry text, p_rounds integer, p_credited_player text, p_related_url text)
returns void
language sql
security invoker
set search_path = ''
as $$
  select public.edit_submission(p_id, p_stage_id, p_group, p_team, p_carry, p_rounds,
                                p_credited_player, p_related_url, null::boolean);
$$;

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
$function$
;
