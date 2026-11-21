-- V2 增量升级：允许站长撤销已经审核通过的成绩。
-- 在已安装 V1 schema.sql 的项目执行本文件一次；全新项目直接执行新版 schema.sql 即可。
-- 记录保留为 status='removed'，并留下操作人、时间及原因，避免直接删除误伤历史。

alter table public.submissions drop constraint if exists submissions_status_check;
alter table public.submissions add constraint submissions_status_check
  check (status in ('pending','approved','rejected','removed'));

create table if not exists public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id),
  admin_id uuid not null references auth.users(id),
  action text not null check(action in ('remove')),
  reason text not null check(char_length(btrim(reason)) between 2 and 200),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.moderation_actions enable row level security;
drop policy if exists "moderation actions admin read" on public.moderation_actions;
create policy "moderation actions admin read" on public.moderation_actions
  for select to authenticated using(public.is_admin());
revoke all on public.moderation_actions from anon,authenticated;
grant select on public.moderation_actions to authenticated;

create or replace function public.remove_submission(
  p_submission_id uuid, p_reason text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.submissions%rowtype;
  old_best uuid;
  new_best uuid;
  new_player uuid;
begin
  if not public.is_admin() then raise exception '仅管理员可以移除成绩'; end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 2 and 200 then
    raise exception '移除原因必须是2到200字';
  end if;
  select * into r from public.submissions where id=p_submission_id for update;
  if not found then raise exception '记录不存在'; end if;
  if r.status <> 'approved' then raise exception '只能移除已通过审核的记录'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.stage_id::text||r.group_code||r.team_key,0));
  select id into old_best from public.submissions
   where stage_id=r.stage_id and group_code=r.group_code and team_key=r.team_key and status='approved'
   order by rounds,created_at,id limit 1;

  update public.submissions
  set status='removed',reviewed_by=auth.uid(),reviewed_at=clock_timestamp(),review_note=btrim(p_reason)
  where id=p_submission_id;
  insert into public.moderation_actions(submission_id,admin_id,action,reason)
  values(p_submission_id,auth.uid(),'remove',btrim(p_reason));

  select id,player_id into new_best,new_player from public.submissions
   where stage_id=r.stage_id and group_code=r.group_code and team_key=r.team_key and status='approved'
   order by rounds,created_at,id limit 1;
  if old_best is distinct from new_best then
    update public.record_history set lost_at=clock_timestamp()
    where stage_id=r.stage_id and group_code=r.group_code
       and team_key=r.team_key and lost_at is null;
    if new_best is not null then
      insert into public.record_history(stage_id,group_code,team_key,submission_id,player_id)
      values(r.stage_id,r.group_code,r.team_key,new_best,new_player);
    end if;
  end if;
end;
$$;
revoke all on function public.remove_submission(uuid,text) from public;
grant execute on function public.remove_submission(uuid,text) to authenticated;

-- 现有 V1 数据库升级：已通过的记录禁止通过普通审核 RPC 直接改成 rejected，
-- 必须使用带原因和审计日志的 remove_submission。
create or replace function public.review_submission(
  p_submission_id uuid,p_decision text,p_note text default ''
) returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.submissions%rowtype;
  old_best uuid;
  new_best uuid;
  new_player uuid;
begin
  if not public.is_admin() then raise exception '仅管理员可以审核';end if;
  if p_decision not in ('approved','rejected') then raise exception '审核状态无效';end if;
  select * into r from public.submissions where id=p_submission_id for update;
  if not found then raise exception '投稿不存在';end if;
  if r.status <> 'pending' then raise exception '仅可审核待审投稿；移除已通过成绩请使用移除功能';end if;
  perform pg_advisory_xact_lock(hashtextextended(r.stage_id::text||r.group_code||r.team_key,0));
  select id into old_best from public.submissions
    where stage_id=r.stage_id and group_code=r.group_code and team_key=r.team_key and status='approved'
    order by rounds,created_at,id limit 1;
  update public.submissions
     set status=p_decision,reviewed_by=auth.uid(),reviewed_at=clock_timestamp(),review_note=nullif(btrim(p_note),'')
   where id=p_submission_id;
  select id,player_id into new_best,new_player from public.submissions
    where stage_id=r.stage_id and group_code=r.group_code and team_key=r.team_key and status='approved'
    order by rounds,created_at,id limit 1;
  if old_best is distinct from new_best then
    update public.record_history set lost_at=clock_timestamp()
     where stage_id=r.stage_id and group_code=r.group_code and team_key=r.team_key and lost_at is null;
    if new_best is not null then
      insert into public.record_history(stage_id,group_code,team_key,submission_id,player_id)
      values(r.stage_id,r.group_code,r.team_key,new_best,new_player);
    end if;
  end if;
end;
$$;
revoke all on function public.review_submission(uuid,text,text) from public;
grant execute on function public.review_submission(uuid,text,text) to authenticated;

