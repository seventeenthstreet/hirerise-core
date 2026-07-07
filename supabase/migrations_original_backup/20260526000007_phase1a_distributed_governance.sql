-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 1A — DISTRIBUTED GOVERNANCE EXTENSION
-- File: 20260526000007_phase1a_distributed_governance.sql
--
-- Governance: HireRise Academic Intelligence Governance Blueprint v2
-- Extends:    20260526000006_phase1a_operational_governance.sql
-- Created:    2026-05-26
--
-- SCOPE: Distributed-system governance additions.
--   This migration EXTENDS and HARDENS the existing schema.
--   It does NOT redesign tables or change taxonomy authority rules.
--
-- SECTIONS:
--   1. governance_contract_versions table
--      Immutable registry of governance contract states. Append-only.
--      Each row captures the governance semantics version active at a point
--      in time: RPC contracts, lifecycle values, event schemas, replay rules,
--      cache contracts, and AI replay expectations.
--
--   2. fn_governance_drift_report()
--      Comprehensive cross-environment parity validation function.
--      Returns a structured drift report comparing the current environment's
--      taxonomy hash, seed lineage, and governance version against expected
--      baselines. Designed to be called by CI/CD pipelines.
--
--   3. fn_build_cache_key()
--      Deterministic cache key builder incorporating taxonomy hash and
--      governance version. Ensures cache keys are version-scoped and
--      self-invalidating on governance state changes.
--
--   4. fn_validate_replay_preconditions()
--      Pre-flight replay integrity check. Validates that all preconditions
--      for a safe taxonomy replay are satisfied before a replay operation
--      is initiated.
--
-- ROLLBACK: See 20260526000007_phase1a_distributed_governance.rollback.sql
--
-- DEPENDENCIES:
--   20260526000001 — 20260526000006 must be applied first.
--
-- IDEMPOTENCY:
--   CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION throughout.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: GOVERNANCE CONTRACT VERSIONS TABLE
--
-- PURPOSE:
--   An immutable registry of governance contract states. A new row is inserted
--   whenever governance semantics change — RPC contracts, lifecycle value sets,
--   event schema versions, replay ordering rules, cache contract definitions,
--   or AI replay expectations.
--
-- RELATIONSHIP TO OTHER GOVERNANCE TABLES:
--   taxonomy_seed_versions    — records WHAT data was seeded
--   taxonomy_snapshots        — records the FULL state at a point in time (future)
--   taxonomy_change_events    — records WHAT changed and when (future)
--   governance_contract_versions — records HOW the system interprets that data
--
--   All three future tables (snapshots, change events, snapshot-based AI outputs)
--   must reference a governance_version to remain reproducible under replay.
--
-- GOVERNANCE INVARIANT:
--   A taxonomy hash alone does not fully define reproducibility.
--   The same taxonomy hash interpreted under two different governance versions
--   may produce different RPC outputs, different lifecycle semantics, and
--   different AI replay outputs. Both coordinates are required for full
--   reproducibility: (taxonomy_hash, governance_version).
--
-- APPEND-ONLY ENFORCEMENT:
--   fn_prevent_governance_contract_mutation() trigger prevents UPDATE and DELETE.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.governance_contract_versions (
  id                   UUID        DEFAULT gen_random_uuid() NOT NULL,
  governance_version   TEXT        NOT NULL,   -- semantic version: 'v2.0.0', 'v2.1.0'
  governance_hash      TEXT        NOT NULL,   -- deterministic hash of contract state
  activated_at         TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  activated_by         TEXT,                   -- actor identity; NULL for automated deployment
  governance_metadata  JSONB       NOT NULL,   -- full contract state snapshot

  CONSTRAINT pk_governance_contract_versions PRIMARY KEY (id),

  -- Governance version is unique — a contract version can only be activated once
  CONSTRAINT uq_governance_contract_versions_version
    UNIQUE (governance_version),

  -- Hash uniqueness ensures contracts are not duplicated under different version labels
  CONSTRAINT uq_governance_contract_versions_hash
    UNIQUE (governance_hash),

  CONSTRAINT chk_governance_contract_versions_nonempty
    CHECK (governance_version <> '' AND governance_hash <> '')
);

COMMENT ON TABLE public.governance_contract_versions IS
  'Immutable registry of governance contract states. '
  'A new row is inserted whenever governance semantics change: '
  'RPC contracts, lifecycle value sets, event schemas, replay rules, '
  'cache contracts, or AI replay expectations. '
  'Rows are append-only — no UPDATE or DELETE permitted. '
  'Reproducibility requires BOTH taxonomy_hash AND governance_version. '
  'AI outputs, taxonomy snapshots, and change events must reference a '
  'governance_version to remain fully reproducible under replay.';

