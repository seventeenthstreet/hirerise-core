-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 1A — TAXONOMY UTILITY RPCs
-- File: 20260526000003_phase1a_taxonomy_utility_rpcs.sql
--
-- PURPOSE: Safe, governance-aware read and soft-delete RPCs for the
--   academic taxonomy layer. These functions are the authorised interface
--   for taxonomy operations from the application layer.
--
-- INCLUDED RPCs:
--   fn_get_streams_for_board(p_board_code, p_country_code)
--   fn_get_subjects_for_stream(p_stream_id, p_include_integrated)
--   fn_get_languages_for_region(p_region_code, p_country_code)
--   fn_deprecate_taxonomy_entity(p_table, p_id)
--   fn_taxonomy_health_check()
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- RPC 1: Get streams for a board
-- Returns all active streams for a given board_code + country_code combo.
-- Used by onboarding: student selects their board → system loads its streams.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_get_streams_for_board(
  p_board_code   TEXT,
  p_country_code TEXT DEFAULT 'IN'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF p_board_code IS NULL OR trim(p_board_code) = '' THEN
    RAISE EXCEPTION 'fn_get_streams_for_board: p_board_code is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',                   ast.id,
      'stream_code',          ast.stream_code,
      'stream_name',          ast.stream_name,
      'applicable_from_class', ast.applicable_from_class,
      'applicable_to_class',  ast.applicable_to_class
    ) ORDER BY ast.stream_name
  ), '[]'::jsonb)
  INTO v_result
  FROM public.academic_streams ast
  JOIN public.academic_boards ab   ON ab.id = ast.board_id
  JOIN public.countries_master cm  ON cm.id = ab.country_id
  WHERE ab.board_code   = upper(trim(p_board_code))
    AND cm.country_code = upper(trim(p_country_code))
    AND ast.is_active   = TRUE
    AND ab.is_active    = TRUE
    AND cm.is_active    = TRUE;

  RETURN jsonb_build_object(
    'success',     TRUE,
    'board_code',  upper(trim(p_board_code)),
    'country_code', upper(trim(p_country_code)),
    'streams',     v_result
  );

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object('success', FALSE, 'error', SQLERRM, 'code', 'VALIDATION_ERROR');
  WHEN OTHERS THEN
    RAISE EXCEPTION 'fn_get_streams_for_board failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;

COMMENT ON FUNCTION public.fn_get_streams_for_board(TEXT, TEXT) IS
  'Returns all active streams for a given board. '
  'Used by onboarding board-selection step. '
  'Governance-safe: only returns is_active = TRUE records.';

-- ---------------------------------------------------------------------------
-- RPC 2: Get subjects for a stream
-- Returns stream-specific subjects + optionally integrated subjects.
-- Used by onboarding: student selects stream → system loads available subjects.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_get_subjects_for_stream(
  p_stream_id         UUID,
  p_include_integrated BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF p_stream_id IS NULL THEN
    RAISE EXCEPTION 'fn_get_subjects_for_stream: p_stream_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',               sub.id,
      'subject_code',     sub.subject_code,
      'subject_name',     sub.subject_name,
      'subject_category', sub.subject_category,
      'is_mandatory',     COALESCE(ssm.is_mandatory, FALSE),
      'is_language',      sub.is_language,
      'is_integrated',    sub.is_integrated,
      'is_optional',      sub.is_optional,
      'source',           CASE WHEN ssm.stream_id IS NOT NULL THEN 'stream' ELSE 'integrated' END
    ) ORDER BY
      (CASE WHEN COALESCE(ssm.is_mandatory, FALSE) THEN 0 ELSE 1 END),
      sub.subject_name
  ), '[]'::jsonb)
  INTO v_result
  FROM public.academic_subjects sub
  LEFT JOIN public.subject_stream_map ssm
    ON  ssm.subject_id = sub.id
    AND ssm.stream_id  = p_stream_id
    AND ssm.is_active  = TRUE
  WHERE sub.is_active = TRUE
    AND (
      -- Subjects explicitly mapped to this stream
      ssm.stream_id IS NOT NULL
      OR
      -- Integrated subjects (appear in all streams) if requested
      (p_include_integrated = TRUE AND sub.is_integrated = TRUE)
    );

  RETURN jsonb_build_object(
    'success',   TRUE,
    'stream_id', p_stream_id,
    'subjects',  v_result
  );

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object('success', FALSE, 'error', SQLERRM, 'code', 'VALIDATION_ERROR');
  WHEN OTHERS THEN
    RAISE EXCEPTION 'fn_get_subjects_for_stream failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;

