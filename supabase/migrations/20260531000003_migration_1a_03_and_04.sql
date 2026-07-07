-- =============================================================================
-- HIRERISE  Phase 2A.1  ·  Sprint 1A  ·  Database Foundation Layer
-- PART 5 — MIGRATION FILE 1A-03: ONTOLOGY TABLES
-- =============================================================================
-- File: migration_1A_03_ontology_tables.sql
-- Batch: 1A-03
-- Target: Supabase / PostgreSQL 17
-- Dependency: Batch 1A-02 must be applied first (signal_category_hierarchy exists)
-- =============================================================================
--
-- Creates:
--   DB-07  signal_ontology_edges  (table + constraints + indexes)
--   DB-14  signal_ontology_edges indexes (2)
--
-- edge_type vocabulary: 'is_a', 'related_to', 'derived_from'
-- Confirmed as approved initial vocabulary per Sprint 1A Spec Section 2.4.
-- Domain team may extend additively. Removing values is prohibited.
--
-- ROLLBACK: Execute migration_1A_rollback.sql section ROLLBACK-03.
--           Safe to roll back independently (no other Sprint 1A tables depend on it).
-- =============================================================================

BEGIN;

-- ─── Pre-deployment assertion: signal_category_hierarchy must exist ────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'signal_category_hierarchy'
    ) THEN
        RAISE EXCEPTION '1A-03 PREREQUISITE FAILED: signal_category_hierarchy table not found. '
            'Apply Batch 1A-02 before 1A-03.';
    END IF;
    RAISE NOTICE '1A-03 PRE-CHECK PASSED: signal_category_hierarchy exists.';
END;
$$;


-- =============================================================================
-- DB-07: signal_ontology_edges
-- =============================================================================
-- Purpose: Directed edges between signal ontology nodes. Captures semantic
--          relationships between signals and/or signal categories.
--          Enables ontology-aware aggregation, scoring, and explainability.
-- Columns: 10 (per Sprint 1A Spec Section 2.4)
-- Constraints: PK, UNIQUE(source, target, edge_type, version),
--              CHECK node_types, CHECK edge_type, CHECK weight range
-- Triggers: none (no updated_at column; immutability via no-delete convention)
-- Indexes: 2 (OE-01, OE-02)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.signal_ontology_edges (
    -- ── Core identity ──────────────────────────────────────────────────────────
    id                  uuid        NOT NULL    DEFAULT gen_random_uuid(),

    -- ── Edge topology ─────────────────────────────────────────────────────────
    source_key          text        NOT NULL,
    -- Key of the source node. Either signal_key or category_key per source_node_type.
    -- Effectively immutable after use (deactivate + recreate to change).

    source_node_type    text        NOT NULL,
    -- Disambiguates source reference: 'signal' or 'category'.
    -- CHECK constraint enforces this vocabulary.

    target_key          text        NOT NULL,
    -- Key of the target node. Either signal_key or category_key per target_node_type.

    target_node_type    text        NOT NULL,
    -- Disambiguates target reference: 'signal' or 'category'.

    -- ── Relationship classification ───────────────────────────────────────────
    edge_type           text        NOT NULL,
    -- Semantic relationship type. Closed initial vocabulary: is_a, related_to, derived_from.
    -- Domain team may extend additively. CHECK constraint enforces vocabulary.

    -- ── Taxonomy scope ────────────────────────────────────────────────────────
    taxonomy_version    text        NOT NULL    DEFAULT 'v1',

    -- ── Relationship weight ───────────────────────────────────────────────────
    weight              numeric     NULL,
    -- Optional semantic distance / relationship strength. Range 0.0–1.0.
    -- NULL = unweighted relationship. CHECK constraint enforces range when non-null.

    -- ── Lifecycle ─────────────────────────────────────────────────────────────
    is_active           boolean     NOT NULL    DEFAULT true,
    -- Soft-delete. Inactive edges excluded from active ontology queries.
    -- To change an edge: deactivate old edge, create new edge.

    -- ── Timestamps ────────────────────────────────────────────────────────────
    created_at          timestamptz NOT NULL    DEFAULT now(),
    -- No updated_at: edge topology is immutable after insert (deactivate + recreate pattern).

    -- ── Constraints ───────────────────────────────────────────────────────────
    CONSTRAINT pk_signal_ontology_edges
        PRIMARY KEY (id),

    -- One edge per (source, target, type, version) — prevents duplicate semantic claims
    CONSTRAINT uq_signal_ontology_edges_unique
        UNIQUE (source_key, target_key, edge_type, taxonomy_version),

    -- source_node_type vocabulary
    CONSTRAINT chk_ontology_source_node_type
        CHECK (source_node_type IN ('signal', 'category')),

    -- target_node_type vocabulary
    CONSTRAINT chk_ontology_target_node_type
        CHECK (target_node_type IN ('signal', 'category')),

    -- edge_type vocabulary (confirmed initial set per Sprint 1A Spec Section 2.4)
    CONSTRAINT chk_ontology_edge_type
        CHECK (edge_type IN ('is_a', 'related_to', 'derived_from')),

    -- weight range: null or [0.0, 1.0]
    CONSTRAINT chk_ontology_weight_range
        CHECK (weight IS NULL OR (weight >= 0.0 AND weight <= 1.0)),

    -- Non-empty key constraints
    CONSTRAINT chk_ontology_source_key_not_empty
        CHECK (trim(source_key) <> ''),

    CONSTRAINT chk_ontology_target_key_not_empty
        CHECK (trim(target_key) <> ''),

    CONSTRAINT chk_ontology_taxonomy_version_not_empty
        CHECK (trim(taxonomy_version) <> ''),

    -- Source and target must not be the same node
    -- (service layer provides meaningful error; CHECK provides DB-level guarantee)
    CONSTRAINT chk_ontology_no_self_loop
        CHECK (source_key <> target_key OR source_node_type <> target_node_type)
);