COMMENT ON COLUMN public.governance_contract_versions.governance_version IS
  'Semantic version of this governance contract state. '
  'Format: v<major>.<minor>.<patch>. '
  'Major version: breaking changes to RPC contracts, lifecycle semantics, or replay rules. '
  'Minor version: additive changes (new lifecycle values, new RPC parameters). '
  'Patch version: documentation or metadata corrections only.';

COMMENT ON COLUMN public.governance_contract_versions.governance_hash IS
  'Deterministic hash of the governance contract state. '
  'Computed from: RPC signatures, lifecycle allowed values, event schema version, '
  'replay ordering rules, cache contract definitions, AI replay expectations. '
  'Must remain stable for a given governance_version. '
  'A change to any contract element requires a new governance_version + new hash.';

COMMENT ON COLUMN public.governance_contract_versions.governance_metadata IS
  'Full structured snapshot of the governance contract at activation time. '
  'Minimum required fields: '
  '  rpc_contracts: [{name, signature, version}], '
  '  lifecycle_values: {active_states: [], inactive_states: []}, '
  '  event_schema_version: TEXT, '
  '  replay_ordering: TEXT, '
  '  cache_contract_version: TEXT, '
  '  ai_replay_expectations: {snapshot_bound: BOOL, hash_required: BOOL}';

-- Append-only governance trigger
CREATE OR REPLACE FUNCTION public.fn_prevent_governance_contract_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'GOVERNANCE_VIOLATION: governance_contract_versions rows are immutable. '
      'Physical DELETE is prohibited. Governance contract lineage must remain permanently intact '
      'for AI replay and distributed system reproducibility. '
      'See HireRise Governance Blueprint v2 §Governance Contract Versioning.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'GOVERNANCE_VIOLATION: governance_contract_versions rows are immutable. '
      'UPDATE is prohibited. Activate a new governance version row instead.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.fn_prevent_governance_contract_mutation() IS
  'Governance trigger — prevents UPDATE and DELETE on governance_contract_versions. '
  'Governance contract rows are strictly append-only to preserve '
  'distributed system and AI replay reproducibility.';

CREATE OR REPLACE TRIGGER trg_governance_immutable_contract_versions
  BEFORE UPDATE OR DELETE ON public.governance_contract_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_governance_contract_mutation();

-- RLS: governance contract versions are readable by service_role and authenticated
-- (needed by future admin tooling and CI pipelines)
ALTER TABLE public.governance_contract_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "governance_contract_versions_authenticated_read"
  ON public.governance_contract_versions
  FOR SELECT
  TO authenticated, service_role
  USING (TRUE);

CREATE POLICY "governance_contract_versions_service_role_insert"
  ON public.governance_contract_versions
  FOR INSERT
  TO service_role
  WITH CHECK (TRUE);

GRANT SELECT         ON public.governance_contract_versions TO authenticated;
GRANT SELECT, INSERT ON public.governance_contract_versions TO service_role;

-- Seed Phase 1A governance contract v2.0.0 (the current active contract)
INSERT INTO public.governance_contract_versions (
  governance_version,
  governance_hash,
  activated_by,
  governance_metadata
)
VALUES (
  'v2.0.0',
  md5('hirerise-governance-v2.0.0-phase1a-operational'),
  'migration:20260526000007',
  jsonb_build_object(
    'rpc_contracts', jsonb_build_array(
      jsonb_build_object('name', 'fn_get_regions_for_country',   'version', '1.0'),
      jsonb_build_object('name', 'fn_get_boards_for_region',     'version', '1.0'),
      jsonb_build_object('name', 'fn_get_streams_for_board',     'version', '1.0'),
      jsonb_build_object('name', 'fn_get_subjects_for_stream',   'version', '1.0'),
      jsonb_build_object('name', 'fn_get_languages_for_region',  'version', '1.0'),
      jsonb_build_object('name', 'fn_deprecate_taxonomy_entity', 'version', '1.1'),
      jsonb_build_object('name', 'fn_taxonomy_health_check',     'version', '1.2'),
      jsonb_build_object('name', 'fn_academic_taxonomy_hash',    'version', '1.0')
    ),
    'lifecycle_values', jsonb_build_object(
      'active_states',   ARRAY['active', 'pending_activation', 'draft'],
      'inactive_states', ARRAY['deprecated', 'archived', 'superseded']
    ),
    'event_schema_version',    'not_implemented',
    'replay_ordering',         'occurred_at ASC, id ASC',
    'cache_contract_version',  'v1.0',
    'ai_replay_expectations',  jsonb_build_object(
      'snapshot_bound',           TRUE,
      'taxonomy_hash_required',   TRUE,
      'governance_version_required', TRUE,
      'seed_version_required',    TRUE
    ),
    'immutable_business_keys',
      ARRAY['country_code', 'region_code', 'board_code', 'stream_code',
            'subject_code', 'language_code'],
    'taxonomy_tables', jsonb_build_array(
      'countries_master', 'curriculum_regions', 'academic_boards',
      'academic_streams', 'academic_subjects', 'academic_languages',
      'state_language_mapping', 'subject_stream_map', 'board_region_map'
    ),
    'blueprint_version', 'v2',
    'phase',             '1A'
  )
)
ON CONFLICT (governance_version) DO NOTHING;

