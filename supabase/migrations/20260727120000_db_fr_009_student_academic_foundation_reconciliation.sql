-- =============================================================================
-- DB-FR-009 — Student Academic Foundation Reconciliation
-- =============================================================================
--
-- Scope: public.fn_create_student_academic_profile(),
--        public.fn_get_student_full_profile(),
--        public.fn_save_student_subjects()
--
-- Full engineering analysis, evidence, and rationale:
--   documents/DB-FR-009_Student_Academic_Foundation_Reconciliation.md
--
-- Summary of findings (see report for full evidence):
--   • fn_create_student_academic_profile(): the taxonomy-resolver call chain
--     passes the canonicalized TEXT input variables (v_canon_country /
--     v_canon_board) to resolver helpers whose certified signatures take the
--     already-resolved UUID identifiers (v_country_id / v_board_id). This is
--     an argument-reference bug introduced when this function's body was
--     rewritten in the Phase 2B "evolution" migration
--     (20260527000003_phase2b_student_academic_rpcs_evolution.sql) — the
--     resolver helpers themselves (fn__phase2_resolve_region_id/_board_id/
--     _stream_id, defined in 20260527000001_phase2_academic_context_apis.sql)
--     are unchanged and are not the defect. Only region_id was surfaced by
--     `supabase db lint`; board_id and stream_id resolution carry the
--     identical defect shape and are corrected together as one issue.
--   • fn_get_student_full_profile() / fn_save_student_subjects(): both read
--     `is_mandatory` from `academic_subjects` (aliased `sub`), but that
--     column has never existed on `academic_subjects` — `is_mandatory` is,
--     and has only ever been, a per-(subject, stream) attribute on
--     `subject_stream_map` (20260526000001_phase1a_academic_taxonomy_
--     infrastructure.sql), because a subject can be mandatory in one stream
--     and elective in another. The certified read pattern already exists
--     elsewhere (fn_get_subjects_for_stream,
--     20260526000003_phase1a_taxonomy_utility_rpcs.sql): LEFT JOIN
--     subject_stream_map on (subject_id, stream_id) and
--     COALESCE(ssm.is_mandatory, FALSE). This migration applies that same
--     certified pattern to both functions, using each student's own
--     stream_id (already resolvable in both functions without any new
--     capability).
--
-- Decision for all three functions: Category A — Reconciled. No signature
-- change, no new capability, no schema change. Only the specific broken
-- statements inside each function body are corrected to use identifiers
-- and joins that already exist and are already certified elsewhere in this
-- schema.
--
-- Replay-safety: CREATE OR REPLACE FUNCTION and COMMENT ON are both
-- idempotent; this migration can be re-run safely. No DROP, no ALTER TABLE,
-- no destructive statement of any kind.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. public.fn_create_student_academic_profile — fix resolver argument bugs
-- -----------------------------------------------------------------------------
-- Signature preserved exactly:
--   (p_country_code TEXT, p_region_code TEXT, p_board_code TEXT,
--    p_stream_code TEXT DEFAULT NULL, p_current_class SMALLINT DEFAULT NULL,
--    p_target_year SMALLINT DEFAULT NULL) RETURNS JSONB
--
-- Changes from the currently-deployed body (all other logic byte-for-byte
-- identical):
--   • fn__phase2_resolve_region_id(v_canon_region, v_canon_country)
--       → fn__phase2_resolve_region_id(v_canon_region, v_country_id)
--   • fn__phase2_resolve_board_id(v_canon_board, v_canon_country)
--       → fn__phase2_resolve_board_id(v_canon_board, v_country_id)
--   • fn__phase2_resolve_stream_id(v_canon_stream, v_canon_board, v_canon_country)
--       → fn__phase2_resolve_stream_id(v_canon_stream, v_board_id, p_current_class)
-- Each corrected call now passes the identifier type the resolver's
-- certified signature actually declares (UUID country/board id in place of
-- the raw TEXT code; SMALLINT class level in place of a TEXT code for the
-- optional third stream-resolver argument), using variables already
-- computed earlier in the same function body.

