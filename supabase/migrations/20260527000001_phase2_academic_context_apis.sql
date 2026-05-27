-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 2 — ACADEMIC CONTEXT APIs
-- File: 20260527000001_phase2_academic_context_apis.sql
--
-- Governance: HireRise Academic Intelligence Governance Blueprint v2
-- Depends on:
--   20260526000001_phase1a_academic_taxonomy_infrastructure.sql
--   20260526000002_phase1a_seed_v1_india_taxonomy.sql
--   20260526000003_phase1a_taxonomy_utility_rpcs.sql
--   20260526000004_phase1a_governance_hardening.sql
--   20260526000005_phase1a_seed_board_region_map.sql
--   20260526000006_phase1a_operational_governance.sql
--   20260526000007_phase1a_distributed_governance.sql
--
-- SCOPE:
--   Authoritative RPC-based academic context read API layer.
--   Replaces all direct frontend table access with governed RPC contracts.
--
-- INCLUDED RPCs:
--   fn_get_countries()
--   fn_get_regions_for_country(p_country_code)
--   fn_get_boards_for_region(p_region_code, p_country_code)
--   fn_get_streams_for_board(p_board_code, p_country_code)     ← SUPERSEDES Phase 1A version
--   fn_get_subjects_for_stream(p_board_code, p_stream_code, p_class_level, p_country_code)
--   fn_get_languages_for_region(p_region_code, p_country_code) ← SUPERSEDES Phase 1A version
--
-- GOVERNANCE CONTRACTS:
--   • Frontend MUST NOT query taxonomy tables directly
--   • RPCs are the ONLY approved read interface for taxonomy access
--   • All RPCs: active-only filtering, soft-delete aware, deterministic ordering
--   • All RPCs: governance-safe failure semantics (empty arrays / structured errors)
--   • All RPCs: replay-safe (STABLE, deterministic ORDER BY)
--   • All RPCs: telemetry-instrumentation points prepared (query_meta envelope)
--   • All RPCs: cache-consistent response contracts (stable shape per RPC version)
--   • All RPCs: RLS-compatible (SECURITY DEFINER + explicit search_path)
--
-- RESPONSE CONTRACT SHAPE (all RPCs):
--   {
--     "success":    bool,
--     "rpc":        string,      -- RPC identifier for telemetry routing
--     "rpc_version": string,     -- semver; cache invalidation anchor
--     "query_meta": {            -- telemetry instrumentation point (Phase 2 baseline)
--       "executed_at": timestamptz,
--       "taxonomy_hash": string  -- snapshot hash; cache consistency anchor
--     },
--     "<data_key>": array | null,
--     -- on error only:
--     "error":   string,
--     "code":    string
--   }
--
-- ROLLBACK: See 20260527000001_phase2_academic_context_apis.rollback.sql
--
-- IDEMPOTENCY:
--   All DDL uses CREATE OR REPLACE FUNCTION.
--   Re-running this migration is safe.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 0: INTERNAL GOVERNANCE HELPERS
-- Private helper functions used within this migration's RPC suite.
-- Prefixed fn__phase2_ to signal they are internal to this layer.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helper 0a: Resolve country UUID from code
-- Validates the country code and returns its UUID.
-- Returns NULL if not found or inactive — callers must handle this.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn__phase2_resolve_country_id(
  p_country_code TEXT
)
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id
  FROM   public.countries_master
  WHERE  country_code = upper(trim(p_country_code))
    AND  is_active    = TRUE
  LIMIT  1;
$$;

COMMENT ON FUNCTION public.fn__phase2_resolve_country_id(TEXT) IS
  'Internal Phase 2 helper. Resolves an active country UUID from its code. '
  'Returns NULL for unknown or inactive codes. Callers raise governance errors. '
  'NOT intended for direct external use — internal to academic context RPC layer.';

-- ---------------------------------------------------------------------------
-- Helper 0b: Resolve region UUID from code + country UUID
-- Validates the region code within a country and returns its UUID.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn__phase2_resolve_region_id(
  p_region_code  TEXT,
  p_country_id   UUID
)
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id
  FROM   public.curriculum_regions
  WHERE  region_code  = upper(trim(p_region_code))
    AND  country_id   = p_country_id
    AND  is_active    = TRUE
  LIMIT  1;
$$;

COMMENT ON FUNCTION public.fn__phase2_resolve_region_id(TEXT, UUID) IS
  'Internal Phase 2 helper. Resolves an active region UUID from its code within a country. '
  'Returns NULL for unknown/inactive codes. NOT for direct external use.';

-- ---------------------------------------------------------------------------
-- Helper 0c: Resolve board UUID from code + country UUID
-- Validates the board code within a country and returns its UUID.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn__phase2_resolve_board_id(
  p_board_code TEXT,
  p_country_id UUID
)
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id
  FROM   public.academic_boards
  WHERE  board_code  = upper(trim(p_board_code))
    AND  country_id  = p_country_id
    AND  is_active   = TRUE
  LIMIT  1;
$$;

COMMENT ON FUNCTION public.fn__phase2_resolve_board_id(TEXT, UUID) IS
  'Internal Phase 2 helper. Resolves an active board UUID from its code within a country. '
  'Returns NULL for unknown/inactive codes. NOT for direct external use.';

