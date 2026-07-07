-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 1A — OPERATIONAL GOVERNANCE EXTENSION ROLLBACK
-- File: 20260526000006_phase1a_operational_governance.rollback.sql
--
-- PURPOSE: Safely reverse migration 20260526000006.
--
-- PRE-ROLLBACK CHECKLIST:
--   □ No taxonomy_seed_versions rows have been inserted
--   □ No lifecycle_status values have been assigned to any rows
--   □ No application code references fn_get_regions_for_country() or
--     fn_get_boards_for_region() directly
--   □ No referential dependency guard triggers have fired in production
--     (i.e. no deprecation operations are in-flight)
--
-- NOTES:
--   • Dropping lifecycle_status columns is safe only if no rows have been
--     assigned lifecycle_status values. Check with:
--     SELECT count(*) FROM public.academic_boards WHERE lifecycle_status IS NOT NULL;
--   • taxonomy_seed_versions DROP will fail if rows exist. Truncate first
--     (service_role only) if rollback is required in CI.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- STEP 1: Drop referential dependency guard triggers and function
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_guard_deps_academic_subjects  ON public.academic_subjects;
DROP TRIGGER IF EXISTS trg_guard_deps_academic_languages ON public.academic_languages;
DROP TRIGGER IF EXISTS trg_guard_deps_curriculum_regions ON public.curriculum_regions;
DROP TRIGGER IF EXISTS trg_guard_deps_academic_boards    ON public.academic_boards;
DROP TRIGGER IF EXISTS trg_guard_deps_academic_streams   ON public.academic_streams;

DROP FUNCTION IF EXISTS public.fn_guard_taxonomy_deprecation_dependencies() CASCADE;

-- ---------------------------------------------------------------------------
-- STEP 2: Drop new RPCs
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.fn_get_boards_for_region(TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.fn_get_regions_for_country(TEXT)     CASCADE;

-- ---------------------------------------------------------------------------
-- STEP 3: Drop taxonomy_seed_versions (table, trigger, function)
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_governance_immutable_seed_versions ON public.taxonomy_seed_versions;
DROP POLICY  IF EXISTS "taxonomy_seed_versions_service_role_full" ON public.taxonomy_seed_versions;
DROP FUNCTION IF EXISTS public.fn_prevent_seed_version_mutation() CASCADE;
DROP TABLE   IF EXISTS public.taxonomy_seed_versions CASCADE;

-- ---------------------------------------------------------------------------
-- STEP 4: Restore original fn_taxonomy_health_check (without lifecycle columns)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_taxonomy_health_check()
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'taxonomy_hash', public.fn_academic_taxonomy_hash(),
    'checked_at',    NOW(),
    'counts', jsonb_build_object(
      'countries_active',        (SELECT count(*) FROM public.countries_master       WHERE is_active),
      'regions_active',          (SELECT count(*) FROM public.curriculum_regions     WHERE is_active),
      'boards_active',           (SELECT count(*) FROM public.academic_boards        WHERE is_active),
      'streams_active',          (SELECT count(*) FROM public.academic_streams       WHERE is_active),
      'subjects_active',         (SELECT count(*) FROM public.academic_subjects      WHERE is_active),
      'languages_active',        (SELECT count(*) FROM public.academic_languages     WHERE is_active),
      'state_language_mappings', (SELECT count(*) FROM public.state_language_mapping WHERE is_active),
      'subject_stream_maps',     (SELECT count(*) FROM public.subject_stream_map     WHERE is_active),
      'countries_deprecated',    (SELECT count(*) FROM public.countries_master       WHERE NOT is_active),
      'regions_deprecated',      (SELECT count(*) FROM public.curriculum_regions     WHERE NOT is_active),
      'boards_deprecated',       (SELECT count(*) FROM public.academic_boards        WHERE NOT is_active),
      'streams_deprecated',      (SELECT count(*) FROM public.academic_streams       WHERE NOT is_active),
      'subjects_deprecated',     (SELECT count(*) FROM public.academic_subjects      WHERE NOT is_active),
      'languages_deprecated',    (SELECT count(*) FROM public.academic_languages     WHERE NOT is_active)
    ),
    'governance', jsonb_build_object(
      'orphan_streams',
        (SELECT count(*) FROM public.academic_streams ast
         WHERE ast.is_active = TRUE
           AND NOT EXISTS (
             SELECT 1 FROM public.subject_stream_map ssm
             WHERE ssm.stream_id = ast.id AND ssm.is_active = TRUE)),
      'regions_without_languages',
        (SELECT count(*) FROM public.curriculum_regions cr
         WHERE cr.is_active = TRUE
           AND NOT EXISTS (
             SELECT 1 FROM public.state_language_mapping slm
             WHERE slm.region_id = cr.id AND slm.is_active = TRUE)),
      'boards_without_streams',
        (SELECT count(*) FROM public.academic_boards ab
         WHERE ab.is_active = TRUE
           AND NOT EXISTS (
             SELECT 1 FROM public.academic_streams ast
             WHERE ast.board_id = ab.id AND ast.is_active = TRUE))
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- STEP 5: Drop lifecycle_status columns and consistency constraints
-- ---------------------------------------------------------------------------

ALTER TABLE public.board_region_map
  DROP CONSTRAINT IF EXISTS chk_board_region_map_lifecycle_consistency,
  DROP COLUMN    IF EXISTS lifecycle_status;

ALTER TABLE public.subject_stream_map
  DROP CONSTRAINT IF EXISTS chk_subject_stream_map_lifecycle_consistency,
  DROP COLUMN    IF EXISTS lifecycle_status;

ALTER TABLE public.state_language_mapping
  DROP CONSTRAINT IF EXISTS chk_state_language_mapping_lifecycle_consistency,
  DROP COLUMN    IF EXISTS lifecycle_status;

ALTER TABLE public.academic_languages
  DROP CONSTRAINT IF EXISTS chk_academic_languages_lifecycle_consistency,
  DROP COLUMN    IF EXISTS lifecycle_status;

ALTER TABLE public.academic_subjects
  DROP CONSTRAINT IF EXISTS chk_academic_subjects_lifecycle_consistency,
  DROP COLUMN    IF EXISTS lifecycle_status;

ALTER TABLE public.academic_streams
  DROP CONSTRAINT IF EXISTS chk_academic_streams_lifecycle_consistency,
  DROP COLUMN    IF EXISTS lifecycle_status;

ALTER TABLE public.academic_boards
  DROP CONSTRAINT IF EXISTS chk_academic_boards_lifecycle_consistency,
  DROP COLUMN    IF EXISTS lifecycle_status;

ALTER TABLE public.curriculum_regions
  DROP CONSTRAINT IF EXISTS chk_curriculum_regions_lifecycle_consistency,
  DROP COLUMN    IF EXISTS lifecycle_status;

ALTER TABLE public.countries_master
  DROP CONSTRAINT IF EXISTS chk_countries_master_lifecycle_consistency,
  DROP COLUMN    IF EXISTS lifecycle_status;

COMMIT;

-- =============================================================================
-- END OF ROLLBACK: 20260526000006_phase1a_operational_governance.rollback.sql
-- =============================================================================
