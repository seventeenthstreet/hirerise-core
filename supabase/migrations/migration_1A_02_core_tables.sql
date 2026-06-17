-- =============================================================================
-- HIRERISE  Phase 2A.1  ·  Sprint 1A  ·  Database Foundation Layer
-- PART 4 — MIGRATION FILE 1A-02: CORE TABLES
-- =============================================================================
-- File: migration_1A_02_core_tables.sql
-- Batch: 1A-02
-- Target: Supabase / PostgreSQL 17
-- Dependency: Batch 1A-01 must be applied first
-- =============================================================================
--
-- Creates:
--   DB-04  signal_lineage             (table + constraints + partial unique index)
--   DB-08  fn_trg_immutability_signal_lineage()  (trigger function)
--          trg_immutability_signal_lineage        (BEFORE UPDATE trigger)
--   DB-    fn_trg_updated_at()        (reusable updated_at trigger function)
--          trg_updated_at_signal_lineage          (BEFORE UPDATE trigger)
--   DB-11  signal_lineage indexes (3)
--
--   DB-05  signal_registry_audit_log  (table)
--   DB-09  fn_trg_immutability_audit_log()  (trigger function)
--          trg_immutability_audit_log         (BEFORE UPDATE + DELETE triggers)
--   DB-12  signal_registry_audit_log indexes (3)
--
--   DB-06  signal_category_hierarchy  (table + constraints)
--          trg_updated_at_signal_category_hierarchy  (BEFORE UPDATE trigger)
--   DB-13  signal_category_hierarchy indexes (1)
--
-- TRIGGER NAMING NOTE:
--   On signal_lineage, two BEFORE UPDATE triggers coexist:
--     trg_immutability_signal_lineage  (alphabetically first → fires first)
--     trg_updated_at_signal_lineage    (alphabetically second → fires second)
--   PostgreSQL executes BEFORE triggers in name-alphabetical order.
--   Immutability must fire first to abort illegal mutations before updated_at is set.
--   'trg_i...' sorts before 'trg_u...' — confirmed correct.
--
-- ROLLBACK: Execute migration_1A_rollback.sql section ROLLBACK-02.
--           1A-03 must be rolled back first.
-- =============================================================================

BEGIN;

-- ─── Pre-deployment assertion: enums must exist ───────────────────────────────
DO $$
DECLARE
    v_missing text := '';
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'lineage_type_enum' AND n.nspname = 'public'
    ) THEN
        v_missing := v_missing || ' lineage_type_enum';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'registry_audit_event_type_enum' AND n.nspname = 'public'
    ) THEN
        v_missing := v_missing || ' registry_audit_event_type_enum';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'signal_category_hierarchy_level_enum' AND n.nspname = 'public'
    ) THEN
        v_missing := v_missing || ' signal_category_hierarchy_level_enum';
    END IF;
    IF v_missing <> '' THEN
        RAISE EXCEPTION '1A-02 PREREQUISITE FAILED: missing enums: %. '
            'Apply Batch 1A-01 before 1A-02.', v_missing;
    END IF;
    RAISE NOTICE '1A-02 PRE-CHECK PASSED: all 3 prerequisite enums present.';
END;
$$;


