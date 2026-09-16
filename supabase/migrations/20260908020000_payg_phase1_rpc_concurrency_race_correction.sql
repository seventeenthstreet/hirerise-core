-- 20260908020000_payg_phase1_rpc_concurrency_race_correction.sql
--
-- PAYG Phase 1 — RPC Concurrency Race Minimal Correction
--
-- Scope: THIS MIGRATION CHANGES ONLY THE BODY OF ONE FUNCTION,
-- public.record_payg_payment_event(...), and only the payment-creation
-- INSERT inside it. It does not touch payg_packages, payg_payment_events,
-- any column, any constraint, any index, any RLS policy, the function's
-- signature/return type, SECURITY DEFINER, search_path, or EXECUTE
-- privileges (already correctly restricted to service_role by
-- 20260908010000_payg_phase1_rpc_execute_privilege_correction.sql, and
-- re-applied here unchanged for completeness/idempotency only).
--
-- ═════════════════════════════════════════════════════════════════════
-- ROOT CAUSE
-- ═════════════════════════════════════════════════════════════════════
--
-- A genuine remote 20-concurrent-caller test through the Supabase
-- Transaction Pooler, against a brand-new (provider, provider_payment_id)
-- with 20 distinct valid provider_event_id values, produced:
--   18 successes, 2 failures with
--   "duplicate key value violates unique constraint
--    payg_payments_idempotency_key_uidx", 1 payment row, 18 event rows
--   (the 2 losers' otherwise-legitimate event rows were rolled back with
--   them), 1 distinct returned payment ID, credits unchanged.
--
-- public.payg_payments carries TWO independent unique indexes:
--   payg_payments_provider_payment_uidx  UNIQUE (provider, provider_payment_id)
--   payg_payments_idempotency_key_uidx   UNIQUE (idempotency_key)
-- idempotency_key is computed deterministically as
-- provider || ':' || provider_payment_id, so for any given
-- (provider, provider_payment_id) the two indexes are logically
-- equivalent dedup keys for the SAME conflict — but PostgreSQL enforces
-- each unique index independently; it has no notion that they are
-- semantically the same key.
--
-- The prior payment INSERT used:
--   ON CONFLICT (provider, provider_payment_id) DO NOTHING
-- ON CONFLICT only suppresses a violation on its named arbiter index. A
-- concurrent violation on any OTHER unique index on the same table is
-- NOT suppressed — it still raises an ordinary, unhandled 23505
-- unique_violation. This is deterministic PostgreSQL behavior, not a
-- probabilistic race artifact: it reproduces with zero concurrency
-- whenever one row conflicts on the arbiter and a different row
-- conflicts only on the non-arbiter index, e.g.:
--   CREATE TABLE t (a int UNIQUE, b int UNIQUE);
--   INSERT INTO t VALUES (1,1);
--   INSERT INTO t VALUES (2,1) ON CONFLICT (a) DO NOTHING;
--   -- ERROR: duplicate key value violates unique constraint "t_b_key"
-- Verified live against local PostgreSQL 16 before this fix was written.
--
-- Under genuine concurrent creation of a brand-new payment, several
-- callers can each observe "no existing row" and race to INSERT.
-- Whichever caller's row PostgreSQL's speculative-insertion protocol
-- resolves as a conflict on the (provider, provider_payment_id) arbiter
-- is handled cleanly via DO NOTHING. But depending on physical
-- backend/connection timing (materially different across genuinely
-- separate pooled connections than same-process sequential calls), a
-- losing caller's conflict can instead be detected first against
-- payg_payments_idempotency_key_uidx, which has no ON CONFLICT handler
-- and therefore raises an unhandled error — exactly the 2-of-20 failures
-- observed in the remote test. Because ON CONFLICT can only ever name
-- ONE arbiter, no ON CONFLICT clause can guard both indexes at once.
--
-- ═════════════════════════════════════════════════════════════════════
-- FIX
-- ═════════════════════════════════════════════════════════════════════
--
-- Wrap the payment INSERT in its own PL/pgSQL sub-block (an implicit
-- savepoint) and catch `unique_violation` generically, in addition to
-- keeping the existing `ON CONFLICT (provider, provider_payment_id) DO
-- NOTHING`. ON CONFLICT still resolves the common case with no
-- exception/rollback overhead; the EXCEPTION handler is the safety net
-- for a race that lands on the OTHER, non-arbiter unique index. Either
-- path is treated identically: discard this attempt and loop back to
-- re-SELECT the winner's row under FOR UPDATE. This is the standard
-- PostgreSQL-documented pattern for resolving a concurrent-insert race
-- against more than one unique constraint (see the PL/pgSQL exception
-- block pattern in the PostgreSQL manual, "Trapping Errors").
--
-- Only `WHEN unique_violation` is caught here — NOT `WHEN OTHERS`. A
-- genuine foreign_key_violation (bad user_id/package_id) or any other
-- error during this INSERT must continue to propagate unchanged to the
-- function's existing outer EXCEPTION block, which already translates
-- foreign_key_violation into VALIDATION_ERROR. This fix does not alter
-- that behavior.
--
-- Neither unique constraint is weakened, dropped, or made deferrable.
-- Both continue to enforce their invariant unconditionally; this only
-- changes how a legitimate concurrent LOSER resolves the winner's row
-- instead of surfacing an unhandled error and losing its own event.
--
-- Everything else in the function — validation, delivery idempotency on
-- payg_payment_events, the out-of-order refunded/disputed first-event
-- handling, the transition-rule UPDATE, attribute-mismatch detection,
-- the conflicting event/payment-ID integrity check, and the outer
-- EXCEPTION block — is reproduced byte-for-byte from
-- 20260907010000_payg_phase1_payment_record_layer.sql. No credit
-- grant/deduction is introduced; this RPC still touches only
-- payg_payment_events and payg_payments.

