-- 20260908040000_payg_phase2_grant_credits.sql
--
-- PAYG PHASE 2 — public.grant_payg_credits(): confirmed payment -> credit
-- grant, plus a bounded reconciliation lookup helper.
--
-- Scope: TWO new SECURITY DEFINER functions. Does not touch
-- record_payg_payment_event, activate_subscription_tx, consume_ai_credits,
-- admin_grant_credits, admin_adjust_credits, or any table definition
-- (the snapshot column/trigger were added in the prior migration).
--
-- Reuses, rather than reinvents, the proven atomic-grant pattern from
-- admin_grant_credits (20260831000001): validate -> SELECT users ... FOR
-- UPDATE -> UPDATE balance -> INSERT ledger -> single transaction.
--
-- Idempotency: reuses the EXISTING credit_ledger_admin_idempotency_uidx
-- unique index (20260831000001) on
-- (user_id, transaction_type, reference_id) WHERE transaction_type IN
-- ('GRANT','ADJUST') AND reference_id IS NOT NULL. No new index is
-- created. This index does not key on `source`, so it enforces a
-- slightly stronger invariant than strictly required (no OTHER GRANT,
-- e.g. a future admin grant, may ever reuse a PAYG payment id as its own
-- reference_id for the same user either) — which is a safe, desirable
-- property, not a gap: payment ids are globally unique UUIDs, so this
-- can never collide with a legitimate unrelated reference_id in normal
-- operation.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. grant_payg_credits(p_payment_id uuid)
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "public"."grant_payg_credits"(
    "p_payment_id" uuid
) RETURNS TABLE(
    "out_result"        text,   -- GRANTED | ALREADY_GRANTED | NOT_ELIGIBLE | VALIDATION_FAILED
    "out_payment_id"    uuid,
    "out_user_id"       uuid,
    "out_amount"        integer,
    "out_balance_after" integer,
    "out_ledger_id"     uuid,
    "out_payment_status" text
)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_payment           RECORD;
    v_existing_ledger_id uuid;
    v_existing_balance   integer;
    v_new_balance        integer;
    v_ledger_id          uuid;
    v_reference_id       text;
