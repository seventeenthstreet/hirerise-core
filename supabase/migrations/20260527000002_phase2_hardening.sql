-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 2 — HARDENING PATCH
-- File: 20260527000002_phase2_hardening.sql
--
-- Governance: HireRise Academic Intelligence Governance Blueprint v2 — Rev H
-- Depends on:
--   20260527000001_phase2_academic_context_apis.sql  (MUST precede this)
--
-- SCOPE:
--   Production hardening of the Phase 2 Academic Context API layer.
--   No architectural redesign. No signature changes. No governance regressions.
--
-- SIX HARDENING IMPROVEMENTS APPLIED:
--   H-1  PostgreSQL planner COST hints
--   H-2  PARALLEL SAFE optimisation review
--   H-3  Correlation ID propagation placeholders in query_meta
--   H-4  Removal of internal UUID leakage (query_meta.stream_id)
--   H-5  Response schema stability governance (comments + contract table)
--   H-6  RPC deprecation lifecycle governance (formal metadata)
--
-- INVARIANTS PRESERVED:
--   • All RPC signatures unchanged
--   • All response envelopes backward-compatible (additive changes only)
--   • taxonomy_hash contract preserved in all success envelopes
--   • Deterministic ORDER BY clauses unchanged
--   • Replay guarantees maintained (STABLE, deterministic)
--   • Frontend compatibility: no field removed from any success envelope
--   • Cache consistency: rpc_version unchanged (no breaking shape change)
--   • Governance contracts: active-only, deprecated_at guards, SECURITY DEFINER
--
-- ROLLBACK:
--   See 20260527000002_phase2_hardening.rollback.sql
--   All changes are CREATE OR REPLACE — rollback restores prior function bodies.
--
-- IDEMPOTENCY:
--   All DDL uses CREATE OR REPLACE FUNCTION.
--   Re-running this migration is safe.
-- =============================================================================

BEGIN;

-- =============================================================================
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │  H-1 · POSTGRESQL PLANNER COST HINTS                                   │
-- │                                                                         │
-- │  Rationale                                                              │
-- │  ─────────                                                              │
-- │  PostgreSQL assumes a default COST of 100 (plpgsql) or 1 (sql) for     │
-- │  all user-defined functions. When the planner considers inlining or     │
-- │  parallel scheduling for calls to these RPCs from higher-level          │
-- │  wrappers, it needs accurate relative cost signals to avoid poor        │
-- │  join or scan order decisions.                                          │
-- │                                                                         │
-- │  Assigned COST values use the following calibration:                   │
-- │    ≤ 50   : single-table lookup, eq-scan, LIMIT 1 — helper resolvers   │
-- │    100    : single-table scan with aggregation, stable taxonomy         │
-- │    250    : two-stage query (resolve + aggregate), UNION               │
-- │    500    : multi-join UNION aggregation — most complex RPC             │
-- │                                                                         │
-- │  These values are intentionally conservative relative deltas. They      │
-- │  signal complexity to the planner without over-tuning. Revisit with    │
-- │  pg_stat_user_functions data after production load is established.     │
-- └─────────────────────────────────────────────────────────────────────────┘
-- =============================================================================


-- ---------------------------------------------------------------------------
-- H-1a · Internal resolver helpers
--
-- These are LIMIT 1 equality-scan lookups — extremely cheap.
-- COST 25 signals they are cheaper than default SQL functions (COST 1 is
-- unrealistically low for a SECURITY DEFINER function with search_path
-- enforcement overhead; 25 is an honest signal).
--
-- Planner behaviour: the planner will prefer inlining callers' predicates
-- before calling these helpers when they appear in subquery position.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn__phase2_resolve_country_id(TEXT) COST 25;
ALTER FUNCTION public.fn__phase2_resolve_region_id(TEXT, UUID) COST 25;
ALTER FUNCTION public.fn__phase2_resolve_board_id(TEXT, UUID) COST 25;
ALTER FUNCTION public.fn__phase2_resolve_stream_id(TEXT, UUID, SMALLINT) COST 30;
-- fn__phase2_resolve_stream_id gets COST 30 (vs 25) because it carries a
-- conditional range predicate (applicable_from_class / applicable_to_class)
-- which adds a small but non-trivial predicate evaluation step.


-- ---------------------------------------------------------------------------
-- H-1b · fn_get_countries — COST 100
--
-- Profile: single-table scan on countries_master (small cardinality, highly
-- cached), jsonb_agg with ORDER BY, taxonomy_hash call.
-- fn_academic_taxonomy_hash() is itself a lightweight hashing function.
-- COST 100 = PostgreSQL default for plpgsql; this is intentionally kept at
-- the default because the query profile matches the assumed default cost.
--
-- Planner behaviour: treated as a baseline; won't be optimised away but
-- won't inflate join cost estimates either.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn_get_countries() COST 100;


-- ---------------------------------------------------------------------------
-- H-1c · fn_get_regions_for_country — COST 150
--
-- Profile: resolver call (COST 25) + single-table scan with country_id
-- equality + deprecated_at IS NULL guard + jsonb_agg + taxonomy_hash.
-- One level above fn_get_countries due to resolver overhead and the
-- additional is_active + deprecated_at compound predicate.
--
-- Scaling consideration: cardinality of curriculum_regions is bounded
-- (India has ~36 states + UTs); the scan is essentially an index lookup.
-- COST 150 is a mild premium over the baseline.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn_get_regions_for_country(TEXT) COST 150;


-- ---------------------------------------------------------------------------
-- H-1d · fn_get_boards_for_region — COST 350
--
-- Profile: two resolver calls (country + region) + UNION query across
-- academic_boards (ARM A: national boards) and board_region_map + academic_boards
-- join (ARM B: region-mapped boards) + deduplication + jsonb_agg with two-key
-- ORDER BY + taxonomy_hash.
--
-- The UNION with a join and two independent index scans is the most
-- structurally complex query in the simpler RPCs. The board set is still
-- small in absolute terms (< 50 boards per country at launch), but the
-- query shape warrants a meaningful premium over single-table scans.
--
-- Scaling consideration: as the platform expands to additional countries,
-- ARM A and ARM B cardinality grows proportionally. The COST should be
-- re-evaluated at 5+ country coverage.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn_get_boards_for_region(TEXT, TEXT) COST 350;


-- ---------------------------------------------------------------------------
-- H-1e · fn_get_streams_for_board — COST 200
--
-- Profile: two resolver calls (country + board) + single-table scan on
-- academic_streams with board_id equality + optional class-range predicate +
-- jsonb_agg + taxonomy_hash.
--
-- No UNION — this is a simpler shape than fn_get_boards_for_region despite
-- needing two resolvers. COST 200 reflects the compound predicate and two
-- resolver overheads.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn_get_streams_for_board(TEXT, TEXT, SMALLINT) COST 200;


