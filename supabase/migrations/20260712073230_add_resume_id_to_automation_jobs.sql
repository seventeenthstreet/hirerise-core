-- ─────────────────────────────────────────────────────────────────────────────
-- migration: 20260712073230_add_resume_id_to_automation_jobs.sql
--
-- WORK PACKAGE A — Repository Idempotency Restoration
--
-- FIX: Adds `resume_id` to automation_jobs.
--
-- ROOT CAUSE:
--   api-service/src/controllers/resume.controller.js's duplicate-submission
--   path returns `resumeId: existingJob.resumeId` from the row found by
--   jobRepo.findByIdempotencyKey(). automation_jobs never had a resume_id
--   column, so that value could never be populated — the duplicate-reuse
--   response would always come back with resumeId = null/undefined, even
--   once findByIdempotencyKey itself was implemented
--   (shared/repositories/partitioned-jobs.repository.js).
--
-- SAFE TO RUN:
--   Nullable, additive column. Uses ADD COLUMN IF NOT EXISTS — idempotent on
--   re-run. Does not touch existing rows or any other table.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE "public"."automation_jobs"
  ADD COLUMN IF NOT EXISTS "resume_id" "text";

COMMENT ON COLUMN "public"."automation_jobs"."resume_id" IS
  'Resume this job scores, for RESUME_SCORE jobs. Null for job types unrelated to resumes (e.g. SALARY_BENCHMARK, CAREER_PATH). Populated by PartitionedJobRepository.createJob(), read back by findByIdempotencyKey() for the duplicate-submission response.';

-- Refresh PostgREST schema cache so the new column is visible immediately.
-- Required in Supabase managed instances; harmless on self-hosted Postgres.
NOTIFY pgrst, 'reload schema';

COMMIT;