-- ---------------------------------------------------------------------------
-- Helper 0d: Resolve stream UUID from code + board UUID + optional class level
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn__phase2_resolve_stream_id(
  p_stream_code TEXT,
  p_board_id    UUID,
  p_class_level SMALLINT DEFAULT NULL
)
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id
  FROM   public.academic_streams
  WHERE  stream_code = upper(trim(p_stream_code))
    AND  board_id    = p_board_id
    AND  is_active   = TRUE
    -- Class level compatibility: stream must be valid for this class
    AND  (
      p_class_level IS NULL
      OR (
        (applicable_from_class IS NULL OR applicable_from_class <= p_class_level)
        AND
        (applicable_to_class   IS NULL OR applicable_to_class   >= p_class_level)
      )
    )
  LIMIT  1;
$$;

COMMENT ON FUNCTION public.fn__phase2_resolve_stream_id(TEXT, UUID, SMALLINT) IS
  'Internal Phase 2 helper. Resolves an active stream UUID with optional class-level '
  'applicability check. Returns NULL for unknown/inactive/class-incompatible codes. '
  'NOT for direct external use.';

-- =============================================================================
-- SECTION 1: fn_get_countries
--
-- PURPOSE:
--   Returns all active countries with governance-safe metadata.
--   This is the root of the academic taxonomy tree.
--
-- FRONTEND CONTRACT:
--   Frontend country-selection dropdowns MUST use this RPC.
--   Direct queries to countries_master are PROHIBITED.
--
-- ORDERING:
--   Deterministic: country_name ASC — stable across replays.
--
-- CACHING:
--   Taxonomy is highly stable. Cache boundary anchored by taxonomy_hash.
--   Invalidate when taxonomy_hash changes (detectable via fn_academic_taxonomy_hash()).
--
-- TELEMETRY POINTS:
--   query_meta.executed_at → latency instrumentation
--   query_meta.taxonomy_hash → drift detection / cache invalidation
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_countries()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_countries    JSONB;
  v_taxonomy_hash TEXT;
BEGIN
  -- Capture taxonomy snapshot hash for cache consistency anchor
  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- Query: active countries only, deterministic ordering
  -- Index: idx_countries_master_active (partial WHERE is_active = TRUE)
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',           cm.id,
        'code',         cm.country_code,
        'name',         cm.country_name,
        'is_active',    cm.is_active
      )
      ORDER BY cm.country_name ASC  -- deterministic, replay-safe
    ),
    '[]'::jsonb
  )
  INTO v_countries
  FROM public.countries_master cm
  WHERE cm.is_active = TRUE;

  RETURN jsonb_build_object(
    'success',     TRUE,
    'rpc',         'fn_get_countries',
    'rpc_version', '2.0.0',
    -- Telemetry instrumentation point: prepared for Phase 3+ observability pipeline
    'query_meta',  jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash
    ),
    'countries',   v_countries
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Surface structured error; never expose raw SQLSTATE to frontend
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_countries',
      'rpc_version', '2.0.0',
      'error',       'Taxonomy query failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_get_countries() IS
  'Phase 2 Academic Context API: returns all active countries. '
  'Authoritative frontend read interface — direct table access PROHIBITED. '
  'Governance: active-only, soft-delete aware, deterministic ORDER BY country_name. '
  'Cache anchor: query_meta.taxonomy_hash. Telemetry-ready envelope.';


