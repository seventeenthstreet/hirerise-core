-- =============================================================================
-- PAYG_RPC_Concurrency_Race_Correction — Regression Test Script
-- =============================================================================
-- File: supabase/tests/PAYG_RPC_Concurrency_Race_Correction_regression.sql
-- Exercises the corrective migration:
--   supabase/migrations/20260908020000_payg_phase1_rpc_concurrency_race_correction.sql
--
-- Verifies, through the actual RPC public.record_payg_payment_event(...)
-- (not direct table INSERT):
--   PART 1 (rollback-safe, sequential, single-session):
--     Test A — sequential duplicate event delivery is a safe no-op.
--     Test B — state-transition rules (valid / invalid / same-status /
--               terminal) are unchanged.
--     Test C — a refunded/disputed event may legitimately be the FIRST
--               event ever seen for a payment (out-of-order delivery).
--     Test D — attribute mismatch between events is surfaced, never
--               silently overwrites the original record.
--     Test E — the same provider_event_id claiming two different
--               provider_payment_id values raises INTEGRITY_VIOLATION.
--     Test F — FK validation (nonexistent user_id / package_id).
--   PART 2 (documentation + structural precondition check):
--     Test G — genuine multi-session concurrent creation of a brand-new
--               payment: N distinct valid events for the SAME
--               (provider, provider_payment_id) must yield exactly one
--               payment row, N event rows, one distinct payment id, zero
--               credit mutation, and zero unhandled errors — including
--               when the race lands on payg_payments_idempotency_key_uidx
--               rather than the ON CONFLICT arbiter
--               (payg_payments_provider_payment_uidx). This is the exact
--               defect this migration corrects.
--
-- True concurrency (Test G) cannot be expressed inside a single
-- sequential script or DO block — statements in one script run in
-- program order on one connection, not concurrently. Follows the
-- WP-ADMIN-COMP-AW-03E precedent: documented here with the exact
-- multi-session procedure (real, separately-opened connections against
-- an isolated database), plus a structural precondition check this
-- script CAN verify without live concurrent sessions.
--
-- Namespacing: all test rows use '__payg_race_'-prefixed
-- provider_event_id / provider_payment_id values and are cleaned up or
-- rolled back; this script never touches any pre-existing row.
-- =============================================================================

-- =============================================================================
-- PART 1 — Rollback-safe sequential tests (A–F)
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_user   uuid;
  v_pkg    text;
  r        RECORD;
  r2       RECORD;
  v_caught boolean;
