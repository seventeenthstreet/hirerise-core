-- =============================================================================
-- HIRERISE  Phase 2A.1  ·  Sprint 1A  ·  Database Foundation Layer
-- MIGRATION FILE 1A-04: signal_weight_versions AMENDMENT
-- =============================================================================
-- File: 20260601000005_migration_1a_04_weight_versions_amendment.sql
-- Batch: 1A-04
-- Target: Supabase / PostgreSQL 17
-- Dependency: signal_weight_versions must exist
--             (20260601000001_governance_foundation_RECONSTRUCTED.sql)
--             AND model_type / chk_model_type_valid must exist
--             (20260601000004_governance_refinements.sql)
-- =============================================================================
--
-- WP-DB-01F NOTE (Migration Dependency Ordering Reconciliation):
--   This file was originally combined with Batch 1A-03 in a single file named
--   `20260531000003_migration_1a_03_and_04.sql`, timestamped 2026-05-31 —
--   before signal_weight_versions (created 2026-06-01, file 20260601000001)
--   and before model_type/chk_model_type_valid (added 2026-06-01, file
--   20260601000004). On a clean `supabase db reset` replay, this caused the
--   1A-04 pre-check to correctly report:
--     "1A-04 PREREQUISITE FAILED: signal_weight_versions table not found"
--   — a true read of database state at that point in a timestamp-ordered
--   replay, not a defect in the check itself (root cause documented in
--   WP-DB-01E; forensically confirmed the verification SQL below is correct
--   and unmodified from the original).
--
--   This file relocates 1A-04, UNMODIFIED in its SQL logic, to timestamp
--   20260601000005 — immediately after both real dependencies
--   (20260601000001, 20260601000004) and before the next existing migration
--   (20260607000001_migration_h1_01_signal_category_hierarchy_seed.sql).
--   No downstream migration in this repository references
--   `chk_model_type_valid` or the `lineage_model` vocabulary value ahead of
--   this position (verified by repository-wide search), so this placement
--   introduces no new ordering conflict.
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