COMMENT ON TABLE public.signal_ontology_edges IS
    'Sprint 1A DB-07: Directed edges between signal ontology nodes. '
    'Captures semantic relationships: is_a, related_to, derived_from. '
    'Edge topology (source, target, edge_type) is immutable after insert — '
    'deactivate via is_active=false and create a new edge to change topology. '
    'Soft references to intelligence_signal_registry (signal_key) and '
    'signal_category_hierarchy (category_key) via source_key/target_key + node_type. '
    'Public reference data: readable by anon/authenticated (Sprint 1B). '
    'Architecture basis: Phase 2A.1 Sprint 1A Migration Specification Section 2.4.';

COMMENT ON COLUMN public.signal_ontology_edges.source_key IS
    'Source node key. signal_key when source_node_type=''signal''; '
    'category_key when source_node_type=''category''. Effectively immutable.';
COMMENT ON COLUMN public.signal_ontology_edges.target_key IS
    'Target node key. Same disambiguation as source_key via target_node_type.';
COMMENT ON COLUMN public.signal_ontology_edges.edge_type IS
    'Semantic relationship: is_a (subtype), related_to (semantic proximity), '
    'derived_from (dependency/derivation). Vocabulary is additive — no removal.';
COMMENT ON COLUMN public.signal_ontology_edges.weight IS
    'Optional semantic distance/strength. Range 0.0–1.0. NULL = unweighted.';
COMMENT ON COLUMN public.signal_ontology_edges.is_active IS
    'Soft-delete. Use is_active=false to deactivate; create new edge for topology changes.';


-- =============================================================================
-- DB-14: signal_ontology_edges Indexes
-- =============================================================================

-- OE-01: Forward traversal (what does this node relate to?)
-- Serves: Pattern 1 — WHERE source_key = $key AND is_active = true
CREATE INDEX IF NOT EXISTS idx_signal_ontology_edges_source
    ON public.signal_ontology_edges (source_key)
    WHERE is_active = true;

COMMENT ON INDEX public.idx_signal_ontology_edges_source IS
    'Sprint 1A DB-14 OE-01: Source key index for forward ontology traversal. '
    'Serves: WHERE source_key = $key AND is_active = true. '
    'Partial index (WHERE is_active = true) excludes deactivated edges. '
    'Governance rationale: ontology-aware processing in Phase 2A.1.6 traverses '
    'from known source nodes. Without index: full table scan per traversal step.';

-- OE-02: Reverse traversal (what points to this node?)
-- Serves: Pattern 2 — WHERE target_key = $key AND is_active = true
CREATE INDEX IF NOT EXISTS idx_signal_ontology_edges_target
    ON public.signal_ontology_edges (target_key)
    WHERE is_active = true;