CREATE OR REPLACE FUNCTION public.fn_create_student_academic_profile(
  p_country_code  TEXT,
  p_region_code   TEXT,
  p_board_code    TEXT,
  p_stream_code   TEXT     DEFAULT NULL,
  p_current_class SMALLINT DEFAULT NULL,
  p_target_year   SMALLINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id         UUID;
  v_country_id      UUID;
  v_region_id       UUID;
  v_board_id        UUID;
  v_stream_id       UUID;
  v_taxonomy_hash   TEXT;
  v_canon_country   TEXT;
  v_canon_region    TEXT;
  v_canon_board     TEXT;
  v_canon_stream    TEXT;
  v_profile_id      UUID;
  v_is_new          BOOLEAN;
  v_completed_at    TIMESTAMPTZ;
BEGIN

  -- ── Auth guard ──────────────────────────────────────────────────────────
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'Authentication required.',
      'code',        'UNAUTHENTICATED'
    );
  END IF;

  -- ── Input validation ────────────────────────────────────────────────────
  IF p_country_code IS NULL OR trim(p_country_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'country_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_region_code IS NULL OR trim(p_region_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'region_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_board_code IS NULL OR trim(p_board_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'board_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_current_class IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'current_class is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_current_class < 1 OR p_current_class > 12 THEN
    RETURN jsonb_build_object(
      'success',       FALSE,
      'rpc',           'fn_create_student_academic_profile',
      'rpc_version',   '2.0.0',
      'error',         format('current_class %s is out of valid range (1–12).', p_current_class),
      'code',          'INVALID_CLASS_LEVEL',
      'current_class', p_current_class
    );
  END IF;

  IF p_target_year IS NOT NULL AND p_target_year < 2024 THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_create_student_academic_profile',
      'rpc_version',  '2.0.0',
      'error',        format('target_year %s is invalid. Must be 2024 or later.', p_target_year),
      'code',         'INVALID_TARGET_YEAR',
      'target_year',  p_target_year
    );
  END IF;

  -- ── Canonicalise inputs ─────────────────────────────────────────────────
  v_canon_country := upper(trim(p_country_code));
  v_canon_region  := upper(trim(p_region_code));
  v_canon_board   := upper(trim(p_board_code));
  v_canon_stream  := CASE
                       WHEN p_stream_code IS NULL OR trim(p_stream_code) = ''
                       THEN NULL
                       ELSE upper(trim(p_stream_code))
                     END;

  -- ── Taxonomy resolution ─────────────────────────────────────────────────
  v_country_id := public.fn__phase2_resolve_country_id(v_canon_country);
  IF v_country_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_create_student_academic_profile',
      'rpc_version',  '2.0.0',
      'error',        format('Country code "%s" is not valid or is inactive.', v_canon_country),
      'code',         'INVALID_COUNTRY_CODE',
      'country_code', v_canon_country
    );
  END IF;

  -- DB-FR-009: pass the resolved country UUID (v_country_id), matching the
  -- certified helper signature fn__phase2_resolve_region_id(TEXT, UUID).
  -- Previously passed v_canon_country (TEXT), which no such overload exists
  -- for.
  v_region_id := public.fn__phase2_resolve_region_id(v_canon_region, v_country_id);
  IF v_region_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_create_student_academic_profile',
      'rpc_version',  '2.0.0',
      'error',        format('Region code "%s" is not valid or is inactive for country "%s".',
                             v_canon_region, v_canon_country),
      'code',         'INVALID_REGION_CODE',
      'region_code',  v_canon_region,
      'country_code', v_canon_country
    );
  END IF;

  -- DB-FR-009: pass the resolved country UUID (v_country_id), matching the
  -- certified helper signature fn__phase2_resolve_board_id(TEXT, UUID).
  -- Previously passed v_canon_country (TEXT).
  v_board_id := public.fn__phase2_resolve_board_id(v_canon_board, v_country_id);
  IF v_board_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_create_student_academic_profile',
      'rpc_version',  '2.0.0',
      'error',        format('Board code "%s" is not valid or is inactive for country "%s".',
                             v_canon_board, v_canon_country),
      'code',         'INVALID_BOARD_CODE',
      'board_code',   v_canon_board,
      'country_code', v_canon_country
    );
  END IF;

  IF v_canon_stream IS NOT NULL THEN
    -- DB-FR-009: pass the resolved board UUID (v_board_id) and the numeric
    -- class level (p_current_class), matching the certified helper
    -- signature fn__phase2_resolve_stream_id(TEXT, UUID, SMALLINT).
    -- Previously passed (v_canon_board, v_canon_country) — two TEXT
    -- arguments — for a signature whose 2nd/3rd parameters are UUID/SMALLINT.
    v_stream_id := public.fn__phase2_resolve_stream_id(v_canon_stream, v_board_id, p_current_class);
    IF v_stream_id IS NULL THEN
      RETURN jsonb_build_object(
        'success',      FALSE,
        'rpc',          'fn_create_student_academic_profile',
        'rpc_version',  '2.0.0',
        'error',        format('Stream code "%s" is not valid or is inactive for board "%s".',
                               v_canon_stream, v_canon_board),
        'code',         'INVALID_STREAM_CODE',
        'stream_code',  v_canon_stream,
        'board_code',   v_canon_board
      );
    END IF;
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- ── Is this a new profile? ──────────────────────────────────────────────
  SELECT EXISTS(
    SELECT 1 FROM public.student_academic_profiles
    WHERE auth_user_id = v_user_id
  ) INTO v_is_new;
  v_is_new := NOT v_is_new;

  -- ── UPSERT profile ──────────────────────────────────────────────────────
  -- The live table uses auth_user_id. The unique constraint on auth_user_id
  -- is used as the conflict target. If the constraint name differs in production,
  -- the DO UPDATE path handles it safely via the WHERE auth_user_id = clause.
  INSERT INTO public.student_academic_profiles (
    auth_user_id,
    country_id,   region_id,   board_id,   stream_id,
    country_code, region_code, board_code, stream_code,
    current_class, target_year,
    taxonomy_hash_at_save,
    rpc_version
  )
  VALUES (
    v_user_id,
    v_country_id, v_region_id, v_board_id, v_stream_id,
    v_canon_country, v_canon_region, v_canon_board, v_canon_stream,
    p_current_class, p_target_year,
    v_taxonomy_hash,
    '2.0.0'
  )
  ON CONFLICT (auth_user_id) DO UPDATE SET
    country_id            = EXCLUDED.country_id,
    region_id             = EXCLUDED.region_id,
    board_id              = EXCLUDED.board_id,
    stream_id             = EXCLUDED.stream_id,
    country_code          = EXCLUDED.country_code,
    region_code           = EXCLUDED.region_code,
    board_code            = EXCLUDED.board_code,
    stream_code           = EXCLUDED.stream_code,
    current_class         = EXCLUDED.current_class,
    target_year           = EXCLUDED.target_year,
    taxonomy_hash_at_save = EXCLUDED.taxonomy_hash_at_save,
    rpc_version           = EXCLUDED.rpc_version,
    -- Preserve completion state — profile update does NOT reset completion
    onboarding_completed_at = public.student_academic_profiles.onboarding_completed_at,
    updated_at            = NOW()
  RETURNING id, onboarding_completed_at
  INTO v_profile_id, v_completed_at;

  RETURN jsonb_build_object(
    'success',     TRUE,
    'rpc',         'fn_create_student_academic_profile',
    'rpc_version', '2.0.0',
    'query_meta',  jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
    ),
    'profile_state', jsonb_build_object(
      'country_code',  v_canon_country,
      'region_code',   v_canon_region,
      'board_code',    v_canon_board,
      'stream_code',   v_canon_stream,
      'current_class', p_current_class,
      'target_year',   p_target_year
    ),
    'onboarding_state', jsonb_build_object(
      'is_new_profile', v_is_new,
      'is_complete',    v_completed_at IS NOT NULL,
      'completed_at',   v_completed_at
    ),
    'timestamps', jsonb_build_object(
      'saved_at',              NOW(),
      'taxonomy_hash_at_save', v_taxonomy_hash
    )
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'Profile save failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_create_student_academic_profile(TEXT, TEXT, TEXT, TEXT, SMALLINT, SMALLINT) IS
  'Phase 2B Evolution: create or update the onboarding academic profile. '
  'UPSERT via auth_user_id (canonical live column). '
  'Writes all evolved columns (country_code, region_code, board_code, stream_code, '
  'target_year, taxonomy_hash_at_save, rpc_version). '
  'Completion state preserved on update. Never exposes internal UUIDs. '
  'DB-FR-009: region/board/stream taxonomy resolver calls corrected to pass '
  'the resolved UUID identifiers (v_country_id/v_board_id) and numeric class '
  'level the certified resolver signatures require, in place of raw TEXT '
  'codes that were being passed by mistake. No other behavior changed. '
  'VOLATILE. SECURITY DEFINER. auth.uid() required.';