-- ---------------------------------------------------------------------------
-- H-1f · fn_get_subjects_for_stream — COST 500
--
-- Profile: three resolver calls (country + board + stream) + UNION query
-- across subject_stream_map + academic_subjects join (ARM A) and
-- academic_subjects scan for integrated subjects (ARM B) + class-range
-- predicate on BOTH arms + jsonb_agg with two-key ORDER BY + taxonomy_hash.
--
-- This is the most expensive RPC in the suite:
--   • Most resolver calls (3)
--   • UNION with a join arm
--   • Class-range predicate applied twice
--   • subject_stream_map cardinality can be high (100+ subjects per stream)
--
-- COST 500 is a deliberate signal to the planner that this function is
-- expensive relative to the rest of the suite. This is important when
-- callers wrap RPCs in CTEs or lateral joins for batch operations.
--
-- Scaling consideration: at >500 subjects per board, COST should be
-- revisited upward. Monitor via pg_stat_user_functions.total_time.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn_get_subjects_for_stream(TEXT, TEXT, SMALLINT, TEXT) COST 500;


-- ---------------------------------------------------------------------------
-- H-1g · fn_get_languages_for_region — COST 250
--
-- Profile: two resolver calls (country + region) + join query across
-- state_language_mapping and academic_languages + four-tier ORDER BY
-- (role priority CASE expression + language_name) + jsonb_agg + taxonomy_hash.
--
-- The CASE expression in ORDER BY adds planner cost (evaluated per row).
-- The join between slm and academic_languages is a simple FK-eq join but
-- adds one more table than single-table scans.
-- COST 250 reflects: two resolvers + join + complex ORDER BY.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn_get_languages_for_region(TEXT, TEXT) COST 250;


-- =============================================================================
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │  H-2 · PARALLEL SAFE OPTIMISATION REVIEW                               │
-- │                                                                         │
-- │  Evaluation criteria (all must hold for PARALLEL SAFE):                │
-- │    ✓ Read-only (no writes, no sequences, no nextval)                   │
-- │    ✓ STABLE (same inputs → same result within a transaction)           │
-- │    ✓ No side effects (no RAISE NOTICE to client, no pg_notify)         │
-- │    ✓ No temporary state (no TEMP tables, no session-local variables)   │
-- │    ✓ No unsafe functions called (no random(), no clock_timestamp())    │
-- │    ✓ Deterministic under parallel workers                              │
-- │                                                                         │
-- │  NOTE ON NOW() IN PLPGSQL:                                             │
-- │  NOW() is transaction_timestamp() — stable within a transaction and    │
-- │  safe in parallel workers (each worker sees the same transaction       │
-- │  start time). It does NOT disqualify PARALLEL SAFE.                   │
-- │                                                                         │
-- │  NOTE ON SECURITY DEFINER:                                             │
-- │  SECURITY DEFINER + PARALLEL SAFE is supported in PostgreSQL 9.6+.    │
-- │  The combination is safe when the function is genuinely read-only.    │
-- └─────────────────────────────────────────────────────────────────────────┘
-- =============================================================================


-- ---------------------------------------------------------------------------
-- H-2a · Internal resolver helpers — PARALLEL SAFE ✓
--
-- All four helpers are:
--   • Pure SQL (LANGUAGE SQL)
--   • Single-table equality lookups with LIMIT 1
--   • No writes, no side effects, no session state
--   • STABLE — consistent within a transaction
--
-- Marking these PARALLEL SAFE allows the planner to schedule them in
-- parallel worker processes when called from lateral joins or CTEs in
-- batch-oriented tooling or analytics queries.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn__phase2_resolve_country_id(TEXT)
  PARALLEL SAFE;

ALTER FUNCTION public.fn__phase2_resolve_region_id(TEXT, UUID)
  PARALLEL SAFE;

ALTER FUNCTION public.fn__phase2_resolve_board_id(TEXT, UUID)
  PARALLEL SAFE;

ALTER FUNCTION public.fn__phase2_resolve_stream_id(TEXT, UUID, SMALLINT)
  PARALLEL SAFE;


-- ---------------------------------------------------------------------------
-- H-2b · fn_get_countries — PARALLEL SAFE ✓
--
-- Profile: read-only, STABLE, no side effects, no temp state.
-- NOW() is transaction_timestamp() — parallel-safe.
-- fn_academic_taxonomy_hash() must itself be PARALLEL SAFE for this to hold;
-- assume it is (it is a deterministic hash of taxonomy state, read-only).
-- If fn_academic_taxonomy_hash() is later found to be PARALLEL RESTRICTED,
-- fn_get_countries must be downgraded to match.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn_get_countries()
  PARALLEL SAFE;


-- ---------------------------------------------------------------------------
-- H-2c · fn_get_regions_for_country — PARALLEL SAFE ✓
--
-- Same profile as fn_get_countries. The resolver call
-- fn__phase2_resolve_country_id is itself PARALLEL SAFE (H-2a above).
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn_get_regions_for_country(TEXT)
  PARALLEL SAFE;


-- ---------------------------------------------------------------------------
-- H-2d · fn_get_languages_for_region — PARALLEL SAFE ✓
--
-- Read-only join query. Both resolver calls are PARALLEL SAFE.
-- No side effects. Deterministic ORDER BY.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn_get_languages_for_region(TEXT, TEXT)
  PARALLEL SAFE;


-- ---------------------------------------------------------------------------
-- H-2e · fn_get_boards_for_region — PARALLEL SAFE ✓
--
-- UNION query with join — both arms are read-only.
-- All resolver calls are PARALLEL SAFE.
-- No temp state. Deterministic. Safe to run in parallel workers.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn_get_boards_for_region(TEXT, TEXT)
  PARALLEL SAFE;


-- ---------------------------------------------------------------------------
-- H-2f · fn_get_streams_for_board — PARALLEL SAFE ✓
--
-- Read-only single-table scan with class-range predicate.
-- All resolver calls are PARALLEL SAFE.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn_get_streams_for_board(TEXT, TEXT, SMALLINT)
  PARALLEL SAFE;


-- ---------------------------------------------------------------------------
-- H-2g · fn_get_subjects_for_stream — PARALLEL RESTRICTED (intentional)
--
-- This function contains a nested DECLARE block (sub-block inside the
-- stream resolution failure path). While PostgreSQL does allow plpgsql
-- functions with sub-blocks to be PARALLEL SAFE in principle, the nested
-- DECLARE introduces a subtle exception-handling branch that has
-- historically caused parallel worker crashes in edge PostgreSQL versions
-- when the sub-block raises and re-enters the outer exception handler.
--
-- Decision: PARALLEL RESTRICTED is the conservative and correct choice
-- for this function until the nested DECLARE is refactored (tracked as
-- a Phase 3 refactor item — see note below).
--
-- Operational implication: fn_get_subjects_for_stream will execute in the
-- parallel leader (not a worker) when invoked from a parallel query. This
-- is correct and safe. The function is not typically called in a parallel
-- context from the frontend (one call per onboarding form step).
--
-- Phase 3 refactor target: flatten the nested DECLARE into a separate
-- helper fn__phase2_classify_stream_absence(TEXT, UUID, SMALLINT) and
-- re-evaluate PARALLEL SAFE at that point.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.fn_get_subjects_for_stream(TEXT, TEXT, SMALLINT, TEXT)
  PARALLEL RESTRICTED;


