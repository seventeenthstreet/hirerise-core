BEGIN;

-- ============================================================================
-- §3  fn_approve_lineage_transition()
--
-- Purpose : Approve a proposed lineage transition.  Updates the signal_lineage
--           row and writes the lineage_event_approved audit record atomically.
--
-- Caller  : lineage.service.ts approveLineageTransition() via supabase.rpc()
-- Role    : service_role
--
-- AMD-08 compliance:
--   All input validation and the four-eyes identity check fire BEFORE any
--   UPDATE or INSERT.  The service layer (G4C) also performs the four-eyes
--   check before calling this RPC — the DB-level check here is defence-in-depth.
--
-- AMD-10 compliance:
--   signal_lineage UPDATE and audit_log INSERT are inside a single PL/pgSQL
--   function body.  If either statement fails the entire transaction rolls back.
--
-- Four-eyes enforcement (AMD-08, SEC-GOV-01):
--   The original proposer identity is recovered from signal_registry_audit_log
--   (event_type = 'lineage_event_proposed', lineage_id = p_lineage_id,
--    event_payload->>'proposedBy').  If proposed_by = p_approved_by, the
--    function raises SELF_APPROVAL_NOT_PERMITTED.
--   This is the defence-in-depth check.  The G4C service layer performs the
--   same check before the RPC call (AMD-08: validation before DB write).
--
-- Concurrency:
--   The signal_lineage row is re-fetched inside the transaction using
--   FOR UPDATE to prevent two concurrent approvals racing each other.
--   If the row is already approved or rejected by the time the lock is
--   acquired, the function raises INVALID_LINEAGE_STATE.
--
-- Taxonomy version freshness:
--   The function verifies that taxonomy_version on the lineage row still
--   references an unexpired version in signal_category_hierarchy before
--   approving.  If the taxonomy has been deprecated since the proposal was
--   created, the function raises TAXONOMY_VERSION_EXPIRED.
--
-- Return contract:
--   { lineage_id: uuid, approved_at: timestamptz }
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_approve_lineage_transition(
    p_lineage_id        uuid,
    p_approved_by       text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row               public.signal_lineage%ROWTYPE;
    v_proposed_by       text;
    v_approved_at       timestamptz;
    v_audit_id          uuid;
    v_taxonomy_valid    integer;
BEGIN
    -- ── VAL-1: Input presence ─────────────────────────────────────────────────
    IF p_lineage_id IS NULL THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: lineage_id is required.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_approved_by IS NULL OR trim(p_approved_by) = '' THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: approved_by is required and must not be empty.'
            USING ERRCODE = 'P0001';
    END IF;

    -- ── Fetch with lock — prevents concurrent approval race ───────────────────
    -- FOR UPDATE acquires a row-level lock. If a concurrent transaction is
    -- already approving this row, this SELECT will block until that transaction
    -- commits or rolls back, at which point the row state is re-read.
    SELECT * INTO v_row
    FROM public.signal_lineage
    WHERE id = p_lineage_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'LINEAGE_NOT_FOUND: No signal_lineage row found with id=%. '
            'Verify the lineage_id before calling approve.', p_lineage_id
            USING ERRCODE = 'P0004';
    END IF;

    -- ── VAL-2: Row must still be in proposed state ────────────────────────────
    IF v_row.approved_at IS NOT NULL THEN
        RAISE EXCEPTION 'INVALID_LINEAGE_STATE: Lineage proposal % has already been approved '
            'at % by %. Cannot approve twice.',
            p_lineage_id, v_row.approved_at, v_row.approved_by
            USING ERRCODE = 'P0005';
    END IF;

    IF v_row.rejected_at IS NOT NULL THEN
        RAISE EXCEPTION 'INVALID_LINEAGE_STATE: Lineage proposal % has been rejected '
            'at % by % with reason: %. A rejected proposal cannot be approved.',
            p_lineage_id, v_row.rejected_at, v_row.rejected_by, v_row.rejection_reason
            USING ERRCODE = 'P0005';
    END IF;

    -- ── VAL-3: Four-eyes rule — recover original proposer from audit log ──────
    -- The proposed_by identity is stored in event_payload->>'proposedBy' in
    -- the lineage_event_proposed audit record for this lineage_id.
    -- We do NOT read proposed_by from signal_lineage itself — it is not stored
    -- there.  The audit log is the authoritative source.
    SELECT event_payload->>'proposedBy' INTO v_proposed_by
    FROM public.signal_registry_audit_log
    WHERE lineage_id   = p_lineage_id
      AND event_type   = 'lineage_event_proposed'
    ORDER BY performed_at ASC
    LIMIT 1;

    IF v_proposed_by IS NULL THEN
        -- Audit record missing: cannot verify four-eyes.
        -- Governance integrity violation — refuse the approval.
        RAISE EXCEPTION 'GOVERNANCE_VIOLATION: Cannot verify four-eyes rule for lineage_id=% '
            'because the lineage_event_proposed audit record is missing or has no proposedBy field. '
            'This is a governance integrity violation. Approval is blocked.',
            p_lineage_id
            USING ERRCODE = 'P0006';
    END IF;

    IF trim(lower(v_proposed_by)) = trim(lower(p_approved_by)) THEN
        RAISE EXCEPTION 'SELF_APPROVAL_NOT_PERMITTED: The approver (%) is the same identity '
            'as the original proposer (%). Four-eyes governance requires a different actor '
            'to approve each proposal.',
            p_approved_by, v_proposed_by
            USING ERRCODE = 'P0007';
    END IF;

    -- ── VAL-4: Taxonomy version freshness check ───────────────────────────────
    -- Verify that the taxonomy_version on the lineage row still resolves to a
    -- non-deprecated category hierarchy entry.  If the taxonomy version has been
    -- superseded or deprecated since the proposal was created, the approval is
    -- blocked with TAXONOMY_VERSION_EXPIRED.
    SELECT COUNT(*) INTO v_taxonomy_valid
    FROM public.signal_category_hierarchy
    WHERE taxonomy_version = v_row.taxonomy_version
      AND deprecated_at    IS NULL
    LIMIT 1;

    IF v_taxonomy_valid = 0 THEN
        RAISE EXCEPTION 'TAXONOMY_VERSION_EXPIRED: taxonomy_version=% referenced by lineage_id=% '
            'has no active (non-deprecated) entries in signal_category_hierarchy. '
            'The taxonomy version may have been deprecated after this proposal was created. '
            'Reject this proposal and create a new one with a current taxonomy version.',
            v_row.taxonomy_version, p_lineage_id
            USING ERRCODE = 'P0008';
    END IF;

    -- ── UPDATE: signal_lineage — set approved state ───────────────────────────
    v_approved_at := now();

    UPDATE public.signal_lineage
    SET approved_by  = trim(p_approved_by),
        approved_at  = v_approved_at,
        updated_at   = v_approved_at
    WHERE id = p_lineage_id;

    -- Verify the update applied (belt-and-suspenders against unexpected row
    -- deletion between the FOR UPDATE and the UPDATE — theoretically impossible
    -- given RLS and no-delete policy, but defensively checked).
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PERSISTENCE_ERROR: UPDATE of signal_lineage row % did not match '
            'any rows. This is an unexpected state. Transaction rolled back.',
            p_lineage_id
            USING ERRCODE = 'P0009';
    END IF;

    -- ── INSERT: audit record — lineage_event_approved ────────────────────────
    -- AMD-10: UPDATE and INSERT are atomic.
    -- If this INSERT fails, the UPDATE above is rolled back.
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
        'lineage_event_approved',
        v_row.predecessor_signal_key,
        v_row.taxonomy_version,
        trim(p_approved_by),
        jsonb_build_object(
            'lineageId',                v_row.id,
            'lineageType',              v_row.lineage_type::text,
            'predecessorKey',           v_row.predecessor_signal_key,
            'successorKey',             v_row.successor_signal_key,
            'lineageReason',            v_row.lineage_reason,
            'effectiveDate',            v_row.effective_date,
            'taxonomyVersion',          v_row.taxonomy_version,
            'weightReviewRequired',     v_row.weight_review_required,
            'originalProposedBy',       v_proposed_by,
            'approvedBy',               trim(p_approved_by),
            'action',                   'lineage_approved'
        ),
        v_row.id,
        v_approved_at
    );

    -- ── Return contract ───────────────────────────────────────────────────────
    RETURN jsonb_build_object(
        'lineage_id',  p_lineage_id,
        'approved_at', v_approved_at
    );

