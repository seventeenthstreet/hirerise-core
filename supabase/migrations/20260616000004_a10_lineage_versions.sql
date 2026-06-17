-- =============================================================================
-- Migration: 20260616000004_a10_lineage_versions.sql
-- Work Package: WP-DB-004 — Versioning Architecture
-- Specification: WP-DB-004-SPEC-01
-- Workstream: WS-1 — Database
-- Programme: HireRise A10 Phase 6A
--
-- Requires (must already be deployed):
--   20260616000001_a10_governance_schema_foundation.sql  (WP-DB-001)
--   20260616000002_a10_governance_role_model.sql         (WP-DB-002)
--   20260616000003_a10_core_governance_entities.sql      (WP-DB-003)
--
-- A09 Classification: NO IMPACT
--   - No reference to signal_lineage
--   - No reference to signal_registry_audit_log
--   - No reference to fn_get_signal_lineage_summary()
--   - No modification of any previously delivered object
--
-- Idempotency: Safe to re-run. All DDL uses IF NOT EXISTS guards or
--   DO $$ catalog-check wrappers. Re-running against an already-migrated
--   schema produces zero errors and zero unintended modifications.
--
-- Out of scope: functions, triggers, procedures, views, grants, RLS,
--   workflow automation, seed data, test data.
-- =============================================================================


-- =============================================================================
-- BLOCK 1: DEPENDENCY GUARDS
-- Spec ref: Section 10 — Migration Design / Dependency Checks
-- Abort with descriptive exceptions if any prerequisite is absent.
-- =============================================================================

DO $$
BEGIN

    -- 1. governance schema must exist
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.schemata
        WHERE  schema_name = 'governance'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 dependency guard FAILED: schema "governance" does not exist. '
            'WP-DB-001 (Governance Schema Foundation) must be deployed first.';
    END IF;

    -- 2. governance.lineage_state_enum must exist (created by WP-DB-001)
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_type     t
        JOIN   pg_namespace n ON n.oid = t.typnamespace
        WHERE  n.nspname = 'governance'
        AND    t.typname  = 'lineage_state_enum'
        AND    t.typtype  = 'e'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 dependency guard FAILED: type "governance.lineage_state_enum" does not exist. '
            'WP-DB-001 must be deployed first.';
    END IF;

-- 2a. lineage_state_enum must have exactly the 8 expected values
IF (
       SELECT COUNT(*)
       FROM pg_enum e
       JOIN pg_type t
         ON t.oid = e.enumtypid
       JOIN pg_namespace n
         ON n.oid = t.typnamespace
       WHERE n.nspname = 'governance'
         AND t.typname = 'lineage_state_enum'
   ) <> 8 THEN
    RAISE EXCEPTION
        'WP-DB-004 dependency guard FAILED: governance.lineage_state_enum must contain exactly 8 values.';
END IF;

    -- 3. governance.review_assignments must exist (created by WP-DB-003)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'review_assignments'
        AND    table_type   = 'BASE TABLE'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 dependency guard FAILED: table "governance.review_assignments" does not exist. '
            'WP-DB-003 (Core Governance Entities) must be deployed first.';
    END IF;

    -- 3a. review_assignments.lineage_version_id must be uuid NOT NULL
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.columns
        WHERE  table_schema             = 'governance'
        AND    table_name               = 'review_assignments'
        AND    column_name              = 'lineage_version_id'
        AND    udt_name                 = 'uuid'
        AND    is_nullable              = 'NO'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 dependency guard FAILED: "governance.review_assignments.lineage_version_id" '
            'either does not exist, is not of type uuid, or is nullable. '
            'Expected: uuid NOT NULL (deferred FK column created by WP-DB-003).';
    END IF;

    -- 4. governance.approval_decisions must exist (created by WP-DB-003)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'approval_decisions'
        AND    table_type   = 'BASE TABLE'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 dependency guard FAILED: table "governance.approval_decisions" does not exist. '
            'WP-DB-003 (Core Governance Entities) must be deployed first.';
    END IF;

    -- 4a. approval_decisions.lineage_version_id must be uuid NOT NULL
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.columns
        WHERE  table_schema             = 'governance'
        AND    table_name               = 'approval_decisions'
        AND    column_name              = 'lineage_version_id'
        AND    udt_name                 = 'uuid'
        AND    is_nullable              = 'NO'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 dependency guard FAILED: "governance.approval_decisions.lineage_version_id" '
            'either does not exist, is not of type uuid, or is nullable. '
            'Expected: uuid NOT NULL (deferred FK column created by WP-DB-003).';
    END IF;

    -- 5. governance.revocation_records must exist (created by WP-DB-003)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'revocation_records'
        AND    table_type   = 'BASE TABLE'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 dependency guard FAILED: table "governance.revocation_records" does not exist. '
            'WP-DB-003 (Core Governance Entities) must be deployed first.';
    END IF;

    -- 5a. revocation_records.lineage_version_id must be uuid NOT NULL
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.columns
        WHERE  table_schema             = 'governance'
        AND    table_name               = 'revocation_records'
        AND    column_name              = 'lineage_version_id'
        AND    udt_name                 = 'uuid'
        AND    is_nullable              = 'NO'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 dependency guard FAILED: "governance.revocation_records.lineage_version_id" '
            'either does not exist, is not of type uuid, or is nullable. '
            'Expected: uuid NOT NULL (deferred FK column created by WP-DB-003).';
    END IF;

    RAISE NOTICE 'WP-DB-004 dependency guards: ALL PASSED.';

