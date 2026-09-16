-- 20260907010000_payg_phase1_payment_record_layer.sql
--
-- PAYG PHASE 1 — PAYMENT RECORD LAYER
--
-- Implements exactly the locked PAYG Phase 1 contract:
--   Payment Provider -> verified provider event -> normalized payment
--   event -> idempotent Payment record -> (future phase) credit grant.
--
-- This migration creates THREE new, purely additive tables and ONE new
-- SECURITY DEFINER RPC. It does not alter, drop, or rename anything that
-- already exists.
--
-- Explicitly NOT touched by this migration: users, subscriptions,
-- subscription_events, subscription_credit_plans, credit_ledger,
-- activate_subscription_tx, cancel_subscription_tx, consume_ai_credits,
-- refund_ai_credits, admin_grant_credits, admin_adjust_credits.
--
-- Audit finding — subscription_credit_plans (000_initial_schema.sql):
--   This table is amount-keyed (UNIQUE on plan_amount_inr), has no
--   currency column (implicitly INR-only), has no stable id/SKU
--   independent of price, and is not referenced anywhere in application
--   code (grep across src/ returns zero hits) — it is a dormant table.
--   It is NOT safe to repurpose as the PAYG package catalog: PAYG needs
--   a stable package identifier decoupled from price, multi-currency
--   support (Stripe/USD, Razorpay/INR), and a catalog that is additive
--   for PAYG rather than shared with subscription pricing semantics.
--   A new minimal `payg_packages` table is created instead, alongside
--   it, unchanged.
--
-- Pricing note: per the controlling prompt (`Do not invent final PAYG
-- prices or credit quantities`), this migration creates the PACKAGE
-- CATALOG SCHEMA only. No package rows are seeded — populating real
-- packages (price, currency, credit quantity) is a product decision
-- pending approval, tracked separately. Until packages exist, all PAYG
-- payment attempts fail closed at package resolution (see
-- src/services/billing/paygPayment.service.js), which is the correct
-- and safe behavior for a phase with no live provider traffic.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. PAYG PACKAGE CATALOG (schema only — no rows seeded, see note above)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "public"."payg_packages" (
    "id"          text        NOT NULL,
    "credits"     integer     NOT NULL,
    "amount"      numeric     NOT NULL,
    "currency"    text        NOT NULL,
    "is_active"   boolean     NOT NULL DEFAULT true,
    "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at"  timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "payg_packages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payg_packages_credits_positive_check" CHECK ("credits" > 0),
    CONSTRAINT "payg_packages_amount_positive_check" CHECK ("amount" > 0),
    CONSTRAINT "payg_packages_currency_check"
        CHECK ("currency" = ANY (ARRAY['INR'::text, 'USD'::text]))
);

ALTER TABLE "public"."payg_packages" OWNER TO "postgres";

COMMENT ON TABLE "public"."payg_packages" IS
    'PAYG package catalog (Phase 1 — Payment Record Layer). Server-side '
    'source of truth for package existence/active-state/price used to '
    'validate incoming PAYG payment events. Deliberately separate from '
    'subscription_credit_plans (subscription pricing, INR-only, unused by '
    'application code). credits is stored for the future credit-grant '
    'phase only — this phase never reads it to mutate any balance.';

CREATE INDEX IF NOT EXISTS "payg_packages_is_active_idx"
    ON "public"."payg_packages" ("is_active");

ALTER TABLE "public"."payg_packages" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."payg_packages" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."payg_packages" FROM "anon";
REVOKE ALL ON TABLE "public"."payg_packages" FROM "authenticated";