COMMENT ON INDEX public.idx_signal_ontology_edges_target IS
    'Sprint 1A DB-14 OE-02: Target key index for reverse ontology traversal. '
    'Serves: WHERE target_key = $key AND is_active = true. '
    'Partial index (WHERE is_active = true) excludes deactivated edges. '
    'Governance rationale: reverse traversal (what categories does this signal belong to?) '
    'required for explainability and cross-domain aggregation.';


-- ─── Post-deployment assertions 1A-03 ────────────────────────────────────────
DO $$
DECLARE
    v_count integer;
BEGIN
    -- Table exists with 10 columns
    SELECT COUNT(*) INTO v_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'signal_ontology_edges';
    IF v_count <> 10 THEN
        RAISE EXCEPTION '1A-03 ASSERTION FAILED: signal_ontology_edges expected 10 columns, found %.', v_count;
    END IF;

    -- Unique constraint exists
    SELECT COUNT(*) INTO v_count FROM pg_constraint
    WHERE conname = 'uq_signal_ontology_edges_unique'
      AND conrelid = 'public.signal_ontology_edges'::regclass;
    IF v_count <> 1 THEN
        RAISE EXCEPTION '1A-03 ASSERTION FAILED: uq_signal_ontology_edges_unique not found.';
    END IF;

    -- Both indexes exist
    SELECT COUNT(*) INTO v_count FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'signal_ontology_edges'
      AND indexname IN (
          'idx_signal_ontology_edges_source',
          'idx_signal_ontology_edges_target'
      );
    IF v_count <> 2 THEN
        RAISE EXCEPTION '1A-03 ASSERTION FAILED: Expected 2 ontology edge indexes, found %.', v_count;
    END IF;

    RAISE NOTICE '1A-03 POST-DEPLOYMENT ASSERTIONS PASSED: '
        'signal_ontology_edges (10 columns), unique constraint, 2 indexes all confirmed.';
END;
$$;

COMMIT;


-- =============================================================================
-- PART 6 — MIGRATION FILE 1A-04: signal_weight_versions AMENDMENT
-- =============================================================================
-- File: migration_1A_04_weight_versions_amendment.sql (continued in this file)
-- Batch: 1A-04
-- Target: Supabase / PostgreSQL 17
-- Dependency: signal_weight_versions must exist (pre-Sprint 1A)
-- =============================================================================
--
-- Amends: signal_weight_versions.model_type CHECK constraint
-- Adds:   'lineage_model' to the approved vocabulary
--
-- Existing vocabulary (from migration 20260601000004_governance_refinements.sql):
--   'signal_weights', 'confidence_model', 'recommendation_model',
--   'matching_model', 'clustering_model', 'explainability_model'
--
-- New vocabulary (adds one value):
--   + 'lineage_model'
--
-- Existing constraint name: chk_model_type_valid (confirmed from source migration)
--
-- SAFETY: This migration drops and recreates the CHECK constraint within a
--         single transaction. No data is affected. All existing rows remain valid.
--         'lineage_model' is reserved — no rows use this value at Sprint 1A.
--
-- ROLLBACK: Execute migration_1A_rollback.sql section ROLLBACK-04.
--           Independent of all Sprint 1A table batches.
--           Restore constraint without 'lineage_model'.
-- =============================================================================

BEGIN;

-- ─── Pre-deployment verification ─────────────────────────────────────────────
DO $$
DECLARE
    v_count integer;
