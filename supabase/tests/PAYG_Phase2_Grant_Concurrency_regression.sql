-- =============================================================================
-- PAYG_Phase2_Grant_Concurrency — Setup, Sequential Smoke Test & Verification
-- =============================================================================
-- File: supabase/tests/PAYG_Phase2_Grant_Concurrency_regression.sql
-- Exercises: public.grant_payg_credits(uuid)
--   (supabase/migrations/20260908040000_payg_phase2_grant_credits.sql)
--
-- PURPOSE
--   This script does three things, and only three things:
--     PART 1 — creates fully isolated test state (a test user, a test
--               package, and ONE confirmed payg_payments row) via the
--               existing sanctioned write paths, never via raw INSERT
--               into payg_payments (see WHY note below).
--     PART 2 — runs a rollback-safe SEQUENTIAL smoke test (two successive
--               calls to grant_payg_credits for the same payment) to
--               confirm the idempotency contract in isolation, before
--               anyone attempts true concurrency.
--     PART 3 — documents exactly how to run the GENUINE 20-way concurrent
--               test against the payment id this script creates, via the
--               companion Node runner
--               (core/tests/manual/payg-grant-concurrency-harness.js),
--               and provides the verification queries to interpret its
--               result and the cleanup to run afterward.
--
--   This script does NOT itself prove the concurrency invariant — see
--   "HARNESS CREATED vs HARNESS EXECUTED vs INVARIANT VERIFIED" at the
--   bottom of this file.
--
-- WHY record_payg_payment_event, NOT A RAW INSERT INTO payg_payments
--   payg_payments.package_credits_snapshot is populated by a BEFORE
--   INSERT trigger (20260908030000) that only fires on the one sanctioned
--   INSERT path, record_payg_payment_event (verified single-hit by grep
--   in that migration's own header). A raw INSERT would either bypass
--   the trigger's real code path or require guessing its behavior —
--   this script instead drives the exact function grant_payg_credits'
--   real callers (paygWebhook.service.js) use, so the resulting row is
--   indistinguishable in shape from a real confirmed payment.
--
-- WHY AN ISOLATED TEST USER, NOT "any existing user"
--   supabase/tests/PAYG_RPC_Concurrency_Race_Correction_regression.sql
--   (Phase 1) picks any existing user because Phase 1 never mutates a
--   balance. This script calls a function that DOES mutate
--   users.ai_credits_remaining and inserts a credit_ledger row — running
--   that against a real user, even "reversibly", is a real financial
--   side effect on a real account. This script creates its own
--   '__payg_grant20_'-namespaced test user instead and deletes it (and
--   only rows that reference it) at the end. It never reads, writes, or
--   reports on any pre-existing row.
--
--   NOTE ON auth.users: this script inserts directly into public.users.
--   In the schema as inspected in this repository, public.users.id is
--   NOT declared with a foreign key to auth.users (it is a standalone
--   uuid primary key with its own default generator), so this is safe
--   as inspected. If your deployed environment enforces such a
--   constraint (schema drift from what's in supabase/migrations/ is
--   possible), this INSERT will fail loudly with a foreign-key error
--   rather than silently doing something unexpected — if that happens,
--   STOP and create the test user via
--   supabase.auth.admin.createUser() first, then re-run PART 1 pointing
--   at that user's id instead.
--
-- NAMESPACING: every row this script creates uses the
--   '__payg_grant20_' prefix (user email, package id, provider event/
--   payment ids). Cleanup at the bottom deletes exactly and only rows
--   matching that prefix. This script never touches any pre-existing
--   row anywhere.
-- =============================================================================


-- =============================================================================
-- PART 1 — Setup: isolated test user, test package, one confirmed payment
-- =============================================================================
-- Run this whole block once. It is NOT wrapped in BEGIN/ROLLBACK — the
-- resulting payment id must survive as a committed row for the Node
-- runner (a separate process/connection) to call grant_payg_credits
-- against it. Cleanup (bottom of this file) is what removes it.

DO $$
DECLARE
  v_user_id    uuid := gen_random_uuid();
  v_package_id text := '__payg_grant20_pkg';
  v_event_id   text := '__payg_grant20_evt_pending';
  v_confirm_id text := '__payg_grant20_evt_confirmed';
  v_ppid       text := '__payg_grant20_ppid';
  v_result     RECORD;
BEGIN
  -- Refuse to run twice without cleanup — namespaced rows from a prior,
  -- un-cleaned run would make this run's aggregate evidence ambiguous.
  IF EXISTS (SELECT 1 FROM public.payg_packages WHERE id = v_package_id) THEN
    RAISE EXCEPTION 'PAYG GRANT-CONCURRENCY SETUP ABORTED: % already exists — run the CLEANUP section at the bottom of this file before re-running PART 1', v_package_id;
  END IF;

  -- 1. Isolated test user. Distinctive, unmistakably-test email; starts
  --    at the schema default ai_credits_remaining = 0 so the post-grant
  --    balance is unambiguous (0 -> exactly one package's credit value).
  INSERT INTO public.users (id, email, tier)
  VALUES (v_user_id, '__payg_grant20_test_user@example.invalid', 'free');

  -- 2. Isolated test package. credits chosen to be easy to eyeball in
  --    verification output; not a real product price/package.
  INSERT INTO public.payg_packages (id, credits, amount, currency, is_active)
  VALUES (v_package_id, 500, 4.99, 'USD', true);

  -- 3. Create the payment row via the sanctioned RPC, 'pending' first
  --    (matches how a real webhook delivery sequence behaves — Stripe/
  --    Razorpay's first-seen event is very often not already
  --    'confirmed'), then transition it to 'confirmed' with a SEPARATE
  --    event id (mirrors two genuinely separate webhook deliveries,
  --    exactly as paygWebhook.service.js produces in production).
  SELECT * INTO v_result FROM public.record_payg_payment_event(
    'stripe', v_event_id, v_ppid, v_user_id, v_package_id,
    4.99, 'USD', 'pending', now(), NULL);

  IF v_result.out_status <> 'pending' THEN
    RAISE EXCEPTION 'PAYG GRANT-CONCURRENCY SETUP FAILED: expected pending status after first event, got %', v_result.out_status;
  END IF;

  SELECT * INTO v_result FROM public.record_payg_payment_event(
    'stripe', v_confirm_id, v_ppid, v_user_id, v_package_id,
    4.99, 'USD', 'confirmed', now(), NULL);

  IF v_result.out_status <> 'confirmed' THEN
    RAISE EXCEPTION 'PAYG GRANT-CONCURRENCY SETUP FAILED: expected confirmed status after second event, got %', v_result.out_status;
  END IF;

  RAISE NOTICE 'PAYG GRANT-CONCURRENCY SETUP COMPLETE';
  RAISE NOTICE '  test_user_id  = %', v_user_id;
  RAISE NOTICE '  test_payment_id = %', v_result.out_payment_id;
  RAISE NOTICE 'Record BOTH ids above — the Node runner (PART 3) needs test_payment_id as its --payment-id argument.';
END;
$$;

-- Re-select the ids in query form too, so a non-interactive/psql -c caller
-- (which may not surface RAISE NOTICE output) can still retrieve them.
SELECT
  u.id   AS test_user_id,
  p.id   AS test_payment_id,
  p.status,
  p.package_credits_snapshot,
  u.ai_credits_remaining AS user_balance_before_grant
FROM public.payg_payments p
JOIN public.users u ON u.id = p.user_id
WHERE p.provider_payment_id = '__payg_grant20_ppid';
-- expect 1 row: status = 'confirmed', package_credits_snapshot = 500,
-- user_balance_before_grant = 0


-- =============================================================================
-- PART 2 — Rollback-safe SEQUENTIAL smoke test (idempotency in isolation)
-- =============================================================================
-- Confirms the GRANTED -> ALREADY_GRANTED contract on a single connection
-- BEFORE attempting true concurrency, using the same pattern as the Phase 1
-- race regression script's Test A. This does not prove the concurrency
-- invariant (a sequential script cannot — see PART 3) but is a cheap,
-- committed-state-changing precondition check: if this fails, the 20-way
-- concurrent run in PART 3 cannot meaningfully pass either, so there is no
-- point running it.
--
-- NOTE: this part is NOT wrapped in ROLLBACK, because it deliberately
-- performs the one real grant this test package's balance narrative
-- depends on (PART 3's Node runner expects a payment that is ALREADY
-- eligible and may already be granted or not — both are valid starting
-- states for the true-concurrency run, since grant_payg_credits is
-- idempotent either way).

DO $$
DECLARE
  v_payment_id uuid;
  v_first      RECORD;
  v_second     RECORD;
BEGIN
  SELECT id INTO v_payment_id
  FROM public.payg_payments
  WHERE provider_payment_id = '__payg_grant20_ppid';

  IF v_payment_id IS NULL THEN
    RAISE EXCEPTION 'PAYG GRANT-CONCURRENCY SMOKE TEST ABORTED: no test payment found — run PART 1 first';
  END IF;

  SELECT * INTO v_first  FROM public.grant_payg_credits(v_payment_id);
  SELECT * INTO v_second FROM public.grant_payg_credits(v_payment_id);

  IF v_first.out_result <> 'GRANTED' THEN
    RAISE EXCEPTION 'SEQUENTIAL SMOKE TEST FAILED: first call expected GRANTED, got %', v_first.out_result;
  END IF;

  IF v_second.out_result <> 'ALREADY_GRANTED' THEN
    RAISE EXCEPTION 'SEQUENTIAL SMOKE TEST FAILED: second call expected ALREADY_GRANTED, got %', v_second.out_result;
  END IF;

  IF v_first.out_ledger_id <> v_second.out_ledger_id THEN
    RAISE EXCEPTION 'SEQUENTIAL SMOKE TEST FAILED: first and second call reported different ledger ids (% vs %) — duplicate grant', v_first.out_ledger_id, v_second.out_ledger_id;
  END IF;

  RAISE NOTICE 'SEQUENTIAL SMOKE TEST PASSED — GRANTED then ALREADY_GRANTED, same ledger id (%), amount %, balance_after %',
    v_first.out_ledger_id, v_first.out_amount, v_first.out_balance_after;
END;
$$;

-- Verify: exactly one GRANT ledger row for this payment, balance matches.
SELECT
  count(*) AS ledger_rows_for_payment,
  (array_agg(amount))[1]        AS grant_amount,
  (array_agg(balance_after))[1] AS balance_after_grant
FROM public.credit_ledger
WHERE reference_id = (
  SELECT id::text FROM public.payg_payments WHERE provider_payment_id = '__payg_grant20_ppid'
)
AND transaction_type = 'GRANT';
-- expect: ledger_rows_for_payment = 1, grant_amount = 500,
-- balance_after_grant = 500 (0 + 500, this test user's only mutation)


-- =============================================================================
-- PART 3 — Genuine 20-way concurrency: documented procedure
-- =============================================================================
-- True concurrency cannot be expressed inside a single sequential script
-- or DO block (per WP-ADMIN-COMP-AW-03E and the Phase 1 PAYG race
-- regression precedent: statements in one script run in program order on
-- one connection, not concurrently). Because the sequential smoke test in
-- PART 2 has ALREADY consumed this payment's one legitimate grant, the
-- 20-way run below exercises exactly the case that matters most in
-- production: 20 simultaneous webhook-retry/reconciliation callers
-- racing an ALREADY-granted (or, on a fresh setup with PART 2 skipped,
-- about-to-be-granted-exactly-once) payment. Both starting states are
-- valid and covered by the same invariant, because grant_payg_credits is
-- documented idempotent regardless of prior state.
--
-- RECOMMENDED METHOD — companion Node runner (true, OS-level concurrency
-- via 20 simultaneous HTTP requests to PostgREST, each its own Postgres
-- backend/session — not simulated, not sequential):
--
--   cd core
--   node tests/manual/payg-grant-concurrency-harness.js \
--     --payment-id <test_payment_id from PART 1's output>
--
--   Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
--   environment (dotenv-loaded, matching scripts/run-migrations.js's
--   convention). grant_payg_credits is service_role-only — no other
--   credential type can execute it. See that script's own header for
--   full usage, safety notes, and output format.
--
-- ALTERNATIVE METHOD — manual multi-session psql (no Node available):
--   Open 20 separate psql connections to the SAME database (e.g. 20
--   terminal tabs, or a shell loop backgrounding 20 `psql -c` processes)
--   and launch, as close to simultaneously as possible:
--
--     psql "$DATABASE_URL" -c \
--       "SELECT * FROM public.grant_payg_credits('<test_payment_id>');" &
--
--   ...repeated 20 times before waiting on all of them (`wait` in bash).
--   This gives real concurrent Postgres sessions, unlike a DO block.
--
-- Either method produces 20 independent (out_result, out_ledger_id,
-- out_balance_after) tuples — capture all 20, not just the first success.


-- =============================================================================
-- VERIFICATION QUERIES — run these AFTER the 20-way run (either method)
-- =============================================================================

-- V1 — Ledger invariant: exactly one GRANT row for this payment, ever.
SELECT count(*) AS total_grant_ledger_rows
FROM public.credit_ledger
WHERE reference_id = (
  SELECT id::text FROM public.payg_payments WHERE provider_payment_id = '__payg_grant20_ppid'
)
AND transaction_type = 'GRANT';
-- expect: exactly 1 (regardless of whether PART 2 or the 20-way run was
-- the one that actually granted it)

-- V2 — Balance invariant: exactly one grant's worth of credit applied.
SELECT ai_credits_remaining
FROM public.users
WHERE id = (SELECT user_id FROM public.payg_payments WHERE provider_payment_id = '__payg_grant20_ppid');
-- expect: 500 (this test user's only possible mutation source)

-- V3 — No unhandled error should have reached any of the 20 callers. The
-- Node runner's own output records this (a thrown/rejected call is a
-- FAIL, not merely an unexpected out_result value); this query has
-- nothing to check server-side beyond V1/V2, since grant_payg_credits'
-- own EXCEPTION block guarantees a clean ALREADY_GRANTED return instead
-- of a raw unique_violation reaching any caller (see migration
-- 20260908040000's WHEN unique_violation branch) — V1 already proves
-- that guarantee held if it shows exactly 1 row despite 20+ callers.


-- =============================================================================
-- CLEANUP — run this after verification is complete, every time
-- =============================================================================
BEGIN;

DELETE FROM public.credit_ledger
WHERE reference_id = (
  SELECT id::text FROM public.payg_payments WHERE provider_payment_id = '__payg_grant20_ppid'
);

DELETE FROM public.payg_payment_events
WHERE provider_event_id LIKE '__payg_grant20_evt_%';

DELETE FROM public.payg_payments
WHERE provider_payment_id = '__payg_grant20_ppid';

DELETE FROM public.payg_packages
WHERE id = '__payg_grant20_pkg';

DELETE FROM public.users
WHERE email = '__payg_grant20_test_user@example.invalid';

COMMIT;

-- Confirm no trace remains.
SELECT
  (SELECT count(*) FROM public.users WHERE email = '__payg_grant20_test_user@example.invalid') AS users_remaining,
  (SELECT count(*) FROM public.payg_packages WHERE id = '__payg_grant20_pkg') AS packages_remaining,
  (SELECT count(*) FROM public.payg_payments WHERE provider_payment_id = '__payg_grant20_ppid') AS payments_remaining,
  (SELECT count(*) FROM public.credit_ledger WHERE reference_id LIKE '__payg_grant20%') AS ledger_remaining;
-- expect all four columns = 0


-- =============================================================================
-- HARNESS CREATED vs HARNESS EXECUTED vs INVARIANT VERIFIED
-- =============================================================================
-- HARNESS CREATED:      this file plus tests/manual/payg-grant-concurrency-
--                        harness.js exist and are internally consistent
--                        with the deployed schema/RPC as inspected in this
--                        repository. TRUE as of this pass.
-- HARNESS EXECUTED:      PART 1/2/3 and cleanup have actually been run
--                        against a real, deployed Supabase project.
--                        NOT true as of this pass — this sandbox has no
--                        network path to any Supabase project.
-- INVARIANT VERIFIED:    the aggregate result of an actual 20-way run has
--                        been captured and matches V1/V2 above.
--                        NOT true as of this pass, and cannot become true
--                        until HARNESS EXECUTED is true first.
-- =============================================================================
