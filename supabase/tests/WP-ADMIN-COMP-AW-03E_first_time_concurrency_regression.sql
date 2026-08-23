-- =============================================================================
-- WP-ADMIN-COMP-AW-03E — First-Time Segment Concurrency Regression Test Script
-- =============================================================================
-- File: supabase/tests/WP-ADMIN-COMP-AW-03E_first_time_concurrency_regression.sql
-- Exercises the corrective migration:
--   supabase/migrations/20260824000000_wp_admin_comp_aw_03e_adaptive_weight_first_time_concurrency_fix.sql
--
-- Verifies, through the actual certified RPCs (not direct table INSERT),
-- that a genuinely new (role_family, experience_bucket, industry_tag)
-- segment can be created by record_adaptive_outcome() and
-- apply_adaptive_override() — sequentially (Tests H, I) and concurrently
-- (Tests J, K) — without either caller ever surfacing PostgreSQL 23505,
-- and with exactly one row persisting per segment in all cases.
--
-- Follows the conventions established by
-- WP-ADMIN-COMP-AW-03C_role_id_nullable_regression.sql:
--   - '__aw03e_'-namespaced identifiers only; never touches any
--     pre-existing row.
--   - Sequential smoke tests (H, I) are rollback-safe.
--   - True concurrency (J, K) cannot be expressed inside a single
--     sequential script or DO block — both statements would run in
--     program order on one connection, not concurrently. That part is
--     documented here with the exact two-session procedure, per AW-03D/
--     AW-03C precedent (two real, separately-opened OS-level connections
--     against an isolated test database).
--
-- =============================================================================

-- =============================================================================
-- PART 1 — Rollback-safe sequential smoke tests (H, I)
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_family_h   text := '__aw03e_seqtest_h_family';
  v_bucket_h   text := '__aw03e_seqtest_h_bucket';
  v_industry_h text := '__aw03e_seqtest_h_industry';

  v_family_i   text := '__aw03e_seqtest_i_family';
  v_bucket_i   text := '__aw03e_seqtest_i_bucket';
  v_industry_i text := '__aw03e_seqtest_i_industry';

  v_result jsonb;
  v_row    RECORD;
BEGIN
  -- Preconditions: no pre-existing rows for these verification segments.
  DELETE FROM public.adaptive_weights
  WHERE role_family IN (v_family_h, v_family_i);

  -- ---------------------------------------------------------------------
  -- Test H — sequential first-time creation via record_adaptive_outcome()
  -- ---------------------------------------------------------------------
  v_result := public.record_adaptive_outcome(
    v_family_h, v_bucket_h, v_industry_h,
    75.0,   -- p_predicted_score
    0.80    -- p_actual_outcome
  );

  IF (v_result ->> 'updated')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST H FAILED — record_adaptive_outcome() did not report updated=true for a genuinely new segment: %', v_result;
  END IF;

  SELECT * INTO v_row
  FROM public.adaptive_weights
  WHERE role_family = v_family_h
    AND experience_bucket = v_bucket_h
    AND industry_tag = v_industry_h;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'TEST H FAILED — no row was created for the new segment';
  END IF;

  IF v_row.role_id IS NOT NULL THEN
    RAISE EXCEPTION 'TEST H FAILED — expected role_id IS NULL, got %', v_row.role_id;
  END IF;

  IF (SELECT count(*) FROM public.adaptive_weights
      WHERE role_family = v_family_h AND experience_bucket = v_bucket_h AND industry_tag = v_industry_h) <> 1 THEN
    RAISE EXCEPTION 'TEST H FAILED — expected exactly one row for the segment, found duplicate(s)';
  END IF;

  RAISE NOTICE 'TEST H PASSED — record_adaptive_outcome() created exactly one new segment, role_id IS NULL, normal response';

  -- ---------------------------------------------------------------------
  -- Test I — sequential first-time creation via apply_adaptive_override()
  -- ---------------------------------------------------------------------
  v_result := public.apply_adaptive_override(
    v_family_i, v_bucket_i, v_industry_i,
    0.45, 0.25, 0.15, 0.15
  );

  IF (v_result ->> 'manualOverride')::boolean IS NOT TRUE
     OR (v_result ->> 'freezeLearning')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST I FAILED — apply_adaptive_override() did not report manualOverride/freezeLearning true: %', v_result;
  END IF;

  SELECT * INTO v_row
  FROM public.adaptive_weights
  WHERE role_family = v_family_i
    AND experience_bucket = v_bucket_i
    AND industry_tag = v_industry_i;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'TEST I FAILED — no row was created for the new override segment';
  END IF;

  IF v_row.role_id IS NOT NULL THEN
    RAISE EXCEPTION 'TEST I FAILED — expected role_id IS NULL, got %', v_row.role_id;
  END IF;

  IF v_row.manual_override IS NOT TRUE OR v_row.freeze_learning IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST I FAILED — row does not have manual_override/freeze_learning = true';
  END IF;

  IF (SELECT count(*) FROM public.adaptive_weights
      WHERE role_family = v_family_i AND experience_bucket = v_bucket_i AND industry_tag = v_industry_i) <> 1 THEN
    RAISE EXCEPTION 'TEST I FAILED — expected exactly one row for the segment, found duplicate(s)';
  END IF;

  RAISE NOTICE 'TEST I PASSED — apply_adaptive_override() created exactly one new segment, role_id IS NULL, manual_override/freeze_learning = true, normal response';

  RAISE NOTICE 'PART 1 (Tests H, I) — ALL PASSED';
