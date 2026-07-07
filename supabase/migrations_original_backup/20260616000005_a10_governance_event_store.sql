-- =============================================================================
-- Migration: 20260616000005_a10_governance_event_store.sql
-- Work Package: WP-DB-005 — Governance Event Store
-- Specification: WP-DB-005-SPEC-01
-- Workstream: WS-1 — Database
-- Programme: HireRise A10 Phase 6A
--
-- Requires (must already be deployed):
--   20260616000001_a10_governance_schema_foundation.sql  (WP-DB-001)
--   20260616000002_a10_governance_role_model.sql         (WP-DB-002)
--   20260616000003_a10_core_governance_entities.sql      (WP-DB-003)
--   20260616000004_a10_lineage_versions.sql              (WP-DB-004)
--
-- A09 Classification: NO IMPACT
--   - public.signal_lineage is referenced as a read-only FK parent.
--     No column, index, constraint, or row in signal_lineage is modified.
--   - No reference to signal_registry_audit_log.
--   - No reference to fn_get_signal_lineage_summary().
--   - No modification of any previously delivered object.
--
-- Idempotency: Safe to re-run. Enum creation uses DO $$ duplicate_object guard.
--   Table DDL uses CREATE TABLE IF NOT EXISTS. Index DDL uses
--   CREATE INDEX IF NOT EXISTS. FK constraints use DO $$ pg_constraint
--   existence checks. Re-running against an already-migrated schema produces
--   zero errors and zero unintended modifications.
--
-- Out of scope: functions, triggers, procedures, views, materialized views,
--   GRANT statements, RLS policies, workflow automation, seed data, test data.
-- =============================================================================


-- =============================================================================
-- BLOCK 1: DEPENDENCY GUARDS
-- Spec ref: WP-DB-005-SPEC-01 §9.2 — Dependencies / §9.6 — Dependency Guard Strategy
-- Abort with descriptive exceptions if any prerequisite is absent.
-- =============================================================================

DO $$
BEGIN

    -- 1. governance schema must exist (created by WP-DB-001)
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.schemata
        WHERE  schema_name = 'governance'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 dependency guard FAILED: schema "governance" does not exist. '
            'WP-DB-001 (Governance Schema Foundation) must be deployed first.';
    END IF;

    -- 2. governance.lineage_state_enum must exist (created by WP-DB-001)
    --    Required for governance_events.from_state and governance_events.to_state.
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_type      t
        JOIN   pg_namespace n ON n.oid = t.typnamespace
        WHERE  n.nspname = 'governance'
        AND    t.typname  = 'lineage_state_enum'
        AND    t.typtype  = 'e'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 dependency guard FAILED: type "governance.lineage_state_enum" does not exist. '
            'WP-DB-001 (Governance Schema Foundation) must be deployed first.';
    END IF;

    -- 3. governance.actor_role_enum must exist (created by WP-DB-001)
    --    Required for governance_events.actor_role.
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_type      t
        JOIN   pg_namespace n ON n.oid = t.typnamespace
        WHERE  n.nspname = 'governance'
        AND    t.typname  = 'actor_role_enum'
        AND    t.typtype  = 'e'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 dependency guard FAILED: type "governance.actor_role_enum" does not exist. '
            'WP-DB-001 (Governance Schema Foundation) must be deployed first.';
    END IF;

    -- 4. governance.lineage_versions must exist (created by WP-DB-004)
    --    Required as FK target for governance_events.lineage_version_id.
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'lineage_versions'
        AND    table_type   = 'BASE TABLE'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 dependency guard FAILED: table "governance.lineage_versions" does not exist. '
            'WP-DB-004 (Versioning Architecture) must be deployed first.';
    END IF;

    -- 5. public.signal_lineage must exist (A09 table, pre-existing)
    --    Required as FK target for governance_events.lineage_id.
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'public'
        AND    table_name   = 'signal_lineage'
        AND    table_type   = 'BASE TABLE'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 dependency guard FAILED: table "public.signal_lineage" does not exist. '
            'The A09 signal_lineage table must be present before this migration can run.';
    END IF;

    -- 6. public.signal_lineage must have a uuid primary key column named "id"
    --    Spec ref: Runtime Validation Results — signal_lineage PK is uuid "id".
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.columns
        WHERE  table_schema  = 'public'
        AND    table_name    = 'signal_lineage'
        AND    column_name   = 'id'
        AND    udt_name      = 'uuid'
        AND    is_nullable   = 'NO'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 dependency guard FAILED: "public.signal_lineage.id" either does not exist, '
            'is not of type uuid, or is nullable. '
            'Runtime validation confirmed PK = uuid "id"; actual schema does not match.';
    END IF;

    RAISE NOTICE 'WP-DB-005 dependency guards: ALL PASSED.';

