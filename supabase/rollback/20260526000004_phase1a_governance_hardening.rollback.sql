-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 1A — GOVERNANCE HARDENING ROLLBACK
-- File: 20260526000004_phase1a_governance_hardening.rollback.sql
--
-- PURPOSE: Safely reverse the governance hardening migration.
--
-- PRE-ROLLBACK CHECKLIST:
--   □ No Phase 1B+ migrations depend on board_region_map
--   □ No board_region_map rows have been created
--   □ No application code references pudx_* partial unique indexes by name
--   □ No audit fields (created_by / updated_by) have been populated
--   □ All immutable business key triggers can be safely dropped
--
-- NOTES:
--   • Dropping partial unique indexes and restoring full UNIQUE constraints
--     requires the active taxonomy to have no conflicting rows.
--   • If soft-deleted rows share a business key with active rows (valid under
--     partial uniqueness), the full UNIQUE restoration will FAIL.
--     Resolve conflicts before rolling back.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- STEP 1: Drop immutable business key triggers and function
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_immutable_key_academic_languages_code ON public.academic_languages;
DROP TRIGGER IF EXISTS trg_immutable_key_academic_subjects_code  ON public.academic_subjects;
DROP TRIGGER IF EXISTS trg_immutable_key_academic_streams_code   ON public.academic_streams;
DROP TRIGGER IF EXISTS trg_immutable_key_academic_boards_code    ON public.academic_boards;
DROP TRIGGER IF EXISTS trg_immutable_key_curriculum_regions_code ON public.curriculum_regions;
DROP TRIGGER IF EXISTS trg_immutable_key_countries_master_code   ON public.countries_master;

DROP FUNCTION IF EXISTS public.fn_enforce_immutable_business_key() CASCADE;

-- ---------------------------------------------------------------------------
-- STEP 2: Drop board_region_map (governance triggers, RLS, table)
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_governance_no_delete_board_region_map ON public.board_region_map;
DROP TRIGGER IF EXISTS trg_board_region_map_updated_at           ON public.board_region_map;

DROP POLICY IF EXISTS "board_region_map_service_role_full" ON public.board_region_map;
DROP POLICY IF EXISTS "board_region_map_public_read"       ON public.board_region_map;

DROP TABLE IF EXISTS public.board_region_map CASCADE;

-- ---------------------------------------------------------------------------
-- STEP 3: Drop partial unique indexes; restore full UNIQUE constraints
-- NOTE: Will fail if soft-deleted rows conflict with active rows on the
--       business key. Resolve data conflicts before running this step.
-- ---------------------------------------------------------------------------

-- subject_stream_map
DROP INDEX IF EXISTS public.pudx_subject_stream_map_active;
ALTER TABLE public.subject_stream_map
  ADD CONSTRAINT uq_subject_stream_map_subject_stream UNIQUE (subject_id, stream_id);

-- state_language_mapping
DROP INDEX IF EXISTS public.pudx_state_language_mapping_active;
ALTER TABLE public.state_language_mapping
  ADD CONSTRAINT uq_state_language_mapping_region_lang UNIQUE (region_id, language_id);

-- academic_languages
DROP INDEX IF EXISTS public.pudx_academic_languages_code_active;
ALTER TABLE public.academic_languages
  ADD CONSTRAINT uq_academic_languages_code UNIQUE (language_code);

-- academic_subjects
DROP INDEX IF EXISTS public.pudx_academic_subjects_code_active;
ALTER TABLE public.academic_subjects
  ADD CONSTRAINT uq_academic_subjects_code UNIQUE (subject_code);

-- academic_streams
DROP INDEX IF EXISTS public.pudx_academic_streams_code_active;
ALTER TABLE public.academic_streams
  ADD CONSTRAINT uq_academic_streams_code UNIQUE (board_id, stream_code);

-- academic_boards
DROP INDEX IF EXISTS public.pudx_academic_boards_code_active;
ALTER TABLE public.academic_boards
  ADD CONSTRAINT uq_academic_boards_code UNIQUE (country_id, board_code);

-- curriculum_regions
DROP INDEX IF EXISTS public.pudx_curriculum_regions_code_active;
ALTER TABLE public.curriculum_regions
  ADD CONSTRAINT uq_curriculum_regions_code UNIQUE (country_id, region_code);