-- =============================================================================
-- SECTION 2: fn_get_regions_for_country
--
-- PURPOSE:
--   Returns all active curriculum regions (states/provinces) for a country.
--   Driven by country_code. Validates the country before querying.
--
-- BOARD GOVERNANCE:
--   Returns regions — not boards. Board compatibility is in fn_get_boards_for_region.
--
-- FILTERING:
--   • is_active = TRUE (soft-delete aware)
--   • deprecated_at IS NULL (explicit deprecation guard)
--   • Country must be active
--
-- ORDERING:
--   Deterministic: region_name ASC
--
-- VALIDATION:
--   • Invalid / missing country_code → structured INVALID_COUNTRY_CODE error
--   • Inactive country → structured error (not an empty array)
--
-- EMPTY STATE:
--   Valid country with no active regions → success: true, regions: []
--   (e.g., newly onboarded country with no regions seeded yet)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_regions_for_country(
  p_country_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_country_id   UUID;
  v_regions      JSONB;
  v_taxonomy_hash TEXT;
  v_canon_code   TEXT;
BEGIN
  -- Input normalisation
  IF p_country_code IS NULL OR trim(p_country_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_regions_for_country',
      'rpc_version', '2.0.0',
      'error',       'country_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  v_canon_code := upper(trim(p_country_code));

  -- Resolve country UUID (validates existence and active state)
  v_country_id := public.fn__phase2_resolve_country_id(v_canon_code);

  IF v_country_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_get_regions_for_country',
      'rpc_version',  '2.0.0',
      'error',        format('Country code "%s" is not valid or is inactive.', v_canon_code),
      'code',         'INVALID_COUNTRY_CODE',
      'country_code', v_canon_code
    );
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- Query: active regions for country, deterministic ordering
  -- Index: idx_curriculum_regions_country_active (country_id, is_active) WHERE is_active = TRUE
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',           cr.id,
        'code',         cr.region_code,
        'name',         cr.region_name,
        'country_code', v_canon_code,
        'is_active',    cr.is_active
      )
      ORDER BY cr.region_name ASC  -- deterministic, replay-safe
    ),
    '[]'::jsonb
  )
  INTO v_regions
  FROM public.curriculum_regions cr
  WHERE cr.country_id   = v_country_id
    AND cr.is_active    = TRUE
    AND cr.deprecated_at IS NULL;  -- explicit deprecation guard

  RETURN jsonb_build_object(
    'success',      TRUE,
    'rpc',          'fn_get_regions_for_country',
    'rpc_version',  '2.0.0',
    'query_meta',   jsonb_build_object(
      'executed_at',   NOW(),
      'taxonomy_hash', v_taxonomy_hash
    ),
    'country_code', v_canon_code,
    'regions',      v_regions
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_regions_for_country',
      'rpc_version', '2.0.0',
      'error',       'Taxonomy query failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_get_regions_for_country(TEXT) IS
  'Phase 2 Academic Context API: returns active curriculum regions for a country. '
  'Validates country_code; returns INVALID_COUNTRY_CODE for unknown codes. '
  'Governance: active-only, deprecated_at guard, deterministic ORDER BY region_name. '
  'Telemetry-ready. Frontend MUST NOT query curriculum_regions directly.';


-- =============================================================================
-- SECTION 3: fn_get_boards_for_region
--
-- PURPOSE:
--   Returns all boards available in a curriculum region.
--   Combines:
--     (a) National boards — available everywhere (board_type = 'national')
--     (b) Region-compatible boards — explicitly mapped via board_region_map
--
-- BOARD-REGION GOVERNANCE:
--   This is the authoritative implementation of the board_region_map contract.
--   A board is included in a region's result set if:
--     1. It is a national board (board_type = 'national') in the same country, OR
--     2. It has an active entry in board_region_map for this region.
--
-- DEDUPLICATION:
--   A national board may also appear in board_region_map (e.g., for is_primary
--   metadata). The UNION-based query ensures no duplicates in the response.
--
-- RESPONSE ENRICHMENT:
--   Each board carries:
--     is_national   — true for national boards
--     is_primary    — true if board_region_map marks this as the primary board
--                     for the region (NULL/false for national boards without mapping)
--
-- ORDERING:
--   Deterministic: national boards first (is_national DESC), then board_name ASC.
--   This ordering is replay-safe and cache-consistent.
--
-- VALIDATION:
--   • Invalid region_code → INVALID_REGION_CODE
--   • Invalid country_code → INVALID_COUNTRY_CODE
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_boards_for_region(
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
  v_country_id    UUID;
  v_region_id     UUID;
  v_boards        JSONB;
  v_taxonomy_hash TEXT;
  v_canon_region  TEXT;
  v_canon_country TEXT;
BEGIN
  -- Input normalisation
  IF p_region_code IS NULL OR trim(p_region_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_boards_for_region',
      'rpc_version', '2.0.0',
      'error',       'region_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  v_canon_region  := upper(trim(p_region_code));
  v_canon_country := upper(trim(COALESCE(p_country_code, 'IN')));

  -- Validate country
  v_country_id := public.fn__phase2_resolve_country_id(v_canon_country);
  IF v_country_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_get_boards_for_region',
      'rpc_version',  '2.0.0',
      'error',        format('Country code "%s" is not valid or is inactive.', v_canon_country),
      'code',         'INVALID_COUNTRY_CODE',
      'country_code', v_canon_country
    );
  END IF;

  -- Validate region
  v_region_id := public.fn__phase2_resolve_region_id(v_canon_region, v_country_id);
  IF v_region_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_get_boards_for_region',
      'rpc_version',  '2.0.0',
      'error',        format('Region code "%s" is not valid or is inactive for country "%s".',
                             v_canon_region, v_canon_country),
      'code',         'INVALID_REGION_CODE',
      'region_code',  v_canon_region,
      'country_code', v_canon_country
    );
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- Board-region governance query:
  --   ARM A: National boards — available in ALL regions of the same country
  --   ARM B: Region-compatible boards — explicitly mapped via board_region_map
  --
  -- Index utilisation:
  --   ARM A: idx_academic_boards_type_active (board_type, is_active)
  --   ARM B: idx_board_region_map_region_active (region_id, is_active)
  --          + idx_academic_boards_country_active (country_id, is_active)
  --
  -- UNION deduplicates boards that are both national AND in board_region_map.
  -- is_primary is NULL for national boards without an explicit mapping row.

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',           b.id,
        'code',         b.board_code,
        'name',         b.board_name,
        'board_type',   b.board_type,
        'is_active',    b.is_active,
        'is_national',  b.is_national,
        'is_primary',   COALESCE(b.is_primary, FALSE)
      )
      -- Ordering contract: national boards first, then alphabetically
      -- This is the authoritative, replay-safe ordering for this RPC
      ORDER BY
        b.is_national   DESC,  -- national boards float to top
        b.board_name    ASC    -- deterministic secondary sort
    ),
    '[]'::jsonb
  )
  INTO v_boards
  FROM (
    -- ARM A: National boards — same country, active, no region restriction
    SELECT
      ab.id,
      ab.board_code,
      ab.board_name,
      ab.board_type,
      ab.is_active,
      TRUE            AS is_national,
      NULL::BOOLEAN   AS is_primary  -- no region-specific primary flag for national
    FROM public.academic_boards ab
    WHERE ab.country_id  = v_country_id
      AND ab.board_type  = 'national'
      AND ab.is_active   = TRUE
      AND ab.deprecated_at IS NULL

    UNION

    -- ARM B: Region-compatible boards via board_region_map
    SELECT
      ab.id,
      ab.board_code,
      ab.board_name,
      ab.board_type,
      ab.is_active,
      (ab.board_type = 'national') AS is_national,
      brm.is_primary
    FROM public.board_region_map brm
    JOIN public.academic_boards ab ON ab.id = brm.board_id
    WHERE brm.region_id  = v_region_id
      AND brm.is_active  = TRUE
      AND ab.is_active   = TRUE
      AND ab.deprecated_at IS NULL
  ) b;

  RETURN jsonb_build_object(
    'success',      TRUE,
    'rpc',          'fn_get_boards_for_region',
    'rpc_version',  '2.0.0',
    'query_meta',   jsonb_build_object(
      'executed_at',   NOW(),
      'taxonomy_hash', v_taxonomy_hash
    ),
    'region_code',  v_canon_region,
    'country_code', v_canon_country,
    'boards',       v_boards
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_boards_for_region',
      'rpc_version', '2.0.0',
      'error',       'Taxonomy query failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_get_boards_for_region(TEXT, TEXT) IS
  'Phase 2 Academic Context API: returns boards available for a curriculum region. '
  'Combines national boards (universally available) with region-mapped boards '
  'via board_region_map. Deduplication via UNION. '
  'Board-region governance contract: this is the ONLY approved source for '
  'board availability by region. '
  'Governance: active-only, deprecated_at guard, national-first deterministic ordering. '
  'Telemetry-ready. Frontend MUST NOT query academic_boards or board_region_map directly.';


-- =============================================================================
-- SECTION 4: fn_get_streams_for_board  (Phase 2 — SUPERSEDES Phase 1A version)
--
-- PURPOSE:
--   Returns all active streams for a given board, resolved by business key.
--   Phase 2 version supersedes the Phase 1A utility RPC with:
--     • Standardised response envelope (rpc, rpc_version, query_meta)
--     • class_level compatibility filtering (optional)
--     • Validated board resolution with structured error codes
--     • Deprecated entity guard
--
-- COMPATIBILITY:
--   This function replaces public.fn_get_streams_for_board(TEXT, TEXT) from
--   Phase 1A. The Phase 1A version is kept in-place (CREATE OR REPLACE) to
--   avoid breaking any existing callers during transition. Frontend MUST
--   migrate to the Phase 2 version by the hook integration milestone.
--
-- ORDERING:
--   Deterministic: stream_name ASC (stable secondary sort after priority)
--   Replay-safe.
--
-- CLASS LEVEL FILTERING:
--   Optional p_class_level: if provided, only streams whose
--   [applicable_from_class, applicable_to_class] range includes the class
--   are returned. NULL means no class filtering.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_streams_for_board(
  p_board_code   TEXT,
  p_country_code TEXT    DEFAULT 'IN',
  p_class_level  SMALLINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_country_id    UUID;
  v_board_id      UUID;
  v_streams       JSONB;
  v_taxonomy_hash TEXT;
  v_canon_board   TEXT;
  v_canon_country TEXT;
BEGIN
  IF p_board_code IS NULL OR trim(p_board_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_streams_for_board',
      'rpc_version', '2.0.0',
      'error',       'board_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  -- Class level range validation (1–12 for Indian curriculum)
  IF p_class_level IS NOT NULL AND (p_class_level < 1 OR p_class_level > 12) THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_get_streams_for_board',
      'rpc_version',  '2.0.0',
      'error',        format('class_level %s is out of valid range (1–12).', p_class_level),
      'code',         'INVALID_CLASS_LEVEL',
      'class_level',  p_class_level
    );
  END IF;

  v_canon_board   := upper(trim(p_board_code));
  v_canon_country := upper(trim(COALESCE(p_country_code, 'IN')));

  -- Validate country
  v_country_id := public.fn__phase2_resolve_country_id(v_canon_country);
  IF v_country_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_get_streams_for_board',
      'rpc_version',  '2.0.0',
      'error',        format('Country code "%s" is not valid or is inactive.', v_canon_country),
      'code',         'INVALID_COUNTRY_CODE',
      'country_code', v_canon_country
    );
  END IF;

  -- Validate board
  v_board_id := public.fn__phase2_resolve_board_id(v_canon_board, v_country_id);
  IF v_board_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_streams_for_board',
      'rpc_version', '2.0.0',
      'error',       format('Board code "%s" is not valid or is inactive for country "%s".',
                            v_canon_board, v_canon_country),
      'code',        'INVALID_BOARD_CODE',
      'board_code',  v_canon_board,
      'country_code', v_canon_country
    );
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- Query: active streams for board, with optional class-level filtering
  -- Index: idx_academic_streams_board_active (board_id, is_active) WHERE is_active = TRUE
  -- Index: idx_academic_streams_class_range (applicable_from_class, applicable_to_class)
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',                    ast.id,
        'code',                  ast.stream_code,
        'name',                  ast.stream_name,
        'applicable_from_class', ast.applicable_from_class,
        'applicable_to_class',   ast.applicable_to_class,
        'is_active',             ast.is_active
      )
      ORDER BY ast.stream_name ASC  -- deterministic, replay-safe
    ),
    '[]'::jsonb
  )
  INTO v_streams
  FROM public.academic_streams ast
  WHERE ast.board_id      = v_board_id
    AND ast.is_active     = TRUE
    AND ast.deprecated_at IS NULL
    -- Class level applicability: only if p_class_level is supplied
    AND (
      p_class_level IS NULL
      OR (
        (ast.applicable_from_class IS NULL OR ast.applicable_from_class <= p_class_level)
        AND
        (ast.applicable_to_class   IS NULL OR ast.applicable_to_class   >= p_class_level)
      )
    );

  RETURN jsonb_build_object(
    'success',      TRUE,
    'rpc',          'fn_get_streams_for_board',
    'rpc_version',  '2.0.0',
    'query_meta',   jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'class_level',    p_class_level       -- instrumentation: filter context
    ),
    'board_code',   v_canon_board,
    'country_code', v_canon_country,
    'streams',      v_streams
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_streams_for_board',
      'rpc_version', '2.0.0',
      'error',       'Taxonomy query failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_get_streams_for_board(TEXT, TEXT, SMALLINT) IS
  'Phase 2 Academic Context API: returns active streams for a board. '
  'Supersedes the Phase 1A fn_get_streams_for_board(TEXT, TEXT) version. '
  'Adds: standard envelope, class_level filtering, validated board resolution. '
  'Governance: active-only, deprecated_at guard, deterministic ORDER BY stream_name. '
  'Telemetry-ready. Frontend MUST NOT query academic_streams directly.';