BEGIN;

DROP FUNCTION IF EXISTS "public"."record_payg_payment_event"(
    text, text, text, uuid, text, numeric, text, text, timestamp with time zone, jsonb
);

CREATE FUNCTION "public"."record_payg_payment_event"(
    "p_provider"            text,
    "p_provider_event_id"   text,
    "p_provider_payment_id" text,
    "p_user_id"             uuid,
    "p_package_id"          text,
    "p_amount"              numeric,
    "p_currency"            text,
    "p_status"              text,
    "p_occurred_at"         timestamp with time zone,
    "p_metadata"            jsonb DEFAULT NULL
) RETURNS TABLE(
    "out_payment_id"          uuid,
    "out_status"              text,
    "out_duplicate"           boolean,
    "out_attributes_mismatch" boolean
)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_event_id            uuid;
    v_payment_id          uuid;
    v_current_status      text;
    v_original_payment_id uuid;
    v_original_ppid       text;
    v_mismatch            boolean := false;
    v_effective_metadata  jsonb;
BEGIN
    IF p_provider IS NULL OR p_provider_event_id IS NULL THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: provider and provider_event_id are required'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_provider_payment_id IS NULL OR p_user_id IS NULL OR p_package_id IS NULL
       OR p_amount IS NULL OR p_currency IS NULL OR p_status IS NULL THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: provider_payment_id, user_id, package_id, amount, currency and status are required'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_status NOT IN ('pending', 'confirmed', 'failed', 'refunded', 'disputed') THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: unrecognised status %', p_status
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- ----------------------------------------------------------------
    -- STEP 1 — DB-enforced delivery idempotency. (unchanged)
    -- ----------------------------------------------------------------
    INSERT INTO public.payg_payment_events (provider, provider_event_id, metadata)
    VALUES (p_provider, p_provider_event_id, p_metadata)
    ON CONFLICT (provider, provider_event_id) DO NOTHING
    RETURNING id INTO v_event_id;

    IF v_event_id IS NULL THEN
        -- Already processed. Look up the payment this SAME event id was
        -- originally associated with — never re-derive it from the
        -- caller's (possibly different) p_provider_payment_id on this
        -- call. If the two disagree, this is not an ordinary duplicate.
        SELECT payment_id INTO v_original_payment_id
        FROM public.payg_payment_events
        WHERE provider = p_provider AND provider_event_id = p_provider_event_id;

        v_payment_id := NULL;
        v_current_status := NULL;

        IF v_original_payment_id IS NOT NULL THEN
            SELECT id, status, provider_payment_id
            INTO   v_payment_id, v_current_status, v_original_ppid
            FROM   public.payg_payments
            WHERE  id = v_original_payment_id;

            IF v_original_ppid IS NOT NULL AND v_original_ppid <> p_provider_payment_id THEN
                RAISE EXCEPTION 'INTEGRITY_VIOLATION: event %/% is already associated with payment % (provider_payment_id %), not %',
                                p_provider, p_provider_event_id, v_payment_id, v_original_ppid, p_provider_payment_id
                    USING ERRCODE = 'integrity_constraint_violation';
            END IF;
        END IF;

        RETURN QUERY SELECT v_payment_id, v_current_status, TRUE, FALSE;
        RETURN;
    END IF;

    -- ----------------------------------------------------------------
    -- STEP 2 — Resolve or create the Payment row, guarded by transition
    -- rules.
    --
    -- CONCURRENCY RACE CORRECTION (this migration): the payment INSERT
    -- below is wrapped in its own PL/pgSQL sub-block so that a
    -- unique_violation raised against EITHER of the table's two unique
    -- indexes — the ON CONFLICT arbiter (provider, provider_payment_id)
    -- *or* the non-arbiter payg_payments_idempotency_key_uidx — is
    -- caught and treated as "lost the creation race", not as a hard
    -- failure. ON CONFLICT DO NOTHING still resolves the common case
    -- (a conflict on the arbiter) without ever raising an exception;
    -- the EXCEPTION handler is the safety net for the race landing on
    -- the other unique index instead, which is exactly what a genuine
    -- remote 20-concurrent-caller test through the Supabase Transaction
    -- Pooler proved happens under real network-level concurrency (see
    -- header comment for full root-cause analysis and a minimal,
    -- deterministic, non-concurrent proof of the underlying PostgreSQL
    -- ON-CONFLICT-only-guards-its-arbiter mechanic). Neither unique
    -- constraint is weakened or removed by this change.
    -- ----------------------------------------------------------------
    LOOP
        SELECT id, status INTO v_payment_id, v_current_status
        FROM   public.payg_payments
        WHERE  provider = p_provider AND provider_payment_id = p_provider_payment_id
        FOR UPDATE;

        IF FOUND THEN
            EXIT;
        END IF;

        -- Out-of-order terminal first event (unchanged): a `refunded`
        -- or `disputed` event can legitimately be the first event ever
        -- seen for a payment (providers do not guarantee delivery
        -- order). Record the terminal state actually reported; never
        -- fabricate a `confirmed` step, never touch credits.
        v_effective_metadata := p_metadata;
        IF p_status IN ('refunded', 'disputed') THEN
            v_effective_metadata := COALESCE(p_metadata, '{}'::jsonb)
                || jsonb_build_object('out_of_order_first_event', true);
        END IF;

        v_payment_id := NULL;
        v_current_status := NULL;

        BEGIN
            INSERT INTO public.payg_payments (
                user_id, provider, provider_payment_id, package_id,
                amount, currency, status, idempotency_key, metadata,
                created_at, updated_at, confirmed_at
            ) VALUES (
                p_user_id, p_provider, p_provider_payment_id, p_package_id,
                p_amount, p_currency, p_status,
                p_provider || ':' || p_provider_payment_id,
                v_effective_metadata,
                COALESCE(p_occurred_at, now()), now(),
                CASE WHEN p_status = 'confirmed' THEN COALESCE(p_occurred_at, now()) ELSE NULL END
            )
            ON CONFLICT (provider, provider_payment_id) DO NOTHING
            RETURNING id, status INTO v_payment_id, v_current_status;
        EXCEPTION
            WHEN unique_violation THEN
                -- Lost the creation race on the OTHER (non-arbiter)
                -- unique index, e.g. payg_payments_idempotency_key_uidx.
                -- The sub-block's implicit savepoint already discarded
                -- this attempt; fall through and loop back to re-SELECT
                -- the winner's row under FOR UPDATE. This event's own
                -- payg_payment_events row (inserted in STEP 1, in the
                -- OUTER transaction, before this sub-block began) is
                -- untouched by this rollback and is never lost.
                v_payment_id := NULL;
                v_current_status := NULL;
        END;

        IF v_payment_id IS NOT NULL THEN
            EXIT; -- we created it
        END IF;
        -- else: lost the creation race to a concurrent call, via either
        -- unique index — loop back and re-SELECT the winner's row under
        -- FOR UPDATE.
    END LOOP;

    IF v_current_status IS NULL THEN
        -- Unreachable in practice (loop always exits with a row), kept
        -- as a defensive guard.
        RAISE EXCEPTION 'record_payg_payment_event: failed to resolve a payment row for %/%',
                        p_provider, p_provider_payment_id;
    END IF;

    -- Attribute-mismatch visibility (unchanged): identity/financial
    -- attributes are never written by the transition UPDATE below —
    -- only detect and surface a disagreement for manual review.
    SELECT (user_id <> p_user_id OR package_id <> p_package_id
            OR amount <> p_amount OR currency <> p_currency)
    INTO v_mismatch
    FROM public.payg_payments WHERE id = v_payment_id;

    IF v_current_status <> p_status THEN
        IF (v_current_status = 'pending'   AND p_status IN ('confirmed', 'failed'))
        OR (v_current_status = 'confirmed' AND p_status IN ('refunded', 'disputed')) THEN

            UPDATE public.payg_payments
            SET status       = p_status,
                updated_at   = now(),
                confirmed_at = CASE WHEN p_status = 'confirmed' THEN COALESCE(p_occurred_at, now())
                                     ELSE confirmed_at END
            WHERE id = v_payment_id
            RETURNING status INTO v_current_status;

        ELSE
            RAISE EXCEPTION 'INVALID_TRANSITION: cannot move payment % from % to %',
                            v_payment_id, v_current_status, p_status
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
    END IF;
    -- else: same-status repeat via a new event id — no-op.

    UPDATE public.payg_payment_events
    SET payment_id = v_payment_id
    WHERE id = v_event_id;

    RETURN QUERY SELECT v_payment_id, v_current_status, FALSE, v_mismatch;

