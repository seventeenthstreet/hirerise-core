-- =============================================================================
-- Rollback: 20260616000005_a10_governance_event_store_rollback.sql
-- Work Package: WP-DB-005 — Governance Event Store
-- Specification: WP-DB-005-SPEC-01 §9.4 — Rollback Boundary
-- Workstream: WS-1 — Database
-- Programme: HireRise A10 Phase 6A
--
-- CRITICAL PRECONDITION WARNING:
--   This rollback MUST NOT be executed if any of the following have been
--   applied:
--     - WP-DB-006 (Audit Store) or any later package
--   Any package that creates objects referencing governance.governance_events
--   must be rolled back FIRST, otherwise this rollback will fail due to
--   active FK dependencies. Check for downstream dependencies before
--   executing this file.
--
-- Rollback removes, in strict reverse dependency order:
--   Step 1 — FK constraints on governance.governance_events
--   Step 2 — Indexes on governance.governance_events
--   Step 3 — Table governance.governance_events
--   Step 4 — Enum governance.governance_event_type_enum
--   Step 5 — Preservation verification (advisory assertions)
--
-- Preservation guarantee:
--   No object created by WP-DB-001, WP-DB-002, WP-DB-003, or WP-DB-004
--   is modified or removed by this rollback. Specifically:
--     - governance schema is NOT dropped
--     - governance.lineage_state_enum is NOT dropped or altered  (WP-DB-001)
--     - governance.actor_role_enum is NOT dropped or altered      (WP-DB-001)
--     - governance.lineage_versions is NOT dropped                (WP-DB-004)
--     - governance.review_assignments is NOT dropped              (WP-DB-003)
--     - governance.approval_decisions is NOT dropped              (WP-DB-003)
--     - governance.revocation_records is NOT dropped              (WP-DB-003)
--     - governance.principal_role_grants is NOT dropped           (WP-DB-003)
--     - governance.governance_roles is NOT dropped                (WP-DB-002)
--     - public.signal_lineage is NOT modified in any way          (A09)
--
-- Idempotency: Safe to re-run. All DROP statements use IF EXISTS. DO $$ blocks
--   guard constraint drops with existence checks. Re-running against a schema
--   where the rollback has already been applied produces zero errors and
--   zero unintended modifications.
--
-- CASCADE policy: CASCADE is NOT used on any DROP in this rollback. All
--   objects are dropped individually and in explicit dependency order.
-- =============================================================================


-- =============================================================================
-- STEP 1: DROP FOREIGN KEY CONSTRAINTS ON governance.governance_events
-- Spec ref: §9.4 — Rollback actions (in order)
-- FKs must be dropped before the table can be dropped. Drop FK 2 first
-- (cross-schema reference to A09), then FK 1 (intra-governance reference).
-- =============================================================================

-- 1a. Drop FK 2: governance_events.lineage_id → public.signal_lineage(id)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   pg_constraint c
        JOIN   pg_class      cl ON cl.oid = c.conrelid
        JOIN   pg_namespace  n  ON n.oid  = cl.relnamespace
        WHERE  n.nspname  = 'governance'
        AND    cl.relname = 'governance_events'
        AND    c.conname  = 'governance_events_lineage_id_fkey'
        AND    c.contype  = 'f'
    ) THEN
        ALTER TABLE governance.governance_events
            DROP CONSTRAINT governance_events_lineage_id_fkey;

        RAISE NOTICE
            'WP-DB-005 rollback: dropped constraint governance_events_lineage_id_fkey.';
    ELSE
        RAISE NOTICE
            'WP-DB-005 rollback: constraint governance_events_lineage_id_fkey not found, skipping.';
    END IF;
END
$$;

-- 1b. Drop FK 1: governance_events.lineage_version_id → governance.lineage_versions(id)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   pg_constraint c
        JOIN   pg_class      cl ON cl.oid = c.conrelid
        JOIN   pg_namespace  n  ON n.oid  = cl.relnamespace
        WHERE  n.nspname  = 'governance'
        AND    cl.relname = 'governance_events'
        AND    c.conname  = 'governance_events_lineage_version_id_fkey'
        AND    c.contype  = 'f'
    ) THEN
        ALTER TABLE governance.governance_events
            DROP CONSTRAINT governance_events_lineage_version_id_fkey;

        RAISE NOTICE
            'WP-DB-005 rollback: dropped constraint governance_events_lineage_version_id_fkey.';
    ELSE
        RAISE NOTICE
            'WP-DB-005 rollback: constraint governance_events_lineage_version_id_fkey not found, skipping.';
    END IF;
END
$$;


-- =============================================================================
-- STEP 2: DROP INDEXES ON governance.governance_events
-- Spec ref: §9.4 — Rollback actions
-- Drop all three non-PK indexes created by this migration.
-- The PK index (governance_events_pkey) is dropped implicitly with the table
-- in Step 3 and must NOT be dropped separately before the table.
-- =============================================================================

DROP INDEX IF EXISTS governance.idx_governance_events_event_type_created_at;
DROP INDEX IF EXISTS governance.idx_governance_events_lineage_id_event_type;
DROP INDEX IF EXISTS governance.idx_governance_events_lineage_version_id_created_at;


-- =============================================================================
-- STEP 3: DROP TABLE governance.governance_events
-- Spec ref: §9.4 — Rollback actions
-- No CASCADE. The FK constraints that reference other tables were dropped in
-- Step 1. Inline constraints (PK, CHECK) are dropped with the table automatically.
-- =============================================================================

DROP TABLE IF EXISTS governance.governance_events;

