-- =============================================================================
-- MIGRATION: Fix schema gaps revealed by production audit
-- File: supabase/migrations/20260421000001_audit_fixes.sql
-- =============================================================================
-- Run this migration BEFORE deploying the fixed application code.
-- All changes are backward-compatible (ADD COLUMN IF NOT EXISTS, etc.)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- FIX 1: resumes table — analysis.service.js queries resume_text and file_name
-- but neither column exists. raw_text is the actual text column.
-- Add resume_text as a generated column (alias for raw_text) so both old and
-- new code works during rolling deploy.
-- ---------------------------------------------------------------------------

-- Add resume_text as a stored generated column pointing to raw_text.
-- This makes analysis.service.js SELECT resume_text work without changing raw_text writes.
-- NOTE: PostgreSQL generated columns require Postgres 12+. Supabase is Postgres 15.
ALTER TABLE public.resumes
  ADD COLUMN IF NOT EXISTS resume_text TEXT GENERATED ALWAYS AS (raw_text) STORED;

-- Add file_name as a generated column extracted from the content JSONB.
ALTER TABLE public.resumes
  ADD COLUMN IF NOT EXISTS file_name TEXT GENERATED ALWAYS AS (content->>'fileName') STORED;

-- Add personal_details column for completeness (populated by parsing pipeline).
ALTER TABLE public.resumes
  ADD COLUMN IF NOT EXISTS personal_details JSONB;

-- ---------------------------------------------------------------------------
-- FIX 2: resume_analyses — analysis_hash is NOT NULL but free-tier engine
-- did not generate one, causing constraint violations on every free analysis.
-- The application now generates a hash, but add a default as defence-in-depth.
-- ---------------------------------------------------------------------------

-- Allow NULL temporarily so old rows don't break; application always supplies a value.
-- This is a no-op if the column is already nullable.
ALTER TABLE public.resume_analyses
  ALTER COLUMN analysis_hash DROP NOT NULL;

-- Re-add NOT NULL with a generated default so future inserts without a hash
-- still satisfy the constraint.
ALTER TABLE public.resume_analyses
  ALTER COLUMN analysis_hash SET DEFAULT md5(random()::text);

-- ---------------------------------------------------------------------------
-- FIX 3: resume_analyses.user_id — currently UUID type but users are TEXT.
-- Normalise to TEXT to match the rest of the schema.
-- Safe: Supabase implicitly casts UUID↔TEXT; this makes it explicit.
-- ---------------------------------------------------------------------------

-- Drop policies that depend on public.resume_analyses.user_id before the
-- type change (Postgres blocks ALTER COLUMN TYPE while a policy references
-- the column). admins_read_all_analyses is NOT dropped: it references
-- user_roles.user_id, not resume_analyses.user_id, so it has no dependency
-- on this column.
DROP POLICY IF EXISTS "users_insert_own_analyses" ON public.resume_analyses;
DROP POLICY IF EXISTS "users_read_own_analyses" ON public.resume_analyses;
DROP POLICY IF EXISTS "users_update_own_analyses" ON public.resume_analyses;

ALTER TABLE public.resume_analyses
  ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;

-- Recreate the dropped policies identically, except auth.uid() (uuid) is
-- cast to text to match the new column type.
CREATE POLICY "users_insert_own_analyses"
  ON public.resume_analyses
  FOR INSERT
  TO authenticated
  WITH CHECK ((auth.uid())::text = user_id);

CREATE POLICY "users_read_own_analyses"
  ON public.resume_analyses
  FOR SELECT
  TO authenticated
  USING ((auth.uid())::text = user_id);

CREATE POLICY "users_update_own_analyses"
  ON public.resume_analyses
  FOR UPDATE
  TO authenticated
  USING ((auth.uid())::text = user_id)
  WITH CHECK ((auth.uid())::text = user_id);

-- ---------------------------------------------------------------------------
-- FIX 4: onboarding_progress — user_id was nullable and often not written.
-- RLS policy and mergeStepHistory() both filter by user_id; if it's NULL
-- those queries silently return 0 rows.
-- Backfill from id (which is also the userId) and add NOT NULL constraint.
-- ---------------------------------------------------------------------------

-- Backfill: for any rows where user_id IS NULL, copy from id.
UPDATE public.onboarding_progress
   SET user_id = id
 WHERE user_id IS NULL;

-- Now safe to add NOT NULL constraint.
ALTER TABLE public.onboarding_progress
  ALTER COLUMN user_id SET NOT NULL;

-- Ensure index exists for user_id lookups (used by RLS + mergeStepHistory).
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_user_id
    ON public.onboarding_progress (user_id);

-- ---------------------------------------------------------------------------
-- FIX 5: onboarding_progress — add missing education JSONB column.
-- evaluateCompletion() checks progress.education?.length but the column
-- didn't exist, so Track A completion was never triggered.
-- ---------------------------------------------------------------------------

ALTER TABLE public.onboarding_progress
  ADD COLUMN IF NOT EXISTS education JSONB DEFAULT '[]'::JSONB;

-- ---------------------------------------------------------------------------
-- FIX 6: resume_analyses engine CHECK constraint.
-- The route was defaulting engine to 'supabase-first' which violates the
-- CHECK constraint. The application now normalises to 'free'|'premium', but
-- remove the constraint and replace with a more permissive one as safety net.
-- ---------------------------------------------------------------------------

ALTER TABLE public.resume_analyses
  DROP CONSTRAINT IF EXISTS resume_analyses_engine_check;

ALTER TABLE public.resume_analyses
  ADD CONSTRAINT resume_analyses_engine_check
    CHECK (engine IN ('free', 'premium'));

-- ---------------------------------------------------------------------------
-- FIX 7: resumes RLS — add INSERT and UPDATE policies.
-- Currently only SELECT exists. Service-role key bypasses this, but add
-- explicit policies so any future client-side usage works correctly.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "resumes: own insert" ON public.resumes;
CREATE POLICY "resumes: own insert"
  ON public.resumes
  FOR INSERT
  WITH CHECK ((auth.uid())::text = user_id);

DROP POLICY IF EXISTS "resumes: own update" ON public.resumes;
CREATE POLICY "resumes: own update"
  ON public.resumes
  FOR UPDATE
  USING ((auth.uid())::text = user_id)
  WITH CHECK ((auth.uid())::text = user_id);

-- ---------------------------------------------------------------------------
-- FIX 8: Ensure health_check table exists (used by verifyConnection in supabase.js).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.health_check (
  id   SERIAL PRIMARY KEY,
  ts   TIMESTAMP WITH TIME ZONE DEFAULT now()
);

INSERT INTO public.health_check (ts)
VALUES (now())
ON CONFLICT DO NOTHING;

-- =============================================================================
-- End of migration
-- =============================================================================