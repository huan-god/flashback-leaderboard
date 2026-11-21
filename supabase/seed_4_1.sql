-- 国服 4.1 第 7 期，参考重返未来1999中文 Wiki「焦点闪回」关卡一览。
-- https://res1999.huijiwiki.com/wiki/焦点闪回
with edition as (
  insert into public.versions (code, label)
  values ('4.1', '4.1 · 第 7 期（11/07–12/10）')
  on conflict (code) do update set label=excluded.label
  returning id
)
insert into public.stages (version_id, stage_no, name)
select edition.id, stage.stage_no, stage.name
from edition cross join (values
  (1, 'Ⅰ · 洞知／额外行动'),
  (2, 'Ⅱ · 余辉／仪式'),
  (3, 'Ⅲ · 术具／仪式')
) as stage(stage_no, name)
on conflict (version_id, stage_no) do update set name=excluded.name;