-- =============================================================================
-- DB-04: signal_lineage
-- =============================================================================
-- Purpose: Authoritative append-only record of all evolutionary relationships
--          between signal keys. The governance backbone of the intelligence
--          registry taxonomy evolution.
-- Columns: 15 (per Sprint 1A Spec Section 2.1)
-- Constraints: PK, partial unique index (approved rows only), successor nullability CHECK
-- Triggers: DB-08 immutability, DB- updated_at maintenance
-- Indexes: 3 (SL-01, SL-02, SL-03)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.signal_lineage (
    -- ── Core identity ──────────────────────────────────────────────────────────
    id                              uuid            NOT NULL    DEFAULT gen_random_uuid(),

    -- ── Lineage relationship ───────────────────────────────────────────────────
    predecessor_signal_key          text            NOT NULL,
    -- Soft reference to intelligence_signal_registry(signal_key).
    -- Immutable after approval. Must resolve at write time.

    successor_signal_key            text            NULL,
    -- Soft reference. Nullable for retired_no_successor only.
    -- CHECK constraint below enforces the bidirectional nullability rule.

    -- ── Lineage classification ─────────────────────────────────────────────────
    lineage_type                    public.lineage_type_enum   NOT NULL,
    -- Immutable after approval.

    lineage_reason                  text            NOT NULL,
    -- Mandatory free-text rationale. Non-empty enforced by application layer.
    -- Immutable after approval.

    -- ── Taxonomy scope ────────────────────────────────────────────────────────
    taxonomy_version                text            NOT NULL    DEFAULT 'v1',
    -- Sourced from predecessor's registry row at write time.
    -- Immutable after approval.

    -- ── Temporal record ───────────────────────────────────────────────────────
    effective_date                  timestamptz     NOT NULL,
    -- Operational effect timestamp. Distinct from approved_at.
    -- May be retrospective or future. Immutable after approval.

    created_at                      timestamptz     NOT NULL    DEFAULT now(),
    -- Database insertion timestamp. Immutable always.

    updated_at                      timestamptz     NOT NULL    DEFAULT now(),
    -- Maintained by trigger on every permitted UPDATE.

    -- ── Approval workflow ─────────────────────────────────────────────────────
    approved_by                     text            NULL,
    -- Identity of approving actor. NULL in proposed state.
    -- Four-eyes rule: must differ from proposing actor (enforced in service layer).
    -- Immutable after set.

    approved_at                     timestamptz     NULL,
    -- NULL = proposed state. Non-null = approved state.
    -- The NULL→non-null transition triggers immutability for other columns.
    -- Immutable after set.

    -- ── Governance linkage ────────────────────────────────────────────────────
    weight_review_required          boolean         NOT NULL    DEFAULT true,
    -- True for all lineage types except renamed_to and retired_no_successor.
    -- May be set false at proposal with justification.

    weight_review_completed_at      timestamptz     NULL,
    -- Set when weight review for this transition is completed.
    -- Mutable after approval (completion workflow).

    triggered_by_pipeline_run_id    uuid            NULL,
    -- Soft reference to intelligence_pipeline_runs.id.
    -- NULL for manually initiated transitions.
    -- Mutable after approval (may be linked retroactively).

    -- ── Constraints ───────────────────────────────────────────────────────────
    CONSTRAINT pk_signal_lineage
        PRIMARY KEY (id),

    -- CHECK: Bidirectional successor nullability rule (Section 2.1 Constraints)
    -- Rule A: if lineage_type != retired_no_successor then successor must NOT be null
    -- Rule B: if lineage_type == retired_no_successor then successor MUST be null
    -- Combined: (type = retired_no_successor OR successor IS NOT NULL)
    --           AND (type != retired_no_successor OR successor IS NULL)
    CONSTRAINT chk_lineage_successor_nullability
        CHECK (
            (lineage_type = 'retired_no_successor' OR successor_signal_key IS NOT NULL)
            AND
            (lineage_type != 'retired_no_successor' OR successor_signal_key IS NULL)
        ),

    -- CHECK: predecessor and successor must not be the same key
    CONSTRAINT chk_lineage_no_self_reference
        CHECK (
            successor_signal_key IS NULL
            OR predecessor_signal_key <> successor_signal_key
        ),

    -- CHECK: lineage_reason must not be empty string
    -- (non-null enforced by column; non-empty enforced here)
    CONSTRAINT chk_lineage_reason_not_empty
        CHECK (trim(lineage_reason) <> ''),

    -- CHECK: taxonomy_version must not be empty
    CONSTRAINT chk_lineage_taxonomy_version_not_empty
        CHECK (trim(taxonomy_version) <> ''),

    -- CHECK: approved_at cannot be retroactively changed to a different timestamp
    -- (This is the database-level guard; the immutability trigger also enforces this)
    CONSTRAINT chk_lineage_predecessor_not_empty
        CHECK (trim(predecessor_signal_key) <> '')
);

COMMENT ON TABLE public.signal_lineage IS
    'Sprint 1A DB-04: Authoritative append-only record of all evolutionary '
    'relationships between signal keys. Governance infrastructure — not public data. '
    'Access: service_role (read/write), governance_audit (read). '
    'Never delete rows. Use proposed→approved workflow for all lineage events. '
    'Architecture basis: Phase 2A.1 Sprint 1A Migration Specification Section 2.1.';

COMMENT ON COLUMN public.signal_lineage.predecessor_signal_key IS
    'Signal key being transitioned away from. Soft reference to intelligence_signal_registry. '
    'Immutable after approval.';
COMMENT ON COLUMN public.signal_lineage.successor_signal_key IS
    'Signal that replaces the predecessor. NULL only for retired_no_successor. '
    'Immutable after approval.';
COMMENT ON COLUMN public.signal_lineage.lineage_type IS
    'Semantic type of the transition. Closed vocabulary via lineage_type_enum. '
    'Immutable after approval.';
COMMENT ON COLUMN public.signal_lineage.lineage_reason IS
    'Mandatory free-text rationale. Must be non-empty. '
    'Immutable after approval.';
COMMENT ON COLUMN public.signal_lineage.taxonomy_version IS
    'Taxonomy version scope. Default v1. Sourced from predecessor registry row. '
    'Immutable after approval.';
COMMENT ON COLUMN public.signal_lineage.effective_date IS
    'Operational effect timestamp. Distinct from approved_at. '
    'Authoritative timestamp for temporal lineage resolution queries. '
    'Immutable after approval.';
COMMENT ON COLUMN public.signal_lineage.approved_at IS
    'Approval timestamp. NULL = proposed state. Non-null = approved state. '
    'The NULL→non-null transition activates immutability on core columns. '
    'Immutable after set.';