-- -----------------------------------------------------------------------------
-- 2. public.fn_get_student_full_profile — fix is_mandatory column reference
-- -----------------------------------------------------------------------------
-- Signature preserved exactly: () RETURNS JSONB
--
-- Change: read is_mandatory from subject_stream_map (the only table that has
-- ever had this column), scoped to the student's own stream_id (now also
-- selected from student_academic_profiles), instead of from academic_subjects
-- (which has never had an is_mandatory column). Join pattern matches the
-- certified fn_get_subjects_for_stream implementation
-- (20260526000003_phase1a_taxonomy_utility_rpcs.sql).

CREATE OR REPLACE FUNCTION public.fn_get_student_full_profile()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id        UUID;
  v_taxonomy_hash  TEXT;
  v_profile        RECORD;
  v_subjects       JSONB;
  v_languages      JSONB;
  v_subject_count  INTEGER;
  v_language_count INTEGER;
BEGIN

  -- ── Auth guard ──────────────────────────────────────────────────────────
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_student_full_profile',
      'rpc_version', '2.0.0',
      'error',       'Authentication required.',
      'code',        'UNAUTHENTICATED'
    );
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- ── Read profile (using auth_user_id) ───────────────────────────────────
  -- DB-FR-009: sap.stream_id added to the projection. It is already a live
  -- column on student_academic_profiles (written by
  -- fn_create_student_academic_profile) and is needed below to scope the
  -- is_mandatory lookup per the certified subject_stream_map pattern.
  SELECT
    sap.id                     AS profile_id,
    sap.stream_id              AS stream_id,
    sap.country_code,
    sap.region_code,
    sap.board_code,
    sap.stream_code,
    sap.current_class,
    sap.target_year,
    sap.onboarding_completed_at,
    sap.taxonomy_hash_at_save,
    sap.created_at,
    sap.updated_at
  INTO v_profile
  FROM public.student_academic_profiles sap
  WHERE sap.auth_user_id = v_user_id;

  -- No profile yet — valid onboarding state, not an error
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success',     TRUE,
      'rpc',         'fn_get_student_full_profile',
      'rpc_version', '2.0.0',
      'query_meta',  jsonb_build_object(
        'executed_at',    NOW(),
        'taxonomy_hash',  v_taxonomy_hash,
        'correlation_id', NULL::TEXT,
        'request_id',     NULL::TEXT
      ),
      'profile',          NULL,
      'subjects',         '[]'::jsonb,
      'languages',        '[]'::jsonb,
      'onboarding_state', jsonb_build_object(
        'profile_exists', FALSE,
        'is_complete',    FALSE,
        'completed_at',   NULL
      )
    );
  END IF;

  -- ── Read subjects via student_profile_id join ────────────────────────────
  -- Supports both old rows (no user_id) and new rows (user_id populated).
  -- DB-FR-009: is_mandatory now sourced from subject_stream_map (ssm),
  -- LEFT JOINed on (subject_id, stream_id = the student's own stream),
  -- matching the certified fn_get_subjects_for_stream pattern. academic_subjects
  -- (sub) has never had an is_mandatory column; sub.is_optional (unchanged,
  -- unused here) remains the only subject-level flag on that table.
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'code',          sss.subject_code,
          'name',          sub.subject_name,
          'category',      sub.subject_category,
          'is_mandatory',  COALESCE(ssm.is_mandatory, FALSE),
          'is_language',   sub.is_language,
          'is_integrated', sub.is_integrated,
          'sort_order',    sss.sort_order
        )
        ORDER BY sss.sort_order ASC, sss.subject_code ASC
      ),
      '[]'::jsonb
    ),
    COUNT(*)::INTEGER
  INTO v_subjects, v_subject_count
  FROM public.student_subject_selections sss
  JOIN public.academic_subjects sub ON sub.id = sss.subject_id
  LEFT JOIN public.subject_stream_map ssm
    ON  ssm.subject_id = sub.id
    AND ssm.stream_id  = v_profile.stream_id
    AND ssm.is_active  = TRUE
  WHERE sss.student_profile_id = v_profile.profile_id
    AND sub.is_active = TRUE
    AND sss.subject_code IS NOT NULL;

  -- ── Read languages via student_profile_id join ───────────────────────────
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'code',       slp.language_code,
          'name',       lang.language_name,
          'sort_order', slp.sort_order
        )
        ORDER BY slp.sort_order ASC, slp.language_code ASC
      ),
      '[]'::jsonb
    ),
    COUNT(*)::INTEGER
  INTO v_languages, v_language_count
  FROM public.student_language_preferences slp
  JOIN public.academic_languages lang ON lang.id = slp.language_id
  WHERE slp.student_profile_id = v_profile.profile_id
    AND lang.is_active = TRUE
    AND slp.language_code IS NOT NULL;

  RETURN jsonb_build_object(
    'success',     TRUE,
    'rpc',         'fn_get_student_full_profile',
    'rpc_version', '2.0.0',
    'query_meta',  jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
    ),
    'profile', jsonb_build_object(
      'country_code',          v_profile.country_code,
      'region_code',           v_profile.region_code,
      'board_code',            v_profile.board_code,
      'stream_code',           v_profile.stream_code,
      'current_class',         v_profile.current_class,
      'target_year',           v_profile.target_year,
      'taxonomy_hash_at_save', v_profile.taxonomy_hash_at_save,
      'created_at',            v_profile.created_at,
      'updated_at',            v_profile.updated_at
    ),
    'subjects',         v_subjects,
    'subject_count',    v_subject_count,
    'languages',        v_languages,
    'language_count',   v_language_count,
    'onboarding_state', jsonb_build_object(
      'profile_exists', TRUE,
      'is_complete',    v_profile.onboarding_completed_at IS NOT NULL,
      'completed_at',   v_profile.onboarding_completed_at
    )
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_student_full_profile',
      'rpc_version', '2.0.0',
      'error',       'Profile read failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_get_student_full_profile() IS
  'Phase 2B Evolution: read complete onboarding state for auth.uid(). '
  'Uses auth_user_id (live canonical column) for profile lookup. '
  'Uses student_profile_id for subject/language lookups (legacy-safe). '
  'DB-FR-009: is_mandatory sourced from subject_stream_map (LEFT JOIN on '
  'subject_id + the student''s own stream_id), matching the certified '
  'fn_get_subjects_for_stream pattern, since academic_subjects has never '
  'had an is_mandatory column. No other behavior changed. '
  'STABLE. PARALLEL SAFE. SECURITY DEFINER. auth.uid() required.';

