-- ─────────────────────────────────────────────────────────────────────────────
-- migration: 20260520000001_add_engine_version_to_sessions.sql
--
-- FIX: Adds the `engine_version` column to student_onboarding_sessions.
--
-- ROOT CAUSE:
--   The column was declared in the migration
--   20260518000001_student_onboarding_foundation.sql but was not yet applied
--   to the live database, causing Supabase PostgREST to return PGRST204:
--   "Could not find the 'engine_version' column of 'student_onboarding_sessions'
--   in the schema cache."
--
--   The frontend API layer (student-onboarding.api.ts) selects '*' from this
--   table and passes the raw row through dbOnboardingSessionRowSchema (Zod),
--   which requires engine_version. Without the column the upsert insert also
--   fails, surfacing as STUDENT_ONBOARDING_SESSION_CREATE_FAILED in the UI.
--
-- SAFE TO RUN:
--   Uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS — idempotent on re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE student_onboarding_sessions
  ADD COLUMN IF NOT EXISTS engine_version TEXT NOT NULL DEFAULT '1.0.0';

COMMENT ON COLUMN student_onboarding_sessions.engine_version IS
  'Version of the intelligence engine used at time of onboarding. Used for future migration targeting.';

-- Refresh PostgREST schema cache so the new column is visible immediately.
-- Required in Supabase managed instances; harmless on self-hosted Postgres.
NOTIFY pgrst, 'reload schema';

COMMIT;