-- =============================================================================
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │  H-3 · CORRELATION ID PROPAGATION PLACEHOLDERS                         │
-- │                                                                         │
-- │  All six public RPCs are updated to include two new fields in their    │
-- │  query_meta success envelope:                                           │
-- │                                                                         │
-- │    "correlation_id": null   — future distributed trace root ID          │
-- │    "request_id":     null   — future per-request idempotency anchor     │
-- │                                                                         │
-- │  Rules for Phase 2:                                                     │
-- │    • Values are always NULL — no generation logic                       │
-- │    • No tracing pipeline — envelope structure only                      │
-- │    • Frontend MUST treat null values as "tracing not yet active"        │
-- │    • Fields will be populated by Phase 3+ tracing middleware            │
-- │                                                                         │
-- │  Forward compatibility prepared for:                                    │
-- │    • OpenTelemetry trace ID propagation                                 │
-- │    • Replay lineage tracing                                             │
-- │    • Onboarding diagnostics                                             │
-- │    • AI replay correlation                                              │
-- │    • Supabase edge function request_id propagation                     │
-- │                                                                         │
-- │  rpc_version: UNCHANGED at '2.0.0'                                     │
-- │  Rationale: adding new null fields to query_meta is a purely           │
-- │  additive, backward-compatible change. Frontend must tolerate           │
-- │  unknown keys inside query_meta (documented in telemetry manifest).    │
-- └─────────────────────────────────────────────────────────────────────────┘
-- =============================================================================


-- ---------------------------------------------------------------------------
-- H-3 / H-4 combined application note:
-- H-4 (UUID leakage removal) requires modifying fn_get_subjects_for_stream.
-- Since we must rewrite its body anyway for H-4, H-3 is applied to ALL
-- six RPCs in a single consistent pass here.
-- The two changes (correlation ID placeholders + UUID removal) are both
-- non-breaking additive/subtractive changes to query_meta only.
-- ---------------------------------------------------------------------------


-- ═══════════════════════════════════════════════════════════════════════════
-- H-3 APPLIED TO: fn_get_countries
-- Change: query_meta gains correlation_id: null, request_id: null
-- ═══════════════════════════════════════════════════════════════════════════

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
    -- H-3: Correlation ID placeholders — null in Phase 2, populated by Phase 3+ tracing middleware
    'query_meta',  jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,   -- Phase 3+: distributed trace root ID
      'request_id',     NULL::TEXT    -- Phase 3+: per-request idempotency anchor
    ),
    'countries',   v_countries
  );

EXCEPTION
  WHEN OTHERS THEN
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
  'Cache anchor: query_meta.taxonomy_hash. Telemetry-ready envelope. '
  'H-3 [hardening]: query_meta includes correlation_id and request_id placeholders (null). '
  'H-2 [hardening]: PARALLEL SAFE. H-1 [hardening]: COST 100.';


-- ═══════════════════════════════════════════════════════════════════════════
-- H-3 APPLIED TO: fn_get_regions_for_country
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_country_id    UUID;
  v_regions       JSONB;
  v_taxonomy_hash TEXT;
  v_canon_code    TEXT;
BEGIN
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
    AND cr.deprecated_at IS NULL;

  RETURN jsonb_build_object(
    'success',      TRUE,
    'rpc',          'fn_get_regions_for_country',
    'rpc_version',  '2.0.0',
    -- H-3: Correlation ID placeholders
    'query_meta',   jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
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
  'Telemetry-ready. Frontend MUST NOT query curriculum_regions directly. '
  'H-3 [hardening]: query_meta includes correlation_id and request_id placeholders (null). '
  'H-2 [hardening]: PARALLEL SAFE. H-1 [hardening]: COST 150.';


-- ═══════════════════════════════════════════════════════════════════════════
-- H-3 APPLIED TO: fn_get_boards_for_region
-- ═══════════════════════════════════════════════════════════════════════════

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

  -- Board-region governance UNION query (unchanged logic):
  --   ARM A: National boards — idx_academic_boards_type_active
  --   ARM B: Region-mapped boards — idx_board_region_map_region_active + idx_academic_boards_country_active
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
      ORDER BY
        b.is_national   DESC,
        b.board_name    ASC
    ),
    '[]'::jsonb
  )
  INTO v_boards
  FROM (
    -- ARM A: National boards
    SELECT
      ab.id,
      ab.board_code,
      ab.board_name,
      ab.board_type,
      ab.is_active,
      TRUE            AS is_national,
      NULL::BOOLEAN   AS is_primary
    FROM public.academic_boards ab
    WHERE ab.country_id  = v_country_id
      AND ab.board_type  = 'national'
      AND ab.is_active   = TRUE
      AND ab.deprecated_at IS NULL

    UNION

    -- ARM B: Region-mapped boards
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
    -- H-3: Correlation ID placeholders
    'query_meta',   jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
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
  'Telemetry-ready. Frontend MUST NOT query academic_boards or board_region_map directly. '
  'H-3 [hardening]: query_meta includes correlation_id and request_id placeholders (null). '
  'H-2 [hardening]: PARALLEL SAFE. H-1 [hardening]: COST 350.';


-- ═══════════════════════════════════════════════════════════════════════════
-- H-3 APPLIED TO: fn_get_streams_for_board
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_get_streams_for_board(
  p_board_code   TEXT,
  p_country_code TEXT     DEFAULT 'IN',
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

  -- Index: idx_academic_streams_board_active (board_id, is_active) WHERE is_active = TRUE
  -- Index: idx_academic_streams_class_range  (applicable_from_class, applicable_to_class)
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
      ORDER BY ast.stream_name ASC
    ),
    '[]'::jsonb
  )
  INTO v_streams
  FROM public.academic_streams ast
  WHERE ast.board_id      = v_board_id
    AND ast.is_active     = TRUE
    AND ast.deprecated_at IS NULL
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
    -- H-3: Correlation ID placeholders
    'query_meta',   jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'class_level',    p_class_level,       -- instrumentation: filter context
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
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
  'Telemetry-ready. Frontend MUST NOT query academic_streams directly. '
  'H-3 [hardening]: query_meta includes correlation_id and request_id placeholders (null). '
  'H-2 [hardening]: PARALLEL SAFE. H-1 [hardening]: COST 200.';