-- -----------------------------------------------------------------------------
-- 3. public.fn_save_student_subjects — fix is_mandatory column reference
-- -----------------------------------------------------------------------------
-- Signature preserved exactly: (p_subject_codes TEXT[]) RETURNS JSONB
--
-- Change: identical fix to #2 above, applied to this function's return
-- payload query. v_stream_id is already fetched earlier in this function
-- body (profile existence check) — no new lookup is introduced.

CREATE OR REPLACE FUNCTION public.fn_save_student_subjects(
  p_subject_codes TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id         UUID;
  v_profile_id      UUID;
  v_stream_id       UUID;
  v_taxonomy_hash   TEXT;
  v_invalid_codes   TEXT[];
  v_invalid_stream  TEXT[];
  v_subject_rows    JSONB;
  v_subject_count   INTEGER;
  v_canon_codes     TEXT[];
  v_code            TEXT;
  v_i               INTEGER;
BEGIN

  -- ── Auth guard ──────────────────────────────────────────────────────────
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_subjects',
      'rpc_version', '2.0.0',
      'error',       'Authentication required.',
      'code',        'UNAUTHENTICATED'
    );
  END IF;

  -- ── Input validation ────────────────────────────────────────────────────
  IF p_subject_codes IS NULL OR array_length(p_subject_codes, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_subjects',
      'rpc_version', '2.0.0',
      'error',       'subject_codes must be a non-empty array.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT upper(trim(c))
    FROM unnest(p_subject_codes) c
    WHERE trim(c) <> ''
    ORDER BY 1
  ) INTO v_canon_codes;

  IF array_length(v_canon_codes, 1) IS NULL OR array_length(v_canon_codes, 1) = 0 THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_subjects',
      'rpc_version', '2.0.0',
      'error',       'subject_codes must contain at least one non-blank code.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  -- ── Profile existence check (auth_user_id) ──────────────────────────────
  SELECT id, stream_id
  INTO v_profile_id, v_stream_id
  FROM public.student_academic_profiles
  WHERE auth_user_id = v_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_subjects',
      'rpc_version', '2.0.0',
      'error',       'No academic profile found. Create a profile first via fn_create_student_academic_profile().',
      'code',        'PROFILE_NOT_FOUND'
    );
  END IF;

  -- ── Validate all subject codes exist in taxonomy ────────────────────────
  SELECT ARRAY(
    SELECT c
    FROM unnest(v_canon_codes) c
    WHERE NOT EXISTS (
      SELECT 1 FROM public.academic_subjects sub
      WHERE sub.subject_code = c
        AND sub.is_active    = TRUE
        AND sub.deprecated_at IS NULL
    )
    ORDER BY 1
  ) INTO v_invalid_codes;

  IF array_length(v_invalid_codes, 1) IS NOT NULL AND array_length(v_invalid_codes, 1) > 0 THEN
    RETURN jsonb_build_object(
      'success',       FALSE,
      'rpc',           'fn_save_student_subjects',
      'rpc_version',   '2.0.0',
      'error',         format('Invalid or inactive subject codes: %s',
                              array_to_string(v_invalid_codes, ', ')),
      'code',          'INVALID_SUBJECT_CODES',
      'invalid_codes', to_jsonb(v_invalid_codes)
    );
  END IF;

  -- ── Stream membership validation ────────────────────────────────────────
  IF v_stream_id IS NOT NULL THEN
    SELECT ARRAY(
      SELECT c
      FROM unnest(v_canon_codes) c
      JOIN public.academic_subjects sub ON sub.subject_code = c AND sub.is_active
      WHERE sub.is_integrated = FALSE
        AND NOT EXISTS (
          SELECT 1
          FROM public.subject_stream_map ssm
          WHERE ssm.stream_id  = v_stream_id
            AND ssm.subject_id = sub.id
            AND ssm.is_active  = TRUE
        )
      ORDER BY 1
    ) INTO v_invalid_stream;

    IF array_length(v_invalid_stream, 1) IS NOT NULL AND array_length(v_invalid_stream, 1) > 0 THEN
      RETURN jsonb_build_object(
        'success',       FALSE,
        'rpc',           'fn_save_student_subjects',
        'rpc_version',   '2.0.0',
        'error',         format('Subject codes not available for your stream: %s',
                                array_to_string(v_invalid_stream, ', ')),
        'code',          'SUBJECTS_NOT_IN_STREAM',
        'invalid_codes', to_jsonb(v_invalid_stream)
      );
    END IF;
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- ── Atomic replacement ──────────────────────────────────────────────────
  -- Delete via student_profile_id (legacy-safe; covers rows with and without user_id)
  DELETE FROM public.student_subject_selections
  WHERE student_profile_id = v_profile_id;

  v_i := 0;
  FOREACH v_code IN ARRAY v_canon_codes LOOP
    INSERT INTO public.student_subject_selections (
      student_profile_id,
      user_id,
      subject_id,
      subject_code,
      sort_order,
      taxonomy_hash_at_save
    )
    SELECT
      v_profile_id,
      v_user_id,
      sub.id,
      sub.subject_code,
      v_i,
      v_taxonomy_hash
    FROM public.academic_subjects sub
    WHERE sub.subject_code = v_code AND sub.is_active;

    v_i := v_i + 1;
  END LOOP;

  -- ── Build return payload ────────────────────────────────────────────────
  -- DB-FR-009: is_mandatory now sourced from subject_stream_map (ssm),
  -- LEFT JOINed on (subject_id, stream_id = v_stream_id, already fetched
  -- above during the profile existence check), matching the certified
  -- fn_get_subjects_for_stream pattern.
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'code',          sss.subject_code,
          'name',          sub.subject_name,
          'category',      sub.subject_category,
          'is_mandatory',  COALESCE(ssm.is_mandatory, FALSE),
          'is_language',   sub.is_language,
          'is_integrated', sub.is_integrated,
          'sort_order',    sss.sort_order
        )
        ORDER BY sss.sort_order ASC, sss.subject_code ASC
      ),
      '[]'::jsonb
    ),
    COUNT(*)::INTEGER
  INTO v_subject_rows, v_subject_count
  FROM public.student_subject_selections sss
  JOIN public.academic_subjects sub ON sub.id = sss.subject_id
  LEFT JOIN public.subject_stream_map ssm
    ON  ssm.subject_id = sub.id
    AND ssm.stream_id  = v_stream_id
    AND ssm.is_active  = TRUE
  WHERE sss.student_profile_id = v_profile_id;

  RETURN jsonb_build_object(
    'success',       TRUE,
    'rpc',           'fn_save_student_subjects',
    'rpc_version',   '2.0.0',
    'query_meta',    jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
    ),
    'subjects',      v_subject_rows,
    'subject_count', v_subject_count,
    'updated_at',    NOW()
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_subjects',
      'rpc_version', '2.0.0',
      'error',       'Subject save failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_save_student_subjects(TEXT[]) IS
  'Phase 2B Evolution: atomically replace student subject selections. '
  'Profile lookup via auth_user_id. DELETE/INSERT via student_profile_id (legacy-safe). '
  'New rows write both student_profile_id AND user_id. '
  'DB-FR-009: is_mandatory sourced from subject_stream_map (LEFT JOIN on '
  'subject_id + the student''s own stream_id), matching the certified '
  'fn_get_subjects_for_stream pattern, since academic_subjects has never '
  'had an is_mandatory column. No other behavior changed. '
  'VOLATILE. SECURITY DEFINER. auth.uid() required.';

COMMIT;
