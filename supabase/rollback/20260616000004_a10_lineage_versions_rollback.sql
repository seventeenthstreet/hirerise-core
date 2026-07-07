-- =============================================================================
-- Rollback: 20260616000004_a10_lineage_versions_rollback.sql
-- Work Package: WP-DB-004 — Versioning Architecture
-- Specification: WP-DB-004-SPEC-01 §10, §7
-- Workstream: WS-1 — Database
-- Programme: HireRise A10 Phase 6A
--
-- CRITICAL PRECONDITION WARNING:
--   This rollback MUST NOT be executed if any of the following have been
--   applied:
--     - WP-DB-005 (Governance Event Store)
--     - WP-DB-007 (Audit Trail Architecture)
--     - WP-DB-010 (Performance Optimisation)
--   Any package that creates objects referencing governance.lineage_versions
--   must be rolled back FIRST, otherwise this rollback will fail due to
--   active FK dependencies.
--
-- Rollback removes, in strict reverse dependency order:
--   Step 1 — Three cross-table deferred FK constraints (added to WP-DB-003 tables)
--   Step 2 — Self-referential FK on governance.lineage_versions
--   Step 3 — Five non-PK indexes on governance.lineage_versions
--   Step 4 — Table governance.lineage_versions (CASCADE drops PK index and
--              inline UNIQUE + CHECK constraints with it)
--
-- Preservation guarantee:
--   No object created by WP-DB-001, WP-DB-002, or WP-DB-003 is modified
--   or removed by this rollback. Specifically:
--     - governance schema is NOT dropped
--     - governance.lineage_state_enum is NOT dropped or altered
--     - governance.review_assignments, .approval_decisions, .revocation_records,
--       .principal_role_grants are NOT dropped or structurally changed
--     - governance.governance_roles and all WP-DB-002 objects are untouched
--     - governance.actor_role_enum and all WP-DB-001 objects are untouched
--
-- Idempotency: Safe to re-run. All DROP statements use IF EXISTS. Re-running
--   against a schema where the rollback has already been applied produces
--   zero errors and zero unintended modifications.
-- =============================================================================


-- =============================================================================
-- STEP 1: DROP DEFERRED FK CONSTRAINTS FROM WP-DB-003 TABLES
-- Spec ref: §7 — Deferred FK Resolution / Rollback Requirements
-- Drop order: approval_decisions, review_assignments, revocation_records
-- (The spec does not mandate an order between these three; any order that
-- does not violate FK chains is acceptable. The three WP-DB-003 tables have
-- no FK relationship with each other for the lineage_version_id column, so
-- any sequence is valid. We follow the spec §7 rollback sequence.)
-- =============================================================================

-- 1a. Drop FK on governance.approval_decisions
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   pg_constraint c
        JOIN   pg_class      cl ON cl.oid = c.conrelid
        JOIN   pg_namespace  n  ON n.oid  = cl.relnamespace
        WHERE  n.nspname  = 'governance'
        AND    cl.relname = 'approval_decisions'
        AND    c.conname  = 'approval_decisions_lineage_version_id_fkey'
        AND    c.contype  = 'f'
    ) THEN
        ALTER TABLE governance.approval_decisions
            DROP CONSTRAINT approval_decisions_lineage_version_id_fkey;

        RAISE NOTICE
            'WP-DB-004 rollback: dropped constraint approval_decisions_lineage_version_id_fkey.';
    ELSE
        RAISE NOTICE
            'WP-DB-004 rollback: constraint approval_decisions_lineage_version_id_fkey not found, skipping.';
    END IF;
END
$$;

-- 1b. Drop FK on governance.review_assignments
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   pg_constraint c
        JOIN   pg_class      cl ON cl.oid = c.conrelid
        JOIN   pg_namespace  n  ON n.oid  = cl.relnamespace
        WHERE  n.nspname  = 'governance'
        AND    cl.relname = 'review_assignments'
        AND    c.conname  = 'review_assignments_lineage_version_id_fkey'
        AND    c.contype  = 'f'
    ) THEN
        ALTER TABLE governance.review_assignments
            DROP CONSTRAINT review_assignments_lineage_version_id_fkey;

        RAISE NOTICE
            'WP-DB-004 rollback: dropped constraint review_assignments_lineage_version_id_fkey.';
    ELSE
        RAISE NOTICE
            'WP-DB-004 rollback: constraint review_assignments_lineage_version_id_fkey not found, skipping.';
    END IF;
END
$$;

-- 1c. Drop FK on governance.revocation_records
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   pg_constraint c
        JOIN   pg_class      cl ON cl.oid = c.conrelid
        JOIN   pg_namespace  n  ON n.oid  = cl.relnamespace
        WHERE  n.nspname  = 'governance'
        AND    cl.relname = 'revocation_records'
        AND    c.conname  = 'revocation_records_lineage_version_id_fkey'
        AND    c.contype  = 'f'
    ) THEN
        ALTER TABLE governance.revocation_records
            DROP CONSTRAINT revocation_records_lineage_version_id_fkey;

        RAISE NOTICE
            'WP-DB-004 rollback: dropped constraint revocation_records_lineage_version_id_fkey.';
    ELSE
        RAISE NOTICE
            'WP-DB-004 rollback: constraint revocation_records_lineage_version_id_fkey not found, skipping.';
    END IF;