EXCEPTION
    WHEN invalid_parameter_value THEN
        RAISE;
    -- foreign_key_violation (23503) is a member of the broader
    -- integrity_constraint_violation (23000) class used below for our
    -- own INTEGRITY_VIOLATION exception, and MUST be listed first —
    -- PL/pgSQL matches WHEN clauses in order.
    WHEN foreign_key_violation THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: user or package does not exist (%)', SQLERRM
            USING ERRCODE = 'invalid_parameter_value';
    WHEN integrity_constraint_violation THEN
        RAISE;
    WHEN OTHERS THEN
        RAISE EXCEPTION 'record_payg_payment_event failed for %/%: % (%)',
                        p_provider, p_provider_payment_id, SQLERRM, SQLSTATE;
END;
$$;

ALTER FUNCTION "public"."record_payg_payment_event"(
    text, text, text, uuid, text, numeric, text, text, timestamp with time zone, jsonb
) OWNER TO "postgres";

-- EXECUTE privileges reproduced unchanged from
-- 20260908010000_payg_phase1_rpc_execute_privilege_correction.sql
-- (idempotent re-application only — this migration does not alter
-- privilege scope).
REVOKE ALL ON FUNCTION "public"."record_payg_payment_event"(
    text, text, text, uuid, text, numeric, text, text, timestamp with time zone, jsonb
) FROM PUBLIC;

REVOKE ALL ON FUNCTION "public"."record_payg_payment_event"(
    text, text, text, uuid, text, numeric, text, text, timestamp with time zone, jsonb
) FROM "anon";

REVOKE ALL ON FUNCTION "public"."record_payg_payment_event"(
    text, text, text, uuid, text, numeric, text, text, timestamp with time zone, jsonb
) FROM "authenticated";

GRANT EXECUTE ON FUNCTION "public"."record_payg_payment_event"(
    text, text, text, uuid, text, numeric, text, text, timestamp with time zone, jsonb
) TO "service_role";

COMMIT;
