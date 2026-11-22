-- ============================================================================
-- 016: 心相与共鸣码扩展迁移（纯增量升级，完整保留现有数据库表与历史数据）
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

-- 3. 更新投稿 RPC，使新投稿提交的心相与共鸣码随同联系方式一并入库
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

-- 4. 更新焦点闪回公开排行榜视图，导出 team_psychubes 与 team_resonance_codes
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

-- 5. 提示：若需鬃毛邮报公开榜同步展示心相与共鸣码，请同步在 public.mane_leaderboard 视图末尾加上：
--    team_psychubes, team_resonance_codes