COMMENT ON FUNCTION public.fn_get_subjects_for_stream(UUID, BOOLEAN) IS
  'Returns subjects for a given stream. '
  'Optionally includes integrated subjects (is_integrated = TRUE). '
  'Integrated subjects appear in all streams (e.g. English, PE). '
  'Used by onboarding subject-selection step.';

-- ---------------------------------------------------------------------------
-- RPC 3: Get languages for a region
-- Returns all languages mapped to a curriculum region with their role flags.
-- Used by onboarding: language subject filtering by student's state.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_get_languages_for_region(
  p_region_code  TEXT,
  p_country_code TEXT DEFAULT 'IN'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF p_region_code IS NULL OR trim(p_region_code) = '' THEN
    RAISE EXCEPTION 'fn_get_languages_for_region: p_region_code is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'language_id',   lang.id,
      'language_code', lang.language_code,
      'language_name', lang.language_name,
      'is_primary',    slm.is_primary,
      'is_common',     slm.is_common,
      'is_optional',   slm.is_optional
    ) ORDER BY
      (CASE WHEN slm.is_primary THEN 0 WHEN slm.is_common THEN 1 ELSE 2 END),
      lang.language_name
  ), '[]'::jsonb)
  INTO v_result
  FROM public.state_language_mapping slm
  JOIN public.academic_languages lang  ON lang.id = slm.language_id
  JOIN public.curriculum_regions cr    ON cr.id   = slm.region_id
  JOIN public.countries_master cm      ON cm.id   = cr.country_id
  WHERE cr.region_code   = upper(trim(p_region_code))
    AND cm.country_code  = upper(trim(p_country_code))
    AND slm.is_active    = TRUE
    AND lang.is_active   = TRUE
    AND cr.is_active     = TRUE
    AND cm.is_active     = TRUE;

  RETURN jsonb_build_object(
    'success',     TRUE,
    'region_code', upper(trim(p_region_code)),
    'languages',   v_result
  );

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object('success', FALSE, 'error', SQLERRM, 'code', 'VALIDATION_ERROR');
  WHEN OTHERS THEN
    RAISE EXCEPTION 'fn_get_languages_for_region failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;

COMMENT ON FUNCTION public.fn_get_languages_for_region(TEXT, TEXT) IS
  'Returns all languages mapped to a curriculum region with role context. '
  'Ordered: primary → common → optional. '
  'Used by onboarding language subject filtering step.';