COMMENT ON COLUMN public.signal_lineage.approved_by IS
    'Identity of approving actor. Four-eyes: must differ from proposer. '
    'Immutable after set.';
COMMENT ON COLUMN public.signal_lineage.weight_review_required IS
    'Whether this transition requires a weight review cycle. '
    'True for all types except renamed_to and retired_no_successor.';
COMMENT ON COLUMN public.signal_lineage.weight_review_completed_at IS
    'Set when weight review is complete (new signal_weight_versions row approved). '
    'Mutable after approval.';
COMMENT ON COLUMN public.signal_lineage.triggered_by_pipeline_run_id IS
    'Soft reference to intelligence_pipeline_runs.id. '
    'NULL for manual transitions. May be set retroactively after approval.';


-- =============================================================================
-- DB-04: signal_lineage — Partial Unique Index (functional constraint)
-- =============================================================================
-- Only one approved transition per (predecessor, successor, type, version).
-- WHERE clause: permits multiple proposals but only one approved row per combination.
-- Without WHERE: proposals would collide at insert rather than at approval.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS
    uidx_signal_lineage_approved_unique
ON public.signal_lineage (
    predecessor_signal_key,
    successor_signal_key,
    lineage_type,
    taxonomy_version
)
WHERE approved_at IS NOT NULL;

COMMENT ON INDEX public.uidx_signal_lineage_approved_unique IS
    'Sprint 1A DB-04: Partial unique index on approved lineage rows. '
    'Permits multiple open proposals for the same pair; enforces uniqueness '
    'only on approved transitions. WHERE approved_at IS NOT NULL. '
    'Architecture basis: Sprint 1A Migration Specification Section 2.1 Constraints.';


-- =============================================================================
-- DB-08: signal_lineage Immutability Trigger Function
-- =============================================================================
-- Purpose: Enforce approved-row immutability on signal_lineage.
-- Timing: BEFORE UPDATE (aborts illegal mutations before disk write)
-- Logic: If OLD.approved_at IS NOT NULL (approved state):
--          - Block changes to: predecessor_signal_key, successor_signal_key,
--            lineage_type, lineage_reason, effective_date, taxonomy_version,
--            created_at, approved_at (re-approval with different timestamp)
--          - Allow changes to: weight_review_completed_at, updated_at,
--            triggered_by_pipeline_run_id
--        If OLD.approved_at IS NULL (proposed state): allow all column changes.
-- Trigger name starts with 'trg_i' to sort BEFORE 'trg_u' (updated_at).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_trg_immutability_signal_lineage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    -- Only activate immutability enforcement on approved rows.
    -- Proposed rows (approved_at IS NULL) may be freely modified.
    IF OLD.approved_at IS NULL THEN
        RETURN NEW;
    END IF;

    -- ── Immutable column checks (post-approval) ───────────────────────────────

    IF NEW.predecessor_signal_key IS DISTINCT FROM OLD.predecessor_signal_key THEN
        RAISE EXCEPTION
            'signal_lineage immutability violation: '
            'column predecessor_signal_key cannot be modified after approval. '
            'Row id: %. Approved at: %. '
            'Attempted change: % → %.',
            OLD.id, OLD.approved_at,
            OLD.predecessor_signal_key, NEW.predecessor_signal_key;
    END IF;

    IF NEW.successor_signal_key IS DISTINCT FROM OLD.successor_signal_key THEN
        RAISE EXCEPTION
            'signal_lineage immutability violation: '
            'column successor_signal_key cannot be modified after approval. '
            'Row id: %. Approved at: %.',
            OLD.id, OLD.approved_at;
    END IF;

    IF NEW.lineage_type IS DISTINCT FROM OLD.lineage_type THEN
        RAISE EXCEPTION
            'signal_lineage immutability violation: '
            'column lineage_type cannot be modified after approval. '
            'Row id: %. Approved at: %. '
            'Attempted change: % → %.',
            OLD.id, OLD.approved_at,
            OLD.lineage_type::text, NEW.lineage_type::text;
    END IF;

    IF NEW.lineage_reason IS DISTINCT FROM OLD.lineage_reason THEN
        RAISE EXCEPTION
            'signal_lineage immutability violation: '
            'column lineage_reason cannot be modified after approval. '
            'Row id: %. Approved at: %.',
            OLD.id, OLD.approved_at;
    END IF;

    IF NEW.effective_date IS DISTINCT FROM OLD.effective_date THEN
        RAISE EXCEPTION
            'signal_lineage immutability violation: '
            'column effective_date cannot be modified after approval. '
            'Row id: %. Approved at: %. '
            'Attempted change: % → %.',
            OLD.id, OLD.approved_at,
            OLD.effective_date, NEW.effective_date;
    END IF;

    IF NEW.taxonomy_version IS DISTINCT FROM OLD.taxonomy_version THEN
        RAISE EXCEPTION
            'signal_lineage immutability violation: '
            'column taxonomy_version cannot be modified after approval. '
            'Row id: %. Approved at: %.',
            OLD.id, OLD.approved_at;
    END IF;

    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION
            'signal_lineage immutability violation: '
            'column created_at is immutable and cannot be modified. '
            'Row id: %. Approved at: %.',
            OLD.id, OLD.approved_at;
    END IF;

    -- Block re-approval: approved_at must not be changed to a different timestamp
    -- once set. Transition from NULL to non-null is the approval event and is
    -- permitted (this trigger fires AFTER the approval UPDATE sets approved_at,
    -- so at this point OLD.approved_at is already non-null — meaning this guard
    -- catches attempts to change the approval timestamp, not the initial approval).
    IF NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
        RAISE EXCEPTION
            'signal_lineage immutability violation: '
            'column approved_at cannot be changed once set. '
            'Re-approval with a different timestamp is not permitted. '
            'Row id: %. Original approved_at: %. '
            'Attempted new approved_at: %.',
            OLD.id, OLD.approved_at, NEW.approved_at;
    END IF;

    -- approved_by: also immutable post-approval
    IF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
        RAISE EXCEPTION
            'signal_lineage immutability violation: '
            'column approved_by cannot be changed after approval. '
            'Row id: %. Approved at: %.',
            OLD.id, OLD.approved_at;
    END IF;

    -- ── Mutable columns (explicitly pass through without interference) ─────────
    -- weight_review_completed_at  — governance completion record
    -- updated_at                  — maintained by trg_updated_at_signal_lineage
    -- triggered_by_pipeline_run_id — may be linked retroactively
    -- weight_review_required      — mutable if accompanied by audit record

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_trg_immutability_signal_lineage() IS
    'Sprint 1A DB-08: BEFORE UPDATE trigger function for signal_lineage immutability. '
    'Blocks modification of 8 immutable columns on approved rows. '
    'Permits changes to weight_review_completed_at, triggered_by_pipeline_run_id, '
    'weight_review_required, and updated_at after approval. '
    'No action for proposed rows (approved_at IS NULL). '
    'Named trg_immutability_signal_lineage to sort alphabetically before '
    'trg_updated_at_signal_lineage, ensuring immutability fires first.';

