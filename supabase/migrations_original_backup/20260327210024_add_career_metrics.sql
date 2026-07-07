BEGIN;

-- ============================================================================
-- STEP 1: Drop ALL possible legacy policies first
-- ============================================================================

DROP POLICY IF EXISTS "career_metrics_self" ON public.career_metrics;
DROP POLICY IF EXISTS "career_metrics_owner" ON public.career_metrics;
DROP POLICY IF EXISTS "career_metrics_select_own" ON public.career_metrics;
DROP POLICY IF EXISTS "career_metrics_insert_own" ON public.career_metrics;
DROP POLICY IF EXISTS "career_metrics_update_own" ON public.career_metrics;
DROP POLICY IF EXISTS "career_metrics_delete_own" ON public.career_metrics;

-- ============================================================================
-- STEP 2: Remove duplicate indexes
-- ============================================================================

DROP INDEX IF EXISTS public.idx_career_metrics_user_date;
DROP INDEX IF EXISTS public.career_metrics_user_id_idx;

-- Rename canonical composite index
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'career_metrics'
      AND indexname = 'career_metrics_recorded_at_idx'
  ) THEN
    ALTER INDEX public.career_metrics_recorded_at_idx
    RENAME TO idx_career_metrics_user_recorded_desc;
  END IF;
END $$;

-- ============================================================================
-- STEP 3: Convert TEXT -> UUID
-- ============================================================================

ALTER TABLE public.career_metrics
ALTER COLUMN user_id TYPE UUID
USING user_id::uuid;

-- ============================================================================
-- STEP 4: Add FK to auth.users
-- ============================================================================

ALTER TABLE public.career_metrics
DROP CONSTRAINT IF EXISTS career_metrics_user_id_fkey;

ALTER TABLE public.career_metrics
ADD CONSTRAINT career_metrics_user_id_fkey
FOREIGN KEY (user_id)
REFERENCES auth.users(id)
ON DELETE CASCADE;

-- ============================================================================
-- STEP 5: Add validation constraints safely
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_composite_range'
  ) THEN
    ALTER TABLE public.career_metrics
    ADD CONSTRAINT chk_composite_range
    CHECK (composite BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ats_score_range'
  ) THEN
    ALTER TABLE public.career_metrics
    ADD CONSTRAINT chk_ats_score_range
    CHECK (ats_score BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_job_match_range'
  ) THEN
    ALTER TABLE public.career_metrics
    ADD CONSTRAINT chk_job_match_range
    CHECK (job_match BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_interview_score_range'
  ) THEN
    ALTER TABLE public.career_metrics
    ADD CONSTRAINT chk_interview_score_range
    CHECK (interview_score BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_activity_score_range'
  ) THEN
    ALTER TABLE public.career_metrics
    ADD CONSTRAINT chk_activity_score_range
    CHECK (activity_score BETWEEN 0 AND 100);
  END IF;
END $$;

-- ============================================================================
-- STEP 6: Recreate optimized RLS policies
-- ============================================================================

CREATE POLICY "career_metrics_select_own"
ON public.career_metrics
FOR SELECT
TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "career_metrics_insert_own"
ON public.career_metrics
FOR INSERT
TO authenticated
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "career_metrics_update_own"
ON public.career_metrics
FOR UPDATE
TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "career_metrics_delete_own"
ON public.career_metrics
FOR DELETE
TO authenticated
USING ((SELECT auth.uid()) = user_id);

COMMIT;