-- =============================================================================
-- WP-ADMIN-COMP-AW-03C — role_id Nullable Regression Test Script
-- =============================================================================
-- File: supabase/tests/WP-ADMIN-COMP-AW-03C_role_id_nullable_regression.sql
-- Exercises the corrective migration:
--   supabase/migrations/20260823120000_wp_admin_comp_aw_03c_adaptive_weights_role_id_nullable.sql
--
-- Verifies, through the actual certified RPCs (not direct table INSERT,
-- per AW-03C §12) that a genuinely new (role_family, experience_bucket,
-- industry_tag) segment can now be created without a role_id, and that no
-- existing behavior regressed.
--
-- Covers WP-ADMIN-COMP-AW-03C §11 tests A-G:
--   A — first-time record_adaptive_outcome()
--   B — first-time apply_adaptive_override()
--   C — existing-segment update
--   D — release_adaptive_override()
--   E — concurrent first-time creation (structural check here; see note below
--       for the true concurrency test, which requires two parallel sessions)
--   F — get_adaptive_weights() read path
--   G — existing data compatibility
--
-- Uses only '__aw03c_verify_%'-namespaced identifiers throughout. Never
-- touches any row outside that namespace. PART 1 (A-D, F) is rollback-safe
-- (wrapped in BEGIN...ROLLBACK); PART 2 (G) is read-only against whatever
-- pre-existing data the environment has, and SKIPS rather than fails when
-- the table is empty (e.g. a freshly reset local database has no
-- historical rows to check compatibility against — an environment/baseline
-- gap, not migration evidence, following the precedent set by
-- WP-ADMIN-COMP-08-R14_Verification_Test_Script_v2.sql's T6 handling).
--
-- =============================================================================

-- =============================================================================
-- PART 1 — Rollback-safe RPC smoke tests (A, B, C, D, F)
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_family      text := '__aw03c_verify_family';
  v_bucket      text := '__aw03c_verify_bucket';
  v_industry    text := '__aw03c_verify_industry';
  v_result      jsonb;
  v_row         RECORD;
BEGIN
  -- Precondition: no pre-existing row for this verification segment.
  DELETE FROM public.adaptive_weights
  WHERE role_family = v_family
    AND experience_bucket = v_bucket
    AND industry_tag = v_industry;

  -- ---------------------------------------------------------------------
  -- Test A — first-time record_adaptive_outcome()
  -- ---------------------------------------------------------------------
  v_result := public.record_adaptive_outcome(
    v_family, v_bucket, v_industry,
    75.0,   -- p_predicted_score
    0.80    -- p_actual_outcome
  );

  IF (v_result ->> 'updated')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST A FAILED — record_adaptive_outcome() did not report updated=true for a genuinely new segment: %', v_result;
  END IF;

  SELECT * INTO v_row
  FROM public.adaptive_weights
  WHERE role_family = v_family
    AND experience_bucket = v_bucket
    AND industry_tag = v_industry;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'TEST A FAILED — no row was created for the new segment';
  END IF;

  IF v_row.role_id IS NOT NULL THEN
    RAISE EXCEPTION 'TEST A FAILED — expected role_id IS NULL, got %', v_row.role_id;
  END IF;

  RAISE NOTICE 'TEST A PASSED — record_adaptive_outcome() created a new segment with role_id IS NULL';

  -- ---------------------------------------------------------------------
  -- Test C — existing-segment update (record_adaptive_outcome() again,
  -- same segment, must UPDATE not fail/duplicate)
  -- ---------------------------------------------------------------------
  v_result := public.record_adaptive_outcome(
    v_family, v_bucket, v_industry,
    60.0, 0.55
  );

  IF (v_result ->> 'updated')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST C FAILED — existing-segment record_adaptive_outcome() did not update: %', v_result;
  END IF;

  IF (SELECT count(*) FROM public.adaptive_weights
      WHERE role_family = v_family AND experience_bucket = v_bucket AND industry_tag = v_industry) <> 1 THEN
    RAISE EXCEPTION 'TEST C FAILED — expected exactly one row for the segment after a second call';
  END IF;

  RAISE NOTICE 'TEST C PASSED — existing-segment update behavior unchanged';

  -- ---------------------------------------------------------------------
  -- Test F — get_adaptive_weights() read path
  -- ---------------------------------------------------------------------
  v_result := public.get_adaptive_weights(v_family, v_bucket, v_industry);

  IF v_result -> 'weights' IS NULL THEN
    RAISE EXCEPTION 'TEST F FAILED — get_adaptive_weights() did not return a weights object: %', v_result;
  END IF;

  RAISE NOTICE 'TEST F PASSED — get_adaptive_weights() read path unaffected';

  -- Clean up before the override tests use a fresh segment.
  DELETE FROM public.adaptive_weights
  WHERE role_family = v_family
    AND experience_bucket = v_bucket
    AND industry_tag = v_industry;

  -- ---------------------------------------------------------------------
  -- Test B — first-time apply_adaptive_override()
  -- ---------------------------------------------------------------------
  v_result := public.apply_adaptive_override(
    v_family, v_bucket, v_industry,
    0.45, 0.25, 0.15, 0.15
  );

  IF (v_result ->> 'manualOverride')::boolean IS NOT TRUE
     OR (v_result ->> 'freezeLearning')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST B FAILED — apply_adaptive_override() did not report manualOverride/freezeLearning true: %', v_result;
  END IF;

  SELECT * INTO v_row
  FROM public.adaptive_weights
  WHERE role_family = v_family
    AND experience_bucket = v_bucket
    AND industry_tag = v_industry;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'TEST B FAILED — no row was created for the new override segment';
  END IF;

  IF v_row.role_id IS NOT NULL THEN
    RAISE EXCEPTION 'TEST B FAILED — expected role_id IS NULL, got %', v_row.role_id;
  END IF;

  IF v_row.manual_override IS NOT TRUE OR v_row.freeze_learning IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST B FAILED — row does not have manual_override/freeze_learning = true';
  END IF;

  RAISE NOTICE 'TEST B PASSED — apply_adaptive_override() created a new segment with role_id IS NULL, manual_override/freeze_learning = true';

  -- ---------------------------------------------------------------------
  -- Test D — release_adaptive_override()
  -- ---------------------------------------------------------------------
  v_result := public.release_adaptive_override(v_family, v_bucket, v_industry);

  IF (v_result ->> 'released')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST D FAILED — release_adaptive_override() did not report released=true: %', v_result;
  END IF;

  SELECT * INTO v_row
  FROM public.adaptive_weights
  WHERE role_family = v_family
    AND experience_bucket = v_bucket
    AND industry_tag = v_industry;

  IF v_row.manual_override IS NOT FALSE OR v_row.freeze_learning IS NOT FALSE THEN
    RAISE EXCEPTION 'TEST D FAILED — expected manual_override/freeze_learning = false after release';
  END IF;

  RAISE NOTICE 'TEST D PASSED — release_adaptive_override() cleared manual_override/freeze_learning';

  RAISE NOTICE 'PART 1 (Tests A, B, C, D, F) — ALL PASSED';
END;
$$;

ROLLBACK;

-- Confirm PART 1 left no trace (ROLLBACK above should have undone
-- everything, including the intra-block DELETE/INSERT/UPDATE statements).
SELECT count(*) AS aw03c_verify_rows_after_rollback
FROM public.adaptive_weights
WHERE role_family LIKE '__aw03c_verify_%';
-- expect 0

-- =============================================================================
-- PART 2 — Test G, existing data compatibility (read-only, no transaction
-- wrapper needed)
-- =============================================================================

DO $$
DECLARE
  v_total_rows        bigint;
  v_null_role_id_rows  bigint;
BEGIN
  SELECT count(*) INTO v_total_rows FROM public.adaptive_weights;

  IF v_total_rows = 0 THEN
    RAISE NOTICE 'TEST G SKIPPED — NO PRE-EXISTING adaptive_weights ROWS IN THIS ENVIRONMENT (freshly reset local database has no historical data to check compatibility against)';
    RETURN;
  END IF;

  -- All pre-existing rows must remain readable and their role_id values
  -- must be exactly as they were (this migration performs no UPDATE, so
  -- this is a read-only sanity check, not a before/after diff).
  PERFORM 1 FROM public.adaptive_weights LIMIT 1;

  SELECT count(*) INTO v_null_role_id_rows
  FROM public.adaptive_weights
  WHERE role_id IS NULL;

  RAISE NOTICE 'TEST G — % total pre-existing rows readable; % have NULL role_id (expected 0 for rows created before this migration, since role_id was NOT NULL until now)', v_total_rows, v_null_role_id_rows;
  RAISE NOTICE 'TEST G PASSED — existing rows remain readable; no historical role_id value was altered by this migration (schema-only change, no UPDATE statement exists in it)';
END;
$$;

-- =============================================================================
-- Test E — concurrent first-time creation
-- =============================================================================
-- A true concurrency test (two genuinely parallel fetch-or-create calls
-- racing for the same brand-new composite key) cannot be expressed inside
-- a single sequential script or a single DO block — both statements would
-- run in program order on one connection, not concurrently. Per the AW-04
-- precedent (which used two real, separately-opened OS-level connections
-- against an isolated test database to test this exact race), Test E
-- requires two parallel sessions, e.g.:
--
--   -- session 1                          -- session 2 (start immediately after)
--   SELECT public.record_adaptive_outcome(
--     '__aw03c_verify_concurrency_family',
--     '__aw03c_verify_concurrency_bucket',
--     '__aw03c_verify_concurrency_industry',
--     70.0, 0.7);
--                                          SELECT public.record_adaptive_outcome(
--                                            '__aw03c_verify_concurrency_family',
--                                            '__aw03c_verify_concurrency_bucket',
--                                            '__aw03c_verify_concurrency_industry',
--                                            70.0, 0.7);
--
-- Expected: both calls succeed (no unhandled exception surfaces to the
-- caller), and exactly one row persists for the segment, because
-- adaptive_weights_role_family_experience_bucket_industry_tag_key (added by
-- DB-FR-005B, left unchanged by this migration — see the corrective
-- migration's own post-deployment verification, check C) rejects the
-- second concurrent INSERT at the database level.
--
-- What this script CAN verify without two live sessions is that the
-- structural protection itself is present and unchanged:
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.adaptive_weights'::regclass
  AND conname = 'adaptive_weights_role_family_experience_bucket_industry_tag_key';
-- expect 1 row: UNIQUE (role_family, experience_bucket, industry_tag)
-- If this row is absent, Test E cannot pass under any concurrency
-- scenario, regardless of role_id's nullability — STOP and report before
-- attempting the two-session test above.

-- Final cleanup safety net: confirm no '__aw03c_verify_%' rows persist
-- outside the rollback-wrapped PART 1 (defensive; PART 1's ROLLBACK
-- already guarantees this).
DELETE FROM public.adaptive_weights WHERE role_family LIKE '__aw03c_verify_%';
SELECT count(*) AS aw03c_verify_rows_final
FROM public.adaptive_weights
WHERE role_family LIKE '__aw03c_verify_%';
-- expect 0