DROP TRIGGER IF EXISTS trg_immutability_signal_lineage ON public.signal_lineage;
CREATE TRIGGER trg_immutability_signal_lineage
    BEFORE UPDATE ON public.signal_lineage
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_immutability_signal_lineage();

COMMENT ON TRIGGER trg_immutability_signal_lineage ON public.signal_lineage IS
    'Sprint 1A DB-08: Fires BEFORE UPDATE. Alphabetically first among BEFORE UPDATE '
    'triggers on signal_lineage — executes before trg_updated_at_signal_lineage. '
    'Abort semantics: exception causes transaction rollback.';


-- =============================================================================
-- DB-: Reusable updated_at maintenance trigger function
-- =============================================================================
-- Applied to: signal_lineage, signal_category_hierarchy
-- Signal_registry_audit_log: excluded (immutable rows, no updated_at column)
-- signal_ontology_edges: excluded (no updated_at column per spec)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_trg_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    -- Unconditionally set updated_at to current transaction timestamp.
    -- No conditions, no exceptions. Pure maintenance.
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_trg_set_updated_at() IS
    'Sprint 1A: Reusable BEFORE UPDATE trigger function that sets updated_at = now(). '
    'Applied to signal_lineage and signal_category_hierarchy. '
    'Named to sort alphabetically AFTER trg_immutability on signal_lineage, '
    'ensuring immutability validation fires first.';

DROP TRIGGER IF EXISTS trg_updated_at_signal_lineage ON public.signal_lineage;
CREATE TRIGGER trg_updated_at_signal_lineage
    BEFORE UPDATE ON public.signal_lineage
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_set_updated_at();

COMMENT ON TRIGGER trg_updated_at_signal_lineage ON public.signal_lineage IS
    'Sprint 1A: Fires BEFORE UPDATE. Alphabetically second among BEFORE UPDATE '
    'triggers on signal_lineage — executes after trg_immutability_signal_lineage. '
    'Sets updated_at = now() on every permitted mutation.';


-- =============================================================================
-- DB-11: signal_lineage Indexes
-- =============================================================================

-- SL-01: Predecessor lookup (most common query pattern)
-- Serves: Pattern 1 (successor chain), Pattern 4 (full history)
-- Cardinality: ~21 distinct predecessor keys; small result sets per key
CREATE INDEX IF NOT EXISTS idx_signal_lineage_predecessor
    ON public.signal_lineage (predecessor_signal_key);

COMMENT ON INDEX public.idx_signal_lineage_predecessor IS
    'Sprint 1A DB-11 SL-01: Predecessor key lookup. '
    'Serves: WHERE predecessor_signal_key = $key (with optional AND approved_at IS NOT NULL). '
    'Hot path for explainability engine and lineage chain resolution. '
    'Governance rationale: every signal lineage query starts from the predecessor key.';

