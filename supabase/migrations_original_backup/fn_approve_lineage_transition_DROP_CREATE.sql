-- =============================================================================
-- HIRERISE  Phase 2A.1  ·  Sprint 1  ·  Package G4D
-- Artifact 3: fn_approve_lineage_transition() — DROP + CREATE REPLACEMENT
-- =============================================================================
--
-- !! DROP + CREATE — USE WHEN CREATE OR REPLACE IS SILENTLY IGNORED !!
--
-- Context:
--   Two prior attempts (diagnostic DO-block wrapper, then bare CREATE OR REPLACE)
--   both returned success but pg_get_functiondef confirmed the stale body
--   remained live in both cases.  CREATE OR REPLACE is silently suppressed when
--   the executing session role does not own the existing function.  Supabase
--   SQL Editor runs as the postgres role; if the function is owned by
--   supabase_admin or another role, CREATE OR REPLACE produces no error but
--   makes no change.
--
--   Solution: DROP FUNCTION (requires only USAGE on schema + ownership OR
--   superuser), then CREATE FUNCTION.  The DROP forces a clean slate
--   regardless of the prior owner.  The new function is owned by the
--   executing role.
--
--   If DROP also fails with a permissions error, run:
--     ALTER FUNCTION public.fn_approve_lineage_transition(uuid, text)
--     OWNER TO postgres;
--   then re-run this file.
--
-- Verification after run:
--   SELECT pg_get_functiondef(p.oid)
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE p.proname = 'fn_approve_lineage_transition'
--     AND n.nspname = 'public';
--
--   Required in output:
--     IF NOT EXISTS (
--     SELECT 1
--     FROM public.signal_category_hierarchy
--     is_active = true
--
--   Forbidden (must be absent):
--     deprecated_at
--     SELECT COUNT(*) INTO v_taxonomy_valid
-- =============================================================================


DROP FUNCTION IF EXISTS public.fn_approve_lineage_transition(uuid, text);


CREATE FUNCTION public.fn_approve_lineage_transition(
    p_lineage_id    uuid,
    p_approved_by   text
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
BEGIN
    -- ══════════════════════════════════════════════════════════════════════════
    -- PRE-WRITE VALIDATION (AMD-08)
    -- ALL checks before UPDATE and INSERT.
    -- ══════════════════════════════════════════════════════════════════════════

    -- ── VAL-1: Input presence ─────────────────────────────────────────────────

    IF p_lineage_id IS NULL THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: lineage_id is required.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_approved_by IS NULL OR trim(p_approved_by) = '' THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: approved_by is required and must not be empty.'
            USING ERRCODE = 'P0001';
    END IF;

    -- ── Row fetch with lock — concurrent approval prevention ─────────────────
    -- FOR UPDATE acquires a row-level exclusive lock on this signal_lineage row.
    -- A concurrent fn_approve_lineage_transition or fn_reject_lineage_transition
    -- call for the same lineage_id will block here until this transaction
    -- completes (commit or rollback).  After the lock is acquired, the row state
    -- is re-read from storage — this re-read reflects any mutations made by
    -- competing transactions that committed before this lock was granted.

    SELECT * INTO v_row
    FROM public.signal_lineage
    WHERE id = p_lineage_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'LINEAGE_NOT_FOUND: No signal_lineage row found with id=%. '
            'Verify the lineage_id before calling approve.', p_lineage_id
            USING ERRCODE = 'P0004';
    END IF;

    -- ── VAL-2: Re-check row state inside transaction ──────────────────────────
    -- After acquiring the FOR UPDATE lock, the row state is authoritative.
    -- A concurrent approval or rejection that completed while we were waiting
    -- for the lock is now visible.

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

    -- ── VAL-3: Four-eyes rule — proposed_by from audit log ────────────────────
    -- The proposer identity is stored ONLY in signal_registry_audit_log.
    -- signal_lineage has no proposed_by column.
    -- We read event_payload->>'proposedBy' from the lineage_event_proposed record.
    -- If the audit record is missing, we block the approval rather than allowing
    -- a bypass — audit completeness is a governance requirement.

    SELECT event_payload->>'proposedBy' INTO v_proposed_by
    FROM public.signal_registry_audit_log
    WHERE lineage_id = p_lineage_id
      AND event_type = 'lineage_event_proposed'
    ORDER BY performed_at ASC
    LIMIT 1;

    IF v_proposed_by IS NULL THEN
        RAISE EXCEPTION 'GOVERNANCE_VIOLATION: Cannot verify four-eyes rule for lineage_id=% '
            'because the lineage_event_proposed audit record is missing or '
            'has no proposedBy field. '
            'This is a governance integrity violation. Approval is blocked.',
            p_lineage_id
            USING ERRCODE = 'P0006';
    END IF;

    -- Four-eyes identity check: case-insensitive, whitespace-trimmed comparison.
    IF trim(lower(v_proposed_by)) = trim(lower(p_approved_by)) THEN
        RAISE EXCEPTION 'SELF_APPROVAL_NOT_PERMITTED: The approver (%) is the same identity '
            'as the original proposer (%). Four-eyes governance requires a different actor '
            'to approve each proposal.',
            p_approved_by, v_proposed_by
            USING ERRCODE = 'P0007';
    END IF;

    -- ── VAL-4: Taxonomy version freshness ─────────────────────────────────────
    -- The taxonomy_version on the lineage row is re-validated at approval time.
    -- signal_category_hierarchy uses is_active boolean for lifecycle governance.
    -- There is NO deprecated_at column on signal_category_hierarchy (Sprint 1A DB-06).
    -- A taxonomy_version is active if at least one row in signal_category_hierarchy
    -- has taxonomy_version = v_row.taxonomy_version AND is_active = true.
    -- If no such row exists, the taxonomy version has been deactivated since
    -- the proposal was created and the approval is blocked.
    -- F-05: NOT EXISTS short-circuit — stops at first matching row, avoids
    --       COUNT aggregate scan over all matching rows.

    IF NOT EXISTS (
        SELECT 1
        FROM public.signal_category_hierarchy
        WHERE taxonomy_version = v_row.taxonomy_version
          AND is_active         = true
        LIMIT 1
    ) THEN
        RAISE EXCEPTION 'TAXONOMY_VERSION_EXPIRED: taxonomy_version=% referenced by lineage_id=% '
            'has no active (is_active = true) entries in signal_category_hierarchy. '
            'The taxonomy version may have been deactivated after this proposal was created. '
            'Reject this proposal and create a new one with a current taxonomy version.',
            v_row.taxonomy_version, p_lineage_id
            USING ERRCODE = 'P0008';
    END IF;


    -- ══════════════════════════════════════════════════════════════════════════
    -- ATOMIC DUAL-WRITE (AMD-10)
    -- UPDATE + INSERT inside this PL/pgSQL body.  Either both succeed or both
    -- roll back.  No partial approval state is possible.
    -- ══════════════════════════════════════════════════════════════════════════

    v_approved_at := now();

    -- ── UPDATE: signal_lineage — set approved state ───────────────────────────

    UPDATE public.signal_lineage
    SET approved_by = trim(p_approved_by),
        approved_at = v_approved_at,
        updated_at  = v_approved_at
    WHERE id = p_lineage_id;

    -- Belt-and-suspenders: verify the UPDATE matched a row.
    -- Theoretically impossible given the FOR UPDATE lock and the RLS no-delete
    -- policy, but checked defensively.
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PERSISTENCE_ERROR: UPDATE of signal_lineage row % did not match '
            'any rows after successful FOR UPDATE lock. '
            'This is an unexpected state. Transaction rolled back.',
            p_lineage_id
            USING ERRCODE = 'P0009';
    END IF;

    -- ── INSERT: audit record — lineage_event_approved ────────────────────────
    -- AMD-10: if this INSERT fails, the UPDATE above is rolled back.
    -- Audit record is the permanent governance trace for this approval event.

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
            'lineageId',              v_row.id,
            'lineageType',            v_row.lineage_type::text,
            'predecessorKey',         v_row.predecessor_signal_key,
            'successorKey',           v_row.successor_signal_key,
            'lineageReason',          v_row.lineage_reason,
            'effectiveDate',          v_row.effective_date,
            'taxonomyVersion',        v_row.taxonomy_version,
            'weightReviewRequired',   v_row.weight_review_required,
            'originalProposedBy',     v_proposed_by,
            'approvedBy',             trim(p_approved_by),
            'action',                 'lineage_approved'
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
        -- Re-raise unconditionally.  Both UPDATE and INSERT are rolled back.
        RAISE;
END;
$$;


GRANT EXECUTE ON FUNCTION public.fn_approve_lineage_transition(uuid, text) TO service_role;
