-- 焦点闪回榜 · Supabase PostgreSQL 初始化脚本（用于新项目，运行一次）
-- 先在 Supabase Dashboard → SQL Editor 执行本文件。
-- 然后通过 README 的指引指定你的管理员邮箱对应 auth.users.id。
-- 不要把 service_role / secret key 放到网页或 GitHub 上。

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 2 and 24),
  created_at timestamptz not null default now()
);

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

create table if not exists public.versions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (char_length(btrim(code)) between 1 and 30),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  created_at timestamptz not null default now()
);

create table if not exists public.stages (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.versions(id) on delete cascade,
  stage_no integer not null check (stage_no between 1 and 3),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  unique(version_id,stage_no),
  unique(id,version_id)
);

-- 数据库与前端统一进行 NFKC / 去首尾空格 / 大小写折叠 / 排序。
-- 角色填写顺序和常见全角字母差异都不会制造新的队伍。
create or replace function public.canonical_team(members text[])
returns text language sql immutable set search_path = '' as $$
  select string_agg(lower(btrim(normalize(t.value, NFKC))), '|'
                    order by lower(btrim(normalize(t.value, NFKC))))
  from unnest(members) as t(value)
$$;

create or replace function public.is_valid_team(members text[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(cardinality(members) between 1 and 4,false)
    and not exists (
      select 1 from unnest(members) as t(value)
      where t.value is null or char_length(btrim(t.value)) not between 1 and 40
    )
    and (select count(distinct lower(btrim(normalize(t.value, NFKC))))
         from unnest(members) as t(value)) = cardinality(members)
$$;

create or replace function public.team_has_carry(members text[],carry text)
returns boolean language sql immutable set search_path = '' as $$
  select exists (
    select 1 from unnest(members) as t(value)
    where lower(btrim(normalize(t.value, NFKC))) = lower(btrim(normalize(carry, NFKC)))
  )
$$;

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.profiles(id) on delete cascade,
  stage_id uuid not null references public.stages(id) on delete restrict,
  group_code text not null check (group_code in ('zero','max')),
  team text[] not null check (public.is_valid_team(team)),
  team_key text generated always as (public.canonical_team(team)) stored,
  carry_name text not null check (public.team_has_carry(team,carry_name)),
  rounds integer not null check (rounds between 0 and 6),
  evidence_path text not null check (char_length(evidence_path) between 10 and 300),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  review_note text
);

-- 用户传入 created_at 也无效：以数据库接收 INSERT 的实际时间为准。
create or replace function public.set_submission_on_insert()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.created_at := clock_timestamp();
  new.status := 'pending';
  new.reviewed_at := null;
  new.reviewed_by := null;
  new.review_note := null;
  return new;
end;
$$;
drop trigger if exists submissions_enforce_insert on public.submissions;
create trigger submissions_enforce_insert before insert on public.submissions
for each row execute function public.set_submission_on_insert();

create index if not exists submissions_records_idx
on public.submissions(stage_id,group_code,team_key,rounds,created_at,id) where status='approved';
create index if not exists submissions_pending_idx
on public.submissions(created_at) where status='pending';

-- 历史记录只记录“获得过纪录席位”这个事件。后续失去纪录也不删事件。
create table if not exists public.record_history (
  id uuid primary key default gen_random_uuid(),
  stage_id uuid not null references public.stages(id),
  group_code text not null check (group_code in ('zero','max')),
  team_key text not null,
  submission_id uuid not null references public.submissions(id),
  player_id uuid not null references public.profiles(id),
  acquired_at timestamptz not null default clock_timestamp(),
  lost_at timestamptz
);
create index if not exists record_history_scope_idx on public.record_history(stage_id,group_code,team_key,lost_at);
create index if not exists record_history_player_idx on public.record_history(player_id);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.admins a join auth.users u on u.id = a.user_id
    where u.id = auth.uid() and not u.is_anonymous and u.email_confirmed_at is not null
  )
$$;

alter table public.profiles enable row level security;
alter table public.admins enable row level security;
alter table public.versions enable row level security;
alter table public.stages enable row level security;
alter table public.submissions enable row level security;
alter table public.record_history enable row level security;

create policy "profiles readable" on public.profiles for select to anon, authenticated using (
  id = (select auth.uid())
  or (select public.is_admin())
  or exists (
    select 1 from public.submissions s
    where s.player_id = profiles.id and s.status = 'approved'
  )
);
create policy "profiles insert self" on public.profiles for insert to authenticated with check (id = (select auth.uid()));
create policy "profiles update self" on public.profiles for update to authenticated using (id=(select auth.uid())) with check (id=(select auth.uid()));
create policy "admins only see self" on public.admins for select to authenticated using(user_id=(select auth.uid()));

