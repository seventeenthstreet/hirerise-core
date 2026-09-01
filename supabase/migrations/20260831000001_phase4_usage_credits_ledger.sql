-- 20260831000001_phase4_usage_credits_ledger.sql
--
-- PHASE 4 — Usage / Credits — Credit Ledger + Admin Credits
--
-- Implements exactly the locked Phase 3 Usage/Credits contract:
--   1. credit_ledger (append-only, RLS-locked, service_role-only writes)
--   2. consume_ai_credits — extended (CREATE OR REPLACE, same required
--      signature) to also write a CONSUME ledger row atomically, and to
--      reject invalid (<= 0) amounts, which it previously did not.
--   3. refund_ai_credits — extended identically for REFUND ledger rows.
--   4. admin_grant_credits / admin_adjust_credits — new MASTER_ADMIN-only
--      RPCs. Balance mutation + ledger insert + admin_logs insert happen
--      in the same function invocation (same DB transaction), matching
--      the existing activate_subscription_tx() idempotent-transaction
--      precedent in 000_initial_schema.sql.
--
-- Explicitly NOT touched: deduct_credits, refund_credits (legacy pair —
-- deferred cleanup, not deleted), ai_usage, credit_operation_costs,
-- subscription_credit_plans, Graph, Intelligence, Adaptive Weights.
--
-- Audit-atomicity note: utils/adminAuditLogger.js#logAdminAction() is a
-- deliberately fire-and-forget, never-throws helper used elsewhere in
-- this codebase for best-effort audit trails. That is incompatible with
-- this contract's explicit requirement that "balance mutation + ledger
-- insertion + admin audit cannot partially succeed" (Phase 3 Contract
-- §17) and that "audit exists, balance unchanged" is a forbidden final
-- state. To satisfy that requirement without weakening
-- logAdminAction()'s existing fire-and-forget contract for its other
-- callers, the admin_logs row for GRANT/ADJUST is written directly
-- inside this migration's SECURITY DEFINER RPCs, in the same statement
-- sequence as the balance and ledger writes, using the identical
-- admin_logs schema/shape logAdminAction() itself writes
-- (entity_type = 'credit'). The Node-side service layer does not call
-- logAdminAction() a second time for these two operations, to avoid a
-- duplicate audit row.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. CREDIT LEDGER TABLE
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "public"."credit_ledger" (
    "id"              uuid        NOT NULL DEFAULT gen_random_uuid(),
    "user_id"         uuid        NOT NULL,
    "transaction_type" text       NOT NULL,
    "amount"          integer     NOT NULL,
    "balance_after"   integer     NOT NULL,
    "source"          text,
    "actor_user_id"   uuid,
    "reference_id"    text,
    "reason"          text,
    "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
    "metadata"        jsonb,
    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credit_ledger_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
        ON DELETE CASCADE,
    CONSTRAINT "credit_ledger_actor_user_id_fkey"
        FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id")
        ON DELETE SET NULL,
    -- CONSUME / REFUND / GRANT / ADJUST only. 'DEDUCT' is intentionally
    -- NOT included — deduct_credits is deferred/legacy and must not be
    -- represented as an active ledger transaction type (Phase 3 Contract
    -- §6 "Transaction type").
    CONSTRAINT "credit_ledger_transaction_type_check"
        CHECK ("transaction_type" = ANY (ARRAY[
            'CONSUME'::text,
            'GRANT'::text,
            'ADJUST'::text,
            'REFUND'::text
        ]))
);

ALTER TABLE "public"."credit_ledger" OWNER TO "postgres";

COMMENT ON TABLE "public"."credit_ledger" IS
    'Append-only historical/audit record of ai_credits_remaining mutations. '
    'users.ai_credits_remaining remains the sole authoritative balance; this '
    'table is never aggregated to derive it. INSERT-only — no application '
    'role may UPDATE or DELETE rows. All writes happen inside SECURITY '
    'DEFINER RPCs (consume_ai_credits, refund_ai_credits, '
    'admin_grant_credits, admin_adjust_credits).';

