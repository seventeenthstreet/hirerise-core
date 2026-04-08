BEGIN;

-- ============================================================================
-- STEP 1: Drop ALL legacy + partial policies
-- ============================================================================
DROP POLICY IF EXISTS "conversations_owner" ON public.edu_career_conversations;
DROP POLICY IF EXISTS "edu_conversations_select_own" ON public.edu_career_conversations;
DROP POLICY IF EXISTS "edu_conversations_insert_own" ON public.edu_career_conversations;
DROP POLICY IF EXISTS "edu_conversations_update_own" ON public.edu_career_conversations;
DROP POLICY IF EXISTS "edu_conversations_delete_own" ON public.edu_career_conversations;

-- ============================================================================
-- STEP 2: Remove old index and normalize final index
-- ============================================================================
DROP INDEX IF EXISTS public.idx_edu_career_conversations_student_created;

DROP INDEX IF EXISTS public.idx_edu_career_conversations_student_created_desc;

CREATE INDEX idx_edu_career_conversations_student_created_desc
ON public.edu_career_conversations (student_id, created_at DESC);

-- ============================================================================
-- STEP 3: Convert TEXT -> UUID
-- ============================================================================
ALTER TABLE public.edu_career_conversations
ALTER COLUMN student_id TYPE UUID
USING student_id::uuid;

-- ============================================================================
-- STEP 4: Add FK
-- ============================================================================
ALTER TABLE public.edu_career_conversations
DROP CONSTRAINT IF EXISTS edu_career_conversations_student_id_fkey;

ALTER TABLE public.edu_career_conversations
ADD CONSTRAINT edu_career_conversations_student_id_fkey
FOREIGN KEY (student_id)
REFERENCES auth.users(id)
ON DELETE CASCADE;

-- ============================================================================
-- STEP 5: Recreate optimized RLS
-- ============================================================================
CREATE POLICY "edu_conversations_select_own"
ON public.edu_career_conversations
FOR SELECT
TO authenticated
USING ((SELECT auth.uid()) = student_id);

CREATE POLICY "edu_conversations_insert_own"
ON public.edu_career_conversations
FOR INSERT
TO authenticated
WITH CHECK ((SELECT auth.uid()) = student_id);

CREATE POLICY "edu_conversations_update_own"
ON public.edu_career_conversations
FOR UPDATE
TO authenticated
USING ((SELECT auth.uid()) = student_id)
WITH CHECK ((SELECT auth.uid()) = student_id);

CREATE POLICY "edu_conversations_delete_own"
ON public.edu_career_conversations
FOR DELETE
TO authenticated
USING ((SELECT auth.uid()) = student_id);

COMMIT;