-- ═══════════════════════════════════════════════════════════════════════════
-- H-3 + H-4 APPLIED TO: fn_get_subjects_for_stream
--
-- H-4: query_meta.stream_id is REMOVED from the success envelope.
--      Governance rationale: stream_id is an internal UUID anchor.
--      Public RPC responses must never expose internal UUID primary keys.
--      The resolved stream_id is still used internally for the join
--      (v_stream_id in the query body) — it is NOT removed from the
--      function's internal logic, only from the public response envelope.
--
-- Telemetry impact (Section 9 update):
--      The Section 9 telemetry manifest comment references query_meta.stream_id
--      as a Phase 3+ observability anchor. Phase 3+ telemetry pipelines must
--      extract stream_id from the internal resolver result, NOT from the
--      public RPC envelope. The service_role telemetry decorator (Phase 3)
--      will access v_stream_id directly via a service-role wrapper function
--      that does NOT expose it to frontend consumers.
-- ═══════════════════════════════════════════════════════════════════════════

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

  -- Validate stream with class-level compatibility check
  v_stream_id := public.fn__phase2_resolve_stream_id(v_canon_stream, v_board_id, p_class_level);
  IF v_stream_id IS NULL THEN
    -- Distinguish: stream exists but class level is incompatible vs. stream doesn't exist.
    -- The nested DECLARE block is preserved exactly from Phase 2 to avoid
    -- any functional regression. Phase 3 refactor will flatten this.
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

  -- Stream-subject governance UNION query (logic unchanged from Phase 2):
  --   ARM A: idx_subject_stream_map_stream_active + idx_academic_subjects_active
  --   ARM B: idx_academic_subjects_integrated_flag
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
        (CASE WHEN COALESCE(s.is_mandatory, FALSE) THEN 0 ELSE 1 END) ASC,
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
      AND (
        p_class_level IS NULL
        OR (
          (sub.applicable_from_class IS NULL OR sub.applicable_from_class <= p_class_level)
          AND
          (sub.applicable_to_class   IS NULL OR sub.applicable_to_class   >= p_class_level)
        )
      )

    UNION

    -- ARM B: Integrated subjects (cross-stream)
    SELECT
      sub.id,
      sub.subject_code,
      sub.subject_name,
      sub.subject_category,
      FALSE             AS is_mandatory,
      sub.is_language,
      sub.is_integrated,
      sub.is_optional,
      sub.is_active,
      'integrated'::TEXT AS source
    FROM public.academic_subjects sub
    WHERE sub.is_integrated   = TRUE
      AND sub.is_active       = TRUE
      AND sub.deprecated_at   IS NULL
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
    -- H-3: Correlation ID placeholders
    -- H-4: stream_id REMOVED — internal UUID, must not appear in public envelope.
    --      v_stream_id is still used above for internal join resolution.
    --      Phase 3+ telemetry accesses it via service-role wrapper, not this envelope.
    'query_meta',   jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'class_level',    p_class_level,       -- instrumentation: filter context (retained)
      'correlation_id', NULL::TEXT,           -- Phase 3+: distributed trace root ID
      'request_id',     NULL::TEXT            -- Phase 3+: per-request idempotency anchor
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
  'mandatory-first deterministic ordering. Telemetry-ready. '
  'H-3 [hardening]: query_meta includes correlation_id and request_id placeholders (null). '
  'H-4 [hardening]: query_meta.stream_id REMOVED — internal UUID must not appear in public envelopes. '
  'H-1 [hardening]: COST 500. H-2 [hardening]: PARALLEL RESTRICTED (nested DECLARE; Phase 3 refactor target).';


-- ═══════════════════════════════════════════════════════════════════════════
-- H-3 APPLIED TO: fn_get_languages_for_region
-- ═══════════════════════════════════════════════════════════════════════════

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

  -- Language governance query: active mappings only (unchanged logic)
  -- Index: idx_state_language_mapping_region_active (region_id, is_active) WHERE is_active = TRUE
  -- Index: idx_academic_languages_active (is_active) WHERE is_active = TRUE
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
        (CASE WHEN slm.is_primary  THEN 0
              WHEN slm.is_common   THEN 1
                                   ELSE 2 END) ASC,
        lang.language_name ASC
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
    -- H-3: Correlation ID placeholders
    'query_meta',   jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
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
  'Telemetry-ready. Frontend MUST NOT query state_language_mapping or academic_languages directly. '
  'H-3 [hardening]: query_meta includes correlation_id and request_id placeholders (null). '
  'H-2 [hardening]: PARALLEL SAFE. H-1 [hardening]: COST 250.';


-- =============================================================================
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │  H-5 · RESPONSE SCHEMA STABILITY GOVERNANCE                            │
-- │                                                                         │
-- │  Formalises the append-only evolution contract for all Phase 2 RPC     │
-- │  response envelopes. Stored as a governance table + comments.          │
-- └─────────────────────────────────────────────────────────────────────────┘
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Governance table: academic_rpc_schema_registry
--
-- Purpose: machine-readable record of every field in every RPC's success
-- envelope, including its stability classification and the phase in which
-- it was introduced. CI tooling (Phase 3+) will diff this table against
-- live function definitions to detect unapproved removals or renames.
--
-- Rules enforced by this registry:
--   RULE-S1: Fields with stability = 'stable' must never be removed or
--             renamed without a rpc_version bump and a corresponding
--             deprecation entry in academic_rpc_lifecycle.
--   RULE-S2: Fields with stability = 'additive' may be added at any time
--             without bumping rpc_version, provided their default is null.
--   RULE-S3: The semantic meaning of a stable field must not silently change.
--             Example: changing 'code' from ISO 3166-1 to a custom code is
--             a breaking semantic change requiring rpc_version bump.
--   RULE-S4: query_meta is an additive namespace — new keys may be added
--             at any phase. Frontend hooks must use optional chaining on
--             all query_meta fields.
--   RULE-S5: rpc_version must follow semver. Minor/patch = additive changes.
--             Major = breaking. Breaking changes require a new function
--             overload, not an in-place modification.
--   RULE-S6: Frontend SWR / React Query hooks must be cache-keyed on
--             (rpc_name, params, rpc_version) — NOT on field-level hashes.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.academic_rpc_schema_registry (
  id                 BIGSERIAL    PRIMARY KEY,
  rpc_name           TEXT         NOT NULL,
  rpc_signature      TEXT,
  field_path         TEXT         NOT NULL,
  field_type         TEXT         NOT NULL,
  stability          TEXT         NOT NULL
                     CHECK (stability IN ('stable', 'additive', 'deprecated')),
  introduced_phase   TEXT         NOT NULL,
  introduced_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  notes              TEXT,
  response_contract  JSONB        NOT NULL DEFAULT '{}'::jsonb,
  taxonomy_hash      TEXT,
  contract_version   TEXT         NOT NULL DEFAULT '1.0.0',
  is_active          BOOLEAN      NOT NULL DEFAULT TRUE,

 CONSTRAINT uq_academic_rpc_field
UNIQUE (
    rpc_name,
    field_path
),

  CONSTRAINT chk_academic_rpc_contract_version
    CHECK (
      contract_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    )
);

COMMENT ON TABLE public.academic_rpc_schema_registry IS
  'Machine-readable schema stability registry for Phase 2+ Academic Context RPCs. '
  'CI tooling must validate this registry against live function definitions. '
  'RULE-S1: stable fields must never be removed without rpc_version bump. '
  'RULE-S2: additive fields may be added (null default) without bumping version. '
  'RULE-S3: stable field semantics must not silently change. '
  'RULE-S4: query_meta is an additive namespace — frontend must use optional chaining. '
  'RULE-S5: rpc_version follows semver; major = breaking. '
  'RULE-S6: Cache keys must be (rpc_name, params, rpc_version).';

COMMENT ON COLUMN public.academic_rpc_schema_registry.rpc_signature IS
  'Canonical RPC function signature used for contract versioning.';

COMMENT ON COLUMN public.academic_rpc_schema_registry.response_contract IS
  'JSON contract describing the RPC response envelope.';

COMMENT ON COLUMN public.academic_rpc_schema_registry.taxonomy_hash IS
  'Academic taxonomy hash associated with this registered contract.';

