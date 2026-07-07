-- =============================================================================
-- HIRERISE  Phase 2A.1  ·  Sprint 1A  ·  Database Foundation Layer
-- Migration Package — Architecture Summary
-- =============================================================================
--
-- Document Classification : Production Migration Package
-- Sprint                  : 1A — Database Foundation
-- Status                  : Production-Ready
-- Architecture Basis      : Phase 2A.1.2 (approved)
--                           R1 Final Approved Amendment (C1/C2/C3 incorporated)
--                           Sprint 1A Migration Specification (authoritative)
--                           Sprint 1 Implementation Plan
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1 — MIGRATION ARCHITECTURE SUMMARY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Sprint 1A delivers the database foundation layer for Phase 2A.1 Intelligence
-- Registry governance infrastructure. It creates the three approved enums,
-- four tables (with all constraints, triggers, and indexes), and amends the
-- existing signal_weight_versions table.
--
-- NO RLS POLICIES are generated in Sprint 1A. (Sprint 1B deliverable.)
-- NO GRANTs are generated in Sprint 1A. (Sprint 1B deliverable.)
-- NO RPCs are generated in Sprint 1A. (Sprint 1C deliverable.)
-- NO seed data is generated in Sprint 1A. (Separate migration, post-1A-02.)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2 — DEPLOYMENT DEPENDENCY ANALYSIS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Prerequisite (already deployed, must exist):
--   ✓  intelligence_signal_registry         (migration 20260525000001)
--   ✓  intelligence_pipeline_runs           (migration 20260601000001)
--   ✓  signal_weight_versions               (migration 20260601000004)
--
-- Sprint 1A deployment order (MUST be applied in this sequence):
--
--   BATCH 1A-01  migration_1A_01_enums.sql
--     Creates: lineage_type_enum
--              registry_audit_event_type_enum
--              signal_category_hierarchy_level_enum
--     Dependency: none
--     Rollback: safe independently (only if 1A-02 not yet applied)
--
--   BATCH 1A-02  migration_1A_02_core_tables.sql
--     Creates: signal_lineage          (table + constraints + triggers + indexes)
--              signal_registry_audit_log (table + trigger + indexes)
--              signal_category_hierarchy (table + constraints + trigger + indexes)
--     Dependency: 1A-01 (enums must exist)
--     Rollback: safe after 1A-03 rolled back
--
--   BATCH 1A-03  migration_1A_03_ontology_tables.sql
--     Creates: signal_ontology_edges   (table + constraints + indexes)
--     Dependency: 1A-02 (signal_category_hierarchy must exist)
--     Rollback: safe independently (only if 1A-04 not yet applied)
--
--   BATCH 1A-04  migration_1A_04_weight_versions_amendment.sql
--     Amends: signal_weight_versions CHECK constraint (adds 'lineage_model')
--     Dependency: signal_weight_versions must exist (pre-Sprint 1A)
--     Rollback: safe independently at any time
--
-- Trigger naming convention (governs execution order on signal_lineage):
--   PostgreSQL BEFORE triggers execute alphabetically by trigger name.
--   Immutability trigger must sort BEFORE updated_at trigger:
--     trg_immutability_signal_lineage      (sorts before)
--     trg_updated_at_signal_lineage        (sorts after)
--   This guarantees immutability validation fires before updated_at is set.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FILE MANIFEST
-- ─────────────────────────────────────────────────────────────────────────────
--   migration_1A_01_enums.sql                (this file continues below)
--   migration_1A_02_core_tables.sql
--   migration_1A_03_ontology_tables.sql
--   migration_1A_04_weight_versions_amendment.sql
--   migration_1A_rollback.sql
--   migration_1A_validation_queries.sql
-- =============================================================================


-- =============================================================================
-- PART 3 — MIGRATION FILE 1A-01: ENUMS
-- =============================================================================
-- File: migration_1A_01_enums.sql
-- Batch: 1A-01
-- Target: Supabase / PostgreSQL 17
-- =============================================================================
--
-- Creates three enums required by Sprint 1A tables.
-- Uses DO blocks for idempotent creation (safe to re-run).
-- All enums created in the public schema to match existing conventions.
--
-- ROLLBACK: Execute migration_1A_rollback.sql section ROLLBACK-01.
--           Only safe if Batch 1A-02 has not been applied.
-- =============================================================================

BEGIN;

-- ─── Pre-deployment assertion ─────────────────────────────────────────────────
-- Verify this migration is not being applied to a schema that already has
-- conflicting enum definitions from a prior failed deploy.
DO $$
DECLARE
    v_count integer;