END
$$;


-- =============================================================================
-- BLOCK 2: ENUM — governance.governance_event_type_enum
-- Spec ref: WP-DB-005-SPEC-01 §3.1 — New Enum
--
-- New enum created by this migration. Do NOT modify this enum in any package
-- other than a formally reviewed amendment to WP-DB-005-SPEC-01.
-- CONTRACT: Never remove or rename values. Append only.
-- =============================================================================

DO $$ BEGIN
    CREATE TYPE governance.governance_event_type_enum AS ENUM (
        'DRAFT_CREATED',
        'SUBMITTED',
        'WITHDRAWN',
        'REVIEW_ASSIGNED',
        'REVIEW_COMPLETED',
        'APPROVED',
        'REJECTED',
        'DEPRECATED',
        'RETIRED',
        'REVOKED',
        'LEGACY_CLASSIFIED',
        'LEGACY_ENROLLED',
        'CONFIG_CHANGED'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- =============================================================================
-- BLOCK 3: TABLE CREATION — governance.governance_events
-- Spec ref: WP-DB-005-SPEC-01 §2 — Entity Definition
--           §5 — Constraint Specification
--
-- Column order, names, types, nullability, and defaults follow the spec
-- exactly. No columns are added, removed, renamed, or reordered beyond what
-- the spec defines.
-- =============================================================================

CREATE TABLE IF NOT EXISTS governance.governance_events (

    -- Primary key — surrogate uuid, immutable after insert
    -- Spec §2: "id uuid NOT NULL DEFAULT gen_random_uuid()"
    id                    uuid                                    NOT NULL DEFAULT gen_random_uuid(),

    -- Version this event applies to — FK to governance.lineage_versions(id)
    -- Spec §2: "lineage_version_id uuid NOT NULL"
    -- FK constraint governance_events_lineage_version_id_fkey added in Block 5.
    lineage_version_id    uuid                                    NOT NULL,

    -- Denormalised lineage reference — FK to public.signal_lineage(id)
    -- Spec §2: "lineage_id uuid NOT NULL"
    -- Runtime Validation: signal_lineage PK is uuid "id".
    -- FK constraint governance_events_lineage_id_fkey added in Block 5.
    lineage_id            uuid                                    NOT NULL,

    -- Governance event type — new enum created in Block 2
    -- Spec §2: "event_type governance.governance_event_type_enum NOT NULL"
    event_type            governance.governance_event_type_enum   NOT NULL,

    -- Lifecycle state before this event — reuses WP-DB-001 enum
    -- Spec §2: "from_state governance.lineage_state_enum NOT NULL"
    from_state            governance.lineage_state_enum           NOT NULL,

    -- Lifecycle state after this event — reuses WP-DB-001 enum
    -- Spec §2: "to_state governance.lineage_state_enum NOT NULL"
    to_state              governance.lineage_state_enum           NOT NULL,

    -- Identity of the triggering principal or system service
    -- Spec §2: "actor_id text NOT NULL"
    actor_id              text                                    NOT NULL,

    -- Role of the actor at event time — reuses WP-DB-001 enum
    -- Spec §2: "actor_role governance.actor_role_enum NOT NULL"
    actor_role            governance.actor_role_enum              NOT NULL,

    -- Free-text rationale; mandatory for REJECTED and REVOKED event types
    -- Spec §2: "rationale text NULL DEFAULT NULL"
    rationale             text                                    NULL     DEFAULT NULL,

    -- Immutable event creation timestamp
    -- Spec §2: "created_at timestamptz NOT NULL DEFAULT now()"
    created_at            timestamptz                             NOT NULL DEFAULT now(),

    -- Optional event-specific metadata (enrollment trigger type, etc.)
    -- Spec §2: "metadata jsonb NULL DEFAULT NULL"
    metadata              jsonb                                   NULL     DEFAULT NULL,


    -- -------------------------------------------------------------------------
    -- PRIMARY KEY
    -- Spec §5.1: "CONSTRAINT governance_events_pkey PRIMARY KEY (id)"
    -- -------------------------------------------------------------------------
    CONSTRAINT governance_events_pkey
        PRIMARY KEY (id),

    -- -------------------------------------------------------------------------
    -- CHECK: actor_id must not be blank / whitespace-only
    -- Spec §5.4.4: "actor_id must be non-empty text"
    -- -------------------------------------------------------------------------
    CONSTRAINT governance_events_actor_id_ck
        CHECK (length(btrim(actor_id)) > 0),

    -- -------------------------------------------------------------------------
    -- CHECK: rationale mandatory for REJECTED and REVOKED events
    -- Spec §5.4.2: "rationale must be non-NULL and non-empty when event_type
    --   is 'REJECTED' or 'REVOKED'"
    -- -------------------------------------------------------------------------
    CONSTRAINT governance_events_rationale_ck
        CHECK (
            event_type NOT IN ('REJECTED', 'REVOKED')
            OR (rationale IS NOT NULL AND length(btrim(rationale)) > 0)
        )

);


-- =============================================================================
-- BLOCK 4: INDEXES
-- Spec ref: WP-DB-005-SPEC-01 §6 — Index Specification
-- Three indexes specified. PK index created implicitly by PRIMARY KEY above.
-- =============================================================================

-- Governance chain retrieval in chronological order for a specific version.
-- Spec §6: "(lineage_version_id, created_at) — Composite, Non-Unique"
-- Supports: Core workflow query — retrieve full event chain for a LineageVersion.
CREATE INDEX IF NOT EXISTS idx_governance_events_lineage_version_id_created_at
    ON governance.governance_events (lineage_version_id, created_at);

-- Event type filtering across a lineage record's complete history.
-- Spec §6: "(lineage_id, event_type) — Composite, Non-Unique"
-- Supports: "Event type filtering across a lineage record's history."
CREATE INDEX IF NOT EXISTS idx_governance_events_lineage_id_event_type
    ON governance.governance_events (lineage_id, event_type);

-- Throughput metrics and dashboard KPI queries.
-- Spec §6: "(event_type, created_at) — Composite, Non-Unique"
-- Supports: "Count of approvals, rejections, and other event types per time period."
CREATE INDEX IF NOT EXISTS idx_governance_events_event_type_created_at
    ON governance.governance_events (event_type, created_at);


-- =============================================================================
-- BLOCK 5: FOREIGN KEY CONSTRAINTS
-- Spec ref: WP-DB-005-SPEC-01 §4.4 — Required Foreign Keys
--           §4.5 — Delete Behaviour (RESTRICT)
--           §4.6 — Update Behaviour (RESTRICT)
--
-- Each FK block follows the WP-DB-004 convention:
--   (a) Orphan detection — abort with descriptive exception if orphans exist.
--   (b) Add FK only if it does not already exist (idempotency guard).
-- =============================================================================


-- ─── FK 1: governance_events.lineage_version_id → governance.lineage_versions(id) ───

-- Orphan detection guard — lineage_version_id
-- Spec §9.7: detect any governance_events rows that reference a non-existent
-- lineage_versions row before attempting to add the constraint.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   governance.governance_events ge
        WHERE  NOT EXISTS (
                   SELECT 1
                   FROM   governance.lineage_versions lv
                   WHERE  lv.id = ge.lineage_version_id
               )
        LIMIT 1
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 orphan guard FAILED for governance_events.lineage_version_id: '
            'one or more rows in governance.governance_events reference a lineage_version_id '
            'that does not exist in governance.lineage_versions. '
            'Resolve orphan rows before re-running this migration.';
    ELSE
        RAISE NOTICE
            'WP-DB-005 orphan guard PASSED: governance_events.lineage_version_id — zero orphan rows.';
    END IF;
END
$$;

-- Add FK — governance_events_lineage_version_id_fkey
-- Spec §4.4: constraint name, references, ON DELETE RESTRICT, ON UPDATE RESTRICT.
DO $$
BEGIN
    IF NOT EXISTS (
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
            ADD CONSTRAINT governance_events_lineage_version_id_fkey
                FOREIGN KEY (lineage_version_id)
                    REFERENCES governance.lineage_versions (id)
                    ON DELETE RESTRICT
                    ON UPDATE RESTRICT;

        RAISE NOTICE
            'WP-DB-005: constraint governance_events_lineage_version_id_fkey created.';
    ELSE
        RAISE NOTICE
            'WP-DB-005: constraint governance_events_lineage_version_id_fkey already exists, skipping.';
    END IF;
END
$$;


-- ─── FK 2: governance_events.lineage_id → public.signal_lineage(id) ──────────

-- Orphan detection guard — lineage_id
-- Spec §4.4: read-only cross-schema reference to public.signal_lineage(id).
-- Runtime Validation: PK of signal_lineage is uuid column "id".
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   governance.governance_events ge
        WHERE  NOT EXISTS (
                   SELECT 1
                   FROM   public.signal_lineage sl
                   WHERE  sl.id = ge.lineage_id
               )
        LIMIT 1
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 orphan guard FAILED for governance_events.lineage_id: '
            'one or more rows in governance.governance_events reference a lineage_id '
            'that does not exist in public.signal_lineage. '
            'Resolve orphan rows before re-running this migration.';
    ELSE
        RAISE NOTICE
            'WP-DB-005 orphan guard PASSED: governance_events.lineage_id — zero orphan rows.';
    END IF;
END
$$;

-- Add FK — governance_events_lineage_id_fkey
-- Spec §4.4: constraint name, references public.signal_lineage(id),
-- ON DELETE RESTRICT, ON UPDATE RESTRICT.
-- A09 note: This FK references signal_lineage as a parent; signal_lineage is
-- never a dependent of A10. ON DELETE RESTRICT is the intended protective
-- behaviour per Phase 4 §7.2 — a lineage record that has dependent governance
-- events cannot be silently deleted. No column, index, or row of signal_lineage
-- is modified by this constraint.
DO $$
BEGIN
    IF NOT EXISTS (
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
            ADD CONSTRAINT governance_events_lineage_id_fkey
                FOREIGN KEY (lineage_id)
                    REFERENCES public.signal_lineage (id)
                    ON DELETE RESTRICT
                    ON UPDATE RESTRICT;

        RAISE NOTICE
            'WP-DB-005: constraint governance_events_lineage_id_fkey created.';
    ELSE
        RAISE NOTICE
            'WP-DB-005: constraint governance_events_lineage_id_fkey already exists, skipping.';
    END IF;
END
$$;


-- =============================================================================
-- BLOCK 6: POST-CREATION VALIDATION
-- Confirms that all expected objects now exist. Advisory — a failure here
-- indicates a deployment problem and must be investigated.
-- =============================================================================

DO $$
BEGIN

    -- Table must exist
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.tables
        WHERE  table_schema = 'governance'
        AND    table_name   = 'governance_events'
        AND    table_type   = 'BASE TABLE'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 post-creation check FAILED: table "governance.governance_events" '
            'was not created as expected.';
    END IF;

    -- Enum must exist with the expected 13 values
    IF (
        SELECT COUNT(*)
        FROM   pg_enum     e
        JOIN   pg_type     t ON t.oid = e.enumtypid
        JOIN   pg_namespace n ON n.oid = t.typnamespace
        WHERE  n.nspname = 'governance'
        AND    t.typname = 'governance_event_type_enum'
    ) <> 13 THEN
        RAISE EXCEPTION
            'WP-DB-005 post-creation check FAILED: governance.governance_event_type_enum '
            'does not have exactly 13 values.';
    END IF;

    -- Primary key constraint must exist
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint c
        JOIN   pg_class      cl ON cl.oid = c.conrelid
        JOIN   pg_namespace  n  ON n.oid  = cl.relnamespace
        WHERE  n.nspname  = 'governance'
        AND    cl.relname = 'governance_events'
        AND    c.conname  = 'governance_events_pkey'
        AND    c.contype  = 'p'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 post-creation check FAILED: primary key constraint '
            '"governance_events_pkey" not found.';
    END IF;

    -- FK 1 must exist
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint c
        JOIN   pg_class      cl ON cl.oid = c.conrelid
        JOIN   pg_namespace  n  ON n.oid  = cl.relnamespace
        WHERE  n.nspname  = 'governance'
        AND    cl.relname = 'governance_events'
        AND    c.conname  = 'governance_events_lineage_version_id_fkey'
        AND    c.contype  = 'f'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 post-creation check FAILED: FK constraint '
            '"governance_events_lineage_version_id_fkey" not found.';
    END IF;

    -- FK 2 must exist
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint c
        JOIN   pg_class      cl ON cl.oid = c.conrelid
        JOIN   pg_namespace  n  ON n.oid  = cl.relnamespace
        WHERE  n.nspname  = 'governance'
        AND    cl.relname = 'governance_events'
        AND    c.conname  = 'governance_events_lineage_id_fkey'
        AND    c.contype  = 'f'
    ) THEN
        RAISE EXCEPTION
            'WP-DB-005 post-creation check FAILED: FK constraint '
            '"governance_events_lineage_id_fkey" not found.';
    END IF;

    RAISE NOTICE
        'WP-DB-005 post-creation checks: ALL PASSED. '
        'governance.governance_events is deployed and verified.';

END
$$;


-- =============================================================================
-- END OF MIGRATION: 20260616000005_a10_governance_event_store.sql
-- All WP-DB-005 objects are now in place.
-- Next authorized package: WP-DB-006 — Audit Store
-- =============================================================================