-- SL-02: Temporal resolution composite (explainability hot path)
-- Serves: Pattern 2 (resolveSignalAtTimestamp)
-- Cardinality: compound selectivity — predecessor + approval state
CREATE INDEX IF NOT EXISTS idx_signal_lineage_predecessor_approved
    ON public.signal_lineage (predecessor_signal_key, approved_at);

COMMENT ON INDEX public.idx_signal_lineage_predecessor_approved IS
    'Sprint 1A DB-11 SL-02: Composite predecessor + approved_at index. '
    'Serves: WHERE predecessor_signal_key = $key AND effective_date <= $ts AND approved_at IS NOT NULL. '
    'Phase 2A.1.6 explainability hot path: resolveSignalAtTimestamp(). '
    'Governance rationale: temporal lineage resolution requires both key and approval state filtering.';

-- SL-03: Pipeline pre-run check (effective_date window scan)
-- Serves: Pattern 3 (open transitions within time window)
-- Governance: pipeline safety — must not straddle unresolved lineage transitions
CREATE INDEX IF NOT EXISTS idx_signal_lineage_effective_date
    ON public.signal_lineage (effective_date);

COMMENT ON INDEX public.idx_signal_lineage_effective_date IS
    'Sprint 1A DB-11 SL-03: effective_date index for pipeline pre-run check. '
    'Serves: WHERE approved_at IS NULL AND effective_date <= ($now + interval). '
    'Pipeline safety: executed before every pipeline run to detect pending transitions '
    'within the run execution window. '
    'Governance rationale: open transitions must not be straddled by pipeline runs.';


-- =============================================================================
-- DB-05: signal_registry_audit_log
-- =============================================================================
-- Purpose: Immutable append-only governance event record for all material
--          mutations to intelligence_signal_registry and signal_lineage.
-- Columns: 7 (per Sprint 1A Spec Section 2.2)
-- Constraints: PK only (no other constraints — immutability by trigger)
-- Triggers: DB-09 unconditional UPDATE+DELETE block
-- Indexes: 3 (AL-01, AL-02, AL-03)
-- Access: service_role only (no anon, no authenticated) — Sprint 1B
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.signal_registry_audit_log (
    -- ── Core identity ──────────────────────────────────────────────────────────
    id                  uuid                                    NOT NULL    DEFAULT gen_random_uuid(),

    -- ── Event classification ───────────────────────────────────────────────────
    event_type          public.registry_audit_event_type_enum  NOT NULL,
    -- Primary filter for all audit queries. Closed vocabulary via enum.

    -- ── Event subject ─────────────────────────────────────────────────────────
    signal_key          text                                    NOT NULL,
    -- Registry key affected. For lineage events: predecessor key.

    taxonomy_version    text                                    NOT NULL,
    -- Taxonomy version scope of the affected signal.

    -- ── Event actor ───────────────────────────────────────────────────────────
    performed_by        text                                    NOT NULL,
    -- Identity of responsible actor. Service account, admin user ID, or 'system'.
    -- Never null — every event has a responsible actor.

    -- ── Event data ────────────────────────────────────────────────────────────
    event_payload       jsonb                                   NOT NULL,
    -- Structured before/after state. Shape is event_type-specific.
    -- Validated by registry-audit.service.ts, not by database constraint.

    -- ── Timestamp ─────────────────────────────────────────────────────────────
    performed_at        timestamptz                             NOT NULL    DEFAULT now(),
    -- Database insertion timestamp. Set at insert. Immutable.

    -- ── Constraints ───────────────────────────────────────────────────────────
    CONSTRAINT pk_signal_registry_audit_log
        PRIMARY KEY (id),

    CONSTRAINT chk_audit_log_signal_key_not_empty
        CHECK (trim(signal_key) <> ''),

    CONSTRAINT chk_audit_log_performed_by_not_empty
        CHECK (trim(performed_by) <> ''),

    CONSTRAINT chk_audit_log_taxonomy_version_not_empty
        CHECK (trim(taxonomy_version) <> '')
);

COMMENT ON TABLE public.signal_registry_audit_log IS
    'Sprint 1A DB-05: Immutable append-only governance audit log for all material '
    'mutations to intelligence_signal_registry and signal_lineage. '
    'Forensic backbone of the registry governance model. '
    'NO updates or deletes permitted — trigger DB-09 enforces unconditionally. '
    'Access: service_role only (INSERT, SELECT). No anon. No authenticated. '
    'Architecture basis: Phase 2A.1 Sprint 1A Migration Specification Section 2.2.';

COMMENT ON COLUMN public.signal_registry_audit_log.event_type IS
    'Governance event classification. Primary filter for all audit queries. '
    'Closed vocabulary: signal_registered, signal_activated, signal_deprecated, '
    'signal_retired, signal_engine_flag_changed, lineage_event_proposed, '
    'lineage_event_approved, weight_review_triggered, weight_review_completed, '
    'signal_metadata_changed (also used for lineage_rejected action).';