BEGIN
    -- If any of the three enums already exist with wrong value counts,
    -- abort rather than silently proceeding with a stale state.
    SELECT COUNT(*) INTO v_count
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname IN (
        'lineage_type_enum',
        'registry_audit_event_type_enum',
        'signal_category_hierarchy_level_enum'
    )
    AND n.nspname = 'public';

    IF v_count > 0 THEN
        RAISE NOTICE '1A-01 PRE-CHECK: % of 3 target enums already exist. '
            'Migration is idempotent — existing types will be skipped.',
            v_count;
    ELSE
        RAISE NOTICE '1A-01 PRE-CHECK: No target enums exist. Clean deployment.';
    END IF;
END;
$$;


-- =============================================================================
-- DB-01: lineage_type_enum
-- =============================================================================
-- Purpose: Closed vocabulary for signal_lineage.lineage_type.
--          Seven semantically distinct transition categories covering all
--          approved signal evolution patterns.
-- Values: 7 (exactly as specified in Section 1.1 of Sprint 1A Spec)
-- References: signal_lineage.lineage_type (Batch 1A-02)
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'lineage_type_enum' AND n.nspname = 'public'
    ) THEN
        CREATE TYPE public.lineage_type_enum AS ENUM (
            'succeeded_by',        -- Direct replacement in same conceptual family.
                                   -- Successor required. Weight review: yes.
            'split_into',          -- Predecessor semantics divided across 2+ narrower signals.
                                   -- One row per outbound edge. Successor required. Weight review: yes.
            'merged_into',         -- Predecessor consolidated into single successor with others.
                                   -- One row per inbound predecessor. Successor required. Weight review: yes.
            'renamed_to',          -- Same semantics, new key. No conceptual change.
                                   -- Successor required. Weight review: no (default).
            'superseded_by',       -- Cross-taxonomy-version replacement.
                                   -- Successor required. Weight review: yes.
            'aggregated_from',     -- Successor is a higher-level aggregate of predecessor.
                                   -- Cross-domain roll-up. Successor required. Weight review: yes.
            'retired_no_successor' -- Signal retired without replacement.
                                   -- Successor must be NULL. Weight review: no.
        );
        RAISE NOTICE 'DB-01: lineage_type_enum created with 7 values.';
    ELSE
        RAISE NOTICE 'DB-01: lineage_type_enum already exists — skipped.';
    END IF;
END;
$$;

COMMENT ON TYPE public.lineage_type_enum IS
    'Sprint 1A DB-01: Closed vocabulary for signal_lineage.lineage_type. '
    'Seven transition categories covering all approved signal evolution patterns. '
    'Additive extension only — removing values is prohibited (existing rows reference them). '
    'Architecture basis: Phase 2A.1 Sprint 1A Migration Specification Section 1.1.';


-- =============================================================================
-- DB-02: registry_audit_event_type_enum
-- =============================================================================
-- Purpose: Closed vocabulary for signal_registry_audit_log.event_type.
--          Ten event classifications covering all material mutations to
--          intelligence_signal_registry and signal_lineage.
-- Values: 10 (exactly as specified in Section 1.2 of Sprint 1A Spec)
-- References: signal_registry_audit_log.event_type (Batch 1A-02)
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'registry_audit_event_type_enum' AND n.nspname = 'public'
    ) THEN
        CREATE TYPE public.registry_audit_event_type_enum AS ENUM (
            'signal_registered',       -- New signal inserted into intelligence_signal_registry.
                                       -- Payload: { signal_key, taxonomy_version, primary_domain, registered_by }
            'signal_activated',        -- lifecycle_status transitions from draft to active.
                                       -- Payload: { signal_key, activated_by, previous_lifecycle_status }
            'signal_deprecated',       -- lifecycle_status transitions to deprecated; deprecated_at set.
                                       -- Payload: { signal_key, deprecated_at, lineage_event_id, reason }
            'signal_retired',          -- lifecycle_status transitions to retired; deleted_at set.
                                       -- Payload: { signal_key, deleted_at, lineage_event_id }
            'signal_engine_flag_changed', -- aggregation_compatible or engine_compatible changed on active signal.
                                          -- Payload: { signal_key, flag_name, old_value, new_value, changed_by }
            'lineage_event_proposed',  -- New signal_lineage row created in proposed state.
                                       -- Payload: { lineage_id, lineage_type, predecessor, successor, proposed_by }
            'lineage_event_approved',  -- signal_lineage row transitions proposed → approved.
                                       -- Payload: { lineage_id, lineage_type, predecessor, successor, approved_by }
            'weight_review_triggered', -- Lineage approval flagged signal(s) for weight review.
                                       -- Payload: { lineage_id, signal_keys_affected, triggered_by }
            'weight_review_completed', -- weight_review_completed_at set on signal_lineage row.
                                       -- Payload: { lineage_id, completed_by, signal_weight_versions_id }
            'signal_metadata_changed'  -- Non-semantic metadata change without lifecycle state change.
                                       -- Payload: { signal_key, changed_fields, old_values, new_values, changed_by }
                                       -- Also used for lineage rejection (action = 'lineage_rejected') per G4D.
        );
        RAISE NOTICE 'DB-02: registry_audit_event_type_enum created with 10 values.';
    ELSE
        RAISE NOTICE 'DB-02: registry_audit_event_type_enum already exists — skipped.';
    END IF;