END
$$;


-- =============================================================================
-- BLOCK 2: TABLE CREATION — governance.lineage_versions
-- Spec ref: Section 4 — Physical Table Design
--           Section 3 — Logical Data Model (column semantics)
--           Section 5 — Lineage State Architecture (enum reuse confirmed)
-- =============================================================================

CREATE TABLE IF NOT EXISTS governance.lineage_versions (

    -- Primary key — surrogate uuid, immutable after insert
    -- Spec §4: "id uuid NOT NULL DEFAULT gen_random_uuid()"
    id                        uuid          NOT NULL DEFAULT gen_random_uuid(),

    -- Signal identifier — must be non-empty text
    -- Spec §4: "signal_key text NOT NULL"
    signal_key                text          NOT NULL,

    -- Monotonically increasing per signal_key, starting at 1
    -- Spec §4: "version_number integer NOT NULL"
    version_number            integer       NOT NULL,

    -- Current governance state — reuses WP-DB-001 enum, default DRAFT
    -- Spec §4: "state governance.lineage_state_enum NOT NULL DEFAULT 'DRAFT'"
    -- Spec §5: "Reuse governance.lineage_state_enum — Do NOT create another state enum."
    state                     governance.lineage_state_enum  NOT NULL
                                  DEFAULT 'DRAFT'::governance.lineage_state_enum,

    -- At most one TRUE per signal_key; service layer controls this flag
    -- Spec §4: "is_current boolean NOT NULL DEFAULT false"
    is_current                boolean       NOT NULL DEFAULT false,

    -- Principal who created this version — must not be nil UUID
    -- Spec §4: "created_by uuid NOT NULL"
    created_by                uuid          NOT NULL,

    -- Immutable creation timestamp
    -- Spec §4: "created_at timestamptz NOT NULL DEFAULT now()"
    created_at                timestamptz   NOT NULL DEFAULT now(),

    -- Set when state transitions DRAFT → PROPOSED; null until first submission
    -- Spec §4: "submitted_at timestamptz NULL DEFAULT NULL"
    submitted_at              timestamptz   NULL     DEFAULT NULL,

    -- Set when state reaches a terminal / stable outcome
    -- Spec §4: "resolved_at timestamptz NULL DEFAULT NULL"
    resolved_at               timestamptz   NULL     DEFAULT NULL,

    -- Self-referential FK: the version that superseded this one
    -- Spec §4: "superseded_by_version_id uuid NULL DEFAULT NULL"
    -- Self-FK constraint added after table creation; see Block 4
    superseded_by_version_id  uuid          NULL     DEFAULT NULL,

    -- Free-text governance annotation; not used for state control
    -- Spec §4: "lineage_notes text NULL DEFAULT NULL"
    lineage_notes             text          NULL     DEFAULT NULL,


    -- -------------------------------------------------------------------------
    -- PRIMARY KEY
    -- Spec §4: "CONSTRAINT lineage_versions_pkey PRIMARY KEY (id)"
    -- -------------------------------------------------------------------------
    CONSTRAINT lineage_versions_pkey
        PRIMARY KEY (id),

    -- -------------------------------------------------------------------------
    -- UNIQUE CONSTRAINT — composite natural key
    -- Spec §4: "CONSTRAINT lineage_versions_signal_key_version_number_uq
    --              UNIQUE (signal_key, version_number)"
    -- -------------------------------------------------------------------------
    CONSTRAINT lineage_versions_signal_key_version_number_uq
        UNIQUE (signal_key, version_number),

    -- -------------------------------------------------------------------------
    -- CHECK CONSTRAINTS
    -- Spec §4: all six check constraints with exact names and expressions
    -- -------------------------------------------------------------------------

    -- signal_key must not be blank / whitespace-only
    CONSTRAINT lineage_versions_signal_key_ck
        CHECK (length(trim(signal_key)) > 0),

    -- version_number must be a positive integer
    CONSTRAINT lineage_versions_version_number_ck
        CHECK (version_number >= 1),

    -- created_by must not be the nil UUID
    CONSTRAINT lineage_versions_created_by_ck
        CHECK (created_by <> '00000000-0000-0000-0000-000000000000'::uuid),

    -- submitted_at, when set, must be on or after created_at
    CONSTRAINT lineage_versions_submitted_after_created_ck
        CHECK (submitted_at IS NULL OR submitted_at >= created_at),

    -- resolved_at, when set, must be on or after COALESCE(submitted_at, created_at)
    CONSTRAINT lineage_versions_resolved_after_submitted_ck
        CHECK (resolved_at IS NULL
               OR resolved_at >= COALESCE(submitted_at, created_at)),

    -- a version cannot supersede itself
    CONSTRAINT lineage_versions_no_self_supersession_ck
        CHECK (superseded_by_version_id IS NULL
               OR superseded_by_version_id <> id)

);


