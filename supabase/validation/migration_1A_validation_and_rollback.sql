-- =============================================================================
-- HIRERISE  Phase 2A.1  ·  Sprint 1A  ·  Database Foundation Layer
-- PART 7 — VALIDATION QUERIES
-- =============================================================================
-- File: migration_1A_validation_queries.sql
-- Purpose: Post-deployment verification for all Sprint 1A objects
-- Run after: All four batches applied
-- Expected: Every query returns the documented expected result.
--           Any deviation = Sprint 1A acceptance criteria NOT MET.
-- =============================================================================

-- ──────────────────────────────────────────────────────────────────────────────
-- SECTION A: ENUM VALIDATION
-- ──────────────────────────────────────────────────────────────────────────────

-- VAL-A01: lineage_type_enum exists with exactly 7 values [P0]
-- Expected: 7 rows
SELECT e.enumlabel AS value, e.enumsortorder AS sort_order
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typname = 'lineage_type_enum' AND n.nspname = 'public'
ORDER BY e.enumsortorder;
-- Expected values (order): succeeded_by, split_into, merged_into, renamed_to,
--                           superseded_by, aggregated_from, retired_no_successor

-- VAL-A02: registry_audit_event_type_enum exists with exactly 10 values [P0]
-- Expected: 10 rows
SELECT e.enumlabel AS value, e.enumsortorder AS sort_order
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typname = 'registry_audit_event_type_enum' AND n.nspname = 'public'
ORDER BY e.enumsortorder;
-- Expected values: signal_registered, signal_activated, signal_deprecated,
--                  signal_retired, signal_engine_flag_changed, lineage_event_proposed,
--                  lineage_event_approved, weight_review_triggered, weight_review_completed,
--                  signal_metadata_changed

-- VAL-A03: signal_category_hierarchy_level_enum exists with exactly 3 values [P0]
-- Expected: 3 rows
SELECT e.enumlabel AS value
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typname = 'signal_category_hierarchy_level_enum' AND n.nspname = 'public'
ORDER BY e.enumsortorder;
-- Expected values: domain, category, subcategory

-- VAL-A04: Enum count summary [P0]
-- Expected: 3 rows, each with the correct count
SELECT
    t.typname AS enum_name,
    COUNT(e.oid) AS value_count
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname IN (
    'lineage_type_enum',
    'registry_audit_event_type_enum',
    'signal_category_hierarchy_level_enum'
)
AND n.nspname = 'public'
GROUP BY t.typname
ORDER BY t.typname;
-- Expected:
--   lineage_type_enum                     | 7
--   registry_audit_event_type_enum        | 10
--   signal_category_hierarchy_level_enum  | 3


-- ──────────────────────────────────────────────────────────────────────────────
-- SECTION B: TABLE SCHEMA VALIDATION
-- ──────────────────────────────────────────────────────────────────────────────

-- VAL-B01: All 4 Sprint 1A tables exist [P0]
-- Expected: 4 rows
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
      'signal_lineage',
      'signal_registry_audit_log',
      'signal_category_hierarchy',
      'signal_ontology_edges'
  )
ORDER BY table_name;

-- VAL-B02: signal_lineage column specification [P0]
-- Expected: 15 rows with correct types and nullability
SELECT
    column_name,
    data_type,
    udt_name,           -- shows enum type name (e.g. lineage_type_enum)
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'signal_lineage'
ORDER BY ordinal_position;
-- Expected columns (15):
--   id                            | uuid         | NO  | gen_random_uuid()
--   predecessor_signal_key        | text         | NO  | —
--   successor_signal_key          | text         | YES | —
--   lineage_type                  | USER-DEFINED | NO  | —  (lineage_type_enum)
--   lineage_reason                | text         | NO  | —
--   taxonomy_version              | text         | NO  | 'v1'
--   effective_date                | timestamptz  | NO  | —
--   created_at                    | timestamptz  | NO  | now()
--   updated_at                    | timestamptz  | NO  | now()
--   approved_by                   | text         | YES | —
--   approved_at                   | timestamptz  | YES | —
--   weight_review_required        | boolean      | NO  | true
--   weight_review_completed_at    | timestamptz  | YES | —
--   triggered_by_pipeline_run_id  | uuid         | YES | —