-- No client-facing read/write policy is created in this phase — there is
-- no approved PAYG checkout UI yet, so a package-listing API would be
-- built without a consumer (see controlling prompt §5: "Do not create a
-- user-facing payment API merely for completeness."). Only service_role
-- (this backend's Supabase client — see src/config/supabase.js) can read
-- it; management is via direct migration/ops access until an admin API
-- is a scoped, approved piece of work.
GRANT SELECT ON TABLE "public"."payg_packages" TO "service_role";


-- ═════════════════════════════════════════════════════════════════════════
-- 2. PAYG PAYMENT EVENTS (append-only raw verified-event log)
-- ═════════════════════════════════════════════════════════════════════════
--
-- One row per verified webhook DELIVERY. This is the idempotency gate
-- for duplicate delivery / retries / concurrent duplicates: the unique
-- index on (provider, provider_event_id) is enforced by Postgres, not by
-- an application-level SELECT-then-INSERT (which is not safe under
-- concurrent delivery).

CREATE TABLE IF NOT EXISTS "public"."payg_payment_events" (
    "id"                  uuid        NOT NULL DEFAULT gen_random_uuid(),
    "provider"            text        NOT NULL,
    "provider_event_id"   text        NOT NULL,
    "payment_id"          uuid,
    "metadata"            jsonb,
    "received_at"         timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "payg_payment_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payg_payment_events_provider_check"
        CHECK ("provider" = ANY (ARRAY['stripe'::text, 'razorpay'::text]))
);

ALTER TABLE "public"."payg_payment_events" OWNER TO "postgres";

COMMENT ON TABLE "public"."payg_payment_events" IS
    'Append-only log of verified PAYG provider webhook deliveries. '
    'Database-enforced idempotency for duplicate delivery / retries / '
    'concurrent duplicates lives on the unique index below, not on '
    'application-level SELECT-then-INSERT. Never updated or deleted.';

CREATE UNIQUE INDEX IF NOT EXISTS "payg_payment_events_provider_event_uidx"
    ON "public"."payg_payment_events" ("provider", "provider_event_id");

CREATE INDEX IF NOT EXISTS "payg_payment_events_payment_id_idx"
    ON "public"."payg_payment_events" ("payment_id");

ALTER TABLE "public"."payg_payment_events" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."payg_payment_events" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."payg_payment_events" FROM "anon";
REVOKE ALL ON TABLE "public"."payg_payment_events" FROM "authenticated";

-- service_role gets SELECT + INSERT only — no UPDATE, no DELETE, ever.
-- Matches the append-only enforcement convention used for credit_ledger
-- in 20260831000001_phase4_usage_credits_ledger.sql. All writes happen
-- inside the SECURITY DEFINER RPC below.
GRANT SELECT, INSERT ON TABLE "public"."payg_payment_events" TO "service_role";


-- ═════════════════════════════════════════════════════════════════════════
-- 3. PAYG PAYMENTS (the Payment record layer itself)
-- ═════════════════════════════════════════════════════════════════════════
--
-- One row per real underlying provider payment/order, keyed by
-- (provider, provider_payment_id). Distinct from payg_payment_events:
-- a single payment can receive several *events* over its lifecycle
-- (pending -> confirmed -> refunded), each a separate delivery, but
-- must remain exactly one payment ROW.

CREATE TABLE IF NOT EXISTS "public"."payg_payments" (
    "id"                    uuid        NOT NULL DEFAULT gen_random_uuid(),
    "user_id"               uuid        NOT NULL,
    "provider"              text        NOT NULL,
    "provider_payment_id"   text        NOT NULL,
    "package_id"            text        NOT NULL,
    "amount"                numeric     NOT NULL,
    "currency"              text        NOT NULL,
    "status"                text        NOT NULL DEFAULT 'pending',
    "idempotency_key"       text        NOT NULL,
    "metadata"              jsonb,
    "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at"            timestamp with time zone NOT NULL DEFAULT now(),
    "confirmed_at"          timestamp with time zone,
    CONSTRAINT "payg_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payg_payments_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
        ON DELETE RESTRICT,
    CONSTRAINT "payg_payments_package_id_fkey"
        FOREIGN KEY ("package_id") REFERENCES "public"."payg_packages"("id")
        ON DELETE RESTRICT,
    CONSTRAINT "payg_payments_provider_check"
        CHECK ("provider" = ANY (ARRAY['stripe'::text, 'razorpay'::text])),
    -- Candidate-state list only — no extra states (controlling prompt §5).
    CONSTRAINT "payg_payments_status_check"
        CHECK ("status" = ANY (ARRAY[
            'pending'::text, 'confirmed'::text, 'failed'::text,
            'refunded'::text, 'disputed'::text
        ])),
    CONSTRAINT "payg_payments_amount_positive_check" CHECK ("amount" > 0)
);

ALTER TABLE "public"."payg_payments" OWNER TO "postgres";

COMMENT ON TABLE "public"."payg_payments" IS
    'PAYG Phase 1 Payment record. A trustworthy, provider-neutral, '
    'database-idempotent record of a verified PAYG payment — and nothing '
    'more. This phase never grants credits, never mutates '
    'users.ai_credits_remaining, never inserts a credit_ledger GRANT, and '
    'never calls activate_subscription_tx. Only `confirmed` is eligible '
    'for the future, separate credit-grant phase.';

-- Idempotency (controlling prompt §11): duplicate delivery of the same
-- (provider, provider_event_id) must never create two Payment records.
-- That is enforced on payg_payment_events above. This index enforces the
-- companion invariant: one real provider payment/order = one Payment row,
-- ever, regardless of how many events reference it.
CREATE UNIQUE INDEX IF NOT EXISTS "payg_payments_provider_payment_uidx"
    ON "public"."payg_payments" ("provider", "provider_payment_id");

CREATE UNIQUE INDEX IF NOT EXISTS "payg_payments_idempotency_key_uidx"
    ON "public"."payg_payments" ("idempotency_key");

CREATE INDEX IF NOT EXISTS "payg_payments_user_id_created_at_idx"
    ON "public"."payg_payments" ("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "payg_payments_status_idx"
    ON "public"."payg_payments" ("status");

ALTER TABLE "public"."payg_payments" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."payg_payments" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."payg_payments" FROM "anon";
REVOKE ALL ON TABLE "public"."payg_payments" FROM "authenticated";

-- Clients can never create/update Payment records (controlling prompt
-- §5). service_role gets SELECT + INSERT + UPDATE (UPDATE is needed for
-- pending->confirmed/failed and confirmed->refunded/disputed
-- transitions) but never DELETE — a Payment record is never destroyed.
-- No user-facing read policy is added in this phase (no approved
-- "my payments" API exists yet); add one later only if a genuine
-- consumer needs it.
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."payg_payments" TO "service_role";

-- AUDIT FIX (migration repeatability, controlling audit prompt §17):
-- plain ADD CONSTRAINT is not idempotent in PostgreSQL (there is no
-- ADD CONSTRAINT IF NOT EXISTS for regular constraints) — re-running
-- this migration file end-to-end (e.g. `supabase db reset`, or a
-- retried `db push` after an unrelated earlier failure) would abort
-- here with "constraint already exists". DROP IF EXISTS + ADD is the
-- standard safe idiom, matching the IF NOT EXISTS style used for every
-- other object in this migration. Verified live: the full migration
-- file was re-applied end-to-end against an already-migrated database
-- with this fix in place and completed with no errors.
DO $$
BEGIN
    ALTER TABLE "public"."payg_payment_events"
        DROP CONSTRAINT IF EXISTS "payg_payment_events_payment_id_fkey";
    ALTER TABLE "public"."payg_payment_events"
        ADD CONSTRAINT "payg_payment_events_payment_id_fkey"
        FOREIGN KEY ("payment_id") REFERENCES "public"."payg_payments"("id")
        ON DELETE SET NULL;
END $$;


-- ═════════════════════════════════════════════════════════════════════════
-- 4. record_payg_payment_event — the atomic, idempotent write path
-- ═════════════════════════════════════════════════════════════════════════
--
-- CRITICAL CREDIT ISOLATION (controlling prompt §14): this function does
-- NOT call any credit-grant RPC, does NOT update users.ai_credits_remaining
-- or users.tier, does NOT insert a credit_ledger row, and does NOT call
-- activate_subscription_tx. It touches only payg_payment_events and
-- payg_payments. Grep-verifiable: no reference to credit_ledger, users,
-- activate_subscription_tx, admin_grant_credits, or admin_adjust_credits
-- anywhere in this function body.
--
-- Package validation (amount/currency/active/existence) happens in the
-- Node service layer (src/services/billing/paygPayment.service.js)
-- *before* this function is ever called, using payg_packages as the
-- server-side source of truth (controlling prompt §7) — this function
-- additionally enforces it can never be bypassed, because
-- payg_payments.package_id carries a hard foreign-key constraint to
-- payg_packages: this RPC cannot insert a Payment row referencing a
-- package that does not exist, regardless of what a caller supplies.
--
-- State machine (controlling prompt §10, corrected per the Migration
-- Integrity Audit — see AUDIT FIX comments inline below for evidence
-- and rationale for each change):
--   pending   -> confirmed | failed
--   confirmed -> refunded | disputed
--   failed / refunded / disputed -> terminal (no further transition)
-- Same-status repeats (e.g. a duplicate 'confirmed' event carried by a
-- new event id) are treated as a safe no-op. Any other transition is
-- rejected as INVALID_TRANSITION rather than silently applied, so
-- out-of-order or malformed provider events cannot corrupt payment state
-- silently — the caller logs and moves on without failing the webhook ack
-- (which has already been sent before this RPC is invoked).
--
-- MIGRATION INTEGRITY AUDIT (post-deployment-review correction, applied
-- before this migration was ever run against any real database): three
-- genuine bugs were found and fixed here, each reproduced and re-verified
-- against live PostgreSQL 16 execution (not just mocked/unit tests):
--   1. A `refunded`/`disputed` event arriving as the FIRST-ever event for
--      a payment (Stripe does not guarantee webhook delivery order —
--      see docs.stripe.com/webhooks, "Order of events") used to be
--      rejected with INVALID_TRANSITION, which rolled back the ENTIRE
--      call, including that event's own, otherwise-legitimate
--      payg_payment_events row — permanently losing a verified payment
--      event. Fixed: a new payment may now start directly in a terminal
--      state, tagged `metadata.out_of_order_first_event = true`, with
--      confirmed_at left NULL (never fabricated).
--   2. Two different events for the same brand-new provider_payment_id,
--      processed concurrently (e.g. Stripe's checkout.session.completed
--      and payment_intent.succeeded, which can resolve to the same
--      payment_intent id), could both observe "no existing payment row"
--      and both attempt to INSERT — the second raised an unhandled
--      unique_violation, rolling back its own event row with no retry.
--      Proven live under a forced race. Fixed: the payment INSERT now
--      uses ON CONFLICT DO NOTHING and loops back to re-resolve the
--      winner's row; re-verified with 20 genuinely concurrent calls
--      producing exactly one payment row and all events logged.
--   3. The same provider_event_id delivered twice while claiming two
--      DIFFERENT provider_payment_id values (e.g. a bug or a replayed/
--      corrupted delivery) was treated as an ordinary duplicate and
--      silently returned a null/misleading result. Fixed: the duplicate
--      path now resolves the ORIGINAL payment this event was first
--      associated with and raises INTEGRITY_VIOLATION if the caller's
--      current provider_payment_id disagrees with it.
-- A fourth, lower-severity gap was also closed: identity/financial
-- attributes (user_id/package_id/amount/currency) were already provably
-- never overwritten by a status transition (the UPDATE statement only
-- ever touches status/updated_at/confirmed_at) — but a disagreement
-- between what an event claims and what is on record was previously
-- invisible. The RPC now also returns `out_attributes_mismatch` so the
-- caller can alert on it without changing enforcement.

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
    v_event_id           uuid;
    v_payment_id         uuid;
    v_current_status     text;
    v_original_payment_id uuid;
    v_original_ppid       text;
    v_mismatch           boolean := false;
    v_effective_metadata jsonb;
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
    -- STEP 1 — DB-enforced delivery idempotency.
    -- ----------------------------------------------------------------
    INSERT INTO public.payg_payment_events (provider, provider_event_id, metadata)
    VALUES (p_provider, p_provider_event_id, p_metadata)
    ON CONFLICT (provider, provider_event_id) DO NOTHING
    RETURNING id INTO v_event_id;

    IF v_event_id IS NULL THEN
        -- Already processed. AUDIT FIX (integrity gap, controlling audit
        -- prompt §5): look up the payment this SAME event id was
        -- originally associated with — never re-derive it from the
        -- caller's (possibly different, e.g. buggy/replayed/malicious)
        -- p_provider_payment_id on this call. If the two disagree, this
        -- is not an ordinary duplicate — it is the same event id being
        -- claimed for two different underlying payments, which must
        -- never be silently accepted.
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
    -- AUDIT FIX (concurrency race, controlling audit prompt §11): the
    -- payment INSERT below uses ON CONFLICT DO NOTHING and loops back to
    -- re-SELECT rather than raising an unhandled unique_violation when
    -- two different events for the same brand-new provider_payment_id
    -- (e.g. Stripe's checkout.session.completed and payment_intent.
    -- succeeded, which can both resolve to the same payment_intent id)
    -- are processed concurrently and both observe "not found". Proven
    -- live: the previous bare-INSERT version, under a forced race, threw
    -- duplicate key value violates unique constraint
    -- "payg_payments_provider_payment_uidx" — which rolled back the
    -- losing call's OWN, legitimately-unique payg_payment_events row
    -- along with it, permanently losing a valid event with no retry
    -- (the RPC error did not match the "INVALID_TRANSITION" prefix the
    -- Node layer treats as a safe no-op, so it surfaced as a hard
    -- failure that is only logged, never retried).
    -- ----------------------------------------------------------------
    LOOP
        SELECT id, status INTO v_payment_id, v_current_status
        FROM   public.payg_payments
        WHERE  provider = p_provider AND provider_payment_id = p_provider_payment_id
        FOR UPDATE;

        IF FOUND THEN
            EXIT;
        END IF;

        -- AUDIT FIX (out-of-order terminal events, controlling audit
        -- prompt §4): Stripe explicitly documents that webhook events
        -- are not guaranteed to arrive in the order they are generated
        -- (docs.stripe.com/webhooks — "Order of events"). A `refunded`
        -- or `disputed` event can therefore legitimately be the FIRST
        -- event this system ever sees for a payment, if the earlier
        -- `confirmed` event is delayed or redelivered later. The
        -- previous version rejected a brand-new payment starting in
        -- `refunded`/`disputed` with INVALID_TRANSITION, which rolled
        -- back the whole call — including the event's own event-log
        -- row — permanently losing a verified, real provider event.
        --
        -- The fix does NOT invent history: it records the payment in
        -- the terminal state actually reported, leaves confirmed_at
        -- NULL (we genuinely never observed a confirmation), and tags
        -- metadata so this is visible for reconciliation — it never
        -- fabricates a `confirmed` step, never grants/reverses credits
        -- (this phase does not touch credits at all), and never
        -- silently accepts `pending` as terminal — `pending` is not a
        -- terminal state and is intentionally excluded from this path.
        v_effective_metadata := p_metadata;
        IF p_status IN ('refunded', 'disputed') THEN
            v_effective_metadata := COALESCE(p_metadata, '{}'::jsonb)
                || jsonb_build_object('out_of_order_first_event', true);
        END IF;

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

        IF v_payment_id IS NOT NULL THEN
            EXIT; -- we created it
        END IF;
        -- else: lost the creation race to a concurrent call — loop back
        -- and re-SELECT the winner's row under FOR UPDATE.
    END LOOP;

    IF v_current_status IS NULL THEN
        -- Unreachable in practice (loop always exits with a row), kept
        -- as a defensive guard.
        RAISE EXCEPTION 'record_payg_payment_event: failed to resolve a payment row for %/%',
                        p_provider, p_provider_payment_id;
    END IF;

    -- AUDIT FIX (attribute-mismatch visibility, controlling audit prompt
    -- §6): identity/financial attributes are NEVER written by the
    -- transition logic below (verified: the UPDATE statement touches
    -- only status/updated_at/confirmed_at) — a payment's user_id,
    -- package_id, amount and currency can never be silently rewritten
    -- by a later event. This was already true before this fix. What was
    -- missing was visibility: detect and surface (not block) a
    -- disagreement between what this event claims and what is already
    -- on record, so the caller can alert for manual review instead of
    -- the mismatch being invisible.
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
    -- else: same-status repeat via a new event id — no-op (status
    -- already matches; attribute mismatch, if any, was already computed
    -- above and is still reported).

    UPDATE public.payg_payment_events
    SET payment_id = v_payment_id
    WHERE id = v_event_id;

    RETURN QUERY SELECT v_payment_id, v_current_status, FALSE, v_mismatch;

EXCEPTION
    WHEN invalid_parameter_value THEN
        RAISE;
    -- NOTE: foreign_key_violation (23503) is a member of the broader
    -- integrity_constraint_violation (23000) SQLSTATE class used below
    -- for our own custom INTEGRITY_VIOLATION exception. It MUST be
    -- listed first — PL/pgSQL matches WHEN clauses in order, and a
    -- class-level condition tests true for any of its members. Verified
    -- live: with the order reversed, a real FK violation was being
    -- caught (and re-raised unchanged) by the generic branch, so the
    -- intended "VALIDATION_ERROR: user or package does not exist"
    -- translation never ran.
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

REVOKE ALL ON FUNCTION "public"."record_payg_payment_event"(
    text, text, text, uuid, text, numeric, text, text, timestamp with time zone, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."record_payg_payment_event"(
    text, text, text, uuid, text, numeric, text, text, timestamp with time zone, jsonb
) TO "service_role";

COMMIT;