COMMENT ON COLUMN public.signal_registry_audit_log.signal_key IS
    'Registry key affected by the event. For lineage events: predecessor key.';
COMMENT ON COLUMN public.signal_registry_audit_log.performed_by IS
    'Identity of responsible actor. Service account, admin user ID, or ''system''. '
    'Never null.';
COMMENT ON COLUMN public.signal_registry_audit_log.event_payload IS
    'Structured event data. Shape is event_type-specific (see registry_audit_event_type_enum). '
    'Validated by registry-audit.service.ts.';


-- =============================================================================
-- DB-09: signal_registry_audit_log Immutability Trigger Function
-- =============================================================================
-- Purpose: Unconditionally block ALL UPDATE and DELETE on audit log rows.
-- Timing: BEFORE (both UPDATE and DELETE)
-- Logic: Unconditional RAISE EXCEPTION. No conditions. No bypass. No exceptions.
--        Not even service_role may modify or delete audit log rows.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_trg_immutability_audit_log()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION
            'signal_registry_audit_log is immutable. '
            'UPDATE is not permitted on audit log rows under any circumstances. '
            'Audit log rows are permanent governance records. '
            'If a correction is required, insert a new row with a corrective note. '
            'Row id: %.',
            OLD.id;
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'signal_registry_audit_log is permanent. '
            'DELETE is not permitted on audit log rows under any circumstances. '
            'Audit log rows cannot be removed — they are the forensic governance record. '
            'Row id: %.',
            OLD.id;
    END IF;
    -- This line is never reached; RAISE EXCEPTION is unconditional.
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.fn_trg_immutability_audit_log() IS
    'Sprint 1A DB-09: BEFORE UPDATE/DELETE trigger function for audit log immutability. '
    'Unconditional RAISE EXCEPTION on all UPDATE and DELETE attempts. '
    'No bypass path. No role exceptions including service_role. '
    'Governance rationale: tamper-proof audit log is the forensic governance backbone.';

DROP TRIGGER IF EXISTS trg_immutability_audit_log_update ON public.signal_registry_audit_log;
CREATE TRIGGER trg_immutability_audit_log_update
    BEFORE UPDATE ON public.signal_registry_audit_log
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_immutability_audit_log();

DROP TRIGGER IF EXISTS trg_immutability_audit_log_delete ON public.signal_registry_audit_log;
CREATE TRIGGER trg_immutability_audit_log_delete
    BEFORE DELETE ON public.signal_registry_audit_log
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_immutability_audit_log();

COMMENT ON TRIGGER trg_immutability_audit_log_update ON public.signal_registry_audit_log IS
    'Sprint 1A DB-09: BEFORE UPDATE. Unconditional exception. No bypass.';
COMMENT ON TRIGGER trg_immutability_audit_log_delete ON public.signal_registry_audit_log IS
    'Sprint 1A DB-09: BEFORE DELETE. Unconditional exception. No bypass.';


-- =============================================================================
-- DB-12: signal_registry_audit_log Indexes
-- =============================================================================

-- AL-01: Signal key lookup (most common governance query)
-- Serves: Pattern 1 — all events for a specific signal
CREATE INDEX IF NOT EXISTS idx_audit_log_signal_key
    ON public.signal_registry_audit_log (signal_key);

COMMENT ON INDEX public.idx_audit_log_signal_key IS
    'Sprint 1A DB-12 AL-01: Signal key index for audit log. '
    'Serves: WHERE signal_key = $key ORDER BY performed_at DESC. '
    'Most common governance pattern: all events for a specific signal. '
    'Governance rationale: primary access path for signal-specific audit reporting.';

-- AL-02: Event type + date range (governance reporting)
-- Serves: Pattern 2 — events by type within date range
CREATE INDEX IF NOT EXISTS idx_audit_log_event_type_performed_at
    ON public.signal_registry_audit_log (event_type, performed_at);

COMMENT ON INDEX public.idx_audit_log_event_type_performed_at IS
    'Sprint 1A DB-12 AL-02: Composite event_type + performed_at index. '
    'Serves: WHERE event_type = $type AND performed_at BETWEEN $from AND $to. '
    'Phase 2A.1.7 governance reporting: quarterly deprecation reports, weight review audits. '
    'Governance rationale: date-ranged reporting by event type requires both columns indexed.';

-- AL-03: Chronological scan (regulatory audit)
-- Serves: Pattern 3 — all events in a date range
CREATE INDEX IF NOT EXISTS idx_audit_log_performed_at
    ON public.signal_registry_audit_log (performed_at);

COMMENT ON INDEX public.idx_audit_log_performed_at IS
    'Sprint 1A DB-12 AL-03: performed_at index for chronological audit scans. '
    'Serves: WHERE performed_at BETWEEN $from AND $to ORDER BY performed_at ASC. '
    'Regulatory audit: full timeline queries for compliance reporting. '
    'Governance rationale: append-only table grows continuously; index prevents '
    'O(n) sort cost for temporal audit queries.';


