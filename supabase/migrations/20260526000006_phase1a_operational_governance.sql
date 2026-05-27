-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 1F — OPERATIONAL GOVERNANCE EXTENSION (FIXED)
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. LIFECYCLE STATUS COLUMNS
-- =============================================================================

ALTER TABLE public.countries_master
ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;

ALTER TABLE public.curriculum_regions
ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;

ALTER TABLE public.academic_boards
ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;

ALTER TABLE public.academic_streams
ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;

ALTER TABLE public.academic_subjects
ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;

ALTER TABLE public.academic_languages
ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;

ALTER TABLE public.state_language_mapping
ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;

ALTER TABLE public.subject_stream_map
ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;

ALTER TABLE public.board_region_map
ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;

-- =============================================================================
-- 2. LIFECYCLE GOVERNANCE CONSTRAINTS
-- =============================================================================

DO $$
BEGIN

IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'chk_countries_master_lifecycle_consistency'
) THEN

ALTER TABLE public.countries_master
ADD CONSTRAINT chk_countries_master_lifecycle_consistency
CHECK (
  lifecycle_status IS NULL
  OR (is_active = TRUE AND lifecycle_status IN ('active','pending_activation','draft'))
  OR (is_active = FALSE AND lifecycle_status IN ('deprecated','archived','superseded'))
);

END IF;

END $$;

DO $$
BEGIN

IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'chk_curriculum_regions_lifecycle_consistency'
) THEN

ALTER TABLE public.curriculum_regions
ADD CONSTRAINT chk_curriculum_regions_lifecycle_consistency
CHECK (
  lifecycle_status IS NULL
  OR (is_active = TRUE AND lifecycle_status IN ('active','pending_activation','draft'))
  OR (is_active = FALSE AND lifecycle_status IN ('deprecated','archived','superseded'))
);

END IF;

END $$;

DO $$
BEGIN

IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'chk_academic_boards_lifecycle_consistency'
) THEN

ALTER TABLE public.academic_boards
ADD CONSTRAINT chk_academic_boards_lifecycle_consistency
CHECK (
  lifecycle_status IS NULL
  OR (is_active = TRUE AND lifecycle_status IN ('active','pending_activation','draft'))
  OR (is_active = FALSE AND lifecycle_status IN ('deprecated','archived','superseded'))
);

END IF;

END $$;

DO $$
BEGIN

IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'chk_academic_streams_lifecycle_consistency'
) THEN

ALTER TABLE public.academic_streams
ADD CONSTRAINT chk_academic_streams_lifecycle_consistency
CHECK (
  lifecycle_status IS NULL
  OR (is_active = TRUE AND lifecycle_status IN ('active','pending_activation','draft'))
  OR (is_active = FALSE AND lifecycle_status IN ('deprecated','archived','superseded'))
);

END IF;

END $$;

DO $$
BEGIN

IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'chk_academic_subjects_lifecycle_consistency'
) THEN

ALTER TABLE public.academic_subjects
ADD CONSTRAINT chk_academic_subjects_lifecycle_consistency
CHECK (
  lifecycle_status IS NULL
  OR (is_active = TRUE AND lifecycle_status IN ('active','pending_activation','draft'))
  OR (is_active = FALSE AND lifecycle_status IN ('deprecated','archived','superseded'))
);

END IF;

END $$;

DO $$
BEGIN

IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'chk_academic_languages_lifecycle_consistency'
) THEN

ALTER TABLE public.academic_languages
ADD CONSTRAINT chk_academic_languages_lifecycle_consistency
CHECK (
  lifecycle_status IS NULL
  OR (is_active = TRUE AND lifecycle_status IN ('active','pending_activation','draft'))
  OR (is_active = FALSE AND lifecycle_status IN ('deprecated','archived','superseded'))
);

END IF;

END $$;

-- =============================================================================
-- 3. DEPENDENCY GOVERNANCE FUNCTION
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_guard_taxonomy_deprecation_dependencies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_active_dependents INT := 0;
BEGIN

IF OLD.is_active = TRUE
AND NEW.is_active = FALSE THEN

  CASE TG_TABLE_NAME

    WHEN 'academic_streams' THEN

      SELECT count(*)
      INTO v_active_dependents
      FROM public.subject_stream_map
      WHERE stream_id = NEW.id
      AND is_active = TRUE;

    WHEN 'academic_boards' THEN

      SELECT count(*)
      INTO v_active_dependents
      FROM public.academic_streams
      WHERE board_id = NEW.id
      AND is_active = TRUE;

    WHEN 'curriculum_regions' THEN

      SELECT count(*)
      INTO v_active_dependents
      FROM public.board_region_map
      WHERE region_id = NEW.id
      AND is_active = TRUE;

    WHEN 'academic_languages' THEN

      SELECT count(*)
      INTO v_active_dependents
      FROM public.state_language_mapping
      WHERE language_id = NEW.id
      AND is_active = TRUE;

    WHEN 'academic_subjects' THEN

      SELECT count(*)
      INTO v_active_dependents
      FROM public.subject_stream_map
      WHERE subject_id = NEW.id
      AND is_active = TRUE;

  END CASE;

  IF v_active_dependents > 0 THEN

    RAISE EXCEPTION
      'GOVERNANCE_VIOLATION: active dependent records exist'
      USING ERRCODE = 'restrict_violation';

  END IF;