BEGIN
  -- Preconditions: pick any existing user and any active package so this
  -- script runs unmodified against a real, already-migrated database.
  SELECT id INTO v_user FROM public.users LIMIT 1;
  SELECT id INTO v_pkg  FROM public.payg_packages WHERE is_active = true LIMIT 1;

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'PAYG RACE REGRESSION — SKIPPED: no row in public.users to test against';
  END IF;
  IF v_pkg IS NULL THEN
    RAISE EXCEPTION 'PAYG RACE REGRESSION — SKIPPED: no active row in public.payg_packages to test against (this phase seeds no packages by design — seed one active test package before running this script)';
  END IF;

  -- -------------------------------------------------------------------
  -- Test A — sequential duplicate event delivery
  -- -------------------------------------------------------------------
  SELECT * INTO r FROM public.record_payg_payment_event(
    'stripe', '__payg_race_evt_dup_1', '__payg_race_ppid_dup_1', v_user, v_pkg,
    499, 'INR', 'pending', now(), NULL);
  IF r.out_duplicate IS NOT FALSE THEN
    RAISE EXCEPTION 'TEST A FAILED: first delivery should not be duplicate';
  END IF;

  SELECT * INTO r2 FROM public.record_payg_payment_event(
    'stripe', '__payg_race_evt_dup_1', '__payg_race_ppid_dup_1', v_user, v_pkg,
    499, 'INR', 'pending', now(), NULL);
  IF r2.out_duplicate IS NOT TRUE OR r2.out_payment_id <> r.out_payment_id THEN
    RAISE EXCEPTION 'TEST A FAILED: redelivery should be reported duplicate with same payment id, got %', r2;
  END IF;
  IF (SELECT count(*) FROM public.payg_payment_events WHERE provider_event_id = '__payg_race_evt_dup_1') <> 1 THEN
    RAISE EXCEPTION 'TEST A FAILED: duplicate delivery must not create a second event row';
  END IF;
  RAISE NOTICE 'TEST A PASSED — sequential duplicate event delivery';

  -- -------------------------------------------------------------------
  -- Test B — state-transition behavior
  -- -------------------------------------------------------------------
  SELECT * INTO r FROM public.record_payg_payment_event(
    'stripe', '__payg_race_evt_tr_1', '__payg_race_ppid_tr_1', v_user, v_pkg,
    499, 'INR', 'pending', now(), NULL);
  IF r.out_status <> 'pending' THEN
    RAISE EXCEPTION 'TEST B FAILED: expected pending, got %', r.out_status;
  END IF;

  SELECT * INTO r2 FROM public.record_payg_payment_event(
    'stripe', '__payg_race_evt_tr_1b', '__payg_race_ppid_tr_1', v_user, v_pkg,
    499, 'INR', 'pending', now(), NULL);
  IF r2.out_status <> 'pending' OR r2.out_payment_id <> r.out_payment_id THEN
    RAISE EXCEPTION 'TEST B FAILED: same-status repeat should no-op, got %', r2;
  END IF;

  SELECT * INTO r FROM public.record_payg_payment_event(
    'stripe', '__payg_race_evt_tr_2', '__payg_race_ppid_tr_1', v_user, v_pkg,
    499, 'INR', 'confirmed', now(), NULL);
  IF r.out_status <> 'confirmed' THEN
    RAISE EXCEPTION 'TEST B FAILED: expected confirmed, got %', r.out_status;
  END IF;

  v_caught := false;
  BEGIN
    PERFORM public.record_payg_payment_event(
      'stripe', '__payg_race_evt_tr_3', '__payg_race_ppid_tr_1', v_user, v_pkg,
      499, 'INR', 'pending', now(), NULL);
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM LIKE 'INVALID_TRANSITION%' THEN v_caught := true; END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST B FAILED: confirmed->pending must raise INVALID_TRANSITION';
  END IF;

  SELECT * INTO r FROM public.record_payg_payment_event(
    'stripe', '__payg_race_evt_tr_4', '__payg_race_ppid_tr_1', v_user, v_pkg,
    499, 'INR', 'refunded', now(), NULL);
  IF r.out_status <> 'refunded' THEN
    RAISE EXCEPTION 'TEST B FAILED: expected refunded, got %', r.out_status;
  END IF;

  v_caught := false;
  BEGIN
    PERFORM public.record_payg_payment_event(
      'stripe', '__payg_race_evt_tr_5', '__payg_race_ppid_tr_1', v_user, v_pkg,
      499, 'INR', 'confirmed', now(), NULL);
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM LIKE 'INVALID_TRANSITION%' THEN v_caught := true; END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST B FAILED: terminal refunded->confirmed must raise INVALID_TRANSITION';
  END IF;
  RAISE NOTICE 'TEST B PASSED — state-transition behavior (valid/invalid/same-status/terminal)';

  -- -------------------------------------------------------------------
  -- Test C — first event is a terminal (refunded/disputed) event
  -- -------------------------------------------------------------------
  SELECT * INTO r FROM public.record_payg_payment_event(
    'stripe', '__payg_race_evt_ooo_1', '__payg_race_ppid_ooo_1', v_user, v_pkg,
    499, 'INR', 'disputed', now(), NULL);
  IF r.out_status <> 'disputed' THEN
    RAISE EXCEPTION 'TEST C FAILED: brand-new payment starting disputed should be accepted, got %', r.out_status;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payg_payments
    WHERE id = r.out_payment_id AND confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'TEST C FAILED: confirmed_at must remain NULL when confirmed was never observed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.payg_payments
    WHERE id = r.out_payment_id
      AND (metadata->>'out_of_order_first_event')::boolean IS TRUE
  ) THEN
    RAISE EXCEPTION 'TEST C FAILED: metadata.out_of_order_first_event must be tagged true';
  END IF;
  RAISE NOTICE 'TEST C PASSED — out-of-order first refunded/disputed event handling';

  -- -------------------------------------------------------------------
  -- Test D — attribute mismatch reporting (never overwrites)
  -- -------------------------------------------------------------------
  SELECT * INTO r FROM public.record_payg_payment_event(
    'stripe', '__payg_race_evt_mm_1', '__payg_race_ppid_mm_1', v_user, v_pkg,
    499, 'INR', 'pending', now(), NULL);
  IF r.out_attributes_mismatch IS NOT FALSE THEN
    RAISE EXCEPTION 'TEST D FAILED: first event should not report mismatch';
  END IF;

  SELECT * INTO r2 FROM public.record_payg_payment_event(
    'stripe', '__payg_race_evt_mm_2', '__payg_race_ppid_mm_1', v_user, v_pkg,
    999, 'INR', 'confirmed', now(), NULL);
  IF r2.out_attributes_mismatch IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST D FAILED: mismatched amount must be reported as mismatch=true';
  END IF;
  IF (SELECT amount FROM public.payg_payments WHERE id = r2.out_payment_id) <> 499 THEN
    RAISE EXCEPTION 'TEST D FAILED: original amount must never be overwritten by a later event';
  END IF;
  RAISE NOTICE 'TEST D PASSED — attribute mismatch detected and surfaced without overwriting';

  -- -------------------------------------------------------------------
  -- Test E — conflicting event/payment ID integrity protection
  -- -------------------------------------------------------------------
  PERFORM public.record_payg_payment_event(
    'stripe', '__payg_race_evt_conflict_1', '__payg_race_ppid_conflict_A', v_user, v_pkg,
    499, 'INR', 'pending', now(), NULL);

  v_caught := false;
  BEGIN
    PERFORM public.record_payg_payment_event(
      'stripe', '__payg_race_evt_conflict_1', '__payg_race_ppid_conflict_B', v_user, v_pkg,
      499, 'INR', 'pending', now(), NULL);
  EXCEPTION WHEN integrity_constraint_violation THEN
    IF SQLERRM LIKE 'INTEGRITY_VIOLATION%' THEN v_caught := true; END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST E FAILED: same event id claiming a different payment id must raise INTEGRITY_VIOLATION';
  END IF;
  RAISE NOTICE 'TEST E PASSED — conflicting event/payment ID integrity protection';

  -- -------------------------------------------------------------------
  -- Test F — FK validation (nonexistent user / package)
  -- -------------------------------------------------------------------
  v_caught := false;
  BEGIN
    PERFORM public.record_payg_payment_event(
      'stripe', '__payg_race_evt_fk_1', '__payg_race_ppid_fk_1', '00000000-0000-0000-0000-000000000000', v_pkg,
      499, 'INR', 'pending', now(), NULL);
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM LIKE 'VALIDATION_ERROR%' THEN v_caught := true; END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST F FAILED: nonexistent user_id must raise VALIDATION_ERROR (FK)';
  END IF;

  v_caught := false;
  BEGIN
    PERFORM public.record_payg_payment_event(
      'stripe', '__payg_race_evt_fk_2', '__payg_race_ppid_fk_2', v_user, '__payg_race_pkg_nonexistent',
      499, 'INR', 'pending', now(), NULL);
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM LIKE 'VALIDATION_ERROR%' THEN v_caught := true; END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST F FAILED: nonexistent package_id must raise VALIDATION_ERROR (FK)';
  END IF;
  RAISE NOTICE 'TEST F PASSED — FK validation (user_id, package_id)';

  RAISE NOTICE 'PART 1 (Tests A-F) — ALL PASSED';
