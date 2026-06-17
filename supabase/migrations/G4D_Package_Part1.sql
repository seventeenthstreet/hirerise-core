-- =============================================================================
-- HIRERISE  Phase 2A.1  ·  Sprint 1  ·  Package G4D
-- Governance RPC Wrapper & Validation Function Implementation
-- =============================================================================
--
-- Document Classification : Production Implementation Package
-- Architecture Basis       : Phase 2A.1.2 Approved Architecture
--                            R1 Final Approved Amendment (C1/C2/C3)
--                            Sprint 1B Security & Service Specification
--                            Sprint 1 Implementation Generation Plan
--                            Package G4 Service Layer Architecture Spec
--                            Package G4B RegistryAuditService Implementation
--                            Package G4C LineageService Implementation
--                            AMD-08, AMD-10, SEC-RLS-02
-- Status                   : REVISED — Revision v1 corrections applied
--
-- Revision v1 changes (against original G4D_Package_Part1.sql):
--   C-01  Preamble assertions corrected:
--           'lineage_type'       → 'lineage_type_enum'
--           'registry_event_type' → 'registry_audit_event_type_enum'
--   C-02  fn_propose_lineage_transition parameter type corrected:
--           public.lineage_type  → public.lineage_type_enum
--   C-03  COMMENT ON / REVOKE / GRANT enum type references corrected:
--           public.lineage_type  → public.lineage_type_enum
--   M-03  Legacy Sprint 1A trigger removed before G4D trigger is bound:
--           DROP TRIGGER IF EXISTS trg_immutability_signal_lineage
--   M-04  Legacy Sprint 1A trigger function dropped:
--           DROP FUNCTION IF EXISTS fn_trg_immutability_signal_lineage()
--
-- SECTION INDEX
-- ─────────────────────────────────────────────────────────────────────────────
-- §0   Legacy trigger cleanup (M-03, M-04)
-- §1   Schema extension — signal_lineage rejection columns
-- §2   fn_propose_lineage_transition()
-- §3   Rollback companion (separate file: G4D_rollback.sql)
-- =============================================================================


-- ============================================================================
-- PREAMBLE — Pre-deployment assertion block
-- Verifies that all prerequisite objects exist before any G4D object is created.
-- If any assertion fails the entire transaction is aborted. No partial state.
-- ============================================================================

BEGIN;

DO $$
DECLARE
    v_count integer;
