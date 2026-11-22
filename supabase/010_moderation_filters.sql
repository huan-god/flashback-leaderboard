create view public.flashback_moderation_list with (security_invoker = true) as
select s.id, s.stage_id, s.group_code, s.team, s.carry_name, s.rounds, s.created_at,
  s.status, s.related_url, s.review_note, s.evidence_path, s.resonance_ten,
  coalesce(s.credited_player, p.display_name, '未知玩家') as display_name, c.contact
from public.submissions s
left join public.profiles p on p.id = s.player_id
left join public.submission_contacts c on c.submission_id = s.id
where s.archived_at is null and (select public.is_admin());

revoke all on public.flashback_moderation_list from public, anon, authenticated;
grant select on public.flashback_moderation_list to authenticated;

create function public.reopen_rejected_result(p_board text, p_id uuid,
  p_updated_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select public.is_admin()) then
    raise exception '仅管理员可以撤回拒绝';
  end if;

  case p_board
    when 'flashback' then
      update public.submissions
      set status = 'pending', reviewed_at = null, reviewed_by = null, review_note = null
      where id = p_id and status = 'rejected' and archived_at is null;
    when 'mane' then
      update public.mane_entries
      set status = 'pending', reviewed_by = null, review_note = null
      where id = p_id and status = 'rejected' and archived_at is null
        and updated_at = p_updated_at;
    else
      raise exception '无效的榜单';
  end case;

  if not found then
    raise exception '成绩已变更或删除，请刷新后台';
  end if;
end;
$$;

revoke execute on function public.reopen_rejected_result(text,uuid,timestamptz) from public, anon;
grant execute on function public.reopen_rejected_result(text,uuid,timestamptz) to authenticated;