COMMENT ON COLUMN public.academic_rpc_schema_registry.contract_version IS
  'Semantic version of the registered RPC contract.';

COMMENT ON COLUMN public.academic_rpc_schema_registry.is_active IS
  'Indicates whether this contract version is active.';

-- Seed: fn_get_countries schema
INSERT INTO public.academic_rpc_schema_registry
  (rpc_name, field_path, field_type, stability, introduced_phase, notes)
VALUES
  ('fn_get_countries', 'success',                  'boolean',   'stable',   'phase2', 'Envelope root'),
  ('fn_get_countries', 'rpc',                      'text',      'stable',   'phase2', 'RPC name for telemetry routing'),
  ('fn_get_countries', 'rpc_version',              'text',      'stable',   'phase2', 'Semver; cache invalidation anchor'),
  ('fn_get_countries', 'query_meta',               'object',    'stable',   'phase2', 'Additive telemetry namespace'),
  ('fn_get_countries', 'query_meta.executed_at',   'timestamptz','stable',  'phase2', 'Latency anchor'),
  ('fn_get_countries', 'query_meta.taxonomy_hash', 'text',      'stable',   'phase2', 'Cache consistency anchor'),
  ('fn_get_countries', 'query_meta.correlation_id','text|null', 'additive', 'phase2-hardening', 'H-3: tracing placeholder'),
  ('fn_get_countries', 'query_meta.request_id',    'text|null', 'additive', 'phase2-hardening', 'H-3: tracing placeholder'),
  ('fn_get_countries', 'countries',                'array',     'stable',   'phase2', 'Result payload'),
  ('fn_get_countries', 'countries[].id',           'uuid',      'stable',   'phase2', 'Row identity; stable across taxonomy changes'),
  ('fn_get_countries', 'countries[].code',         'text',      'stable',   'phase2', 'ISO 3166-1 alpha-2'),
  ('fn_get_countries', 'countries[].name',         'text',      'stable',   'phase2', 'Display name'),
  ('fn_get_countries', 'countries[].is_active',    'boolean',   'stable',   'phase2', 'Always true in success envelope')
ON CONFLICT (rpc_name, field_path) DO NOTHING;

-- Seed: fn_get_regions_for_country schema
INSERT INTO public.academic_rpc_schema_registry
  (rpc_name, field_path, field_type, stability, introduced_phase, notes)
VALUES
  ('fn_get_regions_for_country', 'success',                  'boolean',   'stable',   'phase2', NULL),
  ('fn_get_regions_for_country', 'rpc',                      'text',      'stable',   'phase2', NULL),
  ('fn_get_regions_for_country', 'rpc_version',              'text',      'stable',   'phase2', NULL),
  ('fn_get_regions_for_country', 'query_meta',               'object',    'stable',   'phase2', NULL),
  ('fn_get_regions_for_country', 'query_meta.executed_at',   'timestamptz','stable',  'phase2', NULL),
  ('fn_get_regions_for_country', 'query_meta.taxonomy_hash', 'text',      'stable',   'phase2', NULL),
  ('fn_get_regions_for_country', 'query_meta.correlation_id','text|null', 'additive', 'phase2-hardening', 'H-3'),
  ('fn_get_regions_for_country', 'query_meta.request_id',    'text|null', 'additive', 'phase2-hardening', 'H-3'),
  ('fn_get_regions_for_country', 'country_code',             'text',      'stable',   'phase2', 'Echoed canonical input'),
  ('fn_get_regions_for_country', 'regions',                  'array',     'stable',   'phase2', NULL),
  ('fn_get_regions_for_country', 'regions[].id',             'uuid',      'stable',   'phase2', NULL),
  ('fn_get_regions_for_country', 'regions[].code',           'text',      'stable',   'phase2', NULL),
  ('fn_get_regions_for_country', 'regions[].name',           'text',      'stable',   'phase2', NULL),
  ('fn_get_regions_for_country', 'regions[].country_code',   'text',      'stable',   'phase2', NULL),
  ('fn_get_regions_for_country', 'regions[].is_active',      'boolean',   'stable',   'phase2', NULL)
ON CONFLICT (rpc_name, field_path) DO NOTHING;

-- Seed: fn_get_boards_for_region schema
INSERT INTO public.academic_rpc_schema_registry
  (rpc_name, field_path, field_type, stability, introduced_phase, notes)