END IF;

RETURN NEW;

END;
$$;

REVOKE ALL ON FUNCTION public.fn_guard_taxonomy_deprecation_dependencies()
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_guard_taxonomy_deprecation_dependencies()
TO service_role;

-- =============================================================================
-- 4. SAFE TRIGGER RECREATION
-- =============================================================================

DROP TRIGGER IF EXISTS trg_guard_deps_academic_streams
ON public.academic_streams;

CREATE TRIGGER trg_guard_deps_academic_streams
BEFORE UPDATE ON public.academic_streams
FOR EACH ROW
EXECUTE FUNCTION public.fn_guard_taxonomy_deprecation_dependencies();

DROP TRIGGER IF EXISTS trg_guard_deps_academic_boards
ON public.academic_boards;

CREATE TRIGGER trg_guard_deps_academic_boards
BEFORE UPDATE ON public.academic_boards
FOR EACH ROW
EXECUTE FUNCTION public.fn_guard_taxonomy_deprecation_dependencies();

DROP TRIGGER IF EXISTS trg_guard_deps_curriculum_regions
ON public.curriculum_regions;

CREATE TRIGGER trg_guard_deps_curriculum_regions
BEFORE UPDATE ON public.curriculum_regions
FOR EACH ROW
EXECUTE FUNCTION public.fn_guard_taxonomy_deprecation_dependencies();

-- =============================================================================
-- 5. REGIONS RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_regions_for_country(
  p_country_code TEXT DEFAULT 'IN'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_result JSONB;
BEGIN

SELECT COALESCE(
  jsonb_agg(
    jsonb_build_object(
      'id', cr.id,
      'region_code', cr.region_code,
      'region_name', cr.region_name,
      'lifecycle_status', cr.lifecycle_status
    )
    ORDER BY cr.region_name
  ),
  '[]'::jsonb
)
INTO v_result
FROM public.curriculum_regions cr
JOIN public.countries_master cm
  ON cm.id = cr.country_id
WHERE cm.country_code = upper(trim(p_country_code))
AND cr.is_active = TRUE
AND cm.is_active = TRUE;

RETURN jsonb_build_object(
  'success', TRUE,
  'country_code', upper(trim(p_country_code)),
  'regions', v_result
);

END;
$$;

REVOKE ALL ON FUNCTION public.fn_get_regions_for_country(TEXT)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_get_regions_for_country(TEXT)
TO authenticated, service_role;

-- =============================================================================
-- 6. BOARDS FOR REGION RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_boards_for_region(
  p_region_code TEXT,
  p_country_code TEXT DEFAULT 'IN'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_result JSONB;
BEGIN

SELECT COALESCE(
  jsonb_agg(
    jsonb_build_object(
      'id', ab.id,
      'board_code', ab.board_code,
      'board_name', ab.board_name,
      'board_type', ab.board_type,
      'is_primary', brm.is_primary,
      'lifecycle_status', ab.lifecycle_status
    )
    ORDER BY brm.is_primary DESC, ab.board_name
  ),
  '[]'::jsonb
)
INTO v_result
FROM public.board_region_map brm
JOIN public.academic_boards ab
  ON ab.id = brm.board_id
JOIN public.curriculum_regions cr
  ON cr.id = brm.region_id
JOIN public.countries_master cm
  ON cm.id = cr.country_id
WHERE cr.region_code = upper(trim(p_region_code))
AND cm.country_code = upper(trim(p_country_code))
AND brm.is_active = TRUE
AND ab.is_active = TRUE;

RETURN jsonb_build_object(
  'success', TRUE,
  'region_code', upper(trim(p_region_code)),
  'boards', v_result
);

END;
$$;

REVOKE ALL ON FUNCTION public.fn_get_boards_for_region(TEXT, TEXT)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_get_boards_for_region(TEXT, TEXT)
TO authenticated, service_role;

-- =============================================================================
-- 7. TAXONOMY SEED VERSION TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.taxonomy_seed_versions (

  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  seed_version TEXT NOT NULL UNIQUE,

  taxonomy_hash TEXT NOT NULL,

  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  applied_by TEXT,

  seed_metadata JSONB,

  CONSTRAINT chk_taxonomy_seed_versions_nonempty
  CHECK (
    seed_version <> ''
    AND taxonomy_hash <> ''
  )

);

ALTER TABLE public.taxonomy_seed_versions
ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS taxonomy_seed_versions_service_role_full
ON public.taxonomy_seed_versions;

CREATE POLICY taxonomy_seed_versions_service_role_full
ON public.taxonomy_seed_versions
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);

GRANT SELECT, INSERT
ON public.taxonomy_seed_versions
TO service_role;

COMMIT;