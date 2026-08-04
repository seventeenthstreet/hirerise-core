-- =============================================================================
-- DB-FR-011 — CHI Score Ambiguous Column Fix + Lineage Rejection Workflow
--             Completion (supersedes DB-FR-010 Part 2)
-- =============================================================================
-- IMPORTANT: Do NOT also apply DB-FR-010_migration.sql's Part 2 (the version
-- of fn_approve_lineage_transition that deletes the VAL-2 rejected_at check).
-- That fix was based on a research error — see notes below. If DB-FR-010 has
-- already been applied to a database, re-running this migration will restore
-- the correct behaviour (CREATE OR REPLACE is idempotent).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- PART 1 — public.upsert_chi_score()
-- -----------------------------------------------------------------------------
-- Bug 1 (ambiguous "id", confirmed correct from DB-FR-010 Part 1): RETURNS
-- TABLE(id text) implicitly declares a PL/pgSQL variable named "id" for the
-- OUT column, colliding with the "id" column of "chi_scores". PL/pgSQL's
-- default variable_conflict mode ("error") rejects this as ambiguous
-- (SQLSTATE 42702). Fixed with the "#variable_conflict use_column" pragma —
-- table column wins over the same-named OUT variable. The OUT column is
-- populated via the explicit "RETURN QUERY SELECT v_id" and never referenced
-- bare, so nothing is lost.
--
-- Bug 2 (ON CONFLICT target, found after fixing Bug 1 unmasked it):
-- "chi_scores" is RANGE-partitioned on last_updated (confirmed live: monthly
-- partitions chi_scores_2026_04 .. chi_scores_2026_09 plus chi_scores_default
-- are attached and healthy). Postgres requires the partition key to be part
-- of any unique constraint on a partitioned table, so the only real unique
-- index is chi_scores_v2_pkey on (id, last_updated) — never on id alone.
-- "ON CONFLICT (id)" can therefore never match anything and always fails
-- with "no unique or exclusion constraint matching the ON CONFLICT
-- specification" (SQLSTATE 42P10).
--
-- Fix: target (id, last_updated) instead, matching the real index. Note this
-- also matches the table's evident design intent: public.get_latest_chi_score
-- (p_user_id, p_lookback_days) exists and reads chi_scores as a time-series
-- history, not a single mutable row per user+role. Because last_updated is
-- set to NOW() on every call, a genuine (id, last_updated) collision only
-- happens if two calls land in the same microsecond — in practice this
-- function now behaves as an append-only insert of a new historical
-- snapshot per call, which matches the get_latest_chi_score usage pattern.
-- The DO UPDATE branch is kept for correctness in the rare exact-collision
-- case rather than removed.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upsert_chi_score(
    p_user_id            uuid,
    p_role_id            uuid,
    p_skill_match        integer,
    p_experience_fit     integer,
    p_market_demand      integer,
    p_learning_progress  integer,
    p_chi_score          integer
)
RETURNS TABLE(id text)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
#variable_conflict use_column
DECLARE
  v_id text := p_user_id::text || '_' || p_role_id::text;
BEGIN
  INSERT INTO chi_scores (
    id,
    user_id,
    role_id,
    skill_match,
    experience_fit,
    market_demand,
    learning_progress,
    chi_score,
    last_updated
  )
  VALUES (
    v_id,
    p_user_id,
    p_role_id,
    p_skill_match,
    p_experience_fit,
    p_market_demand,
    p_learning_progress,
    p_chi_score,
    NOW()
  )
  ON CONFLICT (id, last_updated)
  DO UPDATE SET
    skill_match        = EXCLUDED.skill_match,
    experience_fit      = EXCLUDED.experience_fit,
    market_demand        = EXCLUDED.market_demand,
    learning_progress    = EXCLUDED.learning_progress,
    chi_score            = EXCLUDED.chi_score;

  RETURN QUERY SELECT v_id;
END;
$function$;


-- -----------------------------------------------------------------------------
-- PART 2 — public.fn_approve_lineage_transition() rejected_at check
-- -----------------------------------------------------------------------------
-- DB-FR-010 Part 2 concluded the lineage rejection workflow was never
-- delivered and deleted the VAL-2 rejected_at re-check from
-- fn_approve_lineage_transition on that basis. That conclusion does not hold:
--
--   1. hirerise/front/src/services/intelligence/lineage.service.ts contains a
--      complete, actively-used rejectLineageTransition() method that calls
--      fn_reject_lineage_transition via RPC with a full validation, error
--      handling, and typed-result contract.
--   2. The live database already has rejected_at / rejected_by /
--      rejection_reason columns on signal_lineage (confirmed via
--      information_schema.columns) — they exist as untracked schema drift,
--      not as something that was never built.
--   3. 20260531000005_migration_m3_security_foundation.sql explicitly
--      documents the open-proposal partial unique index
--      (WHERE approved_at IS NULL AND rejected_at IS NULL) as a real,
--      specified Sprint 1A/1B deliverable that was deferred to a gap-
--      remediation migration — not abandoned.
--
-- The actual root cause of the original lint error is simpler: the
-- rejected_at / rejected_by / rejection_reason columns were added to the
-- live database by hand at some point and never captured in a migration, so
-- a clean `supabase db reset` (migrations only) produces a signal_lineage
-- table that's missing them — which is exactly what `supabase db lint`
-- caught. Part 3 below formalizes those columns into migration history.
-- fn_approve_lineage_transition itself needs NO changes — the existing
-- VAL-2 rejected_at check (from 20260531000007) is correct and is restored
-- implicitly once the columns exist again.
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- PART 3 — Formalize signal_lineage rejection columns
-- -----------------------------------------------------------------------------