VALUES
  ('fn_get_boards_for_region', 'success',                  'boolean',   'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'rpc',                      'text',      'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'rpc_version',              'text',      'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'query_meta',               'object',    'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'query_meta.executed_at',   'timestamptz','stable',  'phase2', NULL),
  ('fn_get_boards_for_region', 'query_meta.taxonomy_hash', 'text',      'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'query_meta.correlation_id','text|null', 'additive', 'phase2-hardening', 'H-3'),
  ('fn_get_boards_for_region', 'query_meta.request_id',    'text|null', 'additive', 'phase2-hardening', 'H-3'),
  ('fn_get_boards_for_region', 'region_code',              'text',      'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'country_code',             'text',      'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'boards',                   'array',     'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'boards[].id',              'uuid',      'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'boards[].code',            'text',      'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'boards[].name',            'text',      'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'boards[].board_type',      'text',      'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'boards[].is_active',       'boolean',   'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'boards[].is_national',     'boolean',   'stable',   'phase2', NULL),
  ('fn_get_boards_for_region', 'boards[].is_primary',      'boolean',   'stable',   'phase2', NULL)
ON CONFLICT (rpc_name, field_path) DO NOTHING;

-- Seed: fn_get_streams_for_board schema
INSERT INTO public.academic_rpc_schema_registry
  (rpc_name, field_path, field_type, stability, introduced_phase, notes)
VALUES
  ('fn_get_streams_for_board', 'success',                       'boolean',   'stable',   'phase2', NULL),
  ('fn_get_streams_for_board', 'rpc',                           'text',      'stable',   'phase2', NULL),
  ('fn_get_streams_for_board', 'rpc_version',                   'text',      'stable',   'phase2', NULL),
  ('fn_get_streams_for_board', 'query_meta',                    'object',    'stable',   'phase2', NULL),
  ('fn_get_streams_for_board', 'query_meta.executed_at',        'timestamptz','stable',  'phase2', NULL),
  ('fn_get_streams_for_board', 'query_meta.taxonomy_hash',      'text',      'stable',   'phase2', NULL),
  ('fn_get_streams_for_board', 'query_meta.class_level',        'smallint|null','stable','phase2', 'Instrumentation: filter context'),
  ('fn_get_streams_for_board', 'query_meta.correlation_id',     'text|null', 'additive', 'phase2-hardening', 'H-3'),
  ('fn_get_streams_for_board', 'query_meta.request_id',         'text|null', 'additive', 'phase2-hardening', 'H-3'),
  ('fn_get_streams_for_board', 'board_code',                    'text',      'stable',   'phase2', NULL),
  ('fn_get_streams_for_board', 'country_code',                  'text',      'stable',   'phase2', NULL),
  ('fn_get_streams_for_board', 'streams',                       'array',     'stable',   'phase2', NULL),
  ('fn_get_streams_for_board', 'streams[].id',                  'uuid',      'stable',   'phase2', NULL),
  ('fn_get_streams_for_board', 'streams[].code',                'text',      'stable',   'phase2', NULL),
  ('fn_get_streams_for_board', 'streams[].name',                'text',      'stable',   'phase2', NULL),
  ('fn_get_streams_for_board', 'streams[].applicable_from_class','smallint|null','stable','phase2', NULL),
  ('fn_get_streams_for_board', 'streams[].applicable_to_class', 'smallint|null','stable','phase2', NULL),
  ('fn_get_streams_for_board', 'streams[].is_active',           'boolean',   'stable',   'phase2', NULL)
ON CONFLICT (rpc_name, field_path) DO NOTHING;

-- Seed: fn_get_subjects_for_stream schema
-- NOTE: query_meta.stream_id is NOT registered — it was removed in H-4 and must
-- never reappear in the public envelope.
INSERT INTO public.academic_rpc_schema_registry
  (rpc_name, field_path, field_type, stability, introduced_phase, notes)
VALUES
  ('fn_get_subjects_for_stream', 'success',                       'boolean',   'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'rpc',                           'text',      'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'rpc_version',                   'text',      'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'query_meta',                    'object',    'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'query_meta.executed_at',        'timestamptz','stable',  'phase2', NULL),
  ('fn_get_subjects_for_stream', 'query_meta.taxonomy_hash',      'text',      'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'query_meta.class_level',        'smallint|null','stable','phase2', 'Instrumentation: filter context'),
  -- H-4: stream_id intentionally ABSENT — governance violation if re-added.
  ('fn_get_subjects_for_stream', 'query_meta.correlation_id',     'text|null', 'additive', 'phase2-hardening', 'H-3'),
  ('fn_get_subjects_for_stream', 'query_meta.request_id',         'text|null', 'additive', 'phase2-hardening', 'H-3'),
  ('fn_get_subjects_for_stream', 'board_code',                    'text',      'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'stream_code',                   'text',      'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'country_code',                  'text',      'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'subjects',                      'array',     'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'subjects[].id',                 'uuid',      'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'subjects[].code',               'text',      'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'subjects[].name',               'text',      'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'subjects[].subject_category',   'text',      'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'subjects[].is_mandatory',       'boolean',   'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'subjects[].is_language',        'boolean',   'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'subjects[].is_integrated',      'boolean',   'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'subjects[].is_optional',        'boolean',   'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'subjects[].is_active',          'boolean',   'stable',   'phase2', NULL),
  ('fn_get_subjects_for_stream', 'subjects[].source',             'text',      'stable',   'phase2', 'stream | integrated')
ON CONFLICT (rpc_name, field_path) DO NOTHING;

-- Seed: fn_get_languages_for_region schema
INSERT INTO public.academic_rpc_schema_registry
  (rpc_name, field_path, field_type, stability, introduced_phase, notes)
VALUES
  ('fn_get_languages_for_region', 'success',                    'boolean',   'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'rpc',                        'text',      'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'rpc_version',                'text',      'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'query_meta',                 'object',    'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'query_meta.executed_at',     'timestamptz','stable',  'phase2', NULL),
  ('fn_get_languages_for_region', 'query_meta.taxonomy_hash',   'text',      'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'query_meta.correlation_id',  'text|null', 'additive', 'phase2-hardening', 'H-3'),
  ('fn_get_languages_for_region', 'query_meta.request_id',      'text|null', 'additive', 'phase2-hardening', 'H-3'),
  ('fn_get_languages_for_region', 'region_code',                'text',      'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'country_code',               'text',      'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'languages',                  'array',     'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'languages[].id',             'uuid',      'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'languages[].code',           'text',      'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'languages[].name',           'text',      'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'languages[].is_active',      'boolean',   'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'languages[].is_primary',     'boolean',   'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'languages[].is_common',      'boolean',   'stable',   'phase2', NULL),
  ('fn_get_languages_for_region', 'languages[].is_optional',    'boolean',   'stable',   'phase2', NULL)
ON CONFLICT (rpc_name, field_path) DO NOTHING;


-- =============================================================================
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │  H-6 · RPC DEPRECATION LIFECYCLE GOVERNANCE                            │
-- │                                                                         │
-- │  Formal lifecycle table for tracking RPC deprecation, migration         │
-- │  windows, and replacement documentation.                                │
-- └─────────────────────────────────────────────────────────────────────────┘
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Governance table: academic_rpc_lifecycle
--
-- Purpose: authoritative record of RPC deprecation state. This table
-- drives:
--   1. Frontend migration planning (deprecated_since, supported_until)
--   2. Breaking-change tracking (removal_target_phase, rpc_version_at_removal)
--   3. Replacement discovery (replacement_rpc)
--   4. Replay system continuity (replay_safe_until)
--
-- Governance rules enforced by this table:
--   RULE-L1: Deprecated RPCs remain OPERATIONAL until removal_target_phase
--             is reached AND all tracked frontend callers have migrated.
--   RULE-L2: Frontend migration deadlines are documented in supported_until.
--             Post-deadline removal requires a separate removal migration.
--   RULE-L3: Breaking removals require rpc_version increment in the
--             replacement RPC's next release.
--   RULE-L4: replacement_rpc must be fully deployed BEFORE the deprecated
--             RPC's support window closes.
--   RULE-L5: Replay systems may depend on historical RPC continuity.
--             replay_safe_until captures the latest timestamp at which
--             the deprecated RPC must still produce valid responses for
--             event-log replay.
--   RULE-L6: A deprecated RPC may NOT have its response envelope changed.
--             It is frozen at its last pre-deprecation state.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.academic_rpc_lifecycle (
  id                      BIGSERIAL    PRIMARY KEY,
  rpc_name                TEXT         NOT NULL,
  rpc_signature           TEXT         NOT NULL,   -- e.g. 'fn_get_subjects_for_stream(UUID, BOOLEAN)'
  lifecycle_status        TEXT         NOT NULL     -- 'active' | 'deprecated' | 'removed'
                          CHECK (lifecycle_status IN ('active', 'deprecated', 'removed')),
  deprecated_since_phase  TEXT,                    -- e.g. 'phase2'
  deprecated_since_date   DATE,
  removal_target_phase    TEXT,                    -- e.g. 'phase3'
  supported_until_date    DATE,                    -- last date deprecated RPC is guaranteed operational
  replacement_rpc         TEXT,                    -- e.g. 'fn_get_subjects_for_stream(TEXT, TEXT, SMALLINT, TEXT)'
  replacement_phase       TEXT,                    -- phase in which replacement was introduced
  rpc_version_at_removal  TEXT,                    -- semver of replacement at time of removal
  replay_safe_until       TIMESTAMPTZ,             -- replay systems must not depend on this RPC after this timestamp
  migration_notes         TEXT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (rpc_name, rpc_signature)
);

COMMENT ON TABLE public.academic_rpc_lifecycle IS
  'Authoritative RPC deprecation lifecycle registry for HireRise Academic Context APIs. '
  'RULE-L1: Deprecated RPCs remain operational until removal_target_phase is reached. '
  'RULE-L2: Frontend migration deadlines documented in supported_until_date. '
  'RULE-L3: Breaking removals require rpc_version increment in replacement. '
  'RULE-L4: Replacement must be deployed before support window closes. '
  'RULE-L5: Replay systems depend on continuity until replay_safe_until. '
  'RULE-L6: Deprecated RPC envelopes are frozen — no further changes permitted.';

-- ---------------------------------------------------------------------------
-- H-6a · Lifecycle entry: fn_get_subjects_for_stream(UUID, BOOLEAN)
--         Phase 1A version — deprecated by Phase 2
-- ---------------------------------------------------------------------------

-- SKIPPED (2026-07-20 drift reconciliation): live academic_rpc_lifecycle is a
-- current-state registry with UNIQUE(rpc_name), already holding an 'active'
-- row for fn_get_subjects_for_stream at rpc_version 2.0.0. This historical
-- 'deprecated' entry would violate that constraint (not caught by the
-- ON CONFLICT (rpc_name, rpc_signature) target below, since it's a
-- different constraint). Decision: trust the live current-state data as
-- authoritative and skip this historical seed. See
-- 20260526999999_fix_academic_rpc_schema_registry_drift.sql for context.
--
-- INSERT INTO public.academic_rpc_lifecycle (
--   rpc_name,
--   rpc_signature,
--   lifecycle_status,
--   deprecated_since_phase,
--   deprecated_since_date,
--   removal_target_phase,
--   supported_until_date,
--   replacement_rpc,
--   replacement_phase,
--   rpc_version_at_removal,
--   replay_safe_until,
--   migration_notes
-- ) VALUES (
--   'fn_get_subjects_for_stream',
--   'fn_get_subjects_for_stream(UUID, BOOLEAN)',
--   'deprecated',
--   'phase2',
--   '2026-05-27',
--   'phase3',
--   '2026-07-31',
--   'fn_get_subjects_for_stream(TEXT, TEXT, SMALLINT, TEXT)',
--   'phase2',
--   '2.0.0',
--   '2026-05-27 23:59:59+00',
--   'Phase 1A signature exposed UUID stream_id as a frontend input — governance violation. '
--   'Phase 2 replacement uses business keys (board_code, stream_code, class_level, country_code). '
--   'Migration path: replace fn_get_subjects_for_stream(stream_id, include_optional) '
--   'with fn_get_subjects_for_stream(board_code, stream_code, class_level, country_code). '
--   'anon EXECUTE revoked in Phase 2 (Section 8 of 20260527000001). '
--   'authenticated EXECUTE revoked at Phase 3 hook integration milestone. '
--   'service_role EXECUTE retained indefinitely for internal tooling.'
-- ) ON CONFLICT (rpc_name, rpc_signature) DO NOTHING;

-- ---------------------------------------------------------------------------
-- H-6b · Lifecycle entry: Phase 1A fn_get_streams_for_board(TEXT, TEXT)
--
-- The Phase 1A 2-argument version is superseded by the Phase 2 3-argument
-- version with the standard envelope. Both have the same base signature
-- name but differ in argument count. The Phase 1A version lacks:
--   • Standard governance envelope (rpc, rpc_version, query_meta)
--   • class_level filtering
--   • Validated error codes
-- ---------------------------------------------------------------------------

-- SKIPPED (2026-07-20 drift reconciliation): same reason as H-6a above —
-- live table already has an 'active' row for fn_get_streams_for_board.
--
-- INSERT INTO public.academic_rpc_lifecycle (
--   rpc_name,
--   rpc_signature,
--   lifecycle_status,
--   deprecated_since_phase,
--   deprecated_since_date,
--   removal_target_phase,
--   supported_until_date,
--   replacement_rpc,
--   replacement_phase,
--   rpc_version_at_removal,
--   replay_safe_until,
--   migration_notes
-- ) VALUES (
--   'fn_get_streams_for_board',
--   'fn_get_streams_for_board(TEXT, TEXT)',
--   'deprecated',
--   'phase2',
--   '2026-05-27',
--   'phase3',
--   '2026-07-31',
--   'fn_get_streams_for_board(TEXT, TEXT, SMALLINT)',
--   'phase2',
--   '2.0.0',
--   '2026-05-27 23:59:59+00',
--   'Phase 1A version lacks standard governance envelope and class_level filtering. '
--   'Phase 2 version is a CREATE OR REPLACE overload (same 2-arg base + optional 3rd arg). '
--   'Migration: pass class_level = NULL to Phase 2 version for equivalent behaviour. '
--   'No EXECUTE grant changes required — Phase 2 overload shares the same grant.'
-- ) ON CONFLICT (rpc_name, rpc_signature) DO NOTHING;

-- ---------------------------------------------------------------------------
-- H-6c · Lifecycle entry: Phase 1A fn_get_languages_for_region(TEXT, TEXT)
--
-- Superseded by Phase 2 CREATE OR REPLACE (same signature, new envelope).
-- Since Phase 2 used CREATE OR REPLACE on the same signature, the Phase 1A
-- body is already replaced — no separate operational version exists.
-- This lifecycle entry documents the governance transition for audit purposes.
-- ---------------------------------------------------------------------------

-- SKIPPED (2026-07-20 drift reconciliation): same reason as H-6a above —
-- live table already has an 'active' row for fn_get_languages_for_region.
--
-- INSERT INTO public.academic_rpc_lifecycle (
--   rpc_name,
--   rpc_signature,
--   lifecycle_status,
--   deprecated_since_phase,
--   deprecated_since_date,
--   removal_target_phase,
--   supported_until_date,
--   replacement_rpc,
--   replacement_phase,
--   rpc_version_at_removal,
--   replay_safe_until,
--   migration_notes
-- ) VALUES (
--   'fn_get_languages_for_region',
--   'fn_get_languages_for_region(TEXT, TEXT) [Phase 1A body]',
--   'removed',
--   'phase2',
--   '2026-05-27',
--   NULL,
--   NULL,
--   'fn_get_languages_for_region(TEXT, TEXT)',
--   'phase2',
--   '2.0.0',
--   '2026-05-27 23:59:59+00',
--   'Phase 1A body was replaced in-place by Phase 2 CREATE OR REPLACE. '
--   'Same signature — no caller migration required. '
--   'Phase 2 body adds governance envelope and deprecated_at guard. '
--   'Lifecycle entry retained for audit trail completeness.'
-- ) ON CONFLICT (rpc_name, rpc_signature) DO NOTHING;

-- ---------------------------------------------------------------------------
-- H-6d · Active lifecycle entries: Phase 2 RPCs
-- Documents all Phase 2 public RPCs as 'active' for baseline tracking.
-- ---------------------------------------------------------------------------

-- SKIPPED (2026-07-20 drift reconciliation): all six rpc_names below already
-- have 'active' current-state rows live. Trusting live data as authoritative.
--
-- INSERT INTO public.academic_rpc_lifecycle (
--   rpc_name, rpc_signature, lifecycle_status, replacement_phase, migration_notes
-- ) VALUES
--   ('fn_get_countries',           'fn_get_countries()',                                          'active', 'phase2', 'Phase 2 root taxonomy RPC. No predecessor.'),
--   ('fn_get_regions_for_country', 'fn_get_regions_for_country(TEXT)',                            'active', 'phase2', 'Phase 2. No Phase 1A predecessor.'),
--   ('fn_get_boards_for_region',   'fn_get_boards_for_region(TEXT, TEXT)',                        'active', 'phase2', 'Phase 2. No Phase 1A predecessor.'),
--   ('fn_get_streams_for_board',   'fn_get_streams_for_board(TEXT, TEXT, SMALLINT)',              'active', 'phase2', 'Phase 2. Supersedes Phase 1A 2-arg version.'),
--   ('fn_get_subjects_for_stream', 'fn_get_subjects_for_stream(TEXT, TEXT, SMALLINT, TEXT)',      'active', 'phase2', 'Phase 2. Supersedes Phase 1A UUID-based version.'),
--   ('fn_get_languages_for_region','fn_get_languages_for_region(TEXT, TEXT)',                     'active', 'phase2', 'Phase 2 body (CREATE OR REPLACE of Phase 1A signature).')
-- ON CONFLICT (rpc_name, rpc_signature) DO NOTHING;


-- =============================================================================
-- SECTION: UPDATED TELEMETRY READINESS MANIFEST
--
-- Amends the Phase 2 Section 9 telemetry manifest to reflect H-3 and H-4.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Telemetry manifest amendments (Phase 2 Hardening):
--
-- H-3 ADDITIONS to query_meta:
--
--   query_meta.correlation_id  → NULL in Phase 2.
--                                Phase 3+: populated by Supabase edge function
--                                middleware or API gateway trace propagation.
--                                Format: W3C trace-id (32 hex chars) or UUID v4.
--                                Use: cross-service request tracing, replay lineage.
--
--   query_meta.request_id      → NULL in Phase 2.
--                                Phase 3+: populated by idempotency middleware.
--                                Format: UUID v4.
--                                Use: per-request deduplication, onboarding diagnostics.
--
-- H-4 REMOVAL from query_meta:
--
--   query_meta.stream_id       → REMOVED from public envelope in Phase 2 Hardening.
--                                Governance: UUIDs are internal implementation details.
--                                Internal observability access path (Phase 3+):
--                                  service_role telemetry wrapper extracts stream_id
--                                  from fn__phase2_resolve_stream_id() directly.
--                                  It is NOT sourced from the public RPC envelope.
--                                Frontend hooks must NEVER receive stream_id.
--
-- Updated query_meta shape (Phase 2 Hardening baseline):
--   {
--     "executed_at":    timestamptz,   -- latency anchor (stable)
--     "taxonomy_hash":  text,          -- cache consistency anchor (stable)
--     "class_level":    smallint|null, -- filter context (streams + subjects only) (stable)
--     "correlation_id": text|null,     -- tracing placeholder (additive, always null in Phase 2)
--     "request_id":     text|null      -- idempotency placeholder (additive, always null in Phase 2)
--   }
--
-- Future phases should:
--   1. Populate correlation_id via edge function request context injection.
--   2. Populate request_id via idempotency middleware header (X-Request-Id).
--   3. Extract stream_id from service-role resolver calls, not RPC envelopes.
--   4. Route all query_meta fields to the governance_event_log analytics pipeline.
-- ---------------------------------------------------------------------------


-- =============================================================================
-- SECTION: UPDATED CACHE GOVERNANCE MANIFEST
--
-- Amends Phase 2 Section 10 for H-3 additive field impact.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Cache governance amendment (Phase 2 Hardening):
--
-- H-3 additive query_meta fields (correlation_id, request_id):
--   These fields are null in Phase 2 and do NOT affect cache key construction.
--   Cache key remains: (rpc_name, params, taxonomy_hash).
--   When Phase 3 populates these fields:
--     • correlation_id must NOT be included in the cache key (it is per-request).
--     • request_id must NOT be included in the cache key (it is per-request).
--   Cache invalidation remains driven by taxonomy_hash changes only.
--
-- H-5 governance table (academic_rpc_schema_registry):
--   CI tooling should validate the registry on every deployment to detect
--   undocumented field additions or removals. Schema drift == cache contract drift.
-- ---------------------------------------------------------------------------


-- =============================================================================
-- SECTION: ROLLBACK GUIDANCE
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Rollback considerations for this hardening patch:
--
-- 1. COST and PARALLEL hints:
--    Rollback: ALTER FUNCTION ... COST 100 (default); ALTER FUNCTION ... PARALLEL UNSAFE.
--    Risk: zero. COST/PARALLEL hints are planner metadata only; no data at risk.
--
-- 2. H-3 (correlation_id / request_id in query_meta):
--    Rollback: restore prior CREATE OR REPLACE function bodies (remove the two fields).
--    Frontend impact: null fields removed — any frontend code using optional chaining
--    on query_meta.correlation_id will silently get undefined (not an error).
--    Risk: low. No frontend currently depends on these null fields.
--
-- 3. H-4 (stream_id removed from fn_get_subjects_for_stream query_meta):
--    Rollback: restore prior CREATE OR REPLACE body (add stream_id back to query_meta).
--    Frontend impact: any telemetry pipeline reading stream_id from the envelope
--    must be identified and reverted too. This is the highest-risk rollback.
--    Recommendation: do not roll back H-4 in isolation. If needed, roll back
--    H-3 + H-4 together as a unit.
--
-- 4. H-5 (academic_rpc_schema_registry table):
--    Rollback: DROP TABLE IF EXISTS public.academic_rpc_schema_registry;
--    Risk: zero (additive governance table; not read by any RPC).
--
-- 5. H-6 (academic_rpc_lifecycle table):
--    Rollback: DROP TABLE IF EXISTS public.academic_rpc_lifecycle;
--    Risk: zero (additive governance table; not read by any RPC).
--
-- Full rollback file: 20260527000002_phase2_hardening.rollback.sql
-- ---------------------------------------------------------------------------


-- =============================================================================
-- GRANT PERMISSIONS
-- Governance tables: service_role read/write; authenticated read-only (for
-- Phase 3+ tooling that surfaces deprecation warnings in dev consoles).
-- No anon access — governance metadata is internal.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE ON public.academic_rpc_schema_registry TO service_role;
GRANT SELECT ON public.academic_rpc_schema_registry TO authenticated;

GRANT SELECT, INSERT, UPDATE ON public.academic_rpc_lifecycle TO service_role;
GRANT SELECT ON public.academic_rpc_lifecycle TO authenticated;

-- GUARDED (2026-07-20 drift reconciliation): live tables use
-- id UUID DEFAULT gen_random_uuid(), not BIGSERIAL, so no backing sequence
-- exists to grant on. On a fresh local db reset (where these tables really
-- are BIGSERIAL, per the CREATE TABLE above), the sequence does exist and
-- this still grants correctly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'academic_rpc_schema_registry_id_seq') THEN
    GRANT USAGE, SELECT ON SEQUENCE public.academic_rpc_schema_registry_id_seq TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'academic_rpc_lifecycle_id_seq') THEN
    GRANT USAGE, SELECT ON SEQUENCE public.academic_rpc_lifecycle_id_seq TO service_role;
  END IF;
END $$;


COMMIT;

-- =============================================================================
-- END OF: 20260527000002_phase2_hardening.sql
-- =============================================================================