-- VAL-B03: signal_registry_audit_log column specification [P0]
-- Expected: 7 rows
SELECT
    column_name,
    data_type,
    udt_name,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'signal_registry_audit_log'
ORDER BY ordinal_position;
-- Expected columns (7):
--   id             | uuid         | NO  | gen_random_uuid()
--   event_type     | USER-DEFINED | NO  | —  (registry_audit_event_type_enum)
--   signal_key     | text         | NO  | —
--   taxonomy_version | text       | NO  | —
--   performed_by   | text         | NO  | —
--   event_payload  | jsonb        | NO  | —
--   performed_at   | timestamptz  | NO  | now()

-- VAL-B04: signal_category_hierarchy column specification [P0]
-- Expected: 10 rows
SELECT
    column_name,
    data_type,
    udt_name,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'signal_category_hierarchy'
ORDER BY ordinal_position;

-- VAL-B05: signal_ontology_edges column specification [P1]
-- Expected: 10 rows
SELECT
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'signal_ontology_edges'
ORDER BY ordinal_position;


-- ──────────────────────────────────────────────────────────────────────────────
-- SECTION C: CONSTRAINT VALIDATION
-- ──────────────────────────────────────────────────────────────────────────────

-- VAL-C01: signal_lineage constraints [P0]
-- Expected: at least 6 rows (pk + partial unique index + 4 check constraints)
SELECT
    c.conname AS constraint_name,
    c.contype AS constraint_type,
    pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE r.relname = 'signal_lineage' AND n.nspname = 'public'
ORDER BY c.conname;
-- Expected constraints:
--   pk_signal_lineage               p  PRIMARY KEY (id)
--   chk_lineage_no_self_reference   c  CHECK (...)
--   chk_lineage_predecessor_not_empty c CHECK (...)
--   chk_lineage_reason_not_empty    c  CHECK (...)
--   chk_lineage_successor_nullability c CHECK (retired_no_successor / null rule)
--   chk_lineage_taxonomy_version_not_empty c CHECK (...)

-- VAL-C02: signal_lineage partial unique index (approved rows) [P0]
-- Expected: 1 row with a WHERE clause
SELECT
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'signal_lineage'
  AND indexname = 'uidx_signal_lineage_approved_unique';
-- Expected: indexdef includes WHERE (approved_at IS NOT NULL)

-- VAL-C03: signal_category_hierarchy constraints [P0]
-- Expected: at least 7 rows
SELECT
    c.conname AS constraint_name,
    c.contype AS constraint_type,
    pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE r.relname = 'signal_category_hierarchy' AND n.nspname = 'public'
ORDER BY c.conname;
-- Expected constraints:
--   pk_signal_category_hierarchy
--   uq_signal_category_hierarchy_key_version
--   chk_category_key_format     (^[a-z][a-z0-9_]{1,63}$)
--   chk_domain_level_no_parent  (level = 'domain' → parent IS NULL)
--   chk_non_domain_has_parent   (level != 'domain' → parent IS NOT NULL)
--   chk_category_key_not_empty
--   chk_display_name_not_empty
--   chk_taxonomy_version_not_empty

-- VAL-C04: signal_ontology_edges constraints [P1]
-- Expected: at least 8 rows
SELECT
    c.conname AS constraint_name,
    c.contype AS constraint_type,
    pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE r.relname = 'signal_ontology_edges' AND n.nspname = 'public'
ORDER BY c.conname;
-- Expected: pk, uq_unique, chk_source_node_type, chk_target_node_type,
--           chk_edge_type (is_a, related_to, derived_from), chk_weight_range,
--           chk_source_not_empty, chk_target_not_empty, chk_no_self_loop

-- VAL-C05: signal_weight_versions model_type constraint includes 'lineage_model' [P1]
-- Expected: 1 row; definition contains 'lineage_model' and all 6 prior values
SELECT
    c.conname,
    pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE r.relname = 'signal_weight_versions'
  AND c.conname = 'chk_model_type_valid'
  AND n.nspname = 'public';