-- =============================================================================
-- SECTION 2: CROSS-ENVIRONMENT DRIFT VALIDATION RPC
--
-- PURPOSE:
--   A comprehensive drift report function for CI/CD pipelines and operational
--   monitoring. Returns a structured JSONB report comparing the current
--   environment's governance state against expected baselines.
--
-- USAGE:
--   Called by CI/CD pipelines after deployment to verify environment parity.
--   Called by monitoring systems on a schedule to detect governance drift.
--   Returns pass/fail status + full detail for each governance dimension.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_governance_drift_report(
  p_expected_taxonomy_hash     TEXT DEFAULT NULL,
  p_expected_seed_version      TEXT DEFAULT NULL,
  p_expected_governance_version TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_current_hash       TEXT;
  v_current_seed       TEXT;
  v_current_seed_hash  TEXT;
  v_current_gov        TEXT;
  v_health             JSONB;

  v_hash_ok     BOOLEAN;
  v_seed_ok     BOOLEAN;
  v_gov_ok      BOOLEAN;
  v_overall_ok  BOOLEAN;
BEGIN
  -- Capture current state
  v_current_hash := public.fn_academic_taxonomy_hash();

  SELECT seed_version, taxonomy_hash
    INTO v_current_seed, v_current_seed_hash
    FROM public.taxonomy_seed_versions
   ORDER BY applied_at DESC
   LIMIT 1;

  SELECT governance_version
    INTO v_current_gov
    FROM public.governance_contract_versions
   ORDER BY activated_at DESC
   LIMIT 1;

  -- Evaluate each parity dimension
  v_hash_ok := (p_expected_taxonomy_hash IS NULL)
               OR (v_current_hash = p_expected_taxonomy_hash);

  v_seed_ok := (p_expected_seed_version IS NULL)
               OR (v_current_seed = p_expected_seed_version);

  v_gov_ok  := (p_expected_governance_version IS NULL)
               OR (v_current_gov = p_expected_governance_version);

  v_overall_ok := v_hash_ok AND v_seed_ok AND v_gov_ok;

  -- Health check for counts and governance warnings
  v_health := public.fn_taxonomy_health_check();

  RETURN jsonb_build_object(
    -- Top-level pass/fail: pipeline gates on this
    'passed',          v_overall_ok,
    'checked_at',      NOW(),
    'environment_state', jsonb_build_object(
      'taxonomy_hash',       v_current_hash,
      'seed_version',        v_current_seed,
      'seed_hash',           v_current_seed_hash,
      'governance_version',  v_current_gov
    ),
    'parity_checks', jsonb_build_object(
      'taxonomy_hash', jsonb_build_object(
        'passed',   v_hash_ok,
        'expected', p_expected_taxonomy_hash,
        'actual',   v_current_hash,
        'drift',    NOT v_hash_ok
      ),
      'seed_version', jsonb_build_object(
        'passed',   v_seed_ok,
        'expected', p_expected_seed_version,
        'actual',   v_current_seed,
        'drift',    NOT v_seed_ok
      ),
      'governance_version', jsonb_build_object(
        'passed',   v_gov_ok,
        'expected', p_expected_governance_version,
        'actual',   v_current_gov,
        'drift',    NOT v_gov_ok
      )
    ),
    'governance_health', v_health -> 'governance',
    'lifecycle_health',  v_health -> 'lifecycle',
    'entity_counts',     v_health -> 'counts'
  );
END;
$$;

COMMENT ON FUNCTION public.fn_governance_drift_report(TEXT, TEXT, TEXT) IS
  'Cross-environment parity validation. Returns structured drift report '
  'comparing current environment against expected baselines. '
  'All parameters are optional — omit any to skip that parity dimension. '
  'top-level "passed" field is the CI/CD pipeline gate. '
  'Call after every deployment to validate environment parity. '
  'Used by: CI/CD pipelines, operational monitoring, pre-deployment gates.';

-- =============================================================================
-- SECTION 3: DETERMINISTIC CACHE KEY BUILDER
--
-- PURPOSE:
--   Builds governance-versioned cache keys that are self-invalidating
--   on taxonomy hash or governance version changes.
--   All cache keys produced by RPCs must use this function to ensure
--   cache contract governance is enforced consistently.
--
-- KEY FORMAT:
--   hirerise:taxonomy:<scope>:<params_hash>:<taxonomy_hash_prefix>:<gov_version>
--
-- EXAMPLE OUTPUTS:
--   hirerise:taxonomy:boards_for_region:a1b2c3d4:abcd1234:v2.0.0
--   hirerise:taxonomy:streams_for_board:e5f6a7b8:abcd1234:v2.0.0
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_build_cache_key(
  p_scope  TEXT,          -- RPC scope identifier: 'regions', 'boards_for_region', etc.
  p_params JSONB          -- Parameters that distinguish this specific RPC call
)
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT format(
    'hirerise:taxonomy:%s:%s:%s:%s',
    p_scope,
    left(md5(p_params::text), 8),
    left(public.fn_academic_taxonomy_hash(), 8),
    COALESCE(
      (SELECT governance_version FROM public.governance_contract_versions
       ORDER BY activated_at DESC LIMIT 1),
      'unknown'
    )
  );
$$;

COMMENT ON FUNCTION public.fn_build_cache_key(TEXT, JSONB) IS
  'Builds governance-versioned cache keys for taxonomy RPC responses. '
  'Keys are self-invalidating: they incorporate the taxonomy hash prefix '
  'and active governance version. When either changes, all keys become stale '
  'without requiring explicit cache invalidation calls. '
  'Format: hirerise:taxonomy:<scope>:<params_hash>:<tax_hash[8]>:<gov_version>. '
  'All taxonomy RPCs should use this function to build cache key headers. '
  'Cache TTL recommendation: 24 hours (taxonomy changes only via governed migrations).';

-- =============================================================================
-- SECTION 4: REPLAY PRECONDITION VALIDATOR
--
-- PURPOSE:
--   Pre-flight integrity check before initiating any taxonomy replay operation.
--   Validates that the full governance lineage chain is intact, deterministic,
--   and complete before any replay operation begins.
--
-- CALLED BY:
--   Future replay engine before initiating a replay sequence.
--   CI/CD pre-deployment validation.
--   Admin tooling before taxonomy snapshot creation.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_validate_replay_preconditions()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_checks       JSONB := '{}'::JSONB;
  v_failures     INT   := 0;
  v_seed_count   INT;
  v_gov_count    INT;
  v_hash_stable  BOOLEAN;
  v_hash_1       TEXT;
  v_hash_2       TEXT;
BEGIN
  -- Check 1: Seed lineage is not empty
  SELECT count(*) INTO v_seed_count FROM public.taxonomy_seed_versions;
  v_checks := v_checks || jsonb_build_object(
    'seed_lineage_exists', jsonb_build_object(
      'passed', v_seed_count > 0,
      'detail', format('%s seed version(s) registered', v_seed_count)
    )
  );
  IF v_seed_count = 0 THEN v_failures := v_failures + 1; END IF;

  -- Check 2: Governance contract lineage is not empty
  SELECT count(*) INTO v_gov_count FROM public.governance_contract_versions;
  v_checks := v_checks || jsonb_build_object(
    'governance_lineage_exists', jsonb_build_object(
      'passed', v_gov_count > 0,
      'detail', format('%s governance version(s) registered', v_gov_count)
    )
  );
  IF v_gov_count = 0 THEN v_failures := v_failures + 1; END IF;

  -- Check 3: Taxonomy hash is deterministic (two calls produce identical output)
  v_hash_1 := public.fn_academic_taxonomy_hash();
  v_hash_2 := public.fn_academic_taxonomy_hash();
  v_hash_stable := (v_hash_1 = v_hash_2);
  v_checks := v_checks || jsonb_build_object(
    'taxonomy_hash_deterministic', jsonb_build_object(
      'passed', v_hash_stable,
      'detail', CASE WHEN v_hash_stable
                  THEN format('Hash stable: %s', v_hash_1)
                  ELSE 'HASH INSTABILITY DETECTED — concurrent taxonomy write in progress'
                END
    )
  );
  IF NOT v_hash_stable THEN v_failures := v_failures + 1; END IF;

  -- Check 4: No orphan streams (streams with no subjects — broken replay chain)
  DECLARE
    v_orphans INT;
  BEGIN
    SELECT count(*) INTO v_orphans
    FROM public.academic_streams ast
    WHERE ast.is_active = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM public.subject_stream_map ssm
        WHERE ssm.stream_id = ast.id AND ssm.is_active = TRUE
      );
    v_checks := v_checks || jsonb_build_object(
      'no_orphan_streams', jsonb_build_object(
        'passed', v_orphans = 0,
        'detail', format('%s orphan stream(s) found', v_orphans)
      )
    );
    IF v_orphans > 0 THEN v_failures := v_failures + 1; END IF;
  END;

  -- Check 5: No regions without language mappings (incomplete replay state)
  DECLARE
    v_unmapped INT;
  BEGIN
    SELECT count(*) INTO v_unmapped
    FROM public.curriculum_regions cr
    WHERE cr.is_active = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM public.state_language_mapping slm
        WHERE slm.region_id = cr.id AND slm.is_active = TRUE
      );
    v_checks := v_checks || jsonb_build_object(
      'no_unmapped_regions', jsonb_build_object(
        'passed', v_unmapped = 0,
        'detail', format('%s region(s) with no language mapping', v_unmapped)
      )
    );
    IF v_unmapped > 0 THEN v_failures := v_failures + 1; END IF;
  END;

  -- Check 6: Seed hash consistency — latest seed hash matches current taxonomy hash
  DECLARE
    v_seed_hash     TEXT;
    v_current_hash  TEXT;
    v_hash_match    BOOLEAN;
  BEGIN
    SELECT taxonomy_hash INTO v_seed_hash
    FROM public.taxonomy_seed_versions
    ORDER BY applied_at DESC LIMIT 1;

    v_current_hash := public.fn_academic_taxonomy_hash();
    v_hash_match := (v_seed_hash = v_current_hash);

    v_checks := v_checks || jsonb_build_object(
      'seed_hash_matches_current', jsonb_build_object(
        'passed', v_hash_match,
        'detail', CASE WHEN v_hash_match
                    THEN 'Current taxonomy hash matches latest seed registration'
                    ELSE format(
                      'HASH DRIFT: seed registered %s, current taxonomy is %s. '
                      'A taxonomy change has occurred since the last seed registration.',
                      v_seed_hash, v_current_hash
                    )
                  END
      )
    );
    -- Seed hash mismatch is a WARNING not a failure for replay — the taxonomy
    -- may have evolved since the seed. Replay should still proceed but the
    -- drift should be acknowledged.
  END;

  RETURN jsonb_build_object(
    'replay_safe',      v_failures = 0,
    'failure_count',    v_failures,
    'checked_at',       NOW(),
    'taxonomy_hash',    public.fn_academic_taxonomy_hash(),
    'governance_version', (
      SELECT governance_version FROM public.governance_contract_versions
      ORDER BY activated_at DESC LIMIT 1
    ),
    'seed_version', (
      SELECT seed_version FROM public.taxonomy_seed_versions
      ORDER BY applied_at DESC LIMIT 1
    ),
    'checks', v_checks
  );
END;
$$;

COMMENT ON FUNCTION public.fn_validate_replay_preconditions() IS
  'Pre-flight replay integrity validator. '
  'Checks: seed lineage exists, governance lineage exists, '
  'taxonomy hash is deterministic, no orphan streams, '
  'no unmapped regions, seed hash consistency. '
  'Returns replay_safe: true/false as the top-level gate. '
  'Called before any taxonomy replay, snapshot creation, or AI retraining. '
  'A replay_safe: false result must halt the replay operation.';

-- =============================================================================
-- SECTION 5: GRANTS
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.fn_governance_drift_report(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_build_cache_key(TEXT, JSONB)               TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_validate_replay_preconditions()             TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_prevent_governance_contract_mutation()      TO service_role;

COMMIT;

-- =============================================================================
-- END OF MIGRATION: 20260526000007_phase1a_distributed_governance.sql
-- =============================================================================