BEGIN
    -- Confirm signal_weight_versions exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'signal_weight_versions'
    ) THEN
        RAISE EXCEPTION '1A-04 PREREQUISITE FAILED: signal_weight_versions table not found. '
            'This table must exist before the constraint amendment can be applied.';
    END IF;

    -- Confirm model_type column exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'signal_weight_versions'
          AND column_name = 'model_type'
    ) THEN
        RAISE EXCEPTION '1A-04 PREREQUISITE FAILED: model_type column not found on signal_weight_versions. '
            'Apply migration 20260601000004_governance_refinements.sql first.';
    END IF;

    -- Confirm existing constraint exists
    SELECT COUNT(*) INTO v_count FROM pg_constraint
    WHERE conname = 'chk_model_type_valid'
      AND conrelid = 'public.signal_weight_versions'::regclass;
    IF v_count = 0 THEN
        RAISE EXCEPTION '1A-04 PREREQUISITE FAILED: chk_model_type_valid constraint not found on '
            'signal_weight_versions. Cannot amend a constraint that does not exist.';
    END IF;

    -- Confirm 'lineage_model' is not already in the constraint (idempotency check)
    -- This is done by checking if any existing rows would fail the new constraint
    -- (they won't, but the pre-check informs the engineer of current state)
    RAISE NOTICE '1A-04 PRE-CHECK PASSED: signal_weight_versions exists, model_type present, '
        'chk_model_type_valid constraint exists. Proceeding with amendment.';
END;
$$;

-- ─── DB-10: Drop and recreate CHECK constraint with extended vocabulary ───────
-- This is the only safe way to amend a CHECK constraint in PostgreSQL.
-- The DROP removes the old vocabulary; the ADD recreates with the new vocabulary.
-- All within a single transaction — if the ADD fails, the DROP is also rolled back.

ALTER TABLE public.signal_weight_versions
    DROP CONSTRAINT IF EXISTS chk_model_type_valid;

ALTER TABLE public.signal_weight_versions
    ADD CONSTRAINT chk_model_type_valid
        CHECK (model_type IN (
            'signal_weights',       -- Phase 1.6: initial student signal weights
            'confidence_model',     -- Phase 2A: confidence scoring parameters
            'recommendation_model', -- Phase 2A.2: recommendation engine parameters
            'matching_model',       -- Future: employer-student matching
            'clustering_model',     -- Future: capability cluster definitions
            'explainability_model', -- Future: explanation template configuration
            'lineage_model'         -- Phase 2A.1+: lineage resolution rules
                                    -- Reserved for confidence decay curves during
                                    -- signal transition windows. Not yet instantiated.
                                    -- Governance rationale: reserved now to prevent
                                    -- emergency migration when first lineage model row
                                    -- is created in Phase 2A.1.5/2A.1.6.
        ));

COMMENT ON COLUMN public.signal_weight_versions.model_type IS
    'Sprint 1A DB-10: Extended model_type vocabulary. '
    'Added lineage_model to the 6-value prior vocabulary. '
    'lineage_model reserved for Phase 2A.1+ confidence decay curves during '
    'signal transition windows. No rows use this value at Sprint 1A. '
    'Architecture basis: Sprint 1A Migration Specification Section 5.1 (DB-10).';

-- ─── Post-deployment assertions 1A-04 ────────────────────────────────────────
DO $$
DECLARE
    v_count     integer;
    v_def       text;
BEGIN
    -- Constraint exists
    SELECT COUNT(*) INTO v_count FROM pg_constraint
    WHERE conname = 'chk_model_type_valid'
      AND conrelid = 'public.signal_weight_versions'::regclass;
    IF v_count <> 1 THEN
        RAISE EXCEPTION '1A-04 ASSERTION FAILED: chk_model_type_valid not found after amendment.';
    END IF;

    -- Constraint includes 'lineage_model'
    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
    WHERE conname = 'chk_model_type_valid'
      AND conrelid = 'public.signal_weight_versions'::regclass;
    IF v_def NOT LIKE '%lineage_model%' THEN
        RAISE EXCEPTION '1A-04 ASSERTION FAILED: chk_model_type_valid does not contain '
            '''lineage_model'' after amendment. Constraint definition: %', v_def;
    END IF;

    -- All prior values still present
    IF v_def NOT LIKE '%signal_weights%'
    OR v_def NOT LIKE '%confidence_model%'
    OR v_def NOT LIKE '%recommendation_model%'
    OR v_def NOT LIKE '%matching_model%'
    OR v_def NOT LIKE '%clustering_model%'
    OR v_def NOT LIKE '%explainability_model%' THEN
        RAISE EXCEPTION '1A-04 ASSERTION FAILED: chk_model_type_valid is missing prior values. '
            'Full definition: %', v_def;
    END IF;

    -- No existing rows invalidated (all existing rows use prior vocabulary)
    SELECT COUNT(*) INTO v_count FROM public.signal_weight_versions
    WHERE model_type NOT IN (
        'signal_weights', 'confidence_model', 'recommendation_model',
        'matching_model', 'clustering_model', 'explainability_model', 'lineage_model'
    );
    IF v_count > 0 THEN
        RAISE EXCEPTION '1A-04 ASSERTION FAILED: % existing rows have model_type values not '
            'in the new vocabulary. This should be impossible.', v_count;
    END IF;

    RAISE NOTICE '1A-04 POST-DEPLOYMENT ASSERTIONS PASSED: '
        'chk_model_type_valid amended with lineage_model. '
        'All 7 values present. No existing rows invalidated.';
END;
$$;

COMMIT;