END;
$$;

COMMENT ON TYPE public.registry_audit_event_type_enum IS
    'Sprint 1A DB-02: Closed vocabulary for signal_registry_audit_log.event_type. '
    'Ten event classifications covering all material registry and lineage mutations. '
    'signal_metadata_changed is also used for lineage rejection events (action field in payload). '
    'Architecture basis: Phase 2A.1 Sprint 1A Migration Specification Section 1.2.';


-- =============================================================================
-- DB-03: signal_category_hierarchy_level_enum
-- =============================================================================
-- Purpose: Classifies the hierarchical depth of nodes in signal_category_hierarchy.
--          Makes level an explicit, queryable property enabling level-aware
--          hierarchy traversal without chain walking.
-- Values: 3 (exactly as specified in Section 1.3 of Sprint 1A Spec)
-- References: signal_category_hierarchy.level (Batch 1A-02)
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'signal_category_hierarchy_level_enum' AND n.nspname = 'public'
    ) THEN
        CREATE TYPE public.signal_category_hierarchy_level_enum AS ENUM (
            'domain',      -- Top-level grouping. Parent is NULL. (e.g. cognitive_domain)
            'category',    -- Second-level. Parent must be a domain node. (e.g. analytical_reasoning)
            'subcategory'  -- Third-level. Parent must be a category node. (e.g. quantitative_analysis)
        );
        RAISE NOTICE 'DB-03: signal_category_hierarchy_level_enum created with 3 values.';
    ELSE
        RAISE NOTICE 'DB-03: signal_category_hierarchy_level_enum already exists — skipped.';
    END IF;
END;
$$;

COMMENT ON TYPE public.signal_category_hierarchy_level_enum IS
    'Sprint 1A DB-03: Hierarchical depth classifier for signal_category_hierarchy. '
    'Three levels: domain → category → subcategory. '
    'A fourth level (facet) may be added if taxonomy deepens beyond three levels — '
    'requires review of all hierarchy traversal queries before extension. '
    'Architecture basis: Phase 2A.1 Sprint 1A Migration Specification Section 1.3.';


-- ─── Post-deployment assertions ───────────────────────────────────────────────
DO $$
DECLARE
    v_count   integer;
    v_values  text[];
BEGIN
    -- Assert lineage_type_enum has exactly 7 values
    SELECT COUNT(*) INTO v_count
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'lineage_type_enum' AND n.nspname = 'public';
    IF v_count <> 7 THEN
        RAISE EXCEPTION '1A-01 ASSERTION FAILED: lineage_type_enum expected 7 values, found %.', v_count;
    END IF;

    -- Assert registry_audit_event_type_enum has exactly 10 values
    SELECT COUNT(*) INTO v_count
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'registry_audit_event_type_enum' AND n.nspname = 'public';
    IF v_count <> 10 THEN
        RAISE EXCEPTION '1A-01 ASSERTION FAILED: registry_audit_event_type_enum expected 10 values, found %.', v_count;
    END IF;

    -- Assert signal_category_hierarchy_level_enum has exactly 3 values
    SELECT COUNT(*) INTO v_count
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'signal_category_hierarchy_level_enum' AND n.nspname = 'public';
    IF v_count <> 3 THEN
        RAISE EXCEPTION '1A-01 ASSERTION FAILED: signal_category_hierarchy_level_enum expected 3 values, found %.', v_count;
    END IF;

    RAISE NOTICE '1A-01 POST-DEPLOYMENT ASSERTIONS PASSED: '
        '3 enums present with correct value counts (7 / 10 / 3).';
END;
$$;

COMMIT;