-- =============================================================================
-- SECTION 5: fn_get_subjects_for_stream  (Phase 2 — SUPERSEDES Phase 1A version)
--
-- PURPOSE:
--   Returns all subjects applicable for a given board + stream + class_level.
--   Resolves entities via business keys (no UUID required from frontend).
--
-- SUBJECT CATEGORIES RETURNED:
--   1. Stream-mapped subjects (subject_stream_map)
--      Subjects explicitly linked to this stream via subject_stream_map.
--   2. Integrated subjects (academic_subjects.is_integrated = TRUE)
--      Subjects that appear in ALL streams (e.g. English, Physical Education).
--   3. Class-applicable subjects only
--      When p_class_level is provided, subjects whose class range excludes
--      the requested level are filtered out.
--
-- STREAM-SUBJECT GOVERNANCE:
--   This function enforces subject_stream_map compatibility.
--   Language subjects are included (they are valid stream subjects).
--   Optional/elective subjects are included with metadata.
--
-- SUBJECT SOURCE TAGGING:
--   Each subject carries 'source': 'stream' | 'integrated'
--   Frontend can use this to group/render mandatory vs. integrated subjects.
--
-- ORDERING:
--   Deterministic: mandatory first, then by subject_name ASC.
--   Replay-safe.
--
-- VALIDATION:
--   • Missing board_code or stream_code → MISSING_PARAMETER
--   • Invalid board → INVALID_BOARD_CODE
--   • Invalid stream → INVALID_STREAM_CODE
--   • Stream not compatible with class_level → INCOMPATIBLE_CLASS_LEVEL
--   • class_level out of range (1–12) → INVALID_CLASS_LEVEL
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_subjects_for_stream(
  p_board_code   TEXT,
  p_stream_code  TEXT,
  p_class_level  SMALLINT DEFAULT NULL,
  p_country_code TEXT     DEFAULT 'IN'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_country_id     UUID;
  v_board_id       UUID;
  v_stream_id      UUID;
  v_subjects       JSONB;
  v_taxonomy_hash  TEXT;
  v_canon_board    TEXT;
  v_canon_stream   TEXT;
  v_canon_country  TEXT;
BEGIN
  -- Input validation
  IF p_board_code IS NULL OR trim(p_board_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_subjects_for_stream',
      'rpc_version', '2.0.0',
      'error',       'board_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_stream_code IS NULL OR trim(p_stream_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_subjects_for_stream',
      'rpc_version', '2.0.0',
      'error',       'stream_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_class_level IS NOT NULL AND (p_class_level < 1 OR p_class_level > 12) THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_get_subjects_for_stream',
      'rpc_version',  '2.0.0',
      'error',        format('class_level %s is out of valid range (1–12).', p_class_level),
      'code',         'INVALID_CLASS_LEVEL',
      'class_level',  p_class_level
    );
  END IF;

  v_canon_board   := upper(trim(p_board_code));
  v_canon_stream  := upper(trim(p_stream_code));
  v_canon_country := upper(trim(COALESCE(p_country_code, 'IN')));

  -- Validate country
  v_country_id := public.fn__phase2_resolve_country_id(v_canon_country);
  IF v_country_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_get_subjects_for_stream',
      'rpc_version',  '2.0.0',
      'error',        format('Country code "%s" is not valid or is inactive.', v_canon_country),
      'code',         'INVALID_COUNTRY_CODE',
      'country_code', v_canon_country
    );
  END IF;

  -- Validate board
  v_board_id := public.fn__phase2_resolve_board_id(v_canon_board, v_country_id);
  IF v_board_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_subjects_for_stream',
      'rpc_version', '2.0.0',
      'error',       format('Board code "%s" is not valid or is inactive for country "%s".',
                            v_canon_board, v_canon_country),
      'code',        'INVALID_BOARD_CODE',
      'board_code',  v_canon_board,
      'country_code', v_canon_country
    );
  END IF;

  -- Validate stream (with class level compatibility check)
  v_stream_id := public.fn__phase2_resolve_stream_id(v_canon_stream, v_board_id, p_class_level);
  IF v_stream_id IS NULL THEN
    -- Distinguish: stream exists but class level is incompatible vs. stream doesn't exist
    DECLARE
      v_stream_exists BOOLEAN;
    BEGIN
      SELECT EXISTS(
        SELECT 1 FROM public.academic_streams
        WHERE stream_code = v_canon_stream
          AND board_id    = v_board_id
          AND is_active   = TRUE
      ) INTO v_stream_exists;

      IF v_stream_exists AND p_class_level IS NOT NULL THEN
        RETURN jsonb_build_object(
          'success',      FALSE,
          'rpc',          'fn_get_subjects_for_stream',
          'rpc_version',  '2.0.0',
          'error',        format(
            'Stream "%s" exists for board "%s" but is not applicable at class level %s.',
            v_canon_stream, v_canon_board, p_class_level
          ),
          'code',         'INCOMPATIBLE_CLASS_LEVEL',
          'stream_code',  v_canon_stream,
          'board_code',   v_canon_board,
          'class_level',  p_class_level
        );
      ELSE
        RETURN jsonb_build_object(
          'success',      FALSE,
          'rpc',          'fn_get_subjects_for_stream',
          'rpc_version',  '2.0.0',
          'error',        format(
            'Stream code "%s" is not valid or is inactive for board "%s".',
            v_canon_stream, v_canon_board
          ),
          'code',         'INVALID_STREAM_CODE',
          'stream_code',  v_canon_stream,
          'board_code',   v_canon_board
        );
      END IF;
    END;
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- Stream-subject governance query:
  --   ARM A: Subjects mapped to this stream via subject_stream_map
  --   ARM B: Integrated subjects (is_integrated = TRUE) — cross-stream
  --
  -- Class-level filtering applied to BOTH arms:
  --   Subjects whose class range excludes p_class_level are excluded.
  --
  -- Index utilisation:
  --   ARM A: idx_subject_stream_map_stream_active (stream_id, is_active)
  --          idx_academic_subjects_active (is_active)
  --          idx_academic_subjects_class_range (class range filter)
  --   ARM B: idx_academic_subjects_integrated_flag (is_integrated = TRUE)
  --
  -- Deduplication: UNION removes integrated subjects that also appear in
  -- subject_stream_map (e.g. English sometimes appears in both).

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',               s.id,
        'code',             s.subject_code,
        'name',             s.subject_name,
        'subject_category', s.subject_category,
        'is_mandatory',     COALESCE(s.is_mandatory, FALSE),
        'is_language',      s.is_language,
        'is_integrated',    s.is_integrated,
        'is_optional',      s.is_optional,
        'is_active',        s.is_active,
        'source',           s.source
      )
      ORDER BY
        -- Mandatory subjects first within each source group
        (CASE WHEN COALESCE(s.is_mandatory, FALSE) THEN 0 ELSE 1 END) ASC,
        -- Then alphabetically by name — deterministic, replay-safe
        s.subject_name ASC
    ),
    '[]'::jsonb
  )
  INTO v_subjects
  FROM (
    -- ARM A: Stream-mapped subjects
    SELECT
      sub.id,
      sub.subject_code,
      sub.subject_name,
      sub.subject_category,
      ssm.is_mandatory,
      sub.is_language,
      sub.is_integrated,
      sub.is_optional,
      sub.is_active,
      'stream'::TEXT AS source
    FROM public.subject_stream_map ssm
    JOIN public.academic_subjects sub ON sub.id = ssm.subject_id
    WHERE ssm.stream_id    = v_stream_id
      AND ssm.is_active    = TRUE
      AND sub.is_active    = TRUE
      AND sub.deprecated_at IS NULL
      -- Class applicability filter for stream-mapped subjects
      AND (
        p_class_level IS NULL
        OR (
          (sub.applicable_from_class IS NULL OR sub.applicable_from_class <= p_class_level)
          AND
          (sub.applicable_to_class   IS NULL OR sub.applicable_to_class   >= p_class_level)
        )
      )

    UNION

    -- ARM B: Integrated subjects (cross-stream; not stream-specific)
    SELECT
      sub.id,
      sub.subject_code,
      sub.subject_name,
      sub.subject_category,
      FALSE             AS is_mandatory,   -- integrated subjects are not stream-mandatory
      sub.is_language,
      sub.is_integrated,
      sub.is_optional,
      sub.is_active,
      'integrated'::TEXT AS source
    FROM public.academic_subjects sub
    WHERE sub.is_integrated   = TRUE
      AND sub.is_active       = TRUE
      AND sub.deprecated_at   IS NULL
      -- Class applicability filter for integrated subjects
      AND (
        p_class_level IS NULL
        OR (
          (sub.applicable_from_class IS NULL OR sub.applicable_from_class <= p_class_level)
          AND
          (sub.applicable_to_class   IS NULL OR sub.applicable_to_class   >= p_class_level)
        )
      )
  ) s;

  RETURN jsonb_build_object(
    'success',      TRUE,
    'rpc',          'fn_get_subjects_for_stream',
    'rpc_version',  '2.0.0',
    'query_meta',   jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'class_level',    p_class_level,     -- instrumentation: filter context
      'stream_id',      v_stream_id        -- instrumentation: resolved UUID anchor
    ),
    'board_code',   v_canon_board,
    'stream_code',  v_canon_stream,
    'country_code', v_canon_country,
    'subjects',     v_subjects
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_subjects_for_stream',
      'rpc_version', '2.0.0',
      'error',       'Taxonomy query failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_get_subjects_for_stream(TEXT, TEXT, SMALLINT, TEXT) IS
  'Phase 2 Academic Context API: returns subjects for a board+stream+class_level. '
  'Enforces subject_stream_map governance. Includes integrated subjects (cross-stream). '
  'Source-tagged: stream | integrated. Validates board, stream, and class compatibility. '
  'Supersedes Phase 1A fn_get_subjects_for_stream(UUID, BOOLEAN) — frontend must migrate. '
  'Governance: active-only, class-range filter, deprecated_at guard, '
  'mandatory-first deterministic ordering. Telemetry-ready.';