-- =============================================================================
-- BLOCK 3: INDEXES
-- Spec ref: Section 9 — Index Strategy
-- All six indexes listed in the specification, in specification order.
-- =============================================================================

-- PK index already created implicitly by the PRIMARY KEY constraint above.
-- (lineage_versions_pkey)

-- Partial unique index: at most one current version per signal
-- Spec §9: "lineage_versions_current_per_signal_uq
--            (signal_key) WHERE is_current = true"
-- Note: this is a CREATE UNIQUE INDEX, not an inline UNIQUE constraint, because
-- it is a partial index (partial unique constraints are not supported inline in
-- PostgreSQL; they must be expressed as a partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS lineage_versions_current_per_signal_uq
    ON governance.lineage_versions (signal_key)
    WHERE is_current = true;

-- Lookup index: state — governance queue queries filtering by state
-- Spec §9: "idx_lineage_versions_state  (state)"
CREATE INDEX IF NOT EXISTS idx_lineage_versions_state
    ON governance.lineage_versions (state);

-- Lookup index: signal_key — retrieve all versions for a given signal
-- Spec §9: "idx_lineage_versions_signal_key  (signal_key)"
CREATE INDEX IF NOT EXISTS idx_lineage_versions_signal_key
    ON governance.lineage_versions (signal_key);

-- Time-ordered audit index
-- Spec §9: "idx_lineage_versions_created_at  (created_at DESC)"
CREATE INDEX IF NOT EXISTS idx_lineage_versions_created_at
    ON governance.lineage_versions (created_at DESC);


-- =============================================================================
-- BLOCK 4: SELF-REFERENTIAL FK — superseded_by_version_id → id
-- Spec ref: Section 8 — LineageVersion Relationships
--           Section 4 — Physical Table Design (column definition)
--           Section 7 — Deferred FK Resolution (RESTRICT semantics)
-- This FK references the same table and must be added after the table is
-- created. It follows the same ON DELETE RESTRICT / ON UPDATE RESTRICT
-- pattern as the three cross-table deferred FKs below.
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint c
        JOIN   pg_class      cl ON cl.oid = c.conrelid
        JOIN   pg_namespace  n  ON n.oid  = cl.relnamespace
        WHERE  n.nspname   = 'governance'
        AND    cl.relname  = 'lineage_versions'
        AND    c.conname   = 'lineage_versions_superseded_by_version_id_fkey'
        AND    c.contype   = 'f'
    ) THEN
        ALTER TABLE governance.lineage_versions
            ADD CONSTRAINT lineage_versions_superseded_by_version_id_fkey
                FOREIGN KEY (superseded_by_version_id)
                    REFERENCES governance.lineage_versions (id)
                    ON DELETE RESTRICT
                    ON UPDATE RESTRICT;

        RAISE NOTICE
            'WP-DB-004: constraint lineage_versions_superseded_by_version_id_fkey created.';
    ELSE
        RAISE NOTICE
            'WP-DB-004: constraint lineage_versions_superseded_by_version_id_fkey already exists, skipping.';
    END IF;
END
$$;


-- =============================================================================
-- BLOCK 5: ORPHAN DETECTION GUARDS + DEFERRED FK RESOLUTION
-- Spec ref: Section 7 — Deferred Foreign Key Resolution
--
-- Exactly three FK constraints are resolved here, in the order specified:
--   1. governance.review_assignments.lineage_version_id
--   2. governance.approval_decisions.lineage_version_id
--   3. governance.revocation_records.lineage_version_id
--
-- Each FK block:
--   (a) Detects orphan rows — aborts with descriptive exception if found.
--   (b) Adds the FK constraint only if it does not already exist.
--   (c) Uses ON DELETE RESTRICT / ON UPDATE RESTRICT per spec §7.
-- =============================================================================


-- ─── FK 1: review_assignments.lineage_version_id ─────────────────────────────

