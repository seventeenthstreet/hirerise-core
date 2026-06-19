-- =============================================================================
-- HIRERISE  Phase 2A.1  ·  Sprint 1C  ·  Migration 1C-01
-- Read-Side Governance RPCs
-- =============================================================================
--
-- Document Classification : Production Migration
-- File                    : Sprint_1C_Migration_1C_01.sql
-- Amendment Reference     : A03 — Sprint 1C Migration 1C-01 Generation
-- Architecture Basis      : HireRise_A03_Sprint1C_Architecture_Review.md
--                           HireRise_A03_Step1_RPC_Access_Model_Finalization.md
--                           Sprint 1C RPC & Testing Specification (approved)
--                           Sprint 1B Security & Service Specification (approved)
--                           Sprint 1 Implementation Plan (approved)
-- Access-Control Basis    : A03 Step 1 — Frozen Access-Control Contract
-- Structural Reference    : G4D fn_propose_lineage_transition.sql (deployment pattern)
--
-- Scope:
--   Delivers the complete read layer of the HireRise intelligence governance
--   infrastructure.  Sprints 1A and 1B established write infrastructure —
--   tables, immutability controls, roles, RLS policies, GRANTs, and service
--   classes.  Sprint 1C activates the governed read paths through which all
--   downstream consumers access lineage and audit data.
--
-- Functions Deployed (in dependency order):
--   1. fn_get_signal_successors()       — P0 — approved successor chain
--   2. fn_get_signal_lineage_summary()  — P1 — full governance history (admin)
--   3. fn_get_lineage_audit_log()       — P1 — regulatory audit trail
--   4. fn_get_registry_audit_events()   — P1 — full registry audit event query
--
-- Prerequisites (validated in preamble):
--   - signal_lineage table (Sprint 1A)
--   - signal_registry_audit_log table with lineage_id column (Sprint 1A + G4D-P2)
--   - governance_audit role (Sprint 1B / A01)
--   - All four tables must be present; governance_audit must exist
--
-- Security Model (frozen in A03 Step 1):
--   All functions: SECURITY DEFINER, SET search_path = public
--   All functions: REVOKE ALL FROM PUBLIC before any GRANT EXECUTE
--   fn_get_signal_lineage_summary  : EXECUTE → service_role only
--   fn_get_signal_successors       : EXECUTE → service_role only
--   fn_get_lineage_audit_log       : EXECUTE → service_role, governance_audit
--   fn_get_registry_audit_events   : EXECUTE → service_role only
--
-- Idempotency:
--   All functions use CREATE OR REPLACE FUNCTION.
--   GRANT EXECUTE is idempotent in PostgreSQL (re-granting an existing grant
--   has no effect and raises no error).
--   REVOKE ALL FROM PUBLIC is idempotent (revoking a non-existent grant is
--   a no-op in Supabase/PostgreSQL; no error raised).
--   This migration may be re-executed safely in any environment where the
--   prerequisite schema objects already exist.
--
-- Schema Note — proposed_by sourcing:
--   signal_lineage has no proposed_by column (confirmed by G4D deploy record
--   and fn_approve_lineage_transition VAL-3 comment: "signal_lineage has no
--   proposed_by column").  The proposer identity is stored exclusively in
--   signal_registry_audit_log.event_payload->>'proposedBy' for the
--   lineage_event_proposed record correlated via lineage_id.
--   fn_get_signal_lineage_summary() sources proposed_by via LEFT JOIN to
--   signal_registry_audit_log on this field.
--   proposed_at is signal_lineage.created_at (per Sprint 1C Spec §3.1:
--   "proposed_at: When the proposal was created (created_at)").
--
-- Schema Note — audit log timestamp column:
--   signal_registry_audit_log uses performed_at (not created_at) as its
--   timestamp column (confirmed by G4D-P2 preamble asserting 'performed_at'
--   and fn_propose INSERT into performed_at).
--   fn_get_registry_audit_events() filters on performed_at and aliases it
--   to created_at in the output contract (per Sprint 1C Spec §3.4 which
--   lists the output field as 'created_at').
--
-- Schema Note — fn_get_lineage_audit_log join condition:
--   Per A03 Step 1 Deliverable 5: LEFT JOIN signal_registry_audit_log ON
--   (event_payload->>'lineage_id')::uuid = signal_lineage.id
--   AND event_type = 'lineage_event_approved'
--   This is confirmed by the G4D audit payload shape which stores lineage_id
--   in event_payload->>'lineageId'.  However, the approved join condition
--   in A03 Step 1 uses the lineage_id column (FK) not the payload field,
--   since G4D-P2 added the lineage_id FK column to signal_registry_audit_log.
--   The JOIN uses the FK column for correctness and index usage.
--
-- =============================================================================


BEGIN;


-- =============================================================================
-- PREAMBLE — Prerequisite assertions
-- All prerequisite schema objects must exist before any function is created.
-- If any assertion fails, the entire transaction rolls back and no functions
-- are created.  This is a hard deployment gate.
-- =============================================================================

DO $$
DECLARE
    v_count integer;
BEGIN
    -- ── Assert signal_lineage exists ─────────────────────────────────────────
    SELECT COUNT(*) INTO v_count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'signal_lineage';
    IF v_count = 0 THEN
        RAISE EXCEPTION
            'PREAMBLE FAILED [1C-01-P1]: signal_lineage table not found in schema public. '
            'Sprint 1A must be deployed and verified before Sprint 1C. '
            'Run Sprint 1A migrations and confirm Gate 1 before re-executing this migration.';
    END IF;

    -- ── Assert signal_registry_audit_log exists ──────────────────────────────
    SELECT COUNT(*) INTO v_count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'signal_registry_audit_log';
    IF v_count = 0 THEN
        RAISE EXCEPTION
            'PREAMBLE FAILED [1C-01-P2]: signal_registry_audit_log table not found. '
            'Sprint 1A must be deployed before Sprint 1C.';
    END IF;

    -- ── Assert lineage_id column exists on signal_registry_audit_log ─────────
    -- Required for fn_get_signal_lineage_summary proposed_by JOIN and
    -- fn_get_lineage_audit_log correlation JOIN.
    -- Added by G4D Patch P2 (migration_G4D_P2_audit_log_lineage_alignment.sql).
    SELECT COUNT(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'signal_registry_audit_log'
      AND column_name  = 'lineage_id';
    IF v_count = 0 THEN
        RAISE EXCEPTION
            'PREAMBLE FAILED [1C-01-P3]: lineage_id column not found on '
            'signal_registry_audit_log. '
            'G4D Patch P2 (migration_G4D_P2_audit_log_lineage_alignment.sql) '
            'must be deployed before Sprint 1C.';
    END IF;

    -- ── Assert governance_audit role exists ──────────────────────────────────
    -- Required for GRANT EXECUTE on fn_get_lineage_audit_log().
    -- Created by Sprint 1B / A01 M3 recovery migration.
    SELECT COUNT(*) INTO v_count
    FROM pg_roles
    WHERE rolname = 'governance_audit';
    IF v_count = 0 THEN
        RAISE EXCEPTION
            'PREAMBLE FAILED [1C-01-P4]: governance_audit role does not exist. '
            'Sprint 1B security migration (M3 / A01) must be deployed before Sprint 1C. '
            'Run the A01 M3 recovery migration and verify role creation before '
            're-executing this migration.';
    END IF;

    -- ── Assert registry_audit_event_type_enum exists ─────────────────────────
    -- Required for fn_get_registry_audit_events() p_event_type validation.
    SELECT COUNT(*) INTO v_count
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'registry_audit_event_type_enum'
      AND n.nspname = 'public';
    IF v_count = 0 THEN
        RAISE EXCEPTION
            'PREAMBLE FAILED [1C-01-P5]: registry_audit_event_type_enum not found. '
            'Sprint 1A must be deployed before Sprint 1C.';
    END IF;

    -- ── Assert lineage_type_enum exists ──────────────────────────────────────
    SELECT COUNT(*) INTO v_count
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'lineage_type_enum'
      AND n.nspname = 'public';
    IF v_count = 0 THEN
        RAISE EXCEPTION
            'PREAMBLE FAILED [1C-01-P6]: lineage_type_enum not found. '
            'Sprint 1A must be deployed before Sprint 1C.';
    END IF;

    RAISE NOTICE '1C-01 PREAMBLE PASSED: all 6 prerequisite assertions confirmed.';
END;
$$;


-- =============================================================================
-- FUNCTION 1 — fn_get_signal_successors()
-- =============================================================================
--
-- Priority    : P0 — Runtime resolution dependency for pipeline and
--               explainability engine.
-- Purpose     : Returns the approved successor signal key(s) for a given
--               predecessor key.  Approved rows only.  Intentionally minimal
--               output projection — no governance actor identities, no rationale.
-- Data Class  : Internal Operational
-- Caller Model: Direct: service_role via service-layer Supabase client.
--               Indirect: pipeline, explainability engine, confidence engine,
--               all Phase 2A.1.3+ consumers — all via service_role client.
-- Security    : SECURITY DEFINER — signal_lineage has no SELECT grant for
--               authenticated.  Elevation required for all non-service-role
--               calling contexts.  Row filter (approved_at IS NOT NULL) is
--               mandatory and must not be removed or made optional.
-- EXECUTE     : service_role ONLY.  No governance_audit.  No authenticated.
--               No anon.  Model B ruling from A03 Step 1.
-- Columns     : Returns exactly the 6 columns specified in the output contract.
--               Excludes: proposed_by, approved_by, lineage_reason,
--               taxonomy_version, triggered_by_pipeline_run_id, lineage_id.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_signal_successors(
    p_predecessor_key  text
)
RETURNS TABLE (
    successor_signal_key        text,
    lineage_type                text,
    effective_date              date,
    weight_review_required      boolean,
    weight_review_completed_at  timestamptz,
    approved_at                 timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- ── Input validation — executes before any SELECT ─────────────────────────
    -- Per Sprint 1C Spec §3.2: p_predecessor_key non-null and non-empty after
    -- trimming.  Raise INVALID_INPUT before any database query.

    IF p_predecessor_key IS NULL OR trim(p_predecessor_key) = '' THEN
        RAISE EXCEPTION 'INVALID_INPUT: p_predecessor_key is required and must not be empty.'
            USING ERRCODE = 'P0001';
    END IF;

    -- ── Query — approved successor chain ─────────────────────────────────────
    -- Mandatory filter: approved_at IS NOT NULL.
    -- Proposed rows (approved_at IS NULL) must never be returned by this function.
    -- Output projection matches the exact contract — no additional columns.
    -- lineage_type cast to text for consistent output regardless of enum storage.

    RETURN QUERY
    SELECT
        sl.successor_signal_key,
        sl.lineage_type::text,
        sl.effective_date::date,
        sl.weight_review_required,
        sl.weight_review_completed_at,
        sl.approved_at
    FROM public.signal_lineage sl
    WHERE sl.predecessor_signal_key = trim(p_predecessor_key)
      AND sl.approved_at IS NOT NULL          -- MANDATORY: approved rows only
    ORDER BY sl.approved_at ASC;              -- chronological successor chain

END;
$$;

COMMENT ON FUNCTION public.fn_get_signal_successors(text) IS
    '1C-01: Runtime successor chain resolution for pipeline and explainability consumers. '
    'SECURITY DEFINER — signal_lineage has no SELECT grant for authenticated. '
    'Returns approved rows only (approved_at IS NOT NULL — mandatory filter). '
    'Output projection is intentionally minimal: no actor identities, no rationale. '
    'Excluded fields: proposed_by, approved_by, lineage_reason, taxonomy_version, '
    'triggered_by_pipeline_run_id, lineage_id. '
    'Model B (A03 Step 1): service_role EXECUTE only. No authenticated EXECUTE. '
    'Data Classification: Internal Operational. '
    'Sprint 1C RPC-02 / Task 1C-001.';


-- ── Security grants — fn_get_signal_successors ───────────────────────────────

-- REVOKE ALL from PUBLIC first — removes any implicit public EXECUTE that
-- PostgreSQL assigns by default on new functions.  Must precede targeted GRANTs.
REVOKE ALL ON FUNCTION public.fn_get_signal_successors(text) FROM PUBLIC;

-- service_role: sole approved EXECUTE recipient.
-- Model B ruling (A03 Step 1): authenticated receives no EXECUTE.
GRANT EXECUTE ON FUNCTION public.fn_get_signal_successors(text) TO service_role;


-- =============================================================================
-- FUNCTION 2 — fn_get_signal_lineage_summary()
-- =============================================================================
--
-- Priority    : P1 — Admin panel and governance tooling.
-- Purpose     : Returns the complete lineage history for a given signal key —
--               all rows including proposed (approved_at IS NULL) and rejected
--               (rejected_at IS NOT NULL) states — for admin and governance use.
-- Data Class  : Governance Sensitive
-- Caller Model: Direct: service_role via service-layer Supabase client.
--               Indirect: authenticated admin sessions via Admin API endpoint
--               (GET /api/intelligence/admin/signal-lineage/:signal_key).
-- Security    : SECURITY DEFINER — authenticated has no SELECT grant on
--               signal_lineage.  Admin session authority is enforced at the
--               API layer (must be first middleware on route) — this function
--               does not verify session claims.
-- EXECUTE     : service_role ONLY.  No governance_audit.  No authenticated.
-- proposed_by : signal_lineage has no proposed_by column.  Sourced via LEFT JOIN
--               to signal_registry_audit_log on lineage_id WHERE event_type =
--               'lineage_event_proposed', extracting event_payload->>'proposedBy'.
--               NULL if the audit record is missing (governance integrity gap —
--               surfaced as NULL rather than blocking the read, since this is a
--               governance dashboard function, not a write-path guard).
-- proposed_at : signal_lineage.created_at per Sprint 1C Spec §3.1.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_signal_lineage_summary(
    p_signal_key  text
)
RETURNS TABLE (
    lineage_id                  uuid,
    predecessor_signal_key      text,
    successor_signal_key        text,
    lineage_type                text,
    lineage_reason              text,
    effective_date              date,
    taxonomy_version            text,
    proposed_by                 text,
    proposed_at                 timestamptz,
    approved_by                 text,
    approved_at                 timestamptz,
    weight_review_required      boolean,
    weight_review_completed_at  timestamptz,
    triggered_by_pipeline_run_id  uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- ── Input validation — executes before any SELECT ─────────────────────────
    -- Per Sprint 1C Spec §3.1 and A03 Step 1 Deliverable 5:
    -- p_signal_key must be non-null and non-empty after trimming.

    IF p_signal_key IS NULL OR trim(p_signal_key) = '' THEN
        RAISE EXCEPTION 'INVALID_INPUT: p_signal_key is required and must not be empty.'
            USING ERRCODE = 'P0001';
    END IF;

    -- ── Query — full lineage history including proposed and rejected rows ──────
    -- No row filter by approval state — admin use requires visibility of all rows.
    -- proposed_by sourced from signal_registry_audit_log via LEFT JOIN on
    -- lineage_id FK, filtered to the lineage_event_proposed audit record.
    -- LEFT JOIN ensures lineage rows without a correlated audit record are still
    -- returned (proposed_by will be NULL — surfaced as a governance gap indicator).
    -- proposed_at = sl.created_at per Sprint 1C Spec §3.1.
    -- Signal key matches either predecessor or successor to return the full
    -- governance history from both directions for the given signal key.

    RETURN QUERY
    SELECT
        sl.id                               AS lineage_id,
        sl.predecessor_signal_key,
        sl.successor_signal_key,
        sl.lineage_type::text,
        sl.lineage_reason,
        sl.effective_date::date,
        sl.taxonomy_version,
        (al.event_payload->>'proposedBy')   AS proposed_by,
        sl.created_at                       AS proposed_at,
        sl.approved_by,
        sl.approved_at,
        sl.weight_review_required,
        sl.weight_review_completed_at,
        sl.triggered_by_pipeline_run_id
    FROM public.signal_lineage sl
    LEFT JOIN public.signal_registry_audit_log al
           ON al.lineage_id  = sl.id
          AND al.event_type  = 'lineage_event_proposed'
    WHERE sl.predecessor_signal_key = trim(p_signal_key)
       OR sl.successor_signal_key   = trim(p_signal_key)
    ORDER BY sl.created_at ASC;             -- proposed_at ASC per output contract

END;
$$;

COMMENT ON FUNCTION public.fn_get_signal_lineage_summary(text) IS
    '1C-01: Full governance lineage history for admin panel and governance tooling. '
    'SECURITY DEFINER — authenticated has no SELECT grant on signal_lineage. '
    'Returns all rows: proposed (approved_at IS NULL), approved, and rejected. '
    'No row filter — admin use requires full visibility. '
    'proposed_by sourced via LEFT JOIN to signal_registry_audit_log on lineage_id '
    'WHERE event_type = ''lineage_event_proposed'' (signal_lineage has no proposed_by column). '
    'proposed_at = signal_lineage.created_at per Sprint 1C Spec §3.1. '
    'Data Classification: Governance Sensitive. '
    'EXECUTE: service_role only. Admin sessions reach via Admin API → service_role client. '
    'Sprint 1C RPC-01 / Task 1C-002.';


-- ── Security grants — fn_get_signal_lineage_summary ──────────────────────────

REVOKE ALL ON FUNCTION public.fn_get_signal_lineage_summary(text) FROM PUBLIC;

-- service_role: sole approved EXECUTE recipient.
-- governance_audit: DENY — this function returns unapproved proposal data and
-- full actor identities exceeding the governance_audit scope.
-- authenticated: DENY — admin sessions reach this exclusively via Admin API.
GRANT EXECUTE ON FUNCTION public.fn_get_signal_lineage_summary(text) TO service_role;


-- =============================================================================
-- FUNCTION 3 — fn_get_lineage_audit_log()
-- =============================================================================
--
-- Priority    : P1 — Regulatory audit trail and governance reporting.
-- Purpose     : Returns the approved lineage history for a signal key within
--               a date range, formatted for regulatory compliance.  Correlated
--               with signal_registry_audit_log for audit chain evidence.
--               Approved rows only — this is a completed-decisions audit trail.
-- Data Class  : Audit Sensitive
-- Caller Model: Direct: service_role; governance_audit (dedicated governance
--               tooling processes and Phase 2A.1.7 governance integration).
--               Indirect: authenticated admin sessions via Admin API or
--               governance UI → service_role client.
-- Security    : SECURITY DEFINER required for two reasons:
--               (1) authenticated has no SELECT on signal_lineage.
--               (2) governance_audit has no SELECT on signal_registry_audit_log
--                   (audit log access is exclusively via SECURITY DEFINER RPCs
--                   per Sprint 1B §5.2).  The JOIN to signal_registry_audit_log
--                   requires elevation regardless of calling role.
-- EXECUTE     : service_role AND governance_audit.  governance_audit is the
--               sole approved exception in the Sprint 1C EXECUTE grant model.
--               Per Sprint 1C Spec §4.3 and Sprint 1B §3.2.
-- proposed_by : Excluded — this function is for completed governance decisions.
-- event_payload: Excluded — callers requiring full payload use
--               fn_get_registry_audit_events().
-- Join        : LEFT JOIN signal_registry_audit_log ON lineage_id = sl.id
--               AND event_type = 'lineage_event_approved'.
--               Uses the lineage_id FK column (added by G4D Patch P2) for
--               correctness and index support (idx_audit_log_lineage_id).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_lineage_audit_log(
    p_signal_key  text,
    p_from_date   timestamptz,
    p_to_date     timestamptz
)
RETURNS TABLE (
    lineage_id                  uuid,
    predecessor_signal_key      text,
    successor_signal_key        text,
    lineage_type                text,
    lineage_reason              text,
    effective_date              date,
    taxonomy_version            text,
    approved_by                 text,
    approved_at                 timestamptz,
    weight_review_required      boolean,
    weight_review_completed_at  timestamptz,
    audit_event_id              uuid,
    audit_event_created_at      timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- ── Input validation — executes before any SELECT ─────────────────────────
    -- All three parameters required.  Date range validated: from <= to.
    -- Per Sprint 1C Spec §3.3 and A03 Step 1 Deliverable 5.

    IF p_signal_key IS NULL OR trim(p_signal_key) = '' THEN
        RAISE EXCEPTION 'INVALID_INPUT: p_signal_key is required and must not be empty.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_from_date IS NULL THEN
        RAISE EXCEPTION 'INVALID_INPUT: p_from_date is required.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_to_date IS NULL THEN
        RAISE EXCEPTION 'INVALID_INPUT: p_to_date is required.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_from_date > p_to_date THEN
        RAISE EXCEPTION
            'INVALID_DATE_RANGE: p_from_date (%) must not be after p_to_date (%). '
            'Provide a valid date range where from_date <= to_date.',
            p_from_date, p_to_date
            USING ERRCODE = 'P0001';
    END IF;

    -- ── Query — approved lineage within date range, correlated to audit log ───
    -- Mandatory filter: approved_at IS NOT NULL (approved decisions only).
    -- Date range filter on approved_at (inclusive on both bounds).
    -- Signal key matches on predecessor or successor for complete history.
    -- LEFT JOIN to signal_registry_audit_log using lineage_id FK column and
    -- event_type = 'lineage_event_approved' for audit correlation.
    -- LEFT JOIN ensures rows without a correlated audit event are still returned
    -- (audit_event_id and audit_event_created_at will be NULL — governance gap
    -- indicator surfaced to caller rather than silently omitting the row).
    -- proposed_by EXCLUDED per output contract and A03 Step 1.
    -- event_payload EXCLUDED — available via fn_get_registry_audit_events().
    -- audit_event_created_at sourced from al.performed_at (the timestamp column
    -- on signal_registry_audit_log — column name confirmed by G4D-P2 schema).

    RETURN QUERY
    SELECT
        sl.id                           AS lineage_id,
        sl.predecessor_signal_key,
        sl.successor_signal_key,
        sl.lineage_type::text,
        sl.lineage_reason,
        sl.effective_date::date,
        sl.taxonomy_version,
        sl.approved_by,
        sl.approved_at,
        sl.weight_review_required,
        sl.weight_review_completed_at,
        al.id                           AS audit_event_id,
        al.performed_at                 AS audit_event_created_at
    FROM public.signal_lineage sl
    LEFT JOIN public.signal_registry_audit_log al
           ON al.lineage_id  = sl.id                    -- FK join (G4D-P2 column)
          AND al.event_type  = 'lineage_event_approved' -- approved event only
    WHERE (
              sl.predecessor_signal_key = trim(p_signal_key)
           OR sl.successor_signal_key   = trim(p_signal_key)
          )
      AND sl.approved_at IS NOT NULL                    -- MANDATORY: approved only
      AND sl.approved_at >= p_from_date                 -- range filter inclusive
      AND sl.approved_at <= p_to_date
    ORDER BY sl.approved_at ASC;                        -- chronological audit trail

END;
$$;

COMMENT ON FUNCTION public.fn_get_lineage_audit_log(text, timestamptz, timestamptz) IS
    '1C-01: Regulatory audit trail — approved lineage transitions within a date range. '
    'SECURITY DEFINER — governance_audit has no SELECT on signal_registry_audit_log; '
    'authenticated has no SELECT on signal_lineage. Elevation required for both paths. '
    'Returns approved rows only (approved_at IS NOT NULL — mandatory filter). '
    'Date range applied to approved_at (inclusive). '
    'LEFT JOIN to signal_registry_audit_log on lineage_id FK + event_type = '
    '''lineage_event_approved'' for audit chain correlation. '
    'Excluded: proposed_by (completed decisions only), event_payload (use '
    'fn_get_registry_audit_events() for full payload). '
    'Data Classification: Audit Sensitive. '
    'EXECUTE: service_role AND governance_audit (sole approved exception). '
    'Sprint 1C RPC-03 / Task 1C-004.';


-- ── Security grants — fn_get_lineage_audit_log ───────────────────────────────

REVOKE ALL ON FUNCTION public.fn_get_lineage_audit_log(text, timestamptz, timestamptz)
    FROM PUBLIC;

-- service_role: standard operational access.
GRANT EXECUTE ON FUNCTION public.fn_get_lineage_audit_log(text, timestamptz, timestamptz)
    TO service_role;

-- governance_audit: approved exception per Sprint 1C Spec §4.3 and Sprint 1B §3.2.
-- This is the only Sprint 1C function that grants EXECUTE to governance_audit.
-- governance_audit receives no EXECUTE on any other Sprint 1C function.
GRANT EXECUTE ON FUNCTION public.fn_get_lineage_audit_log(text, timestamptz, timestamptz)
    TO governance_audit;


-- =============================================================================
-- FUNCTION 4 — fn_get_registry_audit_events()
-- =============================================================================
--
-- Priority    : P1 — Governance tooling and admin panel.
-- Purpose     : Returns audit events from signal_registry_audit_log for a
--               given signal key, optionally filtered by event type, within a
--               date range.  Projects raw event_payload JSONB without
--               transformation.  Most comprehensive audit query in Sprint 1C.
-- Data Class  : Audit Sensitive — Maximum (raw event_payload exposed)
-- Caller Model: Direct: service_role via service-layer Supabase client.
--               Indirect: admin panel governance views, Phase 2A.1.7 automation
--               — all via service_role client.
-- Security    : SECURITY DEFINER — signal_registry_audit_log grants SELECT to
--               service_role only.  No other role has any grant on this table.
--               SECURITY DEFINER elevation is the only approved read path for
--               non-service-role callers.
-- EXECUTE     : service_role ONLY.  governance_audit DENY — raw event_payload
--               contains all governance actor identities and internal references.
--               Per A03 Step 1 Deliverable 3 and Sprint 1C Spec §4.4 Risk SD-R1.
-- p_event_type: Optional filter.  If non-null, must be a valid value of
--               registry_audit_event_type_enum.  Validated before any SELECT.
-- created_at  : Output column name per Sprint 1C Spec §3.4 output contract.
--               Aliased from signal_registry_audit_log.performed_at (the actual
--               timestamp column name confirmed by G4D-P2 schema evidence).
-- event_payload: Projected as raw JSONB.  Must not be transformed, summarised,
--               or filtered.  Callers receive exactly what was stored.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_registry_audit_events(
    p_signal_key  text,
    p_from_date   timestamptz,
    p_to_date     timestamptz,
    p_event_type  text  DEFAULT NULL
)
RETURNS TABLE (
    audit_event_id   uuid,
    signal_key       text,
    event_type       text,
    event_payload    jsonb,
    performed_by     text,
    taxonomy_version text,
    created_at       timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- ── Input validation — executes before any SELECT ─────────────────────────
    -- Per Sprint 1C Spec §3.4 and A03 Step 1 Deliverable 5.
    -- p_signal_key, p_from_date, p_to_date: required.
    -- p_event_type: optional — if supplied, must be a valid enum value.

    IF p_signal_key IS NULL OR trim(p_signal_key) = '' THEN
        RAISE EXCEPTION 'INVALID_INPUT: p_signal_key is required and must not be empty.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_from_date IS NULL THEN
        RAISE EXCEPTION 'INVALID_INPUT: p_from_date is required.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_to_date IS NULL THEN
        RAISE EXCEPTION 'INVALID_INPUT: p_to_date is required.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_from_date > p_to_date THEN
        RAISE EXCEPTION
            'INVALID_DATE_RANGE: p_from_date (%) must not be after p_to_date (%). '
            'Provide a valid date range where from_date <= to_date.',
            p_from_date, p_to_date
            USING ERRCODE = 'P0001';
    END IF;

    -- ── Optional event_type validation ────────────────────────────────────────
    -- If p_event_type is supplied (non-null, non-empty), validate it against the
    -- registry_audit_event_type_enum.  PostgreSQL enum cast raises an exception
    -- on invalid values; we catch it and re-raise with a typed error code.
    -- Approach: attempt cast in a sub-block; catch invalid_text_representation.

    IF p_event_type IS NOT NULL AND trim(p_event_type) <> '' THEN
        BEGIN
            PERFORM trim(p_event_type)::public.registry_audit_event_type_enum;
        EXCEPTION
            WHEN invalid_text_representation THEN
                RAISE EXCEPTION
                    'INVALID_EVENT_TYPE: p_event_type value ''%'' is not a valid '
                    'registry_audit_event_type_enum value. '
                    'Valid values: signal_registered, signal_activated, '
                    'signal_deprecated, signal_retired, signal_engine_flag_changed, '
                    'lineage_event_proposed, lineage_event_approved, '
                    'weight_review_triggered, weight_review_completed, '
                    'signal_metadata_changed.',
                    p_event_type
                    USING ERRCODE = 'P0001';
        END;
    END IF;

    -- ── Query — audit events for signal key, date range, optional type ────────
    -- WHERE clause:
    --   signal_key = p_signal_key (scoped to one signal — mandatory)
    --   performed_at within [p_from_date, p_to_date] (inclusive)
    --   event_type filter applied only when p_event_type is non-null/non-empty
    -- event_payload projected as raw JSONB — no transformation.
    -- performed_at aliased to created_at per output contract (Sprint 1C Spec §3.4).
    -- event_type cast to text for consistent output regardless of enum storage.

    RETURN QUERY
    SELECT
        al.id                       AS audit_event_id,
        al.signal_key,
        al.event_type::text,
        al.event_payload,
        al.performed_by,
        al.taxonomy_version,
        al.performed_at             AS created_at
    FROM public.signal_registry_audit_log al
    WHERE al.signal_key    = trim(p_signal_key)       -- mandatory signal scope
      AND al.performed_at >= p_from_date              -- date range inclusive
      AND al.performed_at <= p_to_date
      AND (
              p_event_type IS NULL
           OR trim(p_event_type) = ''
           OR al.event_type = trim(p_event_type)::public.registry_audit_event_type_enum
          )
    ORDER BY al.performed_at ASC;                     -- full chronological history

END;
$$;

COMMENT ON FUNCTION public.fn_get_registry_audit_events(text, timestamptz, timestamptz, text) IS
    '1C-01: Full registry audit event query for governance tooling and admin panel. '
    'SECURITY DEFINER — signal_registry_audit_log grants SELECT to service_role only. '
    'Projects raw event_payload JSONB without transformation or summarisation. '
    'p_event_type is optional: if supplied, must be a valid registry_audit_event_type_enum '
    'value; raises INVALID_EVENT_TYPE if not. '
    'performed_at aliased to created_at per Sprint 1C Spec §3.4 output contract. '
    'Data Classification: Audit Sensitive — Maximum. '
    'EXECUTE: service_role only. governance_audit DENY (raw event_payload exposure). '
    'Sprint 1C RPC-04 / Task 1C-005.';


-- ── Security grants — fn_get_registry_audit_events ───────────────────────────

REVOKE ALL ON FUNCTION public.fn_get_registry_audit_events(text, timestamptz, timestamptz, text)
    FROM PUBLIC;

-- service_role: sole approved EXECUTE recipient.
-- governance_audit: DENY — raw event_payload contains actor identities and
-- internal system references.  Per A03 Step 1 and Sprint 1C Spec §4.4 Risk SD-R1.
GRANT EXECUTE ON FUNCTION public.fn_get_registry_audit_events(text, timestamptz, timestamptz, text)
    TO service_role;


-- =============================================================================
-- POST-DEPLOYMENT ASSERTIONS
-- Verify all four functions exist, are SECURITY DEFINER, and have the correct
-- EXECUTE grant model.  If any assertion fails, the transaction rolls back and
-- no functions are committed.
-- =============================================================================

DO $$
DECLARE
    v_count   integer;
    v_fn_name text;
BEGIN

    -- ── Assert fn_get_signal_successors ──────────────────────────────────────
    v_fn_name := 'fn_get_signal_successors';
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname  = v_fn_name
      AND n.nspname  = 'public'
      AND p.prosecdef = true;
    IF v_count = 0 THEN
        RAISE EXCEPTION
            'POST-ASSERTION FAILED [1C-01-A1]: % not found or not SECURITY DEFINER.', v_fn_name;
    END IF;
    RAISE NOTICE '1C-01 POST-ASSERTION PASSED: % present, SECURITY DEFINER = true.', v_fn_name;

    -- ── Assert fn_get_signal_lineage_summary ─────────────────────────────────
    v_fn_name := 'fn_get_signal_lineage_summary';
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname  = v_fn_name
      AND n.nspname  = 'public'
      AND p.prosecdef = true;
    IF v_count = 0 THEN
        RAISE EXCEPTION
            'POST-ASSERTION FAILED [1C-01-A2]: % not found or not SECURITY DEFINER.', v_fn_name;
    END IF;
    RAISE NOTICE '1C-01 POST-ASSERTION PASSED: % present, SECURITY DEFINER = true.', v_fn_name;

    -- ── Assert fn_get_lineage_audit_log ──────────────────────────────────────
    v_fn_name := 'fn_get_lineage_audit_log';
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname  = v_fn_name
      AND n.nspname  = 'public'
      AND p.prosecdef = true;
    IF v_count = 0 THEN
        RAISE EXCEPTION
            'POST-ASSERTION FAILED [1C-01-A3]: % not found or not SECURITY DEFINER.', v_fn_name;
    END IF;
    RAISE NOTICE '1C-01 POST-ASSERTION PASSED: % present, SECURITY DEFINER = true.', v_fn_name;

    -- ── Assert fn_get_registry_audit_events ──────────────────────────────────
    v_fn_name := 'fn_get_registry_audit_events';
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname  = v_fn_name
      AND n.nspname  = 'public'
      AND p.prosecdef = true;
    IF v_count = 0 THEN
        RAISE EXCEPTION
            'POST-ASSERTION FAILED [1C-01-A4]: % not found or not SECURITY DEFINER.', v_fn_name;
    END IF;
    RAISE NOTICE '1C-01 POST-ASSERTION PASSED: % present, SECURITY DEFINER = true.', v_fn_name;

    -- ── Assert governance_audit has EXECUTE on fn_get_lineage_audit_log ───────
    -- pg_proc.proacl stores access control lists; check for governance_audit entry.
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname  = 'fn_get_lineage_audit_log'
      AND n.nspname  = 'public'
      AND p.proacl::text LIKE '%governance_audit=X%';
    IF v_count = 0 THEN
        RAISE EXCEPTION
            'POST-ASSERTION FAILED [1C-01-A5]: governance_audit does not have EXECUTE '
            'on fn_get_lineage_audit_log. GRANT may not have applied correctly.';
    END IF;
    RAISE NOTICE '1C-01 POST-ASSERTION PASSED: governance_audit EXECUTE on fn_get_lineage_audit_log confirmed.';

    RAISE NOTICE '1C-01 ALL POST-DEPLOYMENT ASSERTIONS PASSED: '
        '4 functions present and SECURITY DEFINER; governance_audit EXECUTE grant verified.';

END;
$$;


COMMIT;


-- =============================================================================
-- END OF Sprint_1C_Migration_1C_01.sql
-- =============================================================================
--
-- Next steps after successful deployment:
--   1. Run Sprint_1C_Migration_1C_01_VERIFY.sql (to be generated separately)
--   2. Execute Sprint 1C test suites TST-05 and TST-09 (A04 scope)
--   3. Deploy Admin API endpoint GET /api/intelligence/admin/signal-lineage/:signal_key
--      (A09 scope — TypeScript, not SQL)
--   4. Confirm all Sprint 1 Gates 4, 5, 6 pass before declaring Sprint 1 complete
--
-- Rollback:
--   Sprint_1C_Migration_1C_01_ROLLBACK.sql (to be generated separately)
--   Rollback drops all four functions using DROP FUNCTION IF EXISTS.
--   No schema objects (tables, enums, roles, policies, indexes) are affected.
-- =============================================================================