create policy "versions public read" on public.versions for select to anon, authenticated using(true);
create policy "stages public read" on public.stages for select to anon, authenticated using(true);
create policy "versions admin insert" on public.versions for insert to authenticated with check(public.is_admin());
create policy "stages admin insert" on public.stages for insert to authenticated with check(public.is_admin());
create policy "versions admin update" on public.versions for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy "stages admin update" on public.stages for update to authenticated using(public.is_admin()) with check(public.is_admin());

create policy "approved or own or admin submissions readable" on public.submissions for select to anon, authenticated
using(status='approved' or player_id=(select auth.uid()) or public.is_admin());
create policy "player creates pending own submission" on public.submissions for insert to authenticated
with check(player_id=(select auth.uid()) and status='pending'
  and evidence_path like ((select auth.uid())::text||'/%')
  and reviewed_at is null and reviewed_by is null and review_note is null);
-- 审核状态不能由玩家 UPDATE。只有管理员通过受控 RPC 审核。
-- 后台维护操作由 SQL Editor / service owner 执行。

create policy "history read valid or admin" on public.record_history for select to anon, authenticated
using (public.is_admin() or exists(
    select 1 from public.submissions s
    where s.id=record_history.submission_id and s.status='approved'
));

-- 防止任何匿名用户修改版本、审核状态或历史事件。
revoke all on public.admins from anon, authenticated;
grant select on public.admins to authenticated;
grant select on public.profiles,public.versions,public.stages,public.submissions,public.record_history to anon,authenticated;
grant insert,update on public.profiles to authenticated;
grant insert on public.submissions to authenticated;
grant insert,update on public.versions,public.stages to authenticated;

-- 默认视图带 SECURITY INVOKER，严格沿用原始表 RLS。
create or replace view public.leaderboard_records with (security_invoker = true) as
select r.id,r.player_id,r.stage_id,r.group_code,r.team,r.team_key,
       r.carry_name,r.rounds,r.created_at,p.display_name,
       st.stage_no,st.name as stage_name,st.version_id,
       v.label as version_name
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

create or replace view public.player_ranking with (security_invoker = true) as
with historical as (
  select h.player_id,count(distinct (h.stage_id,h.group_code,h.team_key))::integer as historical_count
  from public.record_history h
  join public.submissions s on s.id=h.submission_id and s.status='approved'
  group by h.player_id
), present as (
  select player_id,count(*)::integer as current_count
  from public.leaderboard_records group by player_id
)
select p.id as player_id,p.display_name,
       coalesce(h.historical_count,0) as historical_count,
       coalesce(c.current_count,0) as current_count
from public.profiles p
left join historical h on h.player_id=p.id
left join present c on c.player_id=p.id
where coalesce(h.historical_count,0)>0 or coalesce(c.current_count,0)>0;

grant select on public.leaderboard_records,public.player_ranking to anon, authenticated;

-- 管理员审稿：事务内加锁，比较审核前后赢家，并原子更新历史事件。
-- 即使一个更早提交的同分稿件后审核，也仍由更早上传者持榜。
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

-- 新增版本 + 恰好三个关卡，原子完成，避免局部创建。
create or replace function public.create_version(
  p_code text,p_label text,p_stage_names text[]
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;i integer;
begin
  if not public.is_admin() then raise exception '仅管理员可以新增版本';end if;
  if cardinality(p_stage_names)<>3 then raise exception '每版本必须恰好三个关卡';end if;
  insert into public.versions(code,label) values(btrim(p_code),btrim(p_label)) returning id into v_id;
  for i in 1..3 loop
    insert into public.stages(version_id,stage_no,name) values(v_id,i,btrim(p_stage_names[i]));
  end loop;
  return v_id;
end;
$$;
revoke all on function public.create_version(text,text,text[]) from public;
grant execute on function public.create_version(text,text,text[]) to authenticated;

-- 私有证据桶：仅上传者与管理员可以看到截图。
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('proofs','proofs',false,5242880,array['image/png','image/jpeg','image/webp']::text[])
on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,
allowed_mime_types=excluded.allowed_mime_types;

create policy "proof owner upload" on storage.objects for insert to authenticated
with check (bucket_id='proofs' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "proof uploader and admin read" on storage.objects for select to authenticated
using (bucket_id='proofs' and ((storage.foldername(name))[1]=(select auth.uid())::text or public.is_admin()));
-- 仅允许用户删除自己上传的孤儿截图；审核后仍可能删除会破坏证据。
-- 因此不授权普通用户对 storage.objects 的 DELETE，清理由后台定期执行。

-- 安全测试建议：以匿名与普通登录身份分别尝试插入 approved、伪造 created_at、修改他人 submission。
-- 这些写入应被阻止或强制回 pending；使用管理员 RPC 才能审核。


-- V2 · 审核通过成绩移除与留痕功能（与增量脚本保持一致）
-- 供全新数据库初始化使用。

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