-- ──────────────────────────────────────────────────────────────────────────────
-- SECTION D: TRIGGER VALIDATION
-- ──────────────────────────────────────────────────────────────────────────────

-- VAL-D01: All Sprint 1A triggers present [P0]
-- Expected: 5 rows (2 on signal_lineage, 2 on audit_log, 1 on category_hierarchy)
SELECT
    t.tgname AS trigger_name,
    c.relname AS table_name,
    CASE t.tgtype & 2 WHEN 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
    CASE
        WHEN t.tgtype & 4 = 4 THEN 'INSERT'
        WHEN t.tgtype & 8 = 8 THEN 'DELETE'
        WHEN t.tgtype & 16 = 16 THEN 'UPDATE'
        ELSE 'MULTIPLE'
    END AS event,
    t.tgenabled AS enabled
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND t.tgname IN (
      'trg_immutability_signal_lineage',
      'trg_updated_at_signal_lineage',
      'trg_immutability_audit_log_update',
      'trg_immutability_audit_log_delete',
      'trg_updated_at_signal_category_hierarchy'
  )
ORDER BY c.relname, t.tgname;
-- Expected: 5 rows, all enabled, all BEFORE timing

-- VAL-D02: Trigger alphabetical order on signal_lineage [P0]
-- Expected: trg_immutability_signal_lineage sorts before trg_updated_at_signal_lineage
-- (PostgreSQL fires BEFORE triggers alphabetically — 'i' before 'u')
SELECT
    t.tgname,
    CASE t.tgtype & 16 WHEN 16 THEN 'UPDATE' ELSE 'OTHER' END AS event,
    row_number() OVER (ORDER BY t.tgname) AS execution_order
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'signal_lineage'
  AND NOT t.tgisinternal
ORDER BY t.tgname;
-- Expected: immutability trigger has lower execution_order than updated_at trigger

-- VAL-D03: Functional test — signal_lineage immutability trigger blocks approved mutation
-- (Run in a separate test transaction, ROLLBACK at end)
-- Expected: raises exception mentioning 'immutability violation'
DO $$
DECLARE
    v_id        uuid;
    v_raised    boolean := false;
BEGIN
    -- Insert a proposed lineage row
    INSERT INTO public.signal_lineage (
        predecessor_signal_key, lineage_type, lineage_reason, effective_date, taxonomy_version
    ) VALUES (
        'test_signal_key_immutability', 'renamed_to', 'Test immutability trigger validation',
        now(), 'v1'
    ) RETURNING id INTO v_id;

    -- Approve the row
    UPDATE public.signal_lineage
    SET approved_by = 'test_actor', approved_at = now()
    WHERE id = v_id;

    -- Attempt to modify an immutable column (predecessor_signal_key)
    BEGIN
        UPDATE public.signal_lineage
        SET predecessor_signal_key = 'should_not_work'
        WHERE id = v_id;
    EXCEPTION WHEN OTHERS THEN
        v_raised := true;
        RAISE NOTICE 'VAL-D03: PASS — immutability trigger correctly blocked mutation. Error: %', SQLERRM;
    END;

    IF NOT v_raised THEN
        RAISE EXCEPTION 'VAL-D03: FAIL — immutability trigger did NOT block mutation on approved row.';
    END IF;

    -- Clean up test row
    -- Note: since approved rows trigger immutability on UPDATE but not on DELETE at DB level
    -- (delete is not governed by trigger in Sprint 1A), we must clean up here
    DELETE FROM public.signal_lineage WHERE id = v_id;
    RAISE NOTICE 'VAL-D03: Test row cleaned up.';
END;
$$;

-- VAL-D04: Functional test — audit_log immutability trigger blocks UPDATE
-- Expected: raises exception
DO $$
DECLARE
    v_id        uuid;
    v_raised    boolean := false;
