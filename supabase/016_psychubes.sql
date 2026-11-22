-- ============================================================================
-- 016: 心相与共鸣码扩展迁移（纯增量升级，完整保留现有数据库表与历史数据）
-- 使用方式：在 Supabase Dashboard -> SQL Editor 粘贴全文并点击 Run 即可。
-- ============================================================================

-- 1. 为鬃毛邮报与焦点闪回表新增可空心相与共鸣码数组列（按 1–4 号位对应 team）
ALTER TABLE public.mane_entries
  ADD COLUMN IF NOT EXISTS team_psychubes text[],
  ADD COLUMN IF NOT EXISTS team_resonance_codes text[];

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS team_psychubes text[],
  ADD COLUMN IF NOT EXISTS team_resonance_codes text[];

-- 2. 基础长度校验（最多 4 名角色配置）
ALTER TABLE public.mane_entries
  DROP CONSTRAINT IF EXISTS mane_entries_team_psychubes_len,
  ADD CONSTRAINT mane_entries_team_psychubes_len
    CHECK (team_psychubes IS NULL OR coalesce(array_length(team_psychubes, 1), 0) <= 4),
  DROP CONSTRAINT IF EXISTS mane_entries_team_resonance_len,
  ADD CONSTRAINT mane_entries_team_resonance_len
    CHECK (team_resonance_codes IS NULL OR coalesce(array_length(team_resonance_codes, 1), 0) <= 4);

ALTER TABLE public.submissions
  DROP CONSTRAINT IF EXISTS submissions_team_psychubes_len,
  ADD CONSTRAINT submissions_team_psychubes_len
    CHECK (team_psychubes IS NULL OR coalesce(array_length(team_psychubes, 1), 0) <= 4),
  DROP CONSTRAINT IF EXISTS submissions_team_resonance_len,
  ADD CONSTRAINT submissions_team_resonance_len
    CHECK (team_resonance_codes IS NULL OR coalesce(array_length(team_resonance_codes, 1), 0) <= 4);

-- 3. 为 mane_entries 新列补充列级权限（沿用 001_mane_leaderboard.sql 的最小权限策略）
GRANT SELECT (team_psychubes, team_resonance_codes) ON public.mane_entries TO anon, authenticated;
GRANT INSERT (team_psychubes, team_resonance_codes), UPDATE (team_psychubes, team_resonance_codes) ON public.mane_entries TO authenticated;

-- 4. 更新投稿 RPC，使新投稿提交的心相与共鸣码随同联系方式一并入库
CREATE OR REPLACE FUNCTION public.submit_flashback_result(p_record jsonb, p_contact text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  result_id uuid;
  contact_text text := nullif(btrim(p_contact), '');
BEGIN
  INSERT INTO public.submissions (
    player_id, stage_id, group_code, team, carry_name,
    rounds, evidence_path, related_url, resonance_ten,
    team_psychubes, team_resonance_codes
  )
  SELECT
    auth.uid(), stage_id, group_code, team, carry_name,
    rounds, evidence_path, related_url, coalesce(resonance_ten, false),
    team_psychubes, team_resonance_codes
  FROM jsonb_to_record(p_record) AS r(
    stage_id uuid, group_code text, team text[],
    carry_name text, rounds integer, evidence_path text,
    related_url text, resonance_ten boolean,
    team_psychubes text[], team_resonance_codes text[]
  )
  RETURNING id INTO result_id;

  IF contact_text IS NOT NULL THEN
    INSERT INTO public.submission_contacts (submission_id, contact) VALUES (result_id, contact_text);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_mane_result(p_record jsonb, p_contact text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  result_id uuid;
  contact_text text := nullif(btrim(p_contact), '');
BEGIN
  INSERT INTO public.mane_entries (
    player_id, map_id, division, display_name, team,
    carry, score, evidence_path, related_url,
    team_psychubes, team_resonance_codes
  )
  SELECT
    auth.uid(), map_id, division, display_name, team,
    carry, score, evidence_path, related_url,
    team_psychubes, team_resonance_codes
  FROM jsonb_to_record(p_record) AS r(
    map_id uuid, division text, display_name text, team text[],
    carry text, score bigint, evidence_path text, related_url text,
    team_psychubes text[], team_resonance_codes text[]
  )
  RETURNING id INTO result_id;

  IF contact_text IS NOT NULL THEN
    INSERT INTO public.submission_contacts (mane_entry_id, contact) VALUES (result_id, contact_text);
  END IF;
END;
$$;

-- 5. 管理员补充/修改焦点闪回心相与共鸣码的受控 RPC（严格校验 is_admin()）
CREATE OR REPLACE FUNCTION public.update_submission_builds(
  p_id uuid,
  p_team_psychubes text[] DEFAULT NULL,
  p_team_resonance_codes text[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION '只有管理员可以修改配装记录。' USING ERRCODE = '42501';
  END IF;
  UPDATE public.submissions
  SET team_psychubes = p_team_psychubes,
      team_resonance_codes = p_team_resonance_codes
  WHERE id = p_id;
END;
$$;
REVOKE ALL ON FUNCTION public.update_submission_builds(uuid, text[], text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_submission_builds(uuid, text[], text[]) TO authenticated;

-- 6. 更新两张公开只读视图，使前台「查看」与榜单列表标签自动显示心相与共鸣码
CREATE OR REPLACE VIEW public.mane_leaderboard WITH (security_invoker = true) AS
SELECT DISTINCT ON (e.map_id, e.division, e.team_key)
  e.id, e.player_id, e.map_id, e.display_name, e.division, e.team, e.carry, e.score, e.created_at, e.related_url,
  e.team_psychubes, e.team_resonance_codes
FROM public.mane_entries e
JOIN public.mane_maps m ON e.map_id = m.id
WHERE e.status = 'approved' AND m.active
ORDER BY e.map_id, e.division, e.team_key, e.score DESC, e.created_at, e.id;
GRANT SELECT ON public.mane_leaderboard TO anon, authenticated;

CREATE OR REPLACE VIEW public.leaderboard_records WITH (security_invoker = true) AS
SELECT r.id, r.player_id, r.stage_id, r.group_code, w.team, r.team_key, r.carry_name,
  r.rounds, r.created_at, coalesce(r.credited_player, p.display_name) AS display_name,
  st.stage_no, st.name AS stage_name, st.version_id, v.label AS version_name, r.related_url,
  r.resonance_ten, r.team_psychubes, r.team_resonance_codes
FROM public.flashback_current_lineups w
JOIN public.submissions r ON r.id = w.id
LEFT JOIN public.profiles p ON p.id = r.player_id
JOIN public.stages st ON st.id = r.stage_id
JOIN public.versions v ON v.id = st.version_id;
GRANT SELECT ON public.leaderboard_records TO anon, authenticated;