BEGIN
    -- ------------------------------------------------------------------
    -- Step 0 — caller-supplied input is only ever the payment id. No
    -- trusted user_id / amount / status / package-credit value is ever
    -- accepted as an argument (controlling prompt §4).
    -- ------------------------------------------------------------------
    IF p_payment_id IS NULL THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: p_payment_id is required'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_reference_id := p_payment_id::text;

    -- ------------------------------------------------------------------
    -- Step 1 — resolve payment (authoritative row, not caller input).
    -- ------------------------------------------------------------------
    SELECT "id", "user_id", "status", "package_credits_snapshot"
    INTO   v_payment
    FROM   public.payg_payments
    WHERE  "id" = p_payment_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PAYMENT_NOT_FOUND: no payg_payments row for id %', p_payment_id
            USING ERRCODE = 'no_data_found';
    END IF;

    IF v_payment.status <> 'confirmed' THEN
        -- pending / failed / refunded / disputed: deterministic non-grant
        -- result, not an exception — this is an expected, routine outcome
        -- (e.g. reconciliation or a retried webhook calling this for a
        -- payment that never confirmed), not a failure condition.
        RETURN QUERY SELECT
            'NOT_ELIGIBLE'::text, v_payment.id, v_payment.user_id,
            NULL::integer, NULL::integer, NULL::uuid, v_payment.status;
        RETURN;
    END IF;

    -- ------------------------------------------------------------------
    -- Step 2 — resolve purchased credit entitlement from the immutable
    -- snapshot ONLY. Never falls back to live payg_packages.credits.
    -- ------------------------------------------------------------------
    IF v_payment.package_credits_snapshot IS NULL
       OR v_payment.package_credits_snapshot <= 0 THEN
        RAISE EXCEPTION
            'VALIDATION_FAILED: payment % has no valid package_credits_snapshot (got %)',
            p_payment_id, v_payment.package_credits_snapshot
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- ------------------------------------------------------------------
    -- Step 4 (checked before the row lock, cheap fast path) — idempotency
    -- pre-check. The DB unique index is the real backstop (below); this
    -- just avoids taking the user row lock and returns a clean
    -- ALREADY_GRANTED result on the common redundant-call path (retries,
    -- duplicate webhooks, reconciliation re-runs).
    -- ------------------------------------------------------------------
    SELECT "id", "balance_after"
    INTO   v_existing_ledger_id, v_existing_balance
    FROM   public.credit_ledger
    WHERE  "user_id" = v_payment.user_id
      AND  "transaction_type" = 'GRANT'
      AND  "reference_id" = v_reference_id;

    IF FOUND THEN
        RETURN QUERY SELECT
            'ALREADY_GRANTED'::text, v_payment.id, v_payment.user_id,
            v_payment.package_credits_snapshot, v_existing_balance,
            v_existing_ledger_id, v_payment.status;
        RETURN;
    END IF;

    -- ------------------------------------------------------------------
    -- Step 3 — lock user. Serializes concurrent grant attempts for the
    -- SAME user (including concurrent calls for this same payment), so
    -- the idempotency check above and the mutation below are consistent
    -- for a given user even under genuine concurrency.
    -- ------------------------------------------------------------------
    PERFORM "id"
    FROM    public.users
    WHERE   "id" = v_payment.user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'USER_NOT_FOUND: payment % references missing user %',
                        p_payment_id, v_payment.user_id
            USING ERRCODE = 'no_data_found';
    END IF;

    -- Re-check idempotency now that the user row is locked: a concurrent
    -- caller may have committed its own GRANT for this same reference_id
    -- between the fast-path check above and acquiring this lock. This is
    -- the real, race-proof check; the unique index below is the final
    -- backstop if even this were somehow bypassed (e.g. isolation-level
    -- edge cases), turning a would-be double grant into a clean
    -- ALREADY_GRANTED result instead of an unhandled unique_violation.
    SELECT "id", "balance_after"
    INTO   v_existing_ledger_id, v_existing_balance
    FROM   public.credit_ledger
    WHERE  "user_id" = v_payment.user_id
      AND  "transaction_type" = 'GRANT'
      AND  "reference_id" = v_reference_id;

    IF FOUND THEN
        RETURN QUERY SELECT
            'ALREADY_GRANTED'::text, v_payment.id, v_payment.user_id,
            v_payment.package_credits_snapshot, v_existing_balance,
            v_existing_ledger_id, v_payment.status;
        RETURN;
    END IF;

    -- ------------------------------------------------------------------
    -- Step 5 — atomic mutation: balance + ledger, same transaction.
    -- ------------------------------------------------------------------
    UPDATE public.users
    SET
        "ai_credits_remaining" = "ai_credits_remaining" + v_payment.package_credits_snapshot,
        "updated_at"           = now()
    WHERE "id" = v_payment.user_id
    RETURNING "ai_credits_remaining" INTO v_new_balance;

    INSERT INTO public.credit_ledger (
        "user_id", "transaction_type", "amount", "balance_after",
        "source", "actor_user_id", "reference_id", "reason", "metadata"
    ) VALUES (
        v_payment.user_id, 'GRANT', v_payment.package_credits_snapshot, v_new_balance,
        'payg', NULL, v_reference_id, 'PAYG confirmed payment credit grant',
        jsonb_build_object('payg_payment_id', p_payment_id)
    )
    RETURNING "id" INTO v_ledger_id;

    RETURN QUERY SELECT
        'GRANTED'::text, v_payment.id, v_payment.user_id,
        v_payment.package_credits_snapshot, v_new_balance,
        v_ledger_id, v_payment.status;