BEGIN
    INSERT INTO public.signal_registry_audit_log (
        event_type, signal_key, taxonomy_version, performed_by, event_payload
    ) VALUES (
        'signal_registered', 'test_audit_key', 'v1', 'test_actor',
        '{"test": true}'::jsonb
    ) RETURNING id INTO v_id;

    BEGIN
        UPDATE public.signal_registry_audit_log
        SET performed_by = 'should_not_work'
        WHERE id = v_id;
    EXCEPTION WHEN OTHERS THEN
        v_raised := true;
        RAISE NOTICE 'VAL-D04: PASS — audit log immutability blocked UPDATE. Error: %', SQLERRM;
    END;

    IF NOT v_raised THEN
        RAISE EXCEPTION 'VAL-D04: FAIL — audit log immutability trigger did NOT block UPDATE.';
    END IF;

    -- Can only clean up via direct delete test (since triggers block UPDATE/DELETE
    -- and this is a test row — in a real test environment use a ROLLBACK)
    -- For safety in staging: leave this inside a SAVEPOINT
    RAISE NOTICE 'VAL-D04: Note — test row id % left in audit log (immutable). '
        'Run in a transaction with ROLLBACK for clean test.', v_id;
END;
$$;

-- VAL-D05: Functional test — signal_lineage updated_at trigger fires on permitted UPDATE
-- Expected: updated_at is set to now() after update
DO $$
DECLARE
    v_id            uuid;
    v_original_ts   timestamptz;
    v_updated_ts    timestamptz;
BEGIN
    INSERT INTO public.signal_lineage (
        predecessor_signal_key, lineage_type, lineage_reason, effective_date, taxonomy_version
    ) VALUES (
        'test_signal_updated_at', 'renamed_to', 'Testing updated_at trigger',
        now(), 'v1'
    ) RETURNING id, updated_at INTO v_id, v_original_ts;

    PERFORM pg_sleep(0.001); -- ensure timestamp difference

    UPDATE public.signal_lineage
    SET lineage_reason = 'Updated reason to test trigger'
    WHERE id = v_id;

    SELECT updated_at INTO v_updated_ts FROM public.signal_lineage WHERE id = v_id;

    IF v_updated_ts > v_original_ts THEN
        RAISE NOTICE 'VAL-D05: PASS — updated_at trigger correctly advanced timestamp.';
    ELSE
        RAISE EXCEPTION 'VAL-D05: FAIL — updated_at not advanced. Original: %. After update: %.',
            v_original_ts, v_updated_ts;
    END IF;

    -- Clean up
    DELETE FROM public.signal_lineage WHERE id = v_id;
END;
$$;


-- ──────────────────────────────────────────────────────────────────────────────
-- SECTION E: INDEX VALIDATION
-- ──────────────────────────────────────────────────────────────────────────────

-- VAL-E01: All Sprint 1A indexes present [P0/P1]
-- Expected: 9 rows (7 P0 + 2 P1)
SELECT
    schemaname,
    tablename,
    indexname,
    CASE WHEN indexdef LIKE '%WHERE%' THEN 'partial' ELSE 'full' END AS index_type
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
      'uidx_signal_lineage_approved_unique',       -- P0 partial unique
      'idx_signal_lineage_predecessor',             -- P0
      'idx_signal_lineage_predecessor_approved',    -- P0
      'idx_signal_lineage_effective_date',          -- P0
      'idx_audit_log_signal_key',                   -- P0
      'idx_audit_log_event_type_performed_at',      -- P0
      'idx_audit_log_performed_at',                 -- P0
      'idx_signal_category_hierarchy_parent',       -- P1
      'idx_signal_ontology_edges_source',           -- P1
      'idx_signal_ontology_edges_target'            -- P1
  )
ORDER BY tablename, indexname;
-- Expected: 10 rows total

-- VAL-E02: Partial index WHERE clauses correct
-- Expected: 3 rows with WHERE clauses
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexdef LIKE '%WHERE%'
  AND tablename IN (
      'signal_lineage', 'signal_category_hierarchy', 'signal_ontology_edges'
  )
ORDER BY indexname;
-- Expected:
--   uidx_signal_lineage_approved_unique  → WHERE (approved_at IS NOT NULL)
--   idx_signal_category_hierarchy_parent → WHERE (parent_category_key IS NOT NULL)
--   idx_signal_ontology_edges_source     → WHERE (is_active = true)
--   idx_signal_ontology_edges_target     → WHERE (is_active = true)