-- Ledger listing for a given user, most recent first (Admin /admin/credits
-- ledger view — Phase 3 Contract §23).
CREATE INDEX IF NOT EXISTS "credit_ledger_user_id_created_at_idx"
    ON "public"."credit_ledger" ("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "credit_ledger_transaction_type_idx"
    ON "public"."credit_ledger" ("transaction_type");

-- Admin-mutation idempotency (Phase 3 Contract §13 / §14): a repeated
-- request for the same (user_id, transaction_type, reference_id) must not
-- create another GRANT/ADJUST row. Enforced at the DB level (preferred per
-- contract) via a partial unique index — CONSUME/REFUND rows (and any
-- admin row with a NULL reference_id, which the RPCs below never produce)
-- are excluded, since system consumption/refund legitimately has no
-- reference_id in many call sites (Phase 3 Contract §9) and must not be
-- constrained by this index.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_admin_idempotency_uidx"
    ON "public"."credit_ledger" ("user_id", "transaction_type", "reference_id")
    WHERE "transaction_type" IN ('GRANT', 'ADJUST') AND "reference_id" IS NOT NULL;

-- Append-only / immutability (Phase 3 Contract §7, §27): RLS enabled with
-- NO policies defined — identical convention to admin_logs (see
-- 000_initial_schema.sql: ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY
-- with no CREATE POLICY). This denies ALL direct access (SELECT/INSERT/
-- UPDATE/DELETE) to the "anon" and "authenticated" roles; only
-- "service_role" (which bypasses RLS in Supabase, and is the only role
-- this backend's Supabase client authenticates as — see
-- src/config/supabase.js) can read/write, and even service_role is only
-- ever granted INSERT/SELECT below — never UPDATE or DELETE.
ALTER TABLE "public"."credit_ledger" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."credit_ledger" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."credit_ledger" FROM "anon";
REVOKE ALL ON TABLE "public"."credit_ledger" FROM "authenticated";

-- service_role gets SELECT + INSERT only. No UPDATE, no DELETE, for any
-- role, ever — this is the enforcement mechanism for append-only.
GRANT SELECT, INSERT ON TABLE "public"."credit_ledger" TO "service_role";

-- ═════════════════════════════════════════════════════════════════════════
-- 2. CONSUME_AI_CREDITS — add CONSUME ledger entry + invalid-amount guard
-- ═════════════════════════════════════════════════════════════════════════
--
-- CORRECTION (Phase 4B live validation): PostgreSQL's `CREATE OR REPLACE
-- FUNCTION` identifies a function by its full parameter TYPE LIST,
-- including parameters that carry a DEFAULT. Adding two new trailing
-- parameters — even DEFAULT NULL ones — changes that identity, so
-- `CREATE OR REPLACE FUNCTION consume_ai_credits(uuid, integer, text,
-- text)` does NOT replace `consume_ai_credits(uuid, integer)`; it creates
-- a SECOND overload alongside it. Verified empirically against a real
-- PostgreSQL 16 instance: after applying this migration as originally
-- written (without the DROP below), every existing 2-named-argument
-- caller (creditGuard.middleware.js, coverLetter.service.js,
-- jobMatchPremium.service.js, onboarding.helpers.js — all of which call
-- `.rpc('consume_ai_credits', { p_user_id, p_amount })`) throws
-- `ERROR: function public.consume_ai_credits(p_user_id => unknown,
-- p_amount => integer) is not unique` on every single consumption
-- attempt, because Postgres cannot choose between the two equally-valid
-- candidate overloads. This is an application-breaking regression, not
-- merely a ledger-bypass risk.
--
-- The old 2-argument overload is therefore explicitly DROPped first, so
-- only the new 4-parameter (2-default) version remains — at which point
-- the exact same 2-named-argument call resolves unambiguously (Postgres
-- fills in the two new parameters from their defaults). Re-verified
-- empirically: the same caller pattern that failed above now succeeds
-- and correctly writes a CONSUME ledger row. `IF EXISTS` makes this
-- statement safe to re-run against an already-migrated database.
DROP FUNCTION IF EXISTS "public"."consume_ai_credits"("p_user_id" "uuid", "p_amount" integer);

CREATE OR REPLACE FUNCTION "public"."consume_ai_credits"(
    "p_user_id" "uuid",
    "p_amount" integer,
    "p_source" text DEFAULT NULL,
    "p_reference_id" text DEFAULT NULL
) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_current   integer;
    v_remaining integer;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT: amount must be a positive integer, got %', p_amount
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT ai_credits_remaining
    INTO   v_current
    FROM   public.users
    WHERE  id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User % not found', p_user_id
            USING ERRCODE = 'no_data_found';
    END IF;

    IF v_current < p_amount THEN
        RAISE EXCEPTION 'INSUFFICIENT_CREDITS: required=%, available=%',
                        p_amount, v_current
            USING ERRCODE = 'insufficient_resources';
    END IF;

    UPDATE public.users
    SET
        ai_credits_remaining = ai_credits_remaining - p_amount,
        updated_at           = now()
    WHERE id = p_user_id
    RETURNING ai_credits_remaining INTO v_remaining;

    INSERT INTO public.credit_ledger (
        user_id, transaction_type, amount, balance_after,
        source, actor_user_id, reference_id, reason, metadata
    ) VALUES (
        p_user_id, 'CONSUME', -p_amount, v_remaining,
        p_source, NULL, p_reference_id, NULL, NULL
    );

    RETURN v_remaining;

EXCEPTION
    WHEN invalid_parameter_value OR insufficient_resources OR no_data_found THEN
        RAISE;
    WHEN OTHERS THEN
        RAISE EXCEPTION 'consume_ai_credits failed for user %: % (%)',
                        p_user_id, SQLERRM, SQLSTATE;
END;
$$;

ALTER FUNCTION "public"."consume_ai_credits"("p_user_id" "uuid", "p_amount" integer, "p_source" text, "p_reference_id" text) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."consume_ai_credits"("p_user_id" "uuid", "p_amount" integer, "p_source" text, "p_reference_id" text) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_ai_credits"("p_user_id" "uuid", "p_amount" integer, "p_source" text, "p_reference_id" text) TO "service_role";

-- ═════════════════════════════════════════════════════════════════════════
-- 3. REFUND_AI_CREDITS — add REFUND ledger entry
-- ═════════════════════════════════════════════════════════════════════════
--
-- Same overload correction as consume_ai_credits above (see the comment
-- there for the full explanation and empirical verification) — the old
-- 2-argument overload must be explicitly dropped, not left for
-- CREATE OR REPLACE to implicitly replace.
DROP FUNCTION IF EXISTS "public"."refund_ai_credits"("p_user_id" "uuid", "p_amount" integer);

CREATE OR REPLACE FUNCTION "public"."refund_ai_credits"(
    "p_user_id" "uuid",
    "p_amount" integer,
    "p_source" text DEFAULT NULL,
    "p_reference_id" text DEFAULT NULL
) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_remaining integer;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT: amount must be a positive integer, got %', p_amount
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- -------------------------------------------------------------------------
    -- Lock the row to serialise concurrent refunds / deductions on same user.
    -- -------------------------------------------------------------------------
    PERFORM id
    FROM    public.users
    WHERE   id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User % not found', p_user_id
            USING ERRCODE = 'no_data_found';
    END IF;

    -- -------------------------------------------------------------------------
    -- Atomic increment + timestamp update.
    -- No balance cap is enforced here — if a cap is needed add it explicitly.
    -- -------------------------------------------------------------------------
    UPDATE public.users
    SET
        ai_credits_remaining = ai_credits_remaining + p_amount,
        updated_at           = now()
    WHERE id = p_user_id
    RETURNING ai_credits_remaining INTO v_remaining;

    INSERT INTO public.credit_ledger (
        user_id, transaction_type, amount, balance_after,
        source, actor_user_id, reference_id, reason, metadata
    ) VALUES (
        p_user_id, 'REFUND', p_amount, v_remaining,
        p_source, NULL, p_reference_id, NULL, NULL
    );

    RETURN v_remaining;

EXCEPTION
    WHEN invalid_parameter_value OR no_data_found THEN
        RAISE;
    WHEN OTHERS THEN
        RAISE EXCEPTION 'refund_ai_credits failed for user %: % (%)',
                        p_user_id, SQLERRM, SQLSTATE;
END;
$$;

ALTER FUNCTION "public"."refund_ai_credits"("p_user_id" "uuid", "p_amount" integer, "p_source" text, "p_reference_id" text) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."refund_ai_credits"("p_user_id" "uuid", "p_amount" integer, "p_source" text, "p_reference_id" text) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refund_ai_credits"("p_user_id" "uuid", "p_amount" integer, "p_source" text, "p_reference_id" text) TO "service_role";

-- ═════════════════════════════════════════════════════════════════════════
-- 4. ADMIN_GRANT_CREDITS — MASTER_ADMIN-only, atomic, idempotent
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "public"."admin_grant_credits"(
    "p_target_user_id" uuid,
    "p_amount"          integer,
    "p_reason"          text,
    "p_reference_id"    text,
    "p_actor_admin_id"  uuid
) RETURNS TABLE("out_balance_after" integer, "out_ledger_id" uuid)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_new_balance integer;
    v_ledger_id   uuid;
    v_actor_role   text;
    v_actor_status text;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT: amount must be a positive integer, got %', p_amount
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'REASON_REQUIRED: reason is required for GRANT'
            USING ERRCODE = 'not_null_violation';
    END IF;

    IF p_reference_id IS NULL OR btrim(p_reference_id) = '' THEN
        RAISE EXCEPTION 'REFERENCE_REQUIRED: reference_id is required for GRANT'
            USING ERRCODE = 'not_null_violation';
    END IF;

    IF p_actor_admin_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUIRED: acting MASTER_ADMIN user id is required'
            USING ERRCODE = 'not_null_violation';
    END IF;

    -- Phase 4B live-validation correction: this is a SECURITY DEFINER
    -- function executable by service_role, so it must not trust the
    -- Node route's requireMasterAdmin check as its only defense —
    -- empirically confirmed exploitable prior to this check (an
    -- arbitrary p_actor_admin_id belonging to an ordinary 'user' role
    -- account was accepted and successfully granted itself credits).
    -- The authoritative source of "is this actor currently a MASTER_ADMIN"
    -- in this codebase is public.admin_principals (role + a revocable
    -- lifecycle status), not users.role — this is exactly what
    -- requireMasterAdmin.middleware.js itself verifies via
    -- adminPrincipal.repository.js#verify() (uid, role, status='active').
    -- Checking users.role instead would silently accept an actor whose
    -- admin_principals row has been suspended/revoked but whose users.role
    -- column has not been kept in sync.
    SELECT "role", "status"
    INTO   v_actor_role, v_actor_status
    FROM   public.admin_principals
    WHERE  "uid" = p_actor_admin_id::text;

    IF NOT FOUND OR v_actor_role IS DISTINCT FROM 'MASTER_ADMIN' OR v_actor_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'UNAUTHORIZED: actor % is not an active MASTER_ADMIN', p_actor_admin_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Idempotency guard (defense-in-depth ahead of the unique index —
    -- gives a clean DUPLICATE_REFERENCE error instead of a raw
    -- unique_violation on the rare race, both mapped to the same
    -- ERRCODE by the EXCEPTION block below).
    IF EXISTS (
        SELECT 1 FROM public.credit_ledger
        WHERE user_id = p_target_user_id
          AND transaction_type = 'GRANT'
          AND reference_id = p_reference_id
    ) THEN
        RAISE EXCEPTION 'DUPLICATE_REFERENCE: reference_id % already applied for user %', p_reference_id, p_target_user_id
            USING ERRCODE = 'unique_violation';
    END IF;

    PERFORM id
    FROM    public.users
    WHERE   id = p_target_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'USER_NOT_FOUND: No user exists with id: %', p_target_user_id
            USING ERRCODE = 'no_data_found';
    END IF;

    UPDATE public.users
    SET
        ai_credits_remaining = ai_credits_remaining + p_amount,
        updated_at           = now()
    WHERE id = p_target_user_id
    RETURNING ai_credits_remaining INTO v_new_balance;

    INSERT INTO public.credit_ledger (
        user_id, transaction_type, amount, balance_after,
        source, actor_user_id, reference_id, reason, metadata
    ) VALUES (
        p_target_user_id, 'GRANT', p_amount, v_new_balance,
        'admin', p_actor_admin_id, p_reference_id, p_reason, NULL
    )
    RETURNING id INTO v_ledger_id;

    -- Admin audit trail — written directly here (same transaction) rather
    -- than via the fire-and-forget utils/adminAuditLogger.js#logAdminAction()
    -- helper, to satisfy the contract's atomicity requirement. Same
    -- schema/shape that helper writes (see module header comment).
    INSERT INTO public.admin_logs (
        id, admin_id, action, entity_type, entity_id, metadata, created_at
    ) VALUES (
        gen_random_uuid()::text,
        p_actor_admin_id::text,
        'CREDIT_GRANT',
        'credit',
        p_target_user_id::text,
        jsonb_build_object(
            'amount', p_amount,
            'reason', p_reason,
            'reference_id', p_reference_id,
            'balance_after', v_new_balance,
            'ledger_id', v_ledger_id
        ),
        now()
    );

    RETURN QUERY SELECT v_new_balance, v_ledger_id;

EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION 'DUPLICATE_REFERENCE: reference_id % already applied for user %', p_reference_id, p_target_user_id
            USING ERRCODE = 'unique_violation';
    WHEN invalid_parameter_value OR not_null_violation OR no_data_found OR insufficient_privilege THEN
        RAISE;
    WHEN OTHERS THEN
        RAISE EXCEPTION 'admin_grant_credits failed for user %: % (%)',
                        p_target_user_id, SQLERRM, SQLSTATE;
END;
$$;

ALTER FUNCTION "public"."admin_grant_credits"(uuid, integer, text, text, uuid) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."admin_grant_credits"(uuid, integer, text, text, uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_grant_credits"(uuid, integer, text, text, uuid) TO "service_role";

-- ═════════════════════════════════════════════════════════════════════════
-- 5. ADMIN_ADJUST_CREDITS — MASTER_ADMIN-only, atomic, idempotent
-- ═════════════════════════════════════════════════════════════════════════
--
-- new_balance = old_balance + p_adjustment (Phase 3 Contract §15 — the
-- ledger records a transaction amount, adjustment is NOT interpreted as
-- the new absolute balance). p_adjustment may be positive or negative,
-- subject to the negative-balance protection below.

CREATE OR REPLACE FUNCTION "public"."admin_adjust_credits"(
    "p_target_user_id" uuid,
    "p_adjustment"      integer,
    "p_reason"          text,
    "p_reference_id"    text,
    "p_actor_admin_id"  uuid
) RETURNS TABLE("out_balance_after" integer, "out_ledger_id" uuid)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_current     integer;
    v_new_balance integer;
    v_ledger_id   uuid;
    v_actor_role   text;
    v_actor_status text;
BEGIN
    IF p_adjustment IS NULL OR p_adjustment = 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT: adjustment must be a non-zero integer, got %', p_adjustment
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'REASON_REQUIRED: reason is required for ADJUST'
            USING ERRCODE = 'not_null_violation';
    END IF;

    IF p_reference_id IS NULL OR btrim(p_reference_id) = '' THEN
        RAISE EXCEPTION 'REFERENCE_REQUIRED: reference_id is required for ADJUST'
            USING ERRCODE = 'not_null_violation';
    END IF;

    IF p_actor_admin_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUIRED: acting MASTER_ADMIN user id is required'
            USING ERRCODE = 'not_null_violation';
    END IF;

    -- Phase 4B live-validation correction — see the identical check in
    -- admin_grant_credits for the full rationale (SECURITY DEFINER +
    -- service_role-executable => must not trust the Node route alone;
    -- authoritative source is admin_principals.role/status, not
    -- users.role).
    SELECT "role", "status"
    INTO   v_actor_role, v_actor_status
    FROM   public.admin_principals
    WHERE  "uid" = p_actor_admin_id::text;

    IF NOT FOUND OR v_actor_role IS DISTINCT FROM 'MASTER_ADMIN' OR v_actor_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'UNAUTHORIZED: actor % is not an active MASTER_ADMIN', p_actor_admin_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.credit_ledger
        WHERE user_id = p_target_user_id
          AND transaction_type = 'ADJUST'
          AND reference_id = p_reference_id
    ) THEN
        RAISE EXCEPTION 'DUPLICATE_REFERENCE: reference_id % already applied for user %', p_reference_id, p_target_user_id
            USING ERRCODE = 'unique_violation';
    END IF;

    SELECT ai_credits_remaining
    INTO   v_current
    FROM   public.users
    WHERE  id = p_target_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'USER_NOT_FOUND: No user exists with id: %', p_target_user_id
            USING ERRCODE = 'no_data_found';
    END IF;

    -- Negative-balance protection — identical guarantee to
    -- consume_ai_credits's INSUFFICIENT_CREDITS check, applied here to a
    -- signed adjustment rather than a fixed cost.
    IF v_current + p_adjustment < 0 THEN
        RAISE EXCEPTION 'INSUFFICIENT_CREDITS: adjustment % would take balance below zero (current=%)',
                        p_adjustment, v_current
            USING ERRCODE = 'insufficient_resources';
    END IF;

    UPDATE public.users
    SET
        ai_credits_remaining = ai_credits_remaining + p_adjustment,
        updated_at           = now()
    WHERE id = p_target_user_id
    RETURNING ai_credits_remaining INTO v_new_balance;

    INSERT INTO public.credit_ledger (
        user_id, transaction_type, amount, balance_after,
        source, actor_user_id, reference_id, reason, metadata
    ) VALUES (
        p_target_user_id, 'ADJUST', p_adjustment, v_new_balance,
        'admin', p_actor_admin_id, p_reference_id, p_reason, NULL
    )
    RETURNING id INTO v_ledger_id;

    INSERT INTO public.admin_logs (
        id, admin_id, action, entity_type, entity_id, metadata, created_at
    ) VALUES (
        gen_random_uuid()::text,
        p_actor_admin_id::text,
        'CREDIT_ADJUST',
        'credit',
        p_target_user_id::text,
        jsonb_build_object(
            'adjustment', p_adjustment,
            'reason', p_reason,
            'reference_id', p_reference_id,
            'balance_after', v_new_balance,
            'ledger_id', v_ledger_id
        ),
        now()
    );

    RETURN QUERY SELECT v_new_balance, v_ledger_id;

EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION 'DUPLICATE_REFERENCE: reference_id % already applied for user %', p_reference_id, p_target_user_id
            USING ERRCODE = 'unique_violation';
    WHEN invalid_parameter_value OR not_null_violation OR no_data_found OR insufficient_resources OR insufficient_privilege THEN
        RAISE;
    WHEN OTHERS THEN
        RAISE EXCEPTION 'admin_adjust_credits failed for user %: % (%)',
                        p_target_user_id, SQLERRM, SQLSTATE;
END;
$$;

ALTER FUNCTION "public"."admin_adjust_credits"(uuid, integer, text, text, uuid) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."admin_adjust_credits"(uuid, integer, text, text, uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_adjust_credits"(uuid, integer, text, text, uuid) TO "service_role";

COMMIT;