-- ---------------------------------------------------------------------------
-- STEP 4: Drop strict class range constraints; restore loose positive checks
-- ---------------------------------------------------------------------------

-- academic_streams
ALTER TABLE public.academic_streams
  DROP CONSTRAINT IF EXISTS chk_academic_streams_from_class_range,
  DROP CONSTRAINT IF EXISTS chk_academic_streams_to_class_range;

ALTER TABLE public.academic_streams
  ADD CONSTRAINT chk_academic_streams_class_positive
    CHECK (
      (applicable_from_class IS NULL OR applicable_from_class > 0)
      AND (applicable_to_class IS NULL OR applicable_to_class > 0)
    );

-- academic_subjects
ALTER TABLE public.academic_subjects
  DROP CONSTRAINT IF EXISTS chk_academic_subjects_from_class_range,
  DROP CONSTRAINT IF EXISTS chk_academic_subjects_to_class_range;

-- Note: the original chk_academic_subjects_class_positive did not exist
-- as a separate constraint in Phase 1A subjects table; no re-add required.

-- ---------------------------------------------------------------------------
-- STEP 5: Drop audit columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.subject_stream_map      DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS updated_by;
ALTER TABLE public.state_language_mapping  DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS updated_by;
ALTER TABLE public.academic_languages      DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS updated_by;
ALTER TABLE public.academic_subjects       DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS updated_by;
ALTER TABLE public.academic_streams        DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS updated_by;
ALTER TABLE public.academic_boards         DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS updated_by;
ALTER TABLE public.curriculum_regions      DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS updated_by;
ALTER TABLE public.countries_master        DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS updated_by;

-- ---------------------------------------------------------------------------
-- STEP 6: Drop deprecated_at supplements on mapping tables
-- ---------------------------------------------------------------------------

ALTER TABLE public.subject_stream_map
  DROP CONSTRAINT IF EXISTS chk_subject_stream_map_deprecated_inactive,
  DROP COLUMN IF EXISTS deprecated_at;

ALTER TABLE public.state_language_mapping
  DROP CONSTRAINT IF EXISTS chk_state_language_mapping_deprecated_inactive,
  DROP COLUMN IF EXISTS deprecated_at;

-- ---------------------------------------------------------------------------
-- STEP 7: Restore fn_deprecate_taxonomy_entity without board_region_map
-- (restores the Phase 1A version of the function)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_deprecate_taxonomy_entity(
  p_table TEXT,
  p_id    UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_allowed_tables TEXT[] := ARRAY[
    'countries_master',
    'curriculum_regions',
    'academic_boards',
    'academic_streams',
    'academic_subjects',
    'academic_languages',
    'state_language_mapping',
    'subject_stream_map'
  ];
  v_result JSONB;
  v_rows   INT;
BEGIN
  IF NOT (p_table = ANY(v_allowed_tables)) THEN
    RAISE EXCEPTION
      'fn_deprecate_taxonomy_entity: table "%" is not a valid taxonomy table. '
      'Allowed: %', p_table, array_to_string(v_allowed_tables, ', ')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'fn_deprecate_taxonomy_entity: p_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  EXECUTE format(
    'UPDATE public.%I
       SET is_active     = FALSE,
           deprecated_at = NOW(),
           updated_at    = NOW()
     WHERE id = $1
       AND is_active = TRUE
     RETURNING to_jsonb(%I.*)',
    p_table, p_table
  )
  USING p_id INTO v_result;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RAISE EXCEPTION
      'fn_deprecate_taxonomy_entity: No active record found in table "%" with id %',
      p_table, p_id
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE, 'table', p_table,
    'deprecated_id', p_id, 'deprecated_at', NOW(), 'entity', v_result
  );
EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object('success', FALSE, 'error', SQLERRM, 'code', 'VALIDATION_ERROR');
  WHEN no_data_found THEN
    RETURN jsonb_build_object('success', FALSE, 'error', SQLERRM, 'code', 'NOT_FOUND');
  WHEN OTHERS THEN
    RAISE EXCEPTION 'fn_deprecate_taxonomy_entity failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;

COMMIT;

-- =============================================================================
-- END OF ROLLBACK: 20260526000004_phase1a_governance_hardening.rollback.sql
-- =============================================================================
