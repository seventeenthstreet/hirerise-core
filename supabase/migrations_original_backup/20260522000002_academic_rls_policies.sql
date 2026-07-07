-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260522000002_academic_rls_policies.sql
-- Phase 3A — RLS Policies for Academic Signal Tables
--
-- POLICY DESIGN:
--   • Students can only read/write their own rows (auth.uid() = user_id)
--   • Service role bypasses RLS (backend API uses service-role key)
--   • No cross-student reads — ever
--   • Cascade deletes are DB-level, not policy-level
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- student_academic_records RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE student_academic_records ENABLE ROW LEVEL SECURITY;

-- Students may SELECT their own records only
DROP POLICY IF EXISTS "student_academic_records_select_own" ON student_academic_records;
CREATE POLICY "student_academic_records_select_own"
  ON student_academic_records
  FOR SELECT
  USING (auth.uid() = user_id);

-- Students may INSERT rows for themselves only
DROP POLICY IF EXISTS "student_academic_records_insert_own" ON student_academic_records;
CREATE POLICY "student_academic_records_insert_own"
  ON student_academic_records
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Students may UPDATE their own rows only
DROP POLICY IF EXISTS "student_academic_records_update_own" ON student_academic_records;
CREATE POLICY "student_academic_records_update_own"
  ON student_academic_records
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Students may DELETE their own rows only
-- (Needed for future "clear year" flows; cascade from auth.users handles account deletion)
DROP POLICY IF EXISTS "student_academic_records_delete_own" ON student_academic_records;
CREATE POLICY "student_academic_records_delete_own"
  ON student_academic_records
  FOR DELETE
  USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- student_academic_subjects RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE student_academic_subjects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "student_academic_subjects_select_own" ON student_academic_subjects;
CREATE POLICY "student_academic_subjects_select_own"
  ON student_academic_subjects
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "student_academic_subjects_insert_own" ON student_academic_subjects;
CREATE POLICY "student_academic_subjects_insert_own"
  ON student_academic_subjects
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "student_academic_subjects_update_own" ON student_academic_subjects;
CREATE POLICY "student_academic_subjects_update_own"
  ON student_academic_subjects
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "student_academic_subjects_delete_own" ON student_academic_subjects;
CREATE POLICY "student_academic_subjects_delete_own"
  ON student_academic_subjects
  FOR DELETE
  USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- GRANT service_role full access (bypasses RLS — used by backend API)
-- ─────────────────────────────────────────────────────────────────────────────

GRANT ALL ON student_academic_records  TO service_role;
GRANT ALL ON student_academic_subjects TO service_role;

-- anon + authenticated roles: no direct table access (all goes via API)
REVOKE ALL ON student_academic_records  FROM anon;
REVOKE ALL ON student_academic_subjects FROM anon;