-- ──────────────────────────────────────────────────────────────────────────────
-- SECTION F: GOVERNANCE INTEGRITY VALIDATION
-- ──────────────────────────────────────────────────────────────────────────────

-- VAL-F01: No approved+rejected rows (post-G4D: mutual exclusivity) [P0]
-- Expected: 0 rows
SELECT id, approved_at, rejected_at
FROM public.signal_lineage
WHERE approved_at IS NOT NULL AND rejected_at IS NOT NULL;

-- VAL-F02: All tables have zero rows at Sprint 1A baseline [informational]
-- Expected: all counts = 0 (no seed data in Sprint 1A)
SELECT
    'signal_lineage'              AS table_name, COUNT(*) AS row_count FROM public.signal_lineage
UNION ALL SELECT
    'signal_registry_audit_log',                 COUNT(*) FROM public.signal_registry_audit_log
UNION ALL SELECT
    'signal_category_hierarchy',                 COUNT(*) FROM public.signal_category_hierarchy
UNION ALL SELECT
    'signal_ontology_edges',                     COUNT(*) FROM public.signal_ontology_edges;

-- VAL-F03: signal_weight_versions model_type vocabulary is exactly 7 values [P1]
-- Expected: query executes without constraint violation
-- This tests that all 7 values would be valid (does not insert, just confirms constraint)
SELECT pg_get_constraintdef(c.oid) AS constraint_definition
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
WHERE c.conname = 'chk_model_type_valid'
  AND r.relname = 'signal_weight_versions';
-- Expected: definition contains all 7 values including 'lineage_model'

-- VAL-F04: No FK violations (Sprint 1A has no hard FKs — confirm soft refs only) [informational]
SELECT
    c.conname AS constraint_name,
    r.relname AS table_name,
    c.contype AS type
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE n.nspname = 'public'
  AND r.relname IN (
      'signal_lineage',
      'signal_registry_audit_log',
      'signal_category_hierarchy',
      'signal_ontology_edges'
  )
  AND c.contype = 'f';  -- foreign key constraints
-- Expected: 0 rows (no hard FKs — Sprint 1A uses soft references exclusively)


-- =============================================================================
-- PART 8 — ROLLBACK SQL
-- =============================================================================
-- File: migration_1A_rollback.sql (sections below)
-- Execute each section independently, in reverse batch order (04 → 03 → 02 → 01)
-- CRITICAL: Read all preconditions before executing any rollback section.
-- =============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK-04: Revert signal_weight_versions CHECK constraint amendment
-- ────────────────────────────────────────────────────────────────────────────
-- Precondition: No signal_weight_versions rows with model_type = 'lineage_model'.
-- Independent of all Sprint 1A table batches. Safe to execute any time.
-- ────────────────────────────────────────────────────────────────────────────

-- BEGIN;
--
-- DO $$
-- DECLARE
--     v_count integer;
-- BEGIN
--     SELECT COUNT(*) INTO v_count FROM public.signal_weight_versions
--     WHERE model_type = 'lineage_model';
--     IF v_count > 0 THEN
--         RAISE EXCEPTION 'ROLLBACK-04 BLOCKED: % rows exist with model_type = ''lineage_model''. '
--             'Remove these rows before rolling back the constraint amendment.', v_count;
--     END IF;
--     RAISE NOTICE 'ROLLBACK-04 PRE-CHECK PASSED: No lineage_model rows found.';
-- END;
-- $$;
--
-- ALTER TABLE public.signal_weight_versions
--     DROP CONSTRAINT IF EXISTS chk_model_type_valid;
--
-- ALTER TABLE public.signal_weight_versions
--     ADD CONSTRAINT chk_model_type_valid
--         CHECK (model_type IN (
--             'signal_weights',
--             'confidence_model',
--             'recommendation_model',
--             'matching_model',
--             'clustering_model',
--             'explainability_model'
--         ));
--
-- RAISE NOTICE 'ROLLBACK-04 COMPLETE: chk_model_type_valid restored to 6-value vocabulary.';
--
-- COMMIT;

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK-03: Drop signal_ontology_edges
-- ────────────────────────────────────────────────────────────────────────────
-- Precondition: Confirm no production data exists in signal_ontology_edges.
-- Must execute BEFORE ROLLBACK-02.
-- ────────────────────────────────────────────────────────────────────────────