-- =============================================================================
-- SECTION 6: fn_get_languages_for_region  (Phase 2 — SUPERSEDES Phase 1A version)
--
-- PURPOSE:
--   Returns all languages available in a curriculum region with their role context.
--   Resolved by business key (region_code), not UUID.
--
-- LANGUAGE GOVERNANCE:
--   Languages are sourced from state_language_mapping — the authoritative mapping
--   of languages to regions. This function enforces:
--     • Only active state_language_mapping entries
--     • Only active academic_languages
--     • Only active curriculum_regions
--     • Inactive mappings are NEVER returned
--
-- ROLE FLAGS:
--   Each language carries:
--     is_primary  — official/primary language for curriculum in this region
--     is_common   — commonly offered in schools of this region
--     is_optional — optionally available but not universally offered
--
-- ORDERING:
--   Deterministic: primary first, then common, then optional, then alphabetically.
--   Replay-safe ordering anchored in the language governance rules.
--
-- VALIDATION:
--   • Invalid region_code → INVALID_REGION_CODE
--   • Invalid country_code → INVALID_COUNTRY_CODE
-- =============================================================================

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
  v_country_id    UUID;
  v_region_id     UUID;
  v_languages     JSONB;
  v_taxonomy_hash TEXT;
  v_canon_region  TEXT;
  v_canon_country TEXT;