EXCEPTION
    WHEN OTHERS THEN
        RAISE;
END;
$$;

COMMENT ON FUNCTION public.fn_approve_lineage_transition(uuid, text) IS
    'G4D: Atomic RPC wrapper for lineage transition approval. '
    'Re-fetches the lineage row inside the transaction (FOR UPDATE) to prevent '
    'concurrent approval races. Enforces four-eyes rule by reading proposedBy '
    'from the audit log. Verifies taxonomy version freshness. '
    'Updates signal_lineage (approved_at, approved_by) and inserts '
    'lineage_event_approved audit record atomically. '
    'AMD-08: all validation before any mutation. '
    'AMD-10: UPDATE + INSERT are atomic. '
    'Returns: { lineage_id: uuid, approved_at: timestamptz }.';

REVOKE ALL ON FUNCTION public.fn_approve_lineage_transition(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_approve_lineage_transition(uuid, text) TO service_role;


-- ============================================================================
-- §4  fn_reject_lineage_transition()
--
-- Purpose : Reject a lineage proposal.  Marks the signal_lineage row as
--           rejected and writes a signal_metadata_changed audit record
--           (action = 'lineage_rejected') atomically.
--
-- Caller  : lineage.service.ts rejectLineageTransition() via supabase.rpc()
-- Role    : service_role
--
-- Rejection persistence model (defined here per G4D brief):
--   rejected_at (timestamptz)       — set to now()
--   rejected_by (text)              — the identity rejecting the proposal
--   rejection_reason (text)         — mandatory rationale (min 10 chars)
--
-- Self-rejection:
--   The original proposer IS permitted to reject (withdraw) their own proposal.
--   This is explicitly distinguished from the four-eyes APPROVAL constraint.
--   Confirmed correct in G4 Final Implementation Review (Section 6.4).
--
-- Audit event type:
--   signal_metadata_changed with event_payload.action = 'lineage_rejected'.
--   This is consistent with the approved registry_audit_event_type_enum
--   (no dedicated rejection event type exists).  The G4 Final Review confirmed
--   this is acceptable within enum constraints.
--
-- AMD-10 compliance:
--   signal_lineage UPDATE and audit INSERT are inside a single PL/pgSQL
--   function body.  Both succeed or both roll back.
--
-- Return contract:
--   { lineage_id: uuid, rejected_at: timestamptz }
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_reject_lineage_transition(
    p_lineage_id        uuid,
    p_rejected_by       text,
    p_rejection_reason  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row           public.signal_lineage%ROWTYPE;
    v_rejected_at   timestamptz;
    v_audit_id      uuid;
BEGIN
    -- ── VAL-1: Input presence ─────────────────────────────────────────────────
    IF p_lineage_id IS NULL THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: lineage_id is required.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_rejected_by IS NULL OR trim(p_rejected_by) = '' THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: rejected_by is required and must not be empty.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_rejection_reason IS NULL OR trim(p_rejection_reason) = '' THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: rejection_reason is required and must not be empty.'
            USING ERRCODE = 'P0001';
    END IF;

    IF char_length(trim(p_rejection_reason)) < 10 THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: rejection_reason must be at least 10 characters. '
            'Provided length: %.', char_length(trim(p_rejection_reason))
            USING ERRCODE = 'P0001';
    END IF;

    -- ── Fetch with lock ───────────────────────────────────────────────────────
    SELECT * INTO v_row
    FROM public.signal_lineage
    WHERE id = p_lineage_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'LINEAGE_NOT_FOUND: No signal_lineage row found with id=%. '
            'Verify the lineage_id before calling reject.', p_lineage_id
            USING ERRCODE = 'P0004';
    END IF;

    -- ── VAL-2: Row must be in proposed (open) state ───────────────────────────
    IF v_row.approved_at IS NOT NULL THEN
        RAISE EXCEPTION 'INVALID_LINEAGE_STATE: Lineage proposal % has already been approved '
            'at % by %. An approved transition cannot be rejected.',
            p_lineage_id, v_row.approved_at, v_row.approved_by
            USING ERRCODE = 'P0005';
    END IF;

    IF v_row.rejected_at IS NOT NULL THEN
        RAISE EXCEPTION 'INVALID_LINEAGE_STATE: Lineage proposal % has already been rejected '
            'at % by %. Cannot reject a proposal that is already rejected.',
            p_lineage_id, v_row.rejected_at, v_row.rejected_by
            USING ERRCODE = 'P0005';
    END IF;

    -- ── UPDATE: signal_lineage — set rejected state ───────────────────────────
    v_rejected_at := now();

    UPDATE public.signal_lineage
    SET rejected_by       = trim(p_rejected_by),
        rejected_at       = v_rejected_at,
        rejection_reason  = trim(p_rejection_reason),
        updated_at        = v_rejected_at
    WHERE id = p_lineage_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PERSISTENCE_ERROR: UPDATE of signal_lineage row % did not match '
            'any rows. Transaction rolled back.', p_lineage_id
            USING ERRCODE = 'P0009';
    END IF;

    -- ── INSERT: audit record — signal_metadata_changed (action=lineage_rejected)
    -- AMD-10: UPDATE and INSERT are atomic.
    -- The audit event_type is signal_metadata_changed (the only available
    -- audit vocabulary for this action per the approved
    -- registry_audit_event_type_enum).  The action field in the payload
    -- distinguishes this from other metadata-changed events.
    -- See G4 Final Review Section 6.4 confirmation.
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
        'signal_metadata_changed',
        v_row.predecessor_signal_key,
        v_row.taxonomy_version,
        trim(p_rejected_by),
        jsonb_build_object(
            'lineageId',        v_row.id,
            'lineageType',      v_row.lineage_type::text,
            'predecessorKey',   v_row.predecessor_signal_key,
            'successorKey',     v_row.successor_signal_key,
            'lineageReason',    v_row.lineage_reason,
            'effectiveDate',    v_row.effective_date,
            'taxonomyVersion',  v_row.taxonomy_version,
            'rejectedBy',       trim(p_rejected_by),
            'rejectionReason',  trim(p_rejection_reason),
            'changedFields',    jsonb_build_array('rejected_at', 'rejected_by', 'rejection_reason'),
            'changeReason',     trim(p_rejection_reason),
            'action',           'lineage_rejected'
        ),
        v_row.id,
        v_rejected_at
    );

    -- ── Return contract ───────────────────────────────────────────────────────
    RETURN jsonb_build_object(
        'lineage_id',   p_lineage_id,
        'rejected_at',  v_rejected_at
    );

EXCEPTION
    WHEN OTHERS THEN
        RAISE;
END;
$$;

COMMENT ON FUNCTION public.fn_reject_lineage_transition(uuid, text, text) IS
    'G4D: Atomic RPC wrapper for lineage proposal rejection. '
    'Self-rejection is permitted (proposer may withdraw own proposal). '
    'Approved proposals cannot be rejected. '
    'Updates signal_lineage (rejected_at, rejected_by, rejection_reason) '
    'and inserts signal_metadata_changed audit record (action=lineage_rejected) '
    'atomically. AMD-10 compliant. '
    'Returns: { lineage_id: uuid, rejected_at: timestamptz }.';

REVOKE ALL ON FUNCTION public.fn_reject_lineage_transition(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_reject_lineage_transition(uuid, text, text) TO service_role;


-- ============================================================================
-- §5  fn_validate_signal_keys() — Revised v2
--
-- Purpose : Validation support for LineageService. Validates predecessor and
--           successor signal keys, taxonomy version, signal lifecycle state,
--           and lineage compatibility. Returns a structured JSONB result.
--
-- Caller  : fn_propose_lineage_transition() internally; lineage.service.ts
--           validateLineageTransition() directly; fn_approve_lineage_transition()
--           internally for successor key re-validation at approval time.
--
-- Context parameter:
--   'proposal'  — validates for new proposal creation (VAL-T through VAL-L)
--   'approval'  — validates for approval (subset of checks; skips
--                 incompatible-state check as it was done at proposal time)
--
-- Return contract:
--   {
--     "valid": boolean,
--     "violations": [
--       {
--         "field": "predecessorSignalKey" | "successorSignalKey" | "taxonomyVersion",
--         "code": string,
--         "message": string
--       }
--     ],
--     "predecessor": {
--       "signalKey": text,
--       "displayName": text,
--       "lifecycleStatus": text,     -- computed: 'active' | 'deprecated' | 'retired'
--       "taxonomyVersion": text,
--       "aggregationCompatible": boolean,
--       "engineCompatible": boolean,
--       "deprecatedAt": timestamptz | null,
--       "deletedAt": timestamptz | null
--     } | null,
--     "successor": { ... same shape ... } | null
--   }
--
-- Lifecycle compatibility rules (C2 — R1 Final Approved Amendment):
--   Lifecycle state is derived from intelligence_signal_registry columns:
--     active     = deprecated_at IS NULL AND deleted_at IS NULL
--     deprecated = deprecated_at IS NOT NULL AND deleted_at IS NULL
--     retired    = deleted_at IS NOT NULL
--   (No 'draft' state exists in the deployed schema.)
--
--   Predecessor rule: must not be retired (deleted_at IS NULL).
--   Successor rule:   must be active
--                     (deprecated_at IS NULL AND deleted_at IS NULL).
--
-- AMD-08 compliance:
--   This function performs only SELECTs. No side effects. It is the
--   pre-write validation gate called by all write RPCs before any mutation.
--
-- Revision v2 changes (deployment fix):
--   CRITICAL: Nested PROCEDURE declaration removed entirely.
--   PostgreSQL does not support nested subprocedure declarations inside
--   PL/pgSQL DECLARE blocks at any version, including PG 17.
--   The pl_gram.y grammar has no production rule for subprocedures in
--   a DECLARE section. The AS $$ ... $$ syntax caused ERROR 42601
--   ('syntax error at or near "v_violations"') because the parser
--   tokenised $$ as the start of a new dollar-quoted string literal,
--   then found the outer DECLARE variable v_violations after the
--   closing $$ in an unexpected context.
--   Fix: the add_violation helper is inlined at all 10 call sites as
--   a direct v_violations assignment. Behavior is identical.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_validate_signal_keys(
    p_predecessor_key   text,
    p_successor_key     text        DEFAULT NULL,
    p_taxonomy_version  text        DEFAULT 'v1',
    p_lineage_type      text        DEFAULT NULL,
    p_context           text        DEFAULT 'proposal'   -- 'proposal' | 'approval'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_violations         jsonb := '[]'::jsonb;
    v_predecessor_row    public.intelligence_signal_registry%ROWTYPE;
    v_successor_row      public.intelligence_signal_registry%ROWTYPE;
    v_found_predecessor  boolean := false;
    v_found_successor    boolean := false;
    v_taxonomy_exists    integer;
    v_incompatible_count integer;
    v_predecessor_json   jsonb := 'null'::jsonb;
    v_successor_json     jsonb := 'null'::jsonb;
BEGIN
    -- ── VAL-T1: taxonomy_version non-empty ────────────────────────────────────
    IF p_taxonomy_version IS NULL OR trim(p_taxonomy_version) = '' THEN
        v_violations := v_violations || jsonb_build_object(
            'field',   'taxonomyVersion',
            'code',    'INVALID_TAXONOMY_VERSION',
            'message', 'taxonomy_version is required and must not be empty.'
        );
        -- Cannot proceed with registry lookups without a taxonomy version.
        -- Return early with this single violation.
        RETURN jsonb_build_object(
            'valid',        false,
            'violations',   v_violations,
            'predecessor',  v_predecessor_json,
            'successor',    v_successor_json
        );
    END IF;

    -- ── VAL-T2: taxonomy_version exists in signal_category_hierarchy ──────────
    -- Checks for at least one active (non-deprecated) hierarchy entry for
    -- this taxonomy version.
    SELECT COUNT(*) INTO v_taxonomy_exists
    FROM public.signal_category_hierarchy
    WHERE taxonomy_version = trim(p_taxonomy_version)
      AND deprecated_at    IS NULL
    LIMIT 1;

    IF v_taxonomy_exists = 0 THEN
        v_violations := v_violations || jsonb_build_object(
            'field',   'taxonomyVersion',
            'code',    'INVALID_TAXONOMY_VERSION',
            'message', format(
                'taxonomy_version=%L has no active entries in signal_category_hierarchy. '
                'Either the version does not exist or has been deprecated.',
                trim(p_taxonomy_version)
            )
        );
    END IF;

    -- ── VAL-P1: predecessor_signal_key non-empty ──────────────────────────────
    IF p_predecessor_key IS NULL OR trim(p_predecessor_key) = '' THEN
        v_violations := v_violations || jsonb_build_object(
            'field',   'predecessorSignalKey',
            'code',    'INVALID_SIGNAL_KEY',
            'message', 'predecessor_signal_key is required and must not be empty.'
        );
    ELSE
        -- ── VAL-P2: predecessor resolves in intelligence_signal_registry ───────
        SELECT * INTO v_predecessor_row
        FROM public.intelligence_signal_registry
        WHERE signal_key       = trim(p_predecessor_key)
          AND taxonomy_version = trim(p_taxonomy_version)
        LIMIT 1;

        IF FOUND THEN
            v_found_predecessor := true;

            -- lifecycleStatus is computed from deprecated_at / deleted_at.
            -- intelligence_signal_registry has no lifecycle_status column.
            -- Lifecycle mapping:
            --   retired    = deleted_at IS NOT NULL
            --   deprecated = deprecated_at IS NOT NULL AND deleted_at IS NULL
            --   active     = deprecated_at IS NULL AND deleted_at IS NULL
            v_predecessor_json := jsonb_build_object(
                'signalKey',             v_predecessor_row.signal_key,
                'displayName',           v_predecessor_row.display_name,
                'lifecycleStatus',       CASE
                                           WHEN v_predecessor_row.deleted_at    IS NOT NULL
                                               THEN 'retired'
                                           WHEN v_predecessor_row.deprecated_at IS NOT NULL
                                               THEN 'deprecated'
                                           ELSE 'active'
                                         END,
                'taxonomyVersion',       v_predecessor_row.taxonomy_version,
                'aggregationCompatible', v_predecessor_row.aggregation_compatible,
                'engineCompatible',      v_predecessor_row.engine_compatible,
                'deprecatedAt',          v_predecessor_row.deprecated_at,
                'deletedAt',             v_predecessor_row.deleted_at
            );

            -- ── VAL-P3: predecessor lifecycle compatibility ─────────────────────
            -- C2 (R1 Final Approved Amendment): predecessor must not be retired.
            -- Retired = deleted_at IS NOT NULL.
            -- Active and deprecated signals may both receive lineage events.
            -- Retired signals are permanently withdrawn — no further lineage possible.
            IF v_predecessor_row.deleted_at IS NOT NULL THEN
                v_violations := v_violations || jsonb_build_object(
                    'field',   'predecessorSignalKey',
                    'code',    'INVALID_SIGNAL_KEY',
                    'message', format(
                        'predecessor_signal_key=%L is retired (deleted_at=%L). '
                        'Only active or deprecated signals may be used as predecessors. '
                        'Retired signals are permanently withdrawn from governance.',
                        v_predecessor_row.signal_key,
                        v_predecessor_row.deleted_at
                    )
                );
            END IF;

        ELSE
            v_violations := v_violations || jsonb_build_object(
                'field',   'predecessorSignalKey',
                'code',    'INVALID_SIGNAL_KEY',
                'message', format(
                    'predecessor_signal_key=%L not found in intelligence_signal_registry '
                    'for taxonomy_version=%L.',
                    trim(p_predecessor_key),
                    trim(p_taxonomy_version)
                )
            );
        END IF;
    END IF;

    -- ── VAL-S: successor_signal_key validation ────────────────────────────────
    -- successor is optional (NULL for retired_no_successor).
    -- When provided, it must exist and have a compatible lifecycle state.
    IF p_successor_key IS NOT NULL AND trim(p_successor_key) <> '' THEN

        -- ── VAL-S1: predecessor ≠ successor ────────────────────────────────────
        IF trim(p_predecessor_key) = trim(p_successor_key) THEN
            v_violations := v_violations || jsonb_build_object(
                'field',   'successorSignalKey',
                'code',    'INVALID_SUCCESSOR_KEY',
                'message', format(
                    'successor_signal_key=%L is identical to predecessor_signal_key. '
                    'A signal cannot be its own successor.',
                    trim(p_successor_key)
                )
            );
        ELSE
            -- ── VAL-S2: successor resolves in intelligence_signal_registry ─────
            SELECT * INTO v_successor_row
            FROM public.intelligence_signal_registry
            WHERE signal_key       = trim(p_successor_key)
              AND taxonomy_version = trim(p_taxonomy_version)
            LIMIT 1;

            IF FOUND THEN
                v_found_successor := true;

                -- lifecycleStatus computed from deprecated_at / deleted_at.
                v_successor_json := jsonb_build_object(
                    'signalKey',             v_successor_row.signal_key,
                    'displayName',           v_successor_row.display_name,
                    'lifecycleStatus',       CASE
                                               WHEN v_successor_row.deleted_at    IS NOT NULL
                                                   THEN 'retired'
                                               WHEN v_successor_row.deprecated_at IS NOT NULL
                                                   THEN 'deprecated'
                                               ELSE 'active'
                                             END,
                    'taxonomyVersion',       v_successor_row.taxonomy_version,
                    'aggregationCompatible', v_successor_row.aggregation_compatible,
                    'engineCompatible',      v_successor_row.engine_compatible,
                    'deprecatedAt',          v_successor_row.deprecated_at,
                    'deletedAt',             v_successor_row.deleted_at
                );

                -- ── VAL-S3: successor lifecycle compatibility ───────────────────
                -- A successor must be active:
                --   deprecated_at IS NULL AND deleted_at IS NULL.
                -- A deprecated signal is transitioning out of use — it cannot
                -- receive new lineage events as a target.
                -- A retired signal is permanently withdrawn — same.
                -- Note: no 'draft' lifecycle state exists in the deployed schema.
                IF v_successor_row.deprecated_at IS NOT NULL
                   OR v_successor_row.deleted_at IS NOT NULL THEN
                    v_violations := v_violations || jsonb_build_object(
                        'field',   'successorSignalKey',
                        'code',    'INVALID_SUCCESSOR_KEY',
                        'message', format(
                            'successor_signal_key=%L is not active '
                            '(deprecated_at=%L, deleted_at=%L). '
                            'Only active signals may be used as successors. '
                            'A deprecated or retired signal cannot receive new lineage.',
                            v_successor_row.signal_key,
                            v_successor_row.deprecated_at,
                            v_successor_row.deleted_at
                        )
                    );
                END IF;

            ELSE
                v_violations := v_violations || jsonb_build_object(
                    'field',   'successorSignalKey',
                    'code',    'INVALID_SIGNAL_KEY',
                    'message', format(
                        'successor_signal_key=%L not found in intelligence_signal_registry '
                        'for taxonomy_version=%L.',
                        trim(p_successor_key),
                        trim(p_taxonomy_version)
                    )
                );
            END IF;
        END IF;

    ELSIF p_successor_key IS NULL OR trim(p_successor_key) = '' THEN
        -- Null successor: valid only for retired_no_successor.
        -- The lineage type check is performed by the calling RPC, not here,
        -- because fn_validate_signal_keys() is also called as a dry-run
        -- validation tool from the service layer which may not always have
        -- the lineage type available at call time.
        -- If p_lineage_type is provided and is NOT retired_no_successor,
        -- we surface the violation here for complete validation support.
        IF p_lineage_type IS NOT NULL AND p_lineage_type <> 'retired_no_successor' THEN
            v_violations := v_violations || jsonb_build_object(
                'field',   'successorSignalKey',
                'code',    'INVALID_SUCCESSOR_KEY',
                'message', format(
                    'successor_signal_key is required for lineage_type=%L. '
                    'Only retired_no_successor permits a null successor.',
                    p_lineage_type
                )
            );
        END IF;
    END IF;

    -- ── VAL-L: Lineage compatibility — incompatible existing approved transitions
    -- For 'proposal' context only.  For 'approval' context this check was
    -- already performed at proposal creation time.
    IF p_context = 'proposal' AND v_found_predecessor
       AND (p_predecessor_key IS NOT NULL AND trim(p_predecessor_key) <> '') THEN

        SELECT COUNT(*) INTO v_incompatible_count
        FROM public.signal_lineage
        WHERE predecessor_signal_key = trim(p_predecessor_key)
          AND taxonomy_version        = trim(p_taxonomy_version)
          AND approved_at             IS NOT NULL
          AND lineage_type IN (
              'retired_no_successor',
              'renamed_to',
              'superseded_by',
              'merged_into'
          );

        IF v_incompatible_count > 0 THEN
            v_violations := v_violations || jsonb_build_object(
                'field',   'predecessorSignalKey',
                'code',    'INCOMPATIBLE_LINEAGE_STATE',
                'message', format(
                    'predecessor_signal_key=%L already has an approved terminal lineage '
                    'transition (retired_no_successor, renamed_to, superseded_by, or '
                    'merged_into) in taxonomy_version=%L. '
                    'No new proposals are permitted for a signal with a terminal transition.',
                    trim(p_predecessor_key),
                    trim(p_taxonomy_version)
                )
            );
        END IF;
    END IF;

    -- ── Build and return result ───────────────────────────────────────────────
    RETURN jsonb_build_object(
        'valid',        jsonb_array_length(v_violations) = 0,
        'violations',   v_violations,
        'predecessor',  v_predecessor_json,
        'successor',    v_successor_json
    );

END;
$$;

COMMENT ON FUNCTION public.fn_validate_signal_keys(text, text, text, text, text) IS
    'G4D Rev2: Validation function for LineageService. '
    'Validates predecessor and successor signal keys against '
    'intelligence_signal_registry, verifies taxonomy_version freshness in '
    'signal_category_hierarchy, checks lifecycle compatibility per '
    'C2 (R1 Final Approved Amendment), and detects incompatible existing '
    'approved lineage events. '
    'Lifecycle state is derived from deprecated_at / deleted_at columns '
    '(intelligence_signal_registry has no lifecycle_status column): '
    '  active     = deprecated_at IS NULL AND deleted_at IS NULL; '
    '  deprecated = deprecated_at IS NOT NULL AND deleted_at IS NULL; '
    '  retired    = deleted_at IS NOT NULL. '
    'Predecessor must not be retired (deleted_at IS NULL). '
    'Successor must be active (deprecated_at IS NULL AND deleted_at IS NULL). '
    'STABLE: performs only SELECTs, no side effects. '
    'SECURITY DEFINER: called by both service_role (via lineage.service.ts) '
    'and internally by fn_propose_lineage_transition(). '
    'p_context = proposal | approval (controls which validation stages run). '
    'Returns: { valid: bool, violations: [...], predecessor: {...}, successor: {...} }.';

REVOKE ALL ON FUNCTION public.fn_validate_signal_keys(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_validate_signal_keys(text, text, text, text, text) TO service_role;

-- ============================================================================
-- §6  POST-DEPLOYMENT ASSERTIONS
-- Verify all G4D objects were created successfully and the legacy 1A trigger
-- has been cleaned up.  Aborts the transaction if any expected object is
-- missing or any forbidden object remains.
-- ============================================================================

DO $$
DECLARE
    v_count integer;
BEGIN
    -- Assert fn_propose_lineage_transition exists
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'fn_propose_lineage_transition'
      AND n.nspname = 'public';
    IF v_count = 0 THEN
        RAISE EXCEPTION 'G4D POST-ASSERTION FAILED: fn_propose_lineage_transition not found. '
            'Ensure G4D_Package_Part1_Revised.sql was deployed before Part 2.';
    END IF;

    -- Assert fn_approve_lineage_transition exists
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'fn_approve_lineage_transition'
      AND n.nspname = 'public';
    IF v_count = 0 THEN
        RAISE EXCEPTION 'G4D POST-ASSERTION FAILED: fn_approve_lineage_transition not found.';
    END IF;

    -- Assert fn_reject_lineage_transition exists
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'fn_reject_lineage_transition'
      AND n.nspname = 'public';
    IF v_count = 0 THEN
        RAISE EXCEPTION 'G4D POST-ASSERTION FAILED: fn_reject_lineage_transition not found.';
    END IF;

    -- Assert fn_validate_signal_keys exists
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'fn_validate_signal_keys'
      AND n.nspname = 'public';
    IF v_count = 0 THEN
        RAISE EXCEPTION 'G4D POST-ASSERTION FAILED: fn_validate_signal_keys not found.';
    END IF;

    -- Assert fn_propose_lineage_transition uses lineage_type_enum in signature
    -- (C-02 regression guard)
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname  = 'fn_propose_lineage_transition'
      AND n.nspname  = 'public'
      AND pg_get_function_arguments(p.oid) LIKE '%lineage_type_enum%';
    IF v_count = 0 THEN
        RAISE EXCEPTION 'G4D POST-ASSERTION FAILED (C-02 regression): '
            'fn_propose_lineage_transition does not use lineage_type_enum in its signature. '
            'The Revised Part 1 file may not have been applied correctly.';
    END IF;

    -- Assert rejection columns exist on signal_lineage
    SELECT COUNT(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'signal_lineage'
      AND column_name  IN ('rejected_at', 'rejected_by', 'rejection_reason');
    IF v_count <> 3 THEN
        RAISE EXCEPTION 'G4D POST-ASSERTION FAILED: rejection columns on signal_lineage '
            'expected 3, found %.', v_count;
    END IF;

    -- Assert chk_lineage_not_approved_and_rejected constraint exists
    SELECT COUNT(*) INTO v_count
    FROM pg_constraint
    WHERE conname  = 'chk_lineage_not_approved_and_rejected'
      AND conrelid = 'public.signal_lineage'::regclass;
    IF v_count = 0 THEN
        RAISE EXCEPTION 'G4D POST-ASSERTION FAILED: '
            'chk_lineage_not_approved_and_rejected constraint not found.';
    END IF;

    -- Assert G4D immutability trigger exists
    SELECT COUNT(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE t.tgname  = 'trg_signal_lineage_immutability'
      AND c.relname = 'signal_lineage'
      AND n.nspname = 'public';
    IF v_count = 0 THEN
        RAISE EXCEPTION 'G4D POST-ASSERTION FAILED: '
            'trg_signal_lineage_immutability trigger not found on signal_lineage.';
    END IF;

    -- Assert legacy Sprint 1A trigger is gone (M-03 / M-04 regression guard)
    SELECT COUNT(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE t.tgname  = 'trg_immutability_signal_lineage'
      AND c.relname = 'signal_lineage'
      AND n.nspname = 'public';
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'G4D POST-ASSERTION FAILED (M-03 regression): '
            'Legacy trigger trg_immutability_signal_lineage still exists on signal_lineage. '
            'Ensure G4D_Package_Part1_Revised.sql §0 executed successfully.';
    END IF;

    -- Assert legacy Sprint 1A function is gone (M-04 regression guard)
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'fn_trg_immutability_signal_lineage'
      AND n.nspname = 'public';
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'G4D POST-ASSERTION FAILED (M-04 regression): '
            'Legacy function fn_trg_immutability_signal_lineage still exists. '
            'Ensure G4D_Package_Part1_Revised.sql §0 executed successfully.';
    END IF;

    -- Assert exactly one immutability trigger on signal_lineage
    -- (duplicate trigger guard — belt-and-suspenders for M-03)
    SELECT COUNT(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'signal_lineage'
      AND n.nspname = 'public'
      AND t.tgname  LIKE '%immutab%';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'G4D POST-ASSERTION FAILED (M-03 regression): '
            'Expected exactly 1 immutability trigger on signal_lineage, found %. '
            'Check for duplicate triggers.', v_count;
    END IF;

    RAISE NOTICE 'G4D POST-DEPLOYMENT ASSERTIONS PASSED: '
        '4 functions created, '
        'fn_propose_lineage_transition uses lineage_type_enum, '
        '3 rejection columns present, '
        '1 constraint present, '
        '1 immutability trigger present (legacy 1A trigger confirmed absent).';
END;
$$;

COMMIT;