END;
$$;

ROLLBACK;

-- Confirm PART 1 left no trace.
SELECT count(*) AS payg_race_seqtest_rows_after_rollback
FROM public.payg_payments
WHERE provider_payment_id LIKE '__payg_race_%';
-- expect 0

-- =============================================================================
-- PART 2 — Test G: genuine multi-session concurrency (documentation +
-- structural precondition check)
-- =============================================================================
-- True concurrency cannot be expressed inside a single sequential script.
-- Test G requires >= 20 real, independently-opened sessions issuing
-- record_payg_payment_event() for the SAME brand-new
-- (provider, provider_payment_id) with DISTINCT provider_event_id values,
-- launched at effectively the same time. Verified procedure for this
-- corrective migration (pgbench, which opens every connection before
-- firing any of them — closer to genuine pooled-connection concurrency
-- than N sequentially-spawned psql processes):
--
--   cat > race.sql <<'SQL'
--   SELECT out_payment_id, out_status, out_duplicate, out_attributes_mismatch
--   FROM public.record_payg_payment_event(
--     'stripe', '__payg_race_g_evt_' || :client_id::text, '__payg_race_g_ppid',
--     '<existing user id>', '<existing active package id>',
--     499, 'INR', 'confirmed', now(), NULL
--   );
--   SQL
--   pgbench -d <db> -n -c 20 -j 20 -t 1 -f race.sql
--
-- Expected: number of failed transactions: 0 (0.000%). Then:
--   SELECT count(*), count(DISTINCT id) FROM payg_payments
--     WHERE provider_payment_id = '__payg_race_g_ppid';        -- expect 1, 1
--   SELECT count(*) FROM payg_payment_events
--     WHERE provider_event_id LIKE '__payg_race_g_evt_%';      -- expect 20
--   -- credits: confirm users.ai_credits_remaining (or equivalent) for the
--   -- test user is identical before and after the run — this RPC must
--   -- never mutate it.
--
-- Verified live against local PostgreSQL 16 for this migration: 5 runs
-- (four at 20 concurrent clients, one at 60) each produced exactly one
-- payment row, N event rows all associated with that one payment id,
-- zero failed transactions, and unchanged credits.
--
-- What this script can verify without live concurrent sessions is that
-- the structural protections Test G depends on are present and unchanged:
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'payg_payments'
  AND indexname IN ('payg_payments_provider_payment_uidx', 'payg_payments_idempotency_key_uidx')
ORDER BY indexname;
-- expect 2 rows: both unique indexes present, neither weakened/dropped.
-- If either is absent, Test G cannot pass under any concurrency
-- scenario — STOP and report before attempting the live pgbench run above.

-- Confirm the function body contains the corrective exception-handling
-- pattern (structural precondition for Test G, not a substitute for
-- running it).
SELECT
  p.proname,
  pg_get_functiondef(p.oid) LIKE '%EXCEPTION%WHEN unique_violation THEN%'
    AND pg_get_functiondef(p.oid) LIKE '%ON CONFLICT (provider, provider_payment_id) DO NOTHING%' AS has_corrective_pattern
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'record_payg_payment_event';
-- expect has_corrective_pattern = true.

-- Final cleanup safety net for any row left behind by an actual Test G run.
DELETE FROM public.payg_payment_events WHERE provider_event_id LIKE '__payg_race_%';
DELETE FROM public.payg_payments WHERE provider_payment_id LIKE '__payg_race_%';
SELECT count(*) AS payg_race_all_rows_final
FROM public.payg_payments
WHERE provider_payment_id LIKE '__payg_race_%';
-- expect 0