-- =============================================================================
-- DB-06: signal_category_hierarchy
-- =============================================================================
-- Purpose: Multi-level hierarchical taxonomy for signal category classification.
--          Replaces flat category enum as the primary classification mechanism
--          for all new taxonomy work from Phase 2A.1 onward.
-- Columns: 10 (per Sprint 1A Spec Section 2.3)
-- Constraints: PK, UNIQUE(category_key, taxonomy_version), CHECK(format), CHECK(domain level)
-- Triggers: updated_at maintenance
-- Indexes: 1 (CH-01)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.signal_category_hierarchy (
    -- ── Core identity ──────────────────────────────────────────────────────────
    id                  uuid                                            NOT NULL    DEFAULT gen_random_uuid(),

    -- ── Category identification ────────────────────────────────────────────────
    category_key        text                                            NOT NULL,
    -- Stable snake_case identifier. Globally unique within taxonomy_version.
    -- Effectively immutable after referenced by signal registry rows or ontology edges.

    display_name        text                                            NOT NULL,
    -- Human-readable label for UI and explainability. Mutable with audit trail.

    -- ── Hierarchy position ────────────────────────────────────────────────────
    level               public.signal_category_hierarchy_level_enum    NOT NULL,
    -- Domain, category, or subcategory. Must be consistent with parent level.
    -- Level consistency (domain→no parent, category→domain parent, subcategory→category parent)
    -- enforced in service layer (complex multi-row validation).

    parent_category_key text                                            NULL,
    -- Soft reference to another category_key in the same table.
    -- NULL for domain-level nodes. Non-null for category and subcategory nodes.

    -- ── Documentation ─────────────────────────────────────────────────────────
    description         text                                            NULL,
    -- Internal documentation for the category's intended scope. Mutable.

    -- ── Taxonomy scope ────────────────────────────────────────────────────────
    taxonomy_version    text                                            NOT NULL    DEFAULT 'v1',
    -- Version scope. Effectively immutable after seeding.

    -- ── Lifecycle ─────────────────────────────────────────────────────────────
    is_active           boolean                                         NOT NULL    DEFAULT true,
    -- Soft-delete. Inactive categories excluded from active taxonomy queries.
    -- Setting false is a governed operation.

    -- ── Timestamps ────────────────────────────────────────────────────────────
    created_at          timestamptz                                     NOT NULL    DEFAULT now(),
    updated_at          timestamptz                                     NOT NULL    DEFAULT now(),

    -- ── Constraints ───────────────────────────────────────────────────────────
    CONSTRAINT pk_signal_category_hierarchy
        PRIMARY KEY (id),

    CONSTRAINT uq_signal_category_hierarchy_key_version
        UNIQUE (category_key, taxonomy_version),

    -- CHECK: category_key format — snake_case, 2–64 chars, lowercase start
    CONSTRAINT chk_category_key_format
        CHECK (category_key ~ '^[a-z][a-z0-9_]{1,63}$'),

    -- CHECK: domain-level nodes must have null parent
    CONSTRAINT chk_domain_level_no_parent
        CHECK (
            level <> 'domain'
            OR parent_category_key IS NULL
        ),

    -- CHECK: non-domain nodes must have a parent
    CONSTRAINT chk_non_domain_has_parent
        CHECK (
            level = 'domain'
            OR parent_category_key IS NOT NULL
        ),

    CONSTRAINT chk_category_key_not_empty
        CHECK (trim(category_key) <> ''),

    CONSTRAINT chk_display_name_not_empty
        CHECK (trim(display_name) <> ''),

    CONSTRAINT chk_taxonomy_version_not_empty
        CHECK (trim(taxonomy_version) <> '')
);

COMMENT ON TABLE public.signal_category_hierarchy IS
    'Sprint 1A DB-06: Multi-level hierarchical taxonomy for signal classification. '
    'Replaces flat category enum for all new taxonomy work. '
    'Self-referencing via parent_category_key (soft reference, no hard FK). '
    'Three levels: domain → category → subcategory. '
    'Public reference data: readable by anon/authenticated (Sprint 1B). '
    'Architecture basis: Phase 2A.1 Sprint 1A Migration Specification Section 2.3.';

COMMENT ON COLUMN public.signal_category_hierarchy.category_key IS
    'Stable snake_case identifier. Unique within taxonomy_version. '
    'Format: ^[a-z][a-z0-9_]{1,63}$. Effectively immutable after referenced.';
COMMENT ON COLUMN public.signal_category_hierarchy.level IS
    'Hierarchical depth: domain (top), category (second), subcategory (third). '
    'Level-parent consistency enforced in service layer.';
COMMENT ON COLUMN public.signal_category_hierarchy.parent_category_key IS
    'Soft self-reference. NULL for domain nodes. Required for category/subcategory nodes.';
COMMENT ON COLUMN public.signal_category_hierarchy.is_active IS
    'Soft-delete mechanism. Inactive categories retained for historical reference.';