-- ---------------------------------------------------------------------------
-- RPC 4: Governance-safe soft-deprecation
-- Centralised safe deprecation that enforces governance rules:
--   - Only service_role may call this
--   - Validates table name against whitelist
--   - Sets is_active = FALSE, deprecated_at = NOW()
--   - Returns the deprecated entity for audit logging
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
  -- Validate table name against whitelist (prevents SQL injection via table name)
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

  -- Dynamic UPDATE via EXECUTE using whitelisted table name
  -- p_id is parameterised — no SQL injection risk
  EXECUTE format(
    'UPDATE public.%I
       SET is_active    = FALSE,
           deprecated_at = NOW(),
           updated_at   = NOW()
     WHERE id = $1
       AND is_active = TRUE
     RETURNING to_jsonb(%I.*)',
    p_table, p_table
  )
  USING p_id
  INTO v_result;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RAISE EXCEPTION
      'fn_deprecate_taxonomy_entity: No active record found in table "%" with id %',
      p_table, p_id
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN jsonb_build_object(
    'success',      TRUE,
    'table',        p_table,
    'deprecated_id', p_id,
    'deprecated_at', NOW(),
    'entity',        v_result
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

COMMENT ON FUNCTION public.fn_deprecate_taxonomy_entity(TEXT, UUID) IS
  'Governance-safe soft-deprecation for taxonomy entities. '
  'Table name is whitelisted — prevents injection. '
  'Sets is_active = FALSE and deprecated_at. '
  'Returns the deprecated entity for audit logging. '
  'Physical DELETE is still prohibited by trg_governance_no_delete_* triggers.';

-- ---------------------------------------------------------------------------
-- RPC 5: Taxonomy health check
-- Returns a snapshot of taxonomy completeness for CI and admin monitoring.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_taxonomy_health_check()
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'taxonomy_hash',            public.fn_academic_taxonomy_hash(),
    'checked_at',               NOW(),
    'counts', jsonb_build_object(
      'countries_active',         (SELECT count(*) FROM public.countries_master        WHERE is_active),
      'regions_active',           (SELECT count(*) FROM public.curriculum_regions      WHERE is_active),
      'boards_active',            (SELECT count(*) FROM public.academic_boards          WHERE is_active),
      'streams_active',           (SELECT count(*) FROM public.academic_streams         WHERE is_active),
      'subjects_active',          (SELECT count(*) FROM public.academic_subjects        WHERE is_active),
      'languages_active',         (SELECT count(*) FROM public.academic_languages       WHERE is_active),
      'state_language_mappings',  (SELECT count(*) FROM public.state_language_mapping   WHERE is_active),
      'subject_stream_maps',      (SELECT count(*) FROM public.subject_stream_map       WHERE is_active),
      'countries_deprecated',     (SELECT count(*) FROM public.countries_master        WHERE NOT is_active),
      'regions_deprecated',       (SELECT count(*) FROM public.curriculum_regions      WHERE NOT is_active),
      'boards_deprecated',        (SELECT count(*) FROM public.academic_boards          WHERE NOT is_active),
      'streams_deprecated',       (SELECT count(*) FROM public.academic_streams         WHERE NOT is_active),
      'subjects_deprecated',      (SELECT count(*) FROM public.academic_subjects        WHERE NOT is_active),
      'languages_deprecated',     (SELECT count(*) FROM public.academic_languages       WHERE NOT is_active)
    ),
    'governance', jsonb_build_object(
      'orphan_streams',      -- streams with no subjects mapped
        (SELECT count(*) FROM public.academic_streams ast
         WHERE ast.is_active = TRUE
           AND NOT EXISTS (
             SELECT 1 FROM public.subject_stream_map ssm
             WHERE ssm.stream_id = ast.id AND ssm.is_active = TRUE
           )),
      'regions_without_languages',  -- regions with no language mappings
        (SELECT count(*) FROM public.curriculum_regions cr
         WHERE cr.is_active = TRUE
           AND NOT EXISTS (
             SELECT 1 FROM public.state_language_mapping slm
             WHERE slm.region_id = cr.id AND slm.is_active = TRUE
           )),
      'boards_without_streams',    -- boards with no active streams
        (SELECT count(*) FROM public.academic_boards ab
         WHERE ab.is_active = TRUE
           AND NOT EXISTS (
             SELECT 1 FROM public.academic_streams ast
             WHERE ast.board_id = ab.id AND ast.is_active = TRUE
           ))
    )
  );
$$;

COMMENT ON FUNCTION public.fn_taxonomy_health_check() IS
  'Returns a complete taxonomy health snapshot: counts, hash, and governance warnings. '
  'Use in CI pipelines and admin dashboards to detect taxonomy drift. '
  'Governance checks surface orphan streams, unmapped regions, and boards without streams.';

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------

-- Read RPCs: available to authenticated users (onboarding flow)
GRANT EXECUTE ON FUNCTION public.fn_get_streams_for_board(TEXT, TEXT)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_subjects_for_stream(UUID, BOOLEAN)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_languages_for_region(TEXT, TEXT)     TO authenticated, service_role;

-- Write/admin RPCs: service_role only
GRANT EXECUTE ON FUNCTION public.fn_deprecate_taxonomy_entity(TEXT, UUID)    TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_taxonomy_health_check()                   TO service_role;

COMMIT;

-- =============================================================================
-- END OF: 20260526000003_phase1a_taxonomy_utility_rpcs.sql
-- =============================================================================