ALTER TABLE public.signal_lineage
  ADD COLUMN IF NOT EXISTS rejected_at      timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by      text,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

COMMENT ON COLUMN public.signal_lineage.rejected_at IS
  'Set when a proposed lineage transition is rejected via fn_reject_lineage_transition. NULL for proposed/approved rows.';
COMMENT ON COLUMN public.signal_lineage.rejected_by IS
  'Identity of the rejecting actor. Self-rejection is permitted (no four-eyes constraint on reject).';
COMMENT ON COLUMN public.signal_lineage.rejection_reason IS
  'Human-readable rejection rationale. Application layer enforces a 10-character minimum.';


-- -----------------------------------------------------------------------------
-- PART 4 — public.fn_reject_lineage_transition() (new — was never deployed
--          via migration, only ever referenced in comments)
-- -----------------------------------------------------------------------------
-- Contract mirrors what lineage.service.ts already calls today:
--   rpc('fn_reject_lineage_transition', {
--     p_lineage_id, p_rejected_by, p_rejection_reason,
--     p_signal_key, p_taxonomy_version
--   })
-- Frontend expects the error message to contain the literal substring
-- "not in proposed state" when the row is already approved or rejected, and
-- expects the success payload to include a "rejected_at" key.
--
-- Unlike approve, no four-eyes check: self-rejection is explicitly permitted
-- (see lineage.service.ts comment on rejectLineageTransition). Audit event
-- uses 'signal_metadata_changed' with action: 'lineage_rejected' in the
-- payload, per public.registry_audit_event_type_enum's own comment: "
-- signal_metadata_changed is also used for lineage rejection events (action
-- field in payload)."
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_reject_lineage_transition(
    p_lineage_id        uuid,
    p_rejected_by        text,
    p_rejection_reason   text,
    p_signal_key         text,
    p_taxonomy_version    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row               public.signal_lineage%ROWTYPE;
    v_rejected_at       timestamptz;
    v_audit_id          uuid;
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

    IF p_rejection_reason IS NULL OR length(trim(p_rejection_reason)) < 10 THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: rejection_reason is required and must be at least 10 characters.'
            USING ERRCODE = 'P0001';
    END IF;

    -- ── Row fetch with lock — concurrent approval/rejection prevention ───────
    -- Mirrors fn_approve_lineage_transition: FOR UPDATE blocks a concurrent
    -- approve/reject on the same lineage_id until this transaction completes.

    SELECT * INTO v_row
    FROM public.signal_lineage
    WHERE id = p_lineage_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'LINEAGE_NOT_FOUND: No signal_lineage row found with id=%. '
            'Verify the lineage_id before calling reject.', p_lineage_id
            USING ERRCODE = 'P0004';
    END IF;

    -- ── VAL-2: Row must still be in proposed state ────────────────────────────
    -- Message deliberately contains "not in proposed state" — the frontend
    -- (lineage.service.ts) pattern-matches on that exact substring to surface
    -- a friendlier INVALID_LINEAGE_STATE error for concurrent-modification
    -- cases.

    IF v_row.approved_at IS NOT NULL THEN
        RAISE EXCEPTION 'INVALID_LINEAGE_STATE: Lineage proposal % is not in proposed state '
            '(already approved at % by %). Cannot reject.',
            p_lineage_id, v_row.approved_at, v_row.approved_by
            USING ERRCODE = 'P0005';
    END IF;

    IF v_row.rejected_at IS NOT NULL THEN
        RAISE EXCEPTION 'INVALID_LINEAGE_STATE: Lineage proposal % is not in proposed state '
            '(already rejected at % by %). Cannot reject twice.',
            p_lineage_id, v_row.rejected_at, v_row.rejected_by
            USING ERRCODE = 'P0005';
    END IF;

    -- ══════════════════════════════════════════════════════════════════════════
    -- ATOMIC DUAL-WRITE (AMD-10) — mirrors fn_approve_lineage_transition
    -- ══════════════════════════════════════════════════════════════════════════

    v_rejected_at := now();

    UPDATE public.signal_lineage
    SET rejected_by      = trim(p_rejected_by),
        rejected_at      = v_rejected_at,
        rejection_reason = trim(p_rejection_reason),
        updated_at       = v_rejected_at
    WHERE id = p_lineage_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PERSISTENCE_ERROR: UPDATE of signal_lineage row % did not match '
            'any rows after successful FOR UPDATE lock. '
            'This is an unexpected state. Transaction rolled back.',
            p_lineage_id
            USING ERRCODE = 'P0009';
    END IF;

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
        coalesce(p_signal_key, v_row.predecessor_signal_key),
        coalesce(p_taxonomy_version, v_row.taxonomy_version),
        trim(p_rejected_by),
        jsonb_build_object(
            'lineageId',          v_row.id,
            'lineageType',        v_row.lineage_type::text,
            'predecessorKey',     v_row.predecessor_signal_key,
            'successorKey',       v_row.successor_signal_key,
            'lineageReason',      v_row.lineage_reason,
            'taxonomyVersion',    v_row.taxonomy_version,
            'rejectedBy',         trim(p_rejected_by),
            'rejectionReason',    trim(p_rejection_reason),
            'action',             'lineage_rejected'
        ),
        v_row.id,
        v_rejected_at
    );

    RETURN jsonb_build_object(
        'lineage_id',  p_lineage_id,
        'rejected_at', v_rejected_at
    );

EXCEPTION
    WHEN OTHERS THEN
        RAISE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_reject_lineage_transition(uuid, text, text, text, text) TO service_role;