BEGIN
    -- Assert M1: lineage_type_enum exists
    -- C-01 FIX: was 'lineage_type' — correct deployed name is 'lineage_type_enum'
    SELECT COUNT(*) INTO v_count
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'lineage_type_enum' AND n.nspname = 'public';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'G4D PREAMBLE FAILED: lineage_type_enum not found. '
            'Deploy Sprint 1A (migration_1A_01_enums.sql) before G4D.';
    END IF;

    -- Assert M1: registry_audit_event_type_enum exists
    -- C-01 FIX: was 'registry_event_type' — correct deployed name is
    --           'registry_audit_event_type_enum'
    SELECT COUNT(*) INTO v_count
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'registry_audit_event_type_enum' AND n.nspname = 'public';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'G4D PREAMBLE FAILED: registry_audit_event_type_enum not found. '
            'Deploy Sprint 1A (migration_1A_01_enums.sql) before G4D.';
    END IF;

    -- Assert M2: signal_lineage table exists
    SELECT COUNT(*) INTO v_count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_lineage';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'G4D PREAMBLE FAILED: signal_lineage table not found. '
            'Deploy Sprint 1A (migration_1A_02_core_tables.sql) before G4D.';
    END IF;

    -- Assert M2: signal_registry_audit_log table exists
    SELECT COUNT(*) INTO v_count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_registry_audit_log';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'G4D PREAMBLE FAILED: signal_registry_audit_log table not found. '
            'Deploy Sprint 1A (migration_1A_02_core_tables.sql) before G4D.';
    END IF;

    -- Assert: intelligence_signal_registry table exists
    SELECT COUNT(*) INTO v_count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'intelligence_signal_registry';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'G4D PREAMBLE FAILED: intelligence_signal_registry table not found. '
            'Deploy Phase 3D migration (20260525000001_cross_domain_intelligence_phase3d.sql) '
            'before G4D.';
    END IF;

    -- Assert: intelligence_signal_registry has deprecated_at and deleted_at columns
    -- (lifecycle state is represented via these timestamp columns, not a lifecycle_status
    -- enum column — verified in Revision v1 review)
    SELECT COUNT(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'intelligence_signal_registry'
      AND column_name  IN ('deprecated_at', 'deleted_at');
    IF v_count <> 2 THEN
        RAISE EXCEPTION 'G4D PREAMBLE FAILED: intelligence_signal_registry is missing '
            'deprecated_at and/or deleted_at columns. '
            'Phase 3D migration must be fully deployed before G4D.';
    END IF;

    RAISE NOTICE 'G4D PREAMBLE PASSED: all prerequisite objects confirmed present.';
END;
$$;


-- ============================================================================
-- §0  LEGACY TRIGGER CLEANUP  (M-03, M-04)
--
-- Sprint 1A deployed an approval-only immutability guard on signal_lineage:
--   trigger:  trg_immutability_signal_lineage
--   function: fn_trg_immutability_signal_lineage()
--
-- G4D replaces this with a broader guard covering both approval and rejection
-- states:
--   trigger:  trg_signal_lineage_immutability
--   function: fn_signal_lineage_immutability_guard()
--
-- The 1A trigger and function must be removed before the G4D trigger is bound
-- to prevent a duplicate BEFORE UPDATE trigger condition on signal_lineage.
-- PostgreSQL would fire both triggers in name-alphabetical order, causing the
-- 1A approval-only guard to fire first on every row update, including on rows
-- in rejected state where its narrower logic does not apply.
--
-- DROP TRIGGER must precede DROP FUNCTION: the trigger holds a reference to
-- the function; dropping the function first raises ERROR 2BP01.
--
-- Both statements use IF EXISTS — idempotent if already cleaned up or if
-- this file is re-run after a partial deployment.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_immutability_signal_lineage
    ON public.signal_lineage;

DROP FUNCTION IF EXISTS public.fn_trg_immutability_signal_lineage();


-- ============================================================================
-- §1  SCHEMA EXTENSION — signal_lineage rejection columns
--
-- The G4C LineageService specification defines fn_reject_lineage_transition()
-- as the PostgreSQL atomic operation that "marks proposal rejected" and records
-- rejected_at, rejected_by, rejection_reason on the signal_lineage row.
-- These three columns are part of the rejection persistence model that G4D is
-- explicitly tasked with defining (G4D brief: "Define approved rejection
-- persistence model").
--
-- They are added here as part of G4D deployment.  If Sprint 1A was generated
-- with these columns already present, the ADD COLUMN IF NOT EXISTS guards are
-- no-ops.
--
-- Rejection state query contract:
--   proposed :  approved_at IS NULL  AND rejected_at IS NULL
--   approved :  approved_at IS NOT NULL
--   rejected :  rejected_at IS NOT NULL  (AND approved_at IS NULL — enforced)
--
-- A rejected row is a terminal state.  Once rejected, the row cannot be
-- transitioned to approved.  This is enforced by fn_reject_lineage_transition()
-- re-checking the row state inside its transaction, and by the immutability
-- trigger defined below which blocks post-rejection column mutations.
-- ============================================================================

ALTER TABLE public.signal_lineage
    ADD COLUMN IF NOT EXISTS rejected_at        timestamptz DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS rejected_by        text        DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS rejection_reason   text        DEFAULT NULL;

COMMENT ON COLUMN public.signal_lineage.rejected_at IS
    'Set by fn_reject_lineage_transition() when a proposal is withdrawn or rejected. '
    'Terminal state: once set, the row cannot be approved. '
    'NULL = not rejected. Non-null = rejected at this timestamp.';

COMMENT ON COLUMN public.signal_lineage.rejected_by IS
    'Identity of the governance actor who rejected this proposal. '
    'Mirrors the proposedBy field (self-rejection is permitted). '
    'Set atomically with rejected_at and rejection_reason.';

COMMENT ON COLUMN public.signal_lineage.rejection_reason IS
    'Mandatory free-text rationale for the rejection. '
    'Minimum 10 characters (enforced by fn_reject_lineage_transition). '
    'Stored in the audit event_payload for regulatory access.';

-- CHECK constraint: a row cannot be both approved and rejected
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_lineage_not_approved_and_rejected'
          AND conrelid = 'public.signal_lineage'::regclass
    ) THEN
        ALTER TABLE public.signal_lineage
            ADD CONSTRAINT chk_lineage_not_approved_and_rejected
            CHECK (NOT (approved_at IS NOT NULL AND rejected_at IS NOT NULL));
    END IF;
END;
$$;

-- Index: rejected_at queries (governance reporting, state filtering)
CREATE INDEX IF NOT EXISTS idx_signal_lineage_rejected_at
    ON public.signal_lineage (rejected_at)
    WHERE rejected_at IS NOT NULL;

-- ── Immutability trigger function ────────────────────────────────────────────
-- Replaces fn_trg_immutability_signal_lineage() (dropped in §0 above).
-- Guards both approval-state and rejection-state immutability, and blocks
-- the re-approval of a rejected row.
--
-- Guard 1: post-approval — core governance columns are immutable.
--   Permitted post-approval mutations: weight_review_completed_at, updated_at,
--   triggered_by_pipeline_run_id, weight_review_required.
--
-- Guard 2: post-rejection — entire row is frozen. No mutations allowed.
--
-- Guard 3: cross-state — a rejected row cannot be transitioned to approved.
--
-- Trigger execution order note:
--   This trigger is named 'trg_signal_lineage_immutability' (starts 's').
--   Sprint 1A's 'trg_updated_at_signal_lineage' (starts 'u') still fires after
--   this one, which is correct — updated_at is set only on permitted writes.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_signal_lineage_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    -- ── Guard 1: post-APPROVAL immutability ──────────────────────────────────
    -- Once approved_at is set, the core governance columns are immutable.
    -- Permitted post-approval mutations: weight_review_completed_at,
    -- updated_at, triggered_by_pipeline_run_id.
    IF OLD.approved_at IS NOT NULL THEN
        IF (NEW.predecessor_signal_key  IS DISTINCT FROM OLD.predecessor_signal_key  OR
            NEW.successor_signal_key    IS DISTINCT FROM OLD.successor_signal_key    OR
            NEW.lineage_type            IS DISTINCT FROM OLD.lineage_type            OR
            NEW.lineage_reason          IS DISTINCT FROM OLD.lineage_reason          OR
            NEW.effective_date          IS DISTINCT FROM OLD.effective_date          OR
            NEW.taxonomy_version        IS DISTINCT FROM OLD.taxonomy_version        OR
            NEW.created_at              IS DISTINCT FROM OLD.created_at              OR
            NEW.approved_by             IS DISTINCT FROM OLD.approved_by             OR
            NEW.approved_at             IS DISTINCT FROM OLD.approved_at) THEN
            RAISE EXCEPTION
                'signal_lineage row % is approved and immutable. '
                'Attempted mutation of governance columns is not permitted. '
                'Op: %. Permitted post-approval columns: weight_review_completed_at, '
                'updated_at, triggered_by_pipeline_run_id.',
                OLD.id, TG_OP;
        END IF;
    END IF;

    -- ── Guard 2: post-REJECTION immutability ─────────────────────────────────
    -- Once rejected_at is set, the entire row is frozen. No mutations allowed.
    IF OLD.rejected_at IS NOT NULL THEN
        IF (NEW.predecessor_signal_key  IS DISTINCT FROM OLD.predecessor_signal_key  OR
            NEW.successor_signal_key    IS DISTINCT FROM OLD.successor_signal_key    OR
            NEW.lineage_type            IS DISTINCT FROM OLD.lineage_type            OR
            NEW.lineage_reason          IS DISTINCT FROM OLD.lineage_reason          OR
            NEW.effective_date          IS DISTINCT FROM OLD.effective_date          OR
            NEW.taxonomy_version        IS DISTINCT FROM OLD.taxonomy_version        OR
            NEW.created_at              IS DISTINCT FROM OLD.created_at              OR
            NEW.approved_by             IS DISTINCT FROM OLD.approved_by             OR
            NEW.approved_at             IS DISTINCT FROM OLD.approved_at             OR
            NEW.rejected_by             IS DISTINCT FROM OLD.rejected_by             OR
            NEW.rejected_at             IS DISTINCT FROM OLD.rejected_at             OR
            NEW.rejection_reason        IS DISTINCT FROM OLD.rejection_reason) THEN
            RAISE EXCEPTION
                'signal_lineage row % is rejected and immutable. '
                'A rejected proposal cannot be mutated. '
                'Op: %.',
                OLD.id, TG_OP;
        END IF;
    END IF;

    -- ── Guard 3: block approval of a rejected row ────────────────────────────
    IF OLD.rejected_at IS NOT NULL AND NEW.approved_at IS NOT NULL THEN
        RAISE EXCEPTION
            'signal_lineage row % has already been rejected. '
            'A rejected proposal cannot be approved. '
            'Rejected at: %. Rejected by: %.',
            OLD.id, OLD.rejected_at, OLD.rejected_by;
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_signal_lineage_immutability_guard() IS
    'G4D Rev1: Replaces fn_trg_immutability_signal_lineage() (Sprint 1A). '
    'Enforces three invariants: (1) post-approval core columns are immutable; '
    '(2) post-rejection the entire row is immutable; '
    '(3) a rejected row cannot be transitioned to approved. '
    'Also maintains updated_at on every permitted write.';

-- Bind the trigger (DROP is idempotent — handles re-runs)
DROP TRIGGER IF EXISTS trg_signal_lineage_immutability ON public.signal_lineage;
CREATE TRIGGER trg_signal_lineage_immutability
    BEFORE UPDATE ON public.signal_lineage
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_signal_lineage_immutability_guard();

-- ── No-delete trigger ────────────────────────────────────────────────────────
-- DELETE is unconditionally blocked — lineage rows are permanent governance
-- records.  This trigger is additive; Sprint 1A did not deploy one.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_signal_lineage_no_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    RAISE EXCEPTION
        'DELETE on signal_lineage is not permitted. '
        'Lineage event records are permanent governance artifacts. '
        'Attempted row id: %.', OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS trg_signal_lineage_no_delete ON public.signal_lineage;
CREATE TRIGGER trg_signal_lineage_no_delete
    BEFORE DELETE ON public.signal_lineage
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_signal_lineage_no_delete();


-- ============================================================================
-- §2  fn_propose_lineage_transition()
--
-- Purpose : Create a proposed lineage transition row and write the
--           lineage_event_proposed audit record in a single atomic transaction.
--
-- Caller  : lineage.service.ts proposeLineageTransition() via supabase.rpc()
-- Role    : service_role
--
-- AMD-08 compliance:
--   All validation runs before any INSERT.  Any validation failure raises an
--   exception and prevents both inserts.
--
-- AMD-10 compliance:
--   signal_lineage INSERT and audit_log INSERT are inside a single PL/pgSQL
--   function body which PostgreSQL executes atomically.  If the audit INSERT
--   fails, the lineage INSERT is rolled back.  No partial success states.
--
-- SEC-RLS-02 compliance:
--   SECURITY DEFINER ensures the function runs under the function owner's
--   privileges (service_role) regardless of the calling role.
--   SET search_path = public prevents search_path injection attacks.
--
-- Four-eyes note:
--   This function does NOT enforce four-eyes.  The proposer identity is
--   recorded in the audit log.  Four-eyes is enforced in
--   fn_approve_lineage_transition() which re-reads the original proposedBy
--   from the audit log and compares it against the approver identity.
--   Defence-in-depth: the signal_lineage_no_self_approval CHECK constraint
--   is enforced at approval time.
--
-- Return contract:
--   { lineage_id: uuid, proposed_at: timestamptz }
--   On any error: RAISE EXCEPTION (service layer catches as DATABASE_ERROR
--   or maps specific SQLSTATE codes to typed error codes).
--
-- Revision v1 changes:
--   C-02: parameter p_lineage_type type changed from public.lineage_type
--         to public.lineage_type_enum (correct deployed enum name).
--   C-03: COMMENT ON / REVOKE / GRANT function OID lookups updated to use
--         public.lineage_type_enum in the argument type list.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_propose_lineage_transition(
    p_predecessor_signal_key        text,
    p_successor_signal_key          text,               -- NULL only for retired_no_successor
    p_lineage_type                  public.lineage_type_enum,  -- C-02 FIX: was public.lineage_type
    p_lineage_reason                text,
    p_effective_date                timestamptz,
    p_taxonomy_version              text,
    p_proposed_by                   text,
    p_weight_review_required        boolean         DEFAULT true,
    p_triggered_by_pipeline_run_id  uuid            DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_lineage_id            uuid;
    v_proposed_at           timestamptz;
    v_duplicate_count       integer;
    v_audit_id              uuid;
    v_validation_result     jsonb;
BEGIN
    -- ── VAL-1: Mandatory parameter presence ──────────────────────────────────
    IF p_predecessor_signal_key IS NULL OR trim(p_predecessor_signal_key) = '' THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: predecessor_signal_key is required and must not be empty.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_lineage_reason IS NULL OR trim(p_lineage_reason) = '' THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: lineage_reason is required and must not be empty.'
            USING ERRCODE = 'P0001';
    END IF;

    IF char_length(trim(p_lineage_reason)) < 10 THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: lineage_reason must be at least 10 characters. '
            'Provided length: %.', char_length(trim(p_lineage_reason))
            USING ERRCODE = 'P0001';
    END IF;

    IF p_taxonomy_version IS NULL OR trim(p_taxonomy_version) = '' THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: taxonomy_version is required and must not be empty.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_proposed_by IS NULL OR trim(p_proposed_by) = '' THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: proposed_by is required and must not be empty.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_effective_date IS NULL THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: effective_date is required.'
            USING ERRCODE = 'P0001';
    END IF;

    -- ── VAL-2: effective_date must not be in the past (>= today) ─────────────
    IF p_effective_date::date < CURRENT_DATE THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: effective_date % is in the past. '
            'Lineage transitions must have an effective_date of today or future. '
            'Today is %.', p_effective_date::date, CURRENT_DATE
            USING ERRCODE = 'P0001';
    END IF;

    -- ── VAL-3: successor_signal_key null rule ─────────────────────────────────
    -- successor_signal_key is NULL only for retired_no_successor.
    -- For all other lineage types it must be non-null and non-empty.
    IF p_lineage_type <> 'retired_no_successor' THEN
        IF p_successor_signal_key IS NULL OR trim(p_successor_signal_key) = '' THEN
            RAISE EXCEPTION 'VALIDATION_ERROR: successor_signal_key is required for lineage_type %. '
                'Only retired_no_successor permits a null successor.', p_lineage_type::text
                USING ERRCODE = 'P0001';
        END IF;
    ELSE
        -- For retired_no_successor, successor must be NULL (not merely empty)
        IF p_successor_signal_key IS NOT NULL THEN
            RAISE EXCEPTION 'VALIDATION_ERROR: successor_signal_key must be NULL for '
                'lineage_type = retired_no_successor. '
                'A signal with no successor cannot specify one.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- ── VAL-4: Signal key validation via fn_validate_signal_keys ─────────────
    -- AMD-08: validation before any DB write.
    -- This call validates that both signal keys exist in intelligence_signal_registry
    -- with the specified taxonomy_version, are in a lifecycle state compatible
    -- with the requested transition, and that the predecessor is not already
    -- subject to an incompatible approved lineage event.
    v_validation_result := public.fn_validate_signal_keys(
        p_predecessor_key   => p_predecessor_signal_key,
        p_successor_key     => p_successor_signal_key,
        p_taxonomy_version  => p_taxonomy_version,
        p_lineage_type      => p_lineage_type::text,
        p_context           => 'proposal'
    );

    IF NOT (v_validation_result->>'valid')::boolean THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: Signal key validation failed. Violations: %',
            v_validation_result->'violations'
            USING ERRCODE = 'P0001';
    END IF;

    -- ── VAL-5: Duplicate proposal guard ──────────────────────────────────────
    -- Prevent a second identical proposed (unapproved) row for the same
    -- predecessor + successor + lineage_type + taxonomy_version combination.
    -- The partial unique index covers approved rows; this runtime check covers
    -- unapproved proposals so the same actor cannot flood the proposal queue.
    SELECT COUNT(*) INTO v_duplicate_count
    FROM public.signal_lineage
    WHERE predecessor_signal_key = p_predecessor_signal_key
      AND lineage_type            = p_lineage_type
      AND taxonomy_version        = p_taxonomy_version
      AND approved_at             IS NULL
      AND rejected_at             IS NULL
      AND (p_successor_signal_key IS NULL AND successor_signal_key IS NULL
           OR successor_signal_key = p_successor_signal_key);

    IF v_duplicate_count > 0 THEN
        RAISE EXCEPTION 'DUPLICATE_PROPOSAL: An open (unapproved, unrejected) proposal already exists '
            'for predecessor=%, successor=%, type=%, taxonomy_version=%. '
            'Reject or approve the existing proposal before creating a new one.',
            p_predecessor_signal_key, p_successor_signal_key,
            p_lineage_type::text, p_taxonomy_version
            USING ERRCODE = 'P0002';
    END IF;

    -- ── VAL-6: Incompatible approved lineage guard ────────────────────────────
    -- A predecessor that has an approved terminal transition
    -- (retired_no_successor, renamed_to, superseded_by, merged_into)
    -- cannot receive new proposals — the signal has already been
    -- definitively disposed of.
    SELECT COUNT(*) INTO v_duplicate_count
    FROM public.signal_lineage
    WHERE predecessor_signal_key = p_predecessor_signal_key
      AND taxonomy_version        = p_taxonomy_version
      AND approved_at             IS NOT NULL
      AND lineage_type IN (
          'retired_no_successor',
          'renamed_to',
          'superseded_by',
          'merged_into'
      );

    IF v_duplicate_count > 0 THEN
        RAISE EXCEPTION 'INCOMPATIBLE_LINEAGE_STATE: predecessor_signal_key=% '
            'already has an approved terminal lineage transition '
            '(retired_no_successor, renamed_to, superseded_by, or merged_into) '
            'in taxonomy_version=%. No new proposals are permitted for this signal.',
            p_predecessor_signal_key, p_taxonomy_version
            USING ERRCODE = 'P0003';
    END IF;

    -- ── INSERT 1: signal_lineage row ─────────────────────────────────────────
    v_lineage_id  := gen_random_uuid();
    v_proposed_at := now();

    INSERT INTO public.signal_lineage (
        id,
        predecessor_signal_key,
        successor_signal_key,
        lineage_type,
        lineage_reason,
        taxonomy_version,
        effective_date,
        weight_review_required,
        triggered_by_pipeline_run_id,
        approved_by,
        approved_at,
        created_at,
        updated_at
    ) VALUES (
        v_lineage_id,
        trim(p_predecessor_signal_key),
        CASE WHEN p_successor_signal_key IS NOT NULL
             THEN trim(p_successor_signal_key)
             ELSE NULL
        END,
        p_lineage_type,
        trim(p_lineage_reason),
        trim(p_taxonomy_version),
        p_effective_date,
        p_weight_review_required,
        p_triggered_by_pipeline_run_id,
        NULL,           -- approved_by: NULL until approved
        NULL,           -- approved_at: NULL until approved
        v_proposed_at,
        v_proposed_at
    );

    -- ── INSERT 2: audit record — lineage_event_proposed ──────────────────────
    -- AMD-10: both inserts in the same PL/pgSQL function body → atomic.
    -- If this INSERT fails, the lineage INSERT above is rolled back.
    v_audit_id := gen_random_uuid();

    INSERT INTO public.signal_registry_audit_log (
        id,
        event_type,
        signal_key,
        taxonomy_version,
        performed_by,
        event_payload,
        lineage_id,
        performed_at
    ) VALUES (
        v_audit_id,
        'lineage_event_proposed',
        trim(p_predecessor_signal_key),
        trim(p_taxonomy_version),
        trim(p_proposed_by),
        jsonb_build_object(
            'lineageId',            v_lineage_id,
            'lineageType',          p_lineage_type::text,
            'predecessorKey',       trim(p_predecessor_signal_key),
            'successorKey',         p_successor_signal_key,
            'lineageReason',        trim(p_lineage_reason),
            'effectiveDate',        p_effective_date,
            'taxonomyVersion',      trim(p_taxonomy_version),
            'weightReviewRequired', p_weight_review_required,
            'proposedBy',           trim(p_proposed_by),
            'action',               'lineage_proposed'
        ),
        v_lineage_id,
        v_proposed_at
    );

    -- ── Return contract ───────────────────────────────────────────────────────
    RETURN jsonb_build_object(
        'lineage_id',  v_lineage_id,
        'proposed_at', v_proposed_at
    );

EXCEPTION
    WHEN OTHERS THEN
        -- Re-raise all exceptions.  The transaction is automatically rolled back
        -- by PostgreSQL when an exception propagates out of the function body
        -- (since the function is called within the caller's transaction context).
        -- Both inserts above are undone.  No partial state is possible.
        RAISE;
END;
$$;

-- C-03 FIX: COMMENT ON / REVOKE / GRANT argument list uses public.lineage_type_enum
--           (was public.lineage_type — nonexistent type, caused OID lookup failure)

COMMENT ON FUNCTION public.fn_propose_lineage_transition(
    text, text, public.lineage_type_enum, text, timestamptz,
    text, text, boolean, uuid
) IS
    'G4D Rev1: Atomic RPC wrapper for lineage proposal creation. '
    'Inserts one signal_lineage row (proposed state) and one audit row '
    '(lineage_event_proposed) in a single transaction. '
    'AMD-08: full validation before any DB write. '
    'AMD-10: both inserts are atomic — audit failure rolls back lineage insert. '
    'SEC-RLS-02: SECURITY DEFINER, search_path = public. '
    'Caller: lineage.service.ts proposeLineageTransition() via service_role. '
    'Returns: { lineage_id: uuid, proposed_at: timestamptz }.';

REVOKE ALL ON FUNCTION public.fn_propose_lineage_transition(
    text, text, public.lineage_type_enum, text, timestamptz,
    text, text, boolean, uuid
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_propose_lineage_transition(
    text, text, public.lineage_type_enum, text, timestamptz,
    text, text, boolean, uuid
) TO service_role;

COMMIT;