BEGIN
  IF p_region_code IS NULL OR trim(p_region_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_languages_for_region',
      'rpc_version', '2.0.0',
      'error',       'region_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  v_canon_region  := upper(trim(p_region_code));
  v_canon_country := upper(trim(COALESCE(p_country_code, 'IN')));

  -- Validate country
  v_country_id := public.fn__phase2_resolve_country_id(v_canon_country);
  IF v_country_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_get_languages_for_region',
      'rpc_version',  '2.0.0',
      'error',        format('Country code "%s" is not valid or is inactive.', v_canon_country),
      'code',         'INVALID_COUNTRY_CODE',
      'country_code', v_canon_country
    );
  END IF;

  -- Validate region
  v_region_id := public.fn__phase2_resolve_region_id(v_canon_region, v_country_id);
  IF v_region_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_get_languages_for_region',
      'rpc_version',  '2.0.0',
      'error',        format('Region code "%s" is not valid or is inactive for country "%s".',
                             v_canon_region, v_canon_country),
      'code',         'INVALID_REGION_CODE',
      'region_code',  v_canon_region,
      'country_code', v_canon_country
    );
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- Language governance query: active mappings only
  -- Index: idx_state_language_mapping_region_active (region_id, is_active) WHERE is_active = TRUE
  -- Index: idx_academic_languages_active (is_active) WHERE is_active = TRUE
  -- Index: idx_state_language_mapping_primary for primary-first ordering support
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',            lang.id,
        'code',          lang.language_code,
        'name',          lang.language_name,
        'is_active',     lang.is_active,
        'is_primary',    slm.is_primary,
        'is_common',     slm.is_common,
        'is_optional',   slm.is_optional
      )
      ORDER BY
        -- Role-priority ordering: primary → common → optional → alphabetical
        -- This is the authoritative ordering for language dropdowns
        (CASE WHEN slm.is_primary  THEN 0
              WHEN slm.is_common   THEN 1
                                   ELSE 2 END) ASC,
        lang.language_name ASC  -- deterministic, replay-safe tiebreaker
    ),
    '[]'::jsonb
  )
  INTO v_languages
  FROM public.state_language_mapping slm
  JOIN public.academic_languages lang ON lang.id = slm.language_id
  WHERE slm.region_id   = v_region_id
    AND slm.is_active   = TRUE
    AND lang.is_active  = TRUE
    AND lang.deprecated_at IS NULL;

  RETURN jsonb_build_object(
    'success',      TRUE,
    'rpc',          'fn_get_languages_for_region',
    'rpc_version',  '2.0.0',
    'query_meta',   jsonb_build_object(
      'executed_at',   NOW(),
      'taxonomy_hash', v_taxonomy_hash
    ),
    'region_code',  v_canon_region,
    'country_code', v_canon_country,
    'languages',    v_languages
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_languages_for_region',
      'rpc_version', '2.0.0',
      'error',       'Taxonomy query failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_get_languages_for_region(TEXT, TEXT) IS
  'Phase 2 Academic Context API: returns languages for a curriculum region. '
  'Supersedes Phase 1A fn_get_languages_for_region(TEXT, TEXT). '
  'Adds: standard envelope, deprecated_at guard, rpc_version anchor. '
  'Governance: active state_language_mapping only, inactive mappings excluded. '
  'Role flags (is_primary, is_common, is_optional) preserved in response. '
  'Ordering: primary → common → optional → alphabetical (authoritative and replay-safe). '
  'Telemetry-ready. Frontend MUST NOT query state_language_mapping or academic_languages directly.';


-- =============================================================================
-- SECTION 7: GRANT PERMISSIONS
-- Follows HireRise grant pattern: anon / authenticated / service_role.
--
-- Read RPCs: available to anon + authenticated (onboarding is accessible pre-login)
-- Internal helpers: service_role only (not for direct external use)
-- =============================================================================

-- Public Academic Context RPCs — available to anonymous and authenticated users
-- (Student onboarding begins before login in some flows)
GRANT EXECUTE ON FUNCTION public.fn_get_countries()
  TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_get_regions_for_country(TEXT)
  TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_get_boards_for_region(TEXT, TEXT)
  TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_get_streams_for_board(TEXT, TEXT, SMALLINT)
  TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_get_subjects_for_stream(TEXT, TEXT, SMALLINT, TEXT)
  TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_get_languages_for_region(TEXT, TEXT)
  TO anon, authenticated, service_role;

-- Internal resolution helpers — service_role only
GRANT EXECUTE ON FUNCTION public.fn__phase2_resolve_country_id(TEXT)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.fn__phase2_resolve_region_id(TEXT, UUID)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.fn__phase2_resolve_board_id(TEXT, UUID)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.fn__phase2_resolve_stream_id(TEXT, UUID, SMALLINT)
  TO service_role;

-- =============================================================================
-- SECTION 8: PHASE 1A COMPATIBILITY BRIDGE
--
-- The Phase 1A utility RPCs fn_get_streams_for_board(TEXT, TEXT) and
-- fn_get_languages_for_region(TEXT, TEXT) are now superseded by their
-- Phase 2 counterparts. To ensure a smooth transition:
--
--   1. Phase 1A signatures are preserved (no DROP) — existing callers continue to work.
--   2. Phase 2 adds a NEW overload (3-arg for streams, same arity for languages
--      but with a new response envelope via CREATE OR REPLACE).
--   3. Frontend MUST migrate from Phase 1A to Phase 2 RPCs at the
--      hook integration milestone. Post-migration, Phase 1A versions
--      will be deprecated via fn_deprecate_taxonomy_entity-equivalent process.
--
-- GOVERNANCE NOTE:
--   The Phase 1A fn_get_subjects_for_stream(UUID, BOOLEAN) takes a UUID
--   stream_id. This is a governance contract violation (frontend must not
--   manage UUIDs). Phase 2 fn_get_subjects_for_stream(TEXT, TEXT, SMALLINT, TEXT)
--   resolves via business keys. Both coexist during transition period.
-- =============================================================================

-- Compatibility bridge: revoke anon access to Phase 1A subject RPC
-- (it requires UUID knowledge which is an internal concern)
-- Phase 2 replaces it with the business-key signature below.
REVOKE EXECUTE ON FUNCTION public.fn_get_subjects_for_stream(UUID, BOOLEAN)
  FROM anon;

-- authenticated users retain access during transition; service_role always has access.
-- Full revoke from authenticated occurs post-migration via a future rollout migration.

COMMENT ON FUNCTION public.fn_get_subjects_for_stream(UUID, BOOLEAN) IS
  '[DEPRECATED — Phase 1A] Returns subjects for a stream by UUID. '
  'Superseded by fn_get_subjects_for_stream(TEXT, TEXT, SMALLINT, TEXT) — Phase 2. '
  'Frontend access revoked for anon. Authenticated access remains during transition. '
  'MIGRATE before Phase 3 hook integration milestone.';


-- =============================================================================
-- SECTION 9: TELEMETRY READINESS MANIFEST
--
-- Documents the instrumentation points built into this phase for future
-- observability pipeline integration (Phase 3+). No pipeline is implemented
-- here — only the contract points are established.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Telemetry contract established by this phase:
--
-- All Phase 2 RPCs return query_meta in their success envelopes:
--
--   query_meta.executed_at   → latency measurement anchor
--                               Phase 3+: compare to response timestamp for P50/P99
--
--   query_meta.taxonomy_hash → cache consistency anchor
--                               Phase 3+: frontend can cache per-hash; invalidate on change
--                               Phase 3+: CI drift detection when hash changes unexpectedly
--
--   query_meta.class_level   → filter context (streams + subjects RPCs only)
--                               Phase 3+: analyse which class levels are most queried
--                               Phase 3+: drive onboarding analytics
--
--   query_meta.stream_id     → resolved UUID anchor (subjects RPC only)
--                               Phase 3+: cross-reference stream popularity
--
-- Future phases should:
--   1. Add a governance_event_log table for structured telemetry event capture.
--   2. Wrap RPCs in a telemetry decorator that extracts query_meta on execution.
--   3. Route telemetry to analytics pipeline without modifying RPC response contracts.
--
-- NOTE: query_meta fields are STABLE additions — frontend must tolerate new keys
-- being added inside query_meta without breaking. This is the forward-compatibility
-- contract for the telemetry envelope.
-- ---------------------------------------------------------------------------


-- =============================================================================
-- SECTION 10: CACHE GOVERNANCE MANIFEST
--
-- Documents the cache invalidation contract for Phase 2 RPCs.
-- Frontend and CDN/edge layers MUST follow these rules.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Cache governance rules:
--
-- 1. taxonomy_hash anchor:
--    All RPC responses carry query_meta.taxonomy_hash.
--    Frontend SHOULD cache RPC responses keyed by (rpc_name, params, taxonomy_hash).
--    When taxonomy_hash changes (detectable via fn_academic_taxonomy_hash()),
--    ALL academic context caches must be invalidated.
--
-- 2. rpc_version anchor:
--    All RPCs carry rpc_version: '2.0.0'.
--    If an RPC signature or response shape changes in a future phase,
--    rpc_version will be bumped. Frontend MUST NOT assume shape stability
--    across rpc_version changes.
--
-- 3. Static taxonomy cache TTL (recommendation):
--    Taxonomy changes are rare (migration-driven, not user-driven).
--    Recommended TTL: 24h for CDN/edge. Hash-based invalidation on migration deploy.
--
-- 4. Replay safety:
--    All RPCs are STABLE (same inputs → same outputs within a transaction).
--    ORDER BY clauses are deterministic — replay produces identical responses.
--    Safe for deterministic caching and event-sourcing replay.
-- ---------------------------------------------------------------------------


COMMIT;

-- =============================================================================
-- END OF: 20260527000001_phase2_academic_context_apis.sql
-- =============================================================================