-- Orphan detection guard — review_assignments
-- Spec §7: "Before creating each foreign key, confirm zero orphan rows"
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   governance.review_assignments ra
        WHERE  NOT EXISTS (
                   SELECT 1
                   FROM   governance.lineage_versions lv
                   WHERE  lv.id = ra.lineage_version_id
               )
        LIMIT 1
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 orphan guard FAILED for review_assignments.lineage_version_id: '
            'one or more rows in governance.review_assignments reference a lineage_version_id '
            'that does not exist in governance.lineage_versions. '
            'Resolve orphan rows before re-running this migration.';
    ELSE
        RAISE NOTICE
            'WP-DB-004 orphan guard PASSED: governance.review_assignments — zero orphan rows.';
    END IF;
END
$$;

-- Add FK — review_assignments_lineage_version_id_fkey
-- Spec §7: exact constraint name specified
DO $$
BEGIN
    IF NOT EXISTS (
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
            ADD CONSTRAINT review_assignments_lineage_version_id_fkey
                FOREIGN KEY (lineage_version_id)
                    REFERENCES governance.lineage_versions (id)
                    ON DELETE RESTRICT
                    ON UPDATE RESTRICT;

        RAISE NOTICE
            'WP-DB-004: constraint review_assignments_lineage_version_id_fkey created.';
    ELSE
        RAISE NOTICE
            'WP-DB-004: constraint review_assignments_lineage_version_id_fkey already exists, skipping.';
    END IF;
END
$$;


-- ─── FK 2: approval_decisions.lineage_version_id ─────────────────────────────

-- Orphan detection guard — approval_decisions
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   governance.approval_decisions ad
        WHERE  NOT EXISTS (
                   SELECT 1
                   FROM   governance.lineage_versions lv
                   WHERE  lv.id = ad.lineage_version_id
               )
        LIMIT 1
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 orphan guard FAILED for approval_decisions.lineage_version_id: '
            'one or more rows in governance.approval_decisions reference a lineage_version_id '
            'that does not exist in governance.lineage_versions. '
            'Resolve orphan rows before re-running this migration.';
    ELSE
        RAISE NOTICE
            'WP-DB-004 orphan guard PASSED: governance.approval_decisions — zero orphan rows.';
    END IF;
END
$$;

-- Add FK — approval_decisions_lineage_version_id_fkey
DO $$
BEGIN
    IF NOT EXISTS (
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
            ADD CONSTRAINT approval_decisions_lineage_version_id_fkey
                FOREIGN KEY (lineage_version_id)
                    REFERENCES governance.lineage_versions (id)
                    ON DELETE RESTRICT
                    ON UPDATE RESTRICT;

        RAISE NOTICE
            'WP-DB-004: constraint approval_decisions_lineage_version_id_fkey created.';
    ELSE
        RAISE NOTICE
            'WP-DB-004: constraint approval_decisions_lineage_version_id_fkey already exists, skipping.';
    END IF;
END
$$;


-- ─── FK 3: revocation_records.lineage_version_id ─────────────────────────────

-- Orphan detection guard — revocation_records
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   governance.revocation_records rr
        WHERE  NOT EXISTS (
                   SELECT 1
                   FROM   governance.lineage_versions lv
                   WHERE  lv.id = rr.lineage_version_id
               )
        LIMIT 1
    ) THEN
        RAISE EXCEPTION
            'WP-DB-004 orphan guard FAILED for revocation_records.lineage_version_id: '
            'one or more rows in governance.revocation_records reference a lineage_version_id '
            'that does not exist in governance.lineage_versions. '
            'Resolve orphan rows before re-running this migration.';
    ELSE
        RAISE NOTICE
            'WP-DB-004 orphan guard PASSED: governance.revocation_records — zero orphan rows.';
    END IF;
END
$$;

-- Add FK — revocation_records_lineage_version_id_fkey
DO $$
BEGIN
    IF NOT EXISTS (
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
            ADD CONSTRAINT revocation_records_lineage_version_id_fkey
                FOREIGN KEY (lineage_version_id)
                    REFERENCES governance.lineage_versions (id)
                    ON DELETE RESTRICT
                    ON UPDATE RESTRICT;

        RAISE NOTICE
            'WP-DB-004: constraint revocation_records_lineage_version_id_fkey created.';
    ELSE
        RAISE NOTICE
            'WP-DB-004: constraint revocation_records_lineage_version_id_fkey already exists, skipping.';
    END IF;
END
$$;


-- =============================================================================
-- END OF MIGRATION: 20260616000004_a10_lineage_versions.sql
-- All objects created or deferred-FK-resolved by WP-DB-004 are now in place.
-- Next authorized package: WP-DB-005 — Governance Event Store
-- =============================================================================