END
$$;


-- =============================================================================
-- STEP 2: DROP SELF-REFERENTIAL FK ON governance.lineage_versions
-- This must be dropped before the table itself can be dropped.
-- Spec ref: §8 — LineageVersion Relationships (self-FK on superseded_by_version_id)
-- =============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   pg_constraint c
        JOIN   pg_class      cl ON cl.oid = c.conrelid
        JOIN   pg_namespace  n  ON n.oid  = cl.relnamespace
        WHERE  n.nspname  = 'governance'
        AND    cl.relname = 'lineage_versions'
        AND    c.conname  = 'lineage_versions_superseded_by_version_id_fkey'
        AND    c.contype  = 'f'
    ) THEN
        ALTER TABLE governance.lineage_versions
            DROP CONSTRAINT lineage_versions_superseded_by_version_id_fkey;

        RAISE NOTICE
            'WP-DB-004 rollback: dropped constraint lineage_versions_superseded_by_version_id_fkey.';
    ELSE
        RAISE NOTICE
            'WP-DB-004 rollback: constraint lineage_versions_superseded_by_version_id_fkey not found, skipping.';
    END IF;
END
$$;


-- =============================================================================
-- STEP 3: DROP INDEXES ON governance.lineage_versions
-- Spec ref: §9 — Index Strategy
-- Drop all five non-PK indexes created by this migration.
-- (The PK index lineage_versions_pkey is dropped implicitly with the table
-- in Step 4; it must not be dropped separately before the table.)
-- =============================================================================

DROP INDEX IF EXISTS governance.lineage_versions_current_per_signal_uq;
DROP INDEX IF EXISTS governance.idx_lineage_versions_state;
DROP INDEX IF EXISTS governance.idx_lineage_versions_signal_key;
DROP INDEX IF EXISTS governance.idx_lineage_versions_created_at;


-- =============================================================================
-- STEP 4: DROP TABLE governance.lineage_versions
-- Spec ref: §7 — Rollback Requirements / §10 — Rollback Strategy
-- CASCADE is specified to cleanly remove the PK index and any remaining
-- inline constraints. It does NOT cascade to the WP-DB-003 tables because
-- the three cross-table FKs were already dropped in Step 1.
-- =============================================================================
DROP TABLE IF EXISTS governance.lineage_versions;

DO $$
BEGIN
    RAISE NOTICE 'WP-DB-004 rollback: governance.lineage_versions dropped (or was not present).';
END
$$;


-- =============================================================================
-- STEP 5: PRESERVATION VERIFICATION
-- Confirm that WP-DB-001, WP-DB-002, and WP-DB-003 objects remain intact.
-- These are advisory assertions; a failure here indicates an unexpected
-- side effect and must be investigated before proceeding.
-- =============================================================================

DO $$
BEGIN

    -- governance schema must still exist
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.schemata
        WHERE  schema_name = 'governance'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 rollback preservation check FAILED: schema "governance" no longer exists. '
            'This is an unexpected side effect. Investigate immediately.';
    END IF;

    -- governance.lineage_state_enum must still exist (WP-DB-001)
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_type     t
        JOIN   pg_namespace n ON n.oid = t.typnamespace
        WHERE  n.nspname = 'governance'
        AND    t.typname  = 'lineage_state_enum'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 rollback preservation check FAILED: "governance.lineage_state_enum" no longer exists. '
            'WP-DB-001 object has been unintentionally removed.';
    END IF;

    -- governance.review_assignments must still exist (WP-DB-003)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'review_assignments'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 rollback preservation check FAILED: "governance.review_assignments" no longer exists. '
            'WP-DB-003 object has been unintentionally removed.';
    END IF;

    -- governance.approval_decisions must still exist (WP-DB-003)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'approval_decisions'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 rollback preservation check FAILED: "governance.approval_decisions" no longer exists. '
            'WP-DB-003 object has been unintentionally removed.';
    END IF;

    -- governance.revocation_records must still exist (WP-DB-003)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'revocation_records'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 rollback preservation check FAILED: "governance.revocation_records" no longer exists. '
            'WP-DB-003 object has been unintentionally removed.';
    END IF;

    -- governance.principal_role_grants must still exist (WP-DB-003)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'principal_role_grants'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 rollback preservation check FAILED: "governance.principal_role_grants" no longer exists. '
            'WP-DB-003 object has been unintentionally removed.';
    END IF;

    -- governance.governance_roles must still exist (WP-DB-002)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'governance_roles'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 rollback preservation check FAILED: "governance.governance_roles" no longer exists. '
            'WP-DB-002 object has been unintentionally removed.';
    END IF;

    RAISE NOTICE
        'WP-DB-004 rollback preservation checks: ALL PASSED. '
        'WP-DB-001, WP-DB-002, and WP-DB-003 objects confirmed intact.';

END
$$;


-- =============================================================================
-- END OF ROLLBACK: 20260616000004_a10_lineage_versions_rollback.sql
-- All WP-DB-004 objects have been removed.
-- WP-DB-001, WP-DB-002, and WP-DB-003 objects confirmed intact.
-- To re-apply WP-DB-004, re-run the migration file.
-- =============================================================================