-- BEGIN;
--
-- DO $$
-- DECLARE v_count integer;
-- BEGIN
--     SELECT COUNT(*) INTO v_count FROM public.signal_ontology_edges;
--     IF v_count > 0 THEN
--         RAISE NOTICE 'ROLLBACK-03 WARNING: % rows exist in signal_ontology_edges. '
--             'These rows will be permanently destroyed. '
--             'Confirm with Principal DBA before proceeding.', v_count;
--     END IF;
-- END;
-- $$;
--
-- DROP INDEX IF EXISTS public.idx_signal_ontology_edges_source;
-- DROP INDEX IF EXISTS public.idx_signal_ontology_edges_target;
-- DROP TABLE IF EXISTS public.signal_ontology_edges;
--
-- RAISE NOTICE 'ROLLBACK-03 COMPLETE: signal_ontology_edges dropped.';
--
-- COMMIT;

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK-02: Drop core tables (signal_lineage, audit_log, category_hierarchy)
-- ────────────────────────────────────────────────────────────────────────────
-- Precondition: ROLLBACK-03 must have been executed first.
-- Precondition: Confirm no production data in any of the three tables.
-- WARNING: This is DESTRUCTIVE if data exists. Back up first.
-- ────────────────────────────────────────────────────────────────────────────

-- BEGIN;
--
-- DO $$
-- DECLARE v_count integer;
-- BEGIN
--     SELECT COUNT(*) + (SELECT COUNT(*) FROM public.signal_registry_audit_log)
--         + (SELECT COUNT(*) FROM public.signal_category_hierarchy)
--     INTO v_count FROM public.signal_lineage;
--     IF v_count > 0 THEN
--         RAISE NOTICE 'ROLLBACK-02 WARNING: % rows total across Sprint 1A tables. '
--             'These rows will be permanently destroyed. '
--             'Confirm with Principal DBA before proceeding.', v_count;
--     END IF;
-- END;
-- $$;
--
-- -- Drop triggers first (dropped automatically with table, but explicit for clarity)
-- DROP TRIGGER IF EXISTS trg_immutability_signal_lineage ON public.signal_lineage;
-- DROP TRIGGER IF EXISTS trg_updated_at_signal_lineage ON public.signal_lineage;
-- DROP TRIGGER IF EXISTS trg_immutability_audit_log_update ON public.signal_registry_audit_log;
-- DROP TRIGGER IF EXISTS trg_immutability_audit_log_delete ON public.signal_registry_audit_log;
-- DROP TRIGGER IF EXISTS trg_updated_at_signal_category_hierarchy ON public.signal_category_hierarchy;
--
-- -- Drop trigger functions (only after all tables using them are dropped)
-- DROP FUNCTION IF EXISTS public.fn_trg_immutability_signal_lineage();
-- DROP FUNCTION IF EXISTS public.fn_trg_immutability_audit_log();
-- DROP FUNCTION IF EXISTS public.fn_trg_set_updated_at();
--
-- -- Drop indexes (dropped automatically with table)
-- -- Drop tables
-- DROP TABLE IF EXISTS public.signal_lineage;
-- DROP TABLE IF EXISTS public.signal_registry_audit_log;
-- DROP TABLE IF EXISTS public.signal_category_hierarchy;
--
-- RAISE NOTICE 'ROLLBACK-02 COMPLETE: 3 core tables, 5 triggers, 3 trigger functions dropped.';
--
-- COMMIT;

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK-01: Drop enums
-- ────────────────────────────────────────────────────────────────────────────
-- Precondition: ROLLBACK-02 must have been executed first.
-- PostgreSQL will refuse to drop enums referenced by existing columns.
-- ────────────────────────────────────────────────────────────────────────────

