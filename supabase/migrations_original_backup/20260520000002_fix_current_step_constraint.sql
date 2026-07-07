-- ─────────────────────────────────────────────────────────────────────────────
-- migration: 20260520000002_fix_current_step_constraint.sql
--
-- FIX: Rebuilds the current_step CHECK constraint on student_onboarding_sessions
--      to include all 7 valid step values.
--
-- ROOT CAUSE:
--   The live database has a stale version of the
--   student_onboarding_sessions_current_step_check constraint that is missing
--   one or more step values (e.g. 'activities', 'cognitive', 'aspiration').
--   When the academics step submits and the API tries to advance current_step
--   to 'activities', Postgres rejects with:
--
--     ERROR 23514: new row for relation "student_onboarding_sessions" violates
--     check constraint "student_onboarding_sessions_current_step_check"
--
--   This happens when the 20260518000001_student_onboarding_foundation migration
--   was applied against an already-existing table (created by an earlier, partial
--   version of the migration), so the CREATE TABLE IF NOT EXISTS was a no-op and
--   the old constraint was never replaced.
--
-- FIX:
--   1. DROP the stale constraint (IF EXISTS — safe if already correct).
--   2. ADD the authoritative constraint with all 7 valid step values.
--   3. Refresh PostgREST schema cache.
--
-- SAFE TO RUN:
--   Idempotent — DROP IF EXISTS + ADD constraint is safe to re-run.
--   No data is modified. Any existing rows with valid step values are unaffected.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Step 1: Drop the stale constraint
ALTER TABLE student_onboarding_sessions
  DROP CONSTRAINT IF EXISTS student_onboarding_sessions_current_step_check;

-- Step 2: Recreate with all 7 valid step values (matches ONBOARDING_STEPS in frontend)
ALTER TABLE student_onboarding_sessions
  ADD CONSTRAINT student_onboarding_sessions_current_step_check
    CHECK (current_step IN (
      'education',
      'academics',
      'activities',
      'cognitive',
      'aspiration',
      'processing',
      'result'
    ));

-- Step 3: Also ensure engine_version column exists (from previous fix migration)
ALTER TABLE student_onboarding_sessions
  ADD COLUMN IF NOT EXISTS engine_version TEXT NOT NULL DEFAULT '1.0.0';

-- Step 4: Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