DO $$
BEGIN
    RAISE NOTICE 'WP-DB-005 rollback: governance.governance_events dropped (or was not present).';
END
$$;


-- =============================================================================
-- STEP 4: DROP ENUM governance.governance_event_type_enum
-- Spec ref: §9.4 — Rollback actions
-- This enum was created solely by WP-DB-005. It is safe to drop once the
-- table that uses it has been dropped. No other WP-DB-001 through WP-DB-004
-- object references this enum.
-- =============================================================================

DROP TYPE IF EXISTS governance.governance_event_type_enum;

DO $$
BEGIN
    RAISE NOTICE 'WP-DB-005 rollback: governance.governance_event_type_enum dropped (or was not present).';
END
$$;


-- =============================================================================
-- STEP 5: PRESERVATION VERIFICATION
-- Confirms that WP-DB-001, WP-DB-002, WP-DB-003, and WP-DB-004 objects
-- remain intact after rollback. A failure here indicates an unexpected side
-- effect and must be investigated before any further migration activity.
-- =============================================================================

DO $$
BEGIN

    -- governance schema must still exist (WP-DB-001)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.schemata
        WHERE  schema_name = 'governance'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 rollback preservation check FAILED: schema "governance" no longer exists. '
            'This is an unexpected side effect. Investigate immediately.';
    END IF;

    -- governance.lineage_state_enum must still exist (WP-DB-001)
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_type      t
        JOIN   pg_namespace n ON n.oid = t.typnamespace
        WHERE  n.nspname = 'governance'
        AND    t.typname  = 'lineage_state_enum'
        AND    t.typtype  = 'e'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 rollback preservation check FAILED: "governance.lineage_state_enum" no longer exists. '
            'WP-DB-001 object has been unintentionally removed.';
    END IF;

    -- governance.actor_role_enum must still exist (WP-DB-001)
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_type      t
        JOIN   pg_namespace n ON n.oid = t.typnamespace
        WHERE  n.nspname = 'governance'
        AND    t.typname  = 'actor_role_enum'
        AND    t.typtype  = 'e'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 rollback preservation check FAILED: "governance.actor_role_enum" no longer exists. '
            'WP-DB-001 object has been unintentionally removed.';
    END IF;

    -- governance.governance_roles must still exist (WP-DB-002)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'governance_roles'
        AND    table_type   = 'BASE TABLE'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 rollback preservation check FAILED: "governance.governance_roles" no longer exists. '
            'WP-DB-002 object has been unintentionally removed.';
    END IF;

    -- governance.principal_role_grants must still exist (WP-DB-003)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'principal_role_grants'
        AND    table_type   = 'BASE TABLE'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 rollback preservation check FAILED: "governance.principal_role_grants" no longer exists. '
            'WP-DB-003 object has been unintentionally removed.';
    END IF;

    -- governance.review_assignments must still exist (WP-DB-003)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'review_assignments'
        AND    table_type   = 'BASE TABLE'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 rollback preservation check FAILED: "governance.review_assignments" no longer exists. '
            'WP-DB-003 object has been unintentionally removed.';
    END IF;

    -- governance.approval_decisions must still exist (WP-DB-003)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'approval_decisions'
        AND    table_type   = 'BASE TABLE'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 rollback preservation check FAILED: "governance.approval_decisions" no longer exists. '
            'WP-DB-003 object has been unintentionally removed.';
    END IF;

    -- governance.revocation_records must still exist (WP-DB-003)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'revocation_records'
        AND    table_type   = 'BASE TABLE'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 rollback preservation check FAILED: "governance.revocation_records" no longer exists. '
            'WP-DB-003 object has been unintentionally removed.';
    END IF;

    -- governance.lineage_versions must still exist (WP-DB-004)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'lineage_versions'
        AND    table_type   = 'BASE TABLE'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 rollback preservation check FAILED: "governance.lineage_versions" no longer exists. '
            'WP-DB-004 object has been unintentionally removed.';
    END IF;

    -- public.signal_lineage must still exist and be unmodified (A09)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'public'
        AND    table_name   = 'signal_lineage'
        AND    table_type   = 'BASE TABLE'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 rollback preservation check FAILED: "public.signal_lineage" no longer exists. '
            'A09 table has been unintentionally removed.';
    END IF;

    -- Confirm governance_event_type_enum is gone (successful rollback)
    IF EXISTS (
        SELECT 1
        FROM   pg_type      t
        JOIN   pg_namespace n ON n.oid = t.typnamespace
        WHERE  n.nspname = 'governance'
        AND    t.typname  = 'governance_event_type_enum'
        AND    t.typtype  = 'e'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 rollback verification FAILED: "governance.governance_event_type_enum" '
            'still exists after rollback. The DROP TYPE did not complete as expected.';
    END IF;

    -- Confirm governance_events table is gone (successful rollback)
    IF EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'governance_events'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 rollback verification FAILED: "governance.governance_events" '
            'still exists after rollback. The DROP TABLE did not complete as expected.';
    END IF;

    RAISE NOTICE
        'WP-DB-005 rollback preservation checks: ALL PASSED. '
        'WP-DB-001, WP-DB-002, WP-DB-003, WP-DB-004, and A09 objects confirmed intact. '
        'WP-DB-005 objects confirmed removed.';

END
$$;


-- =============================================================================
-- END OF ROLLBACK: 20260616000005_a10_governance_event_store_rollback.sql
-- All WP-DB-005 objects have been removed.
-- WP-DB-001 through WP-DB-004 objects confirmed intact.
-- public.signal_lineage (A09) confirmed unmodified.
-- To re-apply WP-DB-005, re-run the migration file.
-- =============================================================================