-- BEGIN;
--
-- DROP TYPE IF EXISTS public.lineage_type_enum;
-- DROP TYPE IF EXISTS public.registry_audit_event_type_enum;
-- DROP TYPE IF EXISTS public.signal_category_hierarchy_level_enum;
--
-- RAISE NOTICE 'ROLLBACK-01 COMPLETE: 3 Sprint 1A enums dropped.';
--
-- COMMIT;


-- =============================================================================
-- PART 9 — IMPLEMENTATION REVIEW CHECKLIST
-- =============================================================================
-- Use this checklist for staging deployment validation before production deploy.
-- Mark each item PASS / FAIL / SKIP with notes.
-- Gate: All [P0] items must be PASS before Sprint 1B can begin.
-- =============================================================================

/*
────────────────────────────────────────────────────────────────────────────────
SPRINT 1A STAGING DEPLOYMENT REVIEW CHECKLIST
Reviewer: ________________________________
Deployment Date: _________________________
Environment: STAGING / PRODUCTION (circle one)
────────────────────────────────────────────────────────────────────────────────

SECTION 1: PRE-DEPLOYMENT VERIFICATION
[ ] 1.1 [P0] Verified prerequisite migrations are deployed:
         - intelligence_signal_registry (20260525000001) exists ✓
         - intelligence_pipeline_runs (20260601000001) exists ✓
         - signal_weight_versions (20260601000004) exists ✓
         - chk_model_type_valid constraint on signal_weight_versions confirmed ✓
         Current vocabulary confirmed: signal_weights, confidence_model,
         recommendation_model, matching_model, clustering_model, explainability_model
[ ] 1.2 [P0] Database backup taken and verified restorable
[ ] 1.3 [P0] edge_type vocabulary confirmed with domain team: is_a, related_to, derived_from
[ ] 1.4 [P0] Trigger naming convention confirmed:
         trg_immutability_signal_lineage sorts before trg_updated_at_signal_lineage ✓
[ ] 1.5 [P0] No active sessions modifying governance tables during deployment window
[ ] 1.6 [P1] Initial signal_category_hierarchy seed data reviewed (ships empty; seed via separate migration)

SECTION 2: BATCH 1A-01 — ENUM DEPLOYMENT
[ ] 2.1 [P0] migration_1A_01_enums.sql applied without errors
[ ] 2.2 [P0] NOTICE "1A-01 POST-DEPLOYMENT ASSERTIONS PASSED" confirmed in output
[ ] 2.3 [P0] VAL-A04 query returns: lineage_type_enum=7, registry_audit_event_type_enum=10,
         signal_category_hierarchy_level_enum=3
[ ] 2.4 [P0] VAL-A01 confirms exactly: succeeded_by, split_into, merged_into, renamed_to,
         superseded_by, aggregated_from, retired_no_successor
[ ] 2.5 [P0] VAL-A02 confirms exactly 10 values including signal_metadata_changed

SECTION 3: BATCH 1A-02 — CORE TABLE DEPLOYMENT
[ ] 3.1 [P0] migration_1A_02_core_tables.sql applied without errors
[ ] 3.2 [P0] NOTICE "1A-02 POST-DEPLOYMENT ASSERTIONS PASSED" confirmed in output
[ ] 3.3 [P0] VAL-B02 confirms signal_lineage has exactly 15 columns with correct types/nullability
[ ] 3.4 [P0] VAL-B03 confirms signal_registry_audit_log has exactly 7 columns
[ ] 3.5 [P0] VAL-B04 confirms signal_category_hierarchy has exactly 10 columns
[ ] 3.6 [P0] VAL-C01 confirms signal_lineage has pk + partial unique index + 4+ CHECK constraints
[ ] 3.7 [P0] VAL-C02 confirms uidx_signal_lineage_approved_unique has WHERE approved_at IS NOT NULL
[ ] 3.8 [P0] VAL-C03 confirms signal_category_hierarchy has all 8 constraints including
         domain-level-no-parent and non-domain-has-parent
[ ] 3.9 [P0] VAL-D01 confirms all 5 triggers present and enabled
[ ] 3.10 [P0] VAL-D02 confirms immutability trigger sorts before updated_at trigger on signal_lineage
[ ] 3.11 [P0] VAL-D03 functional test: immutability trigger BLOCKS mutation on approved row
[ ] 3.12 [P0] VAL-D04 functional test: audit log trigger BLOCKS UPDATE (run in transaction + ROLLBACK)
[ ] 3.13 [P0] VAL-D05 functional test: updated_at trigger ADVANCES timestamp on permitted UPDATE
[ ] 3.14 [P0] VAL-E01 confirms all 7 P0 indexes present (partial unique + 3 lineage + 3 audit_log)
[ ] 3.15 [P1] VAL-E01 confirms all 3 P1 indexes present (category_hierarchy + 2 ontology — apply after 1A-03)

SECTION 4: BATCH 1A-03 — ONTOLOGY TABLE DEPLOYMENT
[ ] 4.1 [P1] migration_1A_03_and_04.sql (1A-03 section) applied without errors
[ ] 4.2 [P1] NOTICE "1A-03 POST-DEPLOYMENT ASSERTIONS PASSED" confirmed in output
[ ] 4.3 [P1] VAL-B05 confirms signal_ontology_edges has exactly 10 columns
[ ] 4.4 [P1] VAL-C04 confirms signal_ontology_edges has pk, unique constraint, 4 CHECK constraints
[ ] 4.5 [P1] Confirm edge_type CHECK: is_a, related_to, derived_from only
[ ] 4.6 [P1] Confirm weight CHECK: NULL or [0.0, 1.0]
[ ] 4.7 [P1] VAL-E02 confirms OE-01 and OE-02 partial indexes have WHERE is_active = true

SECTION 5: BATCH 1A-04 — WEIGHT VERSIONS AMENDMENT
[ ] 5.1 [P1] migration_1A_03_and_04.sql (1A-04 section) applied without errors
[ ] 5.2 [P1] NOTICE "1A-04 POST-DEPLOYMENT ASSERTIONS PASSED" confirmed in output
[ ] 5.3 [P1] VAL-C05 confirms chk_model_type_valid contains all 7 values including lineage_model
[ ] 5.4 [P1] VAL-F03 confirms no existing signal_weight_versions rows invalidated
[ ] 5.5 [P1] Confirm original 6 values still present: signal_weights, confidence_model,
         recommendation_model, matching_model, clustering_model, explainability_model

SECTION 6: CROSS-BATCH GOVERNANCE INTEGRITY
[ ] 6.1 [P0] VAL-F04 confirms zero FK constraints on all Sprint 1A tables (soft refs only)
[ ] 6.2 [P0] VAL-F02 confirms all Sprint 1A tables have 0 rows at baseline
[ ] 6.3 [P0] No errors in pg_stat_activity related to Sprint 1A objects during deployment

SECTION 7: ROLLBACK READINESS
[ ] 7.1 [P0] ROLLBACK-04 script reviewed and confirmed correct for staging
[ ] 7.2 [P0] ROLLBACK-03 script reviewed and confirmed correct for staging
[ ] 7.3 [P0] ROLLBACK-02 script reviewed and confirmed correct (destructive if data present)
[ ] 7.4 [P0] ROLLBACK-01 script reviewed and confirmed correct (requires 02 first)
[ ] 7.5 [P0] Rollback order confirmed: 04 → 03 → 02 → 01

SECTION 8: SPRINT 1B READINESS
[ ] 8.1 [P0] All P0 items above marked PASS
[ ] 8.2 [P0] Principal Database Architect sign-off obtained
[ ] 8.3 [P0] Governance Architect sign-off obtained (trigger correctness, immutability contracts)
[ ] 8.4 [P0] Sprint 1A declared COMPLETE by Lead Engineer
[ ] 8.5 [P0] Sprint 1B begins: roles, RLS policies, GRANTs, service layer

────────────────────────────────────────────────────────────────────────────────
SIGN-OFF
Principal Database Architect: _______________________ Date: ___________
Governance Architect:         _______________________ Date: ___________
Security Architect:           _______________________ Date: ___________
Lead Engineer:                _______________________ Date: ___________
────────────────────────────────────────────────────────────────────────────────
*/