END;
$$;

ROLLBACK;

-- Confirm PART 1 left no trace.
SELECT count(*) AS aw03e_seqtest_rows_after_rollback
FROM public.adaptive_weights
WHERE role_family LIKE '__aw03e_seqtest_%';
-- expect 0

-- =============================================================================
-- PART 2 — Tests J, K: genuine two-session concurrency (documentation +
-- structural precondition check)
-- =============================================================================
-- True concurrency cannot be expressed inside a single sequential script.
-- Tests J and K require two real, independently-opened connections issuing
-- their calls against the SAME brand-new segment at effectively the same
-- time. Executed procedure for this work package (two separate psql
-- connections launched together and awaited):
--
--   session 1                                  session 2 (launched immediately after)
--   SELECT public.record_adaptive_outcome(     SELECT public.record_adaptive_outcome(
--     '__aw03e_j_family',                        '__aw03e_j_family',
--     '__aw03e_j_bucket',                         '__aw03e_j_bucket',
--     '__aw03e_j_industry',                       '__aw03e_j_industry',
--     70.0, 0.70);                                70.0, 0.70);
--
--   session 1                                  session 2 (launched immediately after)
--   SELECT public.apply_adaptive_override(     SELECT public.apply_adaptive_override(
--     '__aw03e_k_family',                        '__aw03e_k_family',
--     '__aw03e_k_bucket',                         '__aw03e_k_bucket',
--     '__aw03e_k_industry',                       '__aw03e_k_industry',
--     0.45, 0.25, 0.15, 0.15);                    0.45, 0.25, 0.15, 0.15);
--
-- Expected for both: neither session raises an unhandled exception (no
-- 23505 reaches either caller), both calls return normally, and exactly
-- one row persists for the segment afterward, with the canonical unique
-- constraint intact. Test K additionally requires manual_override = true
-- and freeze_learning = true on the single persisted row.
--
-- What this script can verify without two live sessions is that the
-- structural protection the corrective INSERT ... ON CONFLICT depends on
-- is present and unchanged:
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.adaptive_weights'::regclass
  AND conname = 'adaptive_weights_role_family_experience_bucket_industry_tag_key';
-- expect 1 row: UNIQUE (role_family, experience_bucket, industry_tag)
-- If this row is absent, Tests J/K cannot pass under any concurrency
-- scenario — STOP and report before attempting the two-session test above.

-- Confirm both function bodies contain the approved ON CONFLICT pattern
-- (structural precondition for J/K, not a substitute for running them).
SELECT
  p.proname,
  pg_get_functiondef(p.oid) LIKE '%ON CONFLICT (role_family, experience_bucket, industry_tag)%DO NOTHING%RETURNING * INTO rec%' AS has_corrective_pattern
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('record_adaptive_outcome', 'apply_adaptive_override')
ORDER BY p.proname;
-- expect has_corrective_pattern = true for both rows.

-- Final cleanup safety net for any segment left behind by an actual J/K run.
DELETE FROM public.adaptive_weights WHERE role_family LIKE '__aw03e_%';
SELECT count(*) AS aw03e_all_rows_final
FROM public.adaptive_weights
WHERE role_family LIKE '__aw03e_%';
-- expect 0