EXCEPTION
    WHEN invalid_parameter_value OR no_data_found THEN
        RAISE;
    WHEN unique_violation THEN
        -- Final backstop (controlling prompt §4/§10): two genuinely
        -- concurrent callers both passed the locked re-check above only
        -- if they were on different Postgres sessions racing the FOR
        -- UPDATE lock itself; the unique index guarantees only one
        -- INSERT ever survives. The loser reports a clean idempotent
        -- result instead of propagating a raw constraint error.
        SELECT "id", "balance_after"
        INTO   v_existing_ledger_id, v_existing_balance
        FROM   public.credit_ledger
        WHERE  "user_id" = v_payment.user_id
          AND  "transaction_type" = 'GRANT'
          AND  "reference_id" = v_reference_id;

        RETURN QUERY SELECT
            'ALREADY_GRANTED'::text, v_payment.id, v_payment.user_id,
            v_payment.package_credits_snapshot, v_existing_balance,
            v_existing_ledger_id, v_payment.status;
    WHEN OTHERS THEN
        RAISE EXCEPTION 'grant_payg_credits failed for payment %: % (%)',
                        p_payment_id, SQLERRM, SQLSTATE;
END;
$$;

ALTER FUNCTION "public"."grant_payg_credits"(uuid) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."grant_payg_credits"(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."grant_payg_credits"(uuid) FROM "anon";
REVOKE ALL ON FUNCTION "public"."grant_payg_credits"(uuid) FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."grant_payg_credits"(uuid) TO "service_role";

COMMENT ON FUNCTION "public"."grant_payg_credits"(uuid) IS
    'PAYG Phase 2: authoritative confirmed-payment -> credit-grant '
    'primitive. Caller supplies ONLY a payment id; entitlement, user, and '
    'eligibility are always re-derived from payg_payments/'
    'package_credits_snapshot, never trusted from the caller. Idempotent: '
    'safe to call any number of times for the same payment_id — reuses '
    'credit_ledger_admin_idempotency_uidx as the DB-enforced backstop. '
    'SECURITY DEFINER, service_role-only (see REVOKE/GRANT above), '
    'matching the record_payg_payment_event privilege pattern corrected '
    'in 20260908010000.';


-- ═════════════════════════════════════════════════════════════════════════
-- 2. find_unreconciled_payg_grants(p_limit integer) — reconciliation read
-- ═════════════════════════════════════════════════════════════════════════
--
-- Bounded, read-only helper for the reconciliation safety net (controlling
-- prompt §10): confirmed payg_payments with no matching PAYG GRANT ledger
-- row. SECURITY DEFINER only so it can read credit_ledger (service_role-
-- only table) via the same restricted-privilege convention as the other
-- PAYG functions; it performs no writes.

CREATE OR REPLACE FUNCTION "public"."find_unreconciled_payg_grants"(
    "p_limit" integer DEFAULT 500
) RETURNS TABLE(
    "out_payment_id" uuid,
    "out_user_id"    uuid,
    "out_confirmed_at" timestamp with time zone
)
    LANGUAGE "sql" SECURITY DEFINER STABLE
    SET "search_path" TO 'public'
    AS $$
    SELECT p."id", p."user_id", p."confirmed_at"
    FROM   public.payg_payments p
    WHERE  p."status" = 'confirmed'
      AND  NOT EXISTS (
            SELECT 1 FROM public.credit_ledger cl
            WHERE cl."transaction_type" = 'GRANT'
              AND cl."source" = 'payg'
              AND cl."reference_id" = p."id"::text
          )
    ORDER BY p."confirmed_at" ASC NULLS LAST, p."created_at" ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
$$;

ALTER FUNCTION "public"."find_unreconciled_payg_grants"(integer) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."find_unreconciled_payg_grants"(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."find_unreconciled_payg_grants"(integer) FROM "anon";
REVOKE ALL ON FUNCTION "public"."find_unreconciled_payg_grants"(integer) FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."find_unreconciled_payg_grants"(integer) TO "service_role";

COMMENT ON FUNCTION "public"."find_unreconciled_payg_grants"(integer) IS
    'PAYG Phase 2 reconciliation read path: confirmed payg_payments with '
    'no matching (source=payg, transaction_type=GRANT, reference_id = '
    'payment id) credit_ledger row. Bounded by p_limit (clamped 1..5000, '
    'default 500) so a large backlog cannot produce an unbounded scan/'
    'result set. Read-only — never mutates anything. Pair with '
    'grant_payg_credits(), which is independently idempotent, so calling '
    'it for a row this function returns is always safe even under '
    'repeated/overlapping reconciliation runs.';

COMMIT;