-- updated_at trigger for signal_category_hierarchy
DROP TRIGGER IF EXISTS trg_updated_at_signal_category_hierarchy ON public.signal_category_hierarchy;
CREATE TRIGGER trg_updated_at_signal_category_hierarchy
    BEFORE UPDATE ON public.signal_category_hierarchy
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_set_updated_at();

COMMENT ON TRIGGER trg_updated_at_signal_category_hierarchy ON public.signal_category_hierarchy IS
    'Sprint 1A: BEFORE UPDATE. Sets updated_at = now() on every permitted mutation.';


-- =============================================================================
-- DB-13: signal_category_hierarchy Indexes
-- =============================================================================

-- CH-01: Parent key lookup (hierarchy traversal)
-- Serves: Pattern 2 — children of a category node
CREATE INDEX IF NOT EXISTS idx_signal_category_hierarchy_parent
    ON public.signal_category_hierarchy (parent_category_key)
    WHERE parent_category_key IS NOT NULL;

COMMENT ON INDEX public.idx_signal_category_hierarchy_parent IS
    'Sprint 1A DB-13 CH-01: Parent key index for hierarchy traversal. '
    'Serves: WHERE parent_category_key = $key AND is_active = true. '
    'Partial index (WHERE parent_category_key IS NOT NULL) excludes domain nodes. '
    'Governance rationale: hierarchy rendering and aggregation routing require '
    'efficient parent-to-children lookup. Essential as taxonomy deepens across domains.';


-- ─── Post-deployment assertions 1A-02 ────────────────────────────────────────
DO $$
DECLARE
    v_count integer;
BEGIN
    -- Tables
    SELECT COUNT(*) INTO v_count FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('signal_lineage', 'signal_registry_audit_log', 'signal_category_hierarchy');
    IF v_count <> 3 THEN
        RAISE EXCEPTION '1A-02 ASSERTION FAILED: Expected 3 tables, found %.', v_count;
    END IF;

    -- signal_lineage columns
    SELECT COUNT(*) INTO v_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'signal_lineage';
    IF v_count <> 14 THEN
    RAISE EXCEPTION '1A-02 ASSERTION FAILED: signal_lineage expected 14 columns, found %.', v_count;
END IF;

    -- signal_registry_audit_log columns
    SELECT COUNT(*) INTO v_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'signal_registry_audit_log';
    IF v_count <> 7 THEN
        RAISE EXCEPTION '1A-02 ASSERTION FAILED: signal_registry_audit_log expected 7 columns, found %.', v_count;
    END IF;

    -- signal_category_hierarchy columns
    SELECT COUNT(*) INTO v_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'signal_category_hierarchy';
    IF v_count <> 10 THEN
        RAISE EXCEPTION '1A-02 ASSERTION FAILED: signal_category_hierarchy expected 10 columns, found %.', v_count;
    END IF;

    -- Partial unique index
    SELECT COUNT(*) INTO v_count FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'signal_lineage'
      AND indexname = 'uidx_signal_lineage_approved_unique';
    IF v_count <> 1 THEN
        RAISE EXCEPTION '1A-02 ASSERTION FAILED: uidx_signal_lineage_approved_unique not found.';
    END IF;

    -- Triggers on signal_lineage (expect 3: immutability + updated_at from lineage,
    -- noting audit log has 2 separate triggers)
    SELECT COUNT(*) INTO v_count FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'signal_lineage' AND n.nspname = 'public'
      AND t.tgname IN ('trg_immutability_signal_lineage', 'trg_updated_at_signal_lineage');
    IF v_count <> 2 THEN
        RAISE EXCEPTION '1A-02 ASSERTION FAILED: Expected 2 signal_lineage triggers, found %.', v_count;
    END IF;

    -- Audit log triggers (expect 2)
    SELECT COUNT(*) INTO v_count FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'signal_registry_audit_log' AND n.nspname = 'public'
      AND t.tgname IN ('trg_immutability_audit_log_update', 'trg_immutability_audit_log_delete');
    IF v_count <> 2 THEN
        RAISE EXCEPTION '1A-02 ASSERTION FAILED: Expected 2 audit log triggers, found %.', v_count;
    END IF;

    -- All 7 indexes
    SELECT COUNT(*) INTO v_count FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
          'idx_signal_lineage_predecessor',
          'idx_signal_lineage_predecessor_approved',
          'idx_signal_lineage_effective_date',
          'idx_audit_log_signal_key',
          'idx_audit_log_event_type_performed_at',
          'idx_audit_log_performed_at',
          'idx_signal_category_hierarchy_parent'
      );
    IF v_count <> 7 THEN
        RAISE EXCEPTION '1A-02 ASSERTION FAILED: Expected 7 indexes, found %.', v_count;
    END IF;

    RAISE NOTICE '1A-02 POST-DEPLOYMENT ASSERTIONS PASSED: '
        '3 tables, 14/7/10 columns, 1 partial unique index, '
        '2+2+1 triggers, 7 indexes all confirmed.';
END;
$$;

COMMIT;
