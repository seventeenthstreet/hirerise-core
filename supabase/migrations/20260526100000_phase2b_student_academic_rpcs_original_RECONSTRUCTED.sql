-- =============================================================================
-- HireRise Academic Intelligence Platform
-- Migration: 20260526100000_phase2b_student_academic_rpcs_original_RECONSTRUCTED.sql
--
-- PHASE 2B BASE SCHEMA — student_academic_profiles / student_subject_selections /
--   student_language_preferences
--
-- RECONSTRUCTED — this file did not exist anywhere in the repository. It is
--   rebuilt from direct evidence so that the migration chain can create the
--   objects that 20260527000003_phase2b_student_academic_rpcs_evolution.sql
--   ALTERs. See WP-DB-01B Root Cause Analysis for the full audit trail.
--
-- RECONSTRUCTION METHOD:
--   Every column, type, default, constraint name, and index name below is
--   taken either verbatim from backups/post_wp_db_005_schema.sql (a pg_dump
--   of production), or is a column explicitly named as "already live" in the
--   header/section comments of 20260527000003_phase2b_student_academic_rpcs_evolution.sql.
--   No column, constraint, or object is introduced speculatively.
--
--   Columns are DELIBERATELY EXCLUDED from this file when the evolution
--   migration's own comments state it is adding them (e.g. "Adding:
--   country_code, region_code, ..."). Those columns are created later, by
--   20260527000003, via ADD COLUMN IF NOT EXISTS — reproducing them here
--   would make this file drift from what evolution expects to ALTER.
--
--   RLS ENABLE / RLS POLICIES / updated_at TRIGGERS / the evolution-added
--   indexes (idx_sap_*, idx_sss_*, idx_slp_*) are DELIBERATELY EXCLUDED here
--   for the same reason: 20260527000003 creates all of those itself, each
--   guarded by an IF NOT EXISTS check, so duplicating them here is unnecessary
--   and would just be redundant work performed twice.
--
-- KEY PROOFS:
--   • Evolution migration header: "Depends on: ... 20260527000003_phase2b_
--     student_academic_rpcs.sql (ORIGINAL — already deployed)"
--     → an original, non-"_evolution" migration was deployed to production
--       but is absent from this repository's migrations/ directory.
--   • Evolution migration header: "LIVE TABLE STATE (as discovered in
--     production): student_academic_profiles — has auth_user_id (NOT
--     user_id), lacks code columns, lacks target_year, onboarding_completed_at,
--     taxonomy_hash_at_save, rpc_version" → confirms the base column set
--     reconstructed below, and confirms auth_user_id (not user_id) is original.
--   • backups/post_wp_db_005_schema.sql lines 16552–16884, 17053–17066 →
--     literal CREATE TABLE definitions for all three tables, used verbatim
--     for column names/types/defaults not attributable to the evolution file.
--   • backups/post_wp_db_005_schema.sql lines 19044, 19159, 19214 → PRIMARY
--     KEY constraint names.
--   • backups/post_wp_db_005_schema.sql lines 23349–23509 → FOREIGN KEY
--     constraint definitions (not created anywhere in the evolution file).
--   • backups/post_wp_db_005_schema.sql lines 21727–21735, 21823, 21863–21867
--     → index names idx_student_academic_profiles_auth_user / _board /
--     _stream, idx_student_language_preferences_profile,
--     idx_student_subject_selections_profile / _subject — none of these
--     names are created by the evolution migration (which creates a
--     differently-named, functionally overlapping set: idx_sap_*, idx_sss_*,
--     idx_slp_*), so they must belong to this base migration.
--   • backups/post_wp_db_005_schema.sql lines 27872–27993 → GRANT ALL to
--     anon/authenticated/service_role, consistent with this project's
--     standard new-table grant pattern (access is subsequently restricted by
--     RLS policies, added in the evolution migration, not by GRANT).
--
-- SCOPE DISCIPLINE (per WP-DB-01B):
--   This migration ONLY creates the three base tables, their constraints,
--   and their pre-evolution indexes/grants. It does not touch Student SPCE,
--   Professional onboarding, APIs, or frontend code, and it does not
--   introduce any column, table, or behavior beyond what production evidence
--   confirms existed before the evolution migration ran.
--
-- IDEMPOTENCY: CREATE TABLE IF NOT EXISTS / ADD CONSTRAINT guarded by
--   DO $$ IF NOT EXISTS $$ blocks / CREATE INDEX IF NOT EXISTS throughout.
--   Safe to run against a database where these objects already exist
--   (e.g. production, where they were created outside the migration chain).
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- TABLE 1: student_academic_profiles
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.student_academic_profiles (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id           UUID        NOT NULL,
  country_id             UUID        NOT NULL,
  region_id              UUID        NOT NULL,
  board_id               UUID        NOT NULL,
  stream_id              UUID,
  current_class          SMALLINT    NOT NULL,
  academic_year          TEXT        NOT NULL,
  school_name            TEXT,
  medium_of_instruction  UUID,
  onboarding_completed   BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active              BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT student_academic_profiles_current_class_check
    CHECK (current_class >= 1 AND current_class <= 12)
);

COMMENT ON TABLE public.student_academic_profiles IS
  'RECONSTRUCTED base table (WP-DB-01B). Taxonomy-driven student academic '
  'identity: one row per student, referencing country/region/board/stream by '
  'FK. Evolved by 20260527000003 to add denormalized business-key code '
  'columns. Do not confuse with student_education_profiles (India-board-'
  'centric, enum-based, unrelated table).';

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_academic_profiles_auth_user_id_fkey'
      AND conrelid = 'public.student_academic_profiles'::regclass
  ) THEN
    ALTER TABLE public.student_academic_profiles
      ADD CONSTRAINT student_academic_profiles_auth_user_id_fkey
      FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_academic_profiles_country_id_fkey'
      AND conrelid = 'public.student_academic_profiles'::regclass
  ) THEN
    ALTER TABLE public.student_academic_profiles
      ADD CONSTRAINT student_academic_profiles_country_id_fkey
      FOREIGN KEY (country_id) REFERENCES public.countries_master(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_academic_profiles_region_id_fkey'
      AND conrelid = 'public.student_academic_profiles'::regclass
  ) THEN
    ALTER TABLE public.student_academic_profiles
      ADD CONSTRAINT student_academic_profiles_region_id_fkey
      FOREIGN KEY (region_id) REFERENCES public.curriculum_regions(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_academic_profiles_board_id_fkey'
      AND conrelid = 'public.student_academic_profiles'::regclass
  ) THEN
    ALTER TABLE public.student_academic_profiles
      ADD CONSTRAINT student_academic_profiles_board_id_fkey
      FOREIGN KEY (board_id) REFERENCES public.academic_boards(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_academic_profiles_stream_id_fkey'
      AND conrelid = 'public.student_academic_profiles'::regclass
  ) THEN
    ALTER TABLE public.student_academic_profiles
      ADD CONSTRAINT student_academic_profiles_stream_id_fkey
      FOREIGN KEY (stream_id) REFERENCES public.academic_streams(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_academic_profiles_medium_of_instruction_fkey'
      AND conrelid = 'public.student_academic_profiles'::regclass
  ) THEN
    ALTER TABLE public.student_academic_profiles
      ADD CONSTRAINT student_academic_profiles_medium_of_instruction_fkey
      FOREIGN KEY (medium_of_instruction) REFERENCES public.academic_languages(id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pre-evolution indexes (legacy names — distinct from idx_sap_* added later
-- by the evolution migration)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_student_academic_profiles_auth_user
  ON public.student_academic_profiles (auth_user_id);

CREATE INDEX IF NOT EXISTS idx_student_academic_profiles_board
  ON public.student_academic_profiles (board_id);

CREATE INDEX IF NOT EXISTS idx_student_academic_profiles_stream
  ON public.student_academic_profiles (stream_id);

GRANT ALL ON TABLE public.student_academic_profiles TO anon;
GRANT ALL ON TABLE public.student_academic_profiles TO authenticated;
GRANT ALL ON TABLE public.student_academic_profiles TO service_role;


-- =============================================================================
-- TABLE 2: student_subject_selections
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.student_subject_selections (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_profile_id  UUID        NOT NULL,
  subject_id          UUID        NOT NULL,
  is_primary          BOOLEAN     NOT NULL DEFAULT FALSE,
  is_elective         BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.student_subject_selections IS
  'RECONSTRUCTED base table (WP-DB-01B). Child of student_academic_profiles: '
  'one row per subject a student has selected. Evolved by 20260527000003 to '
  'add denormalized user_id / subject_code / sort_order columns.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_subject_selections_student_profile_id_fkey'
      AND conrelid = 'public.student_subject_selections'::regclass
  ) THEN
    ALTER TABLE public.student_subject_selections
      ADD CONSTRAINT student_subject_selections_student_profile_id_fkey
      FOREIGN KEY (student_profile_id)
      REFERENCES public.student_academic_profiles(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_subject_selections_subject_id_fkey'
      AND conrelid = 'public.student_subject_selections'::regclass
  ) THEN
    ALTER TABLE public.student_subject_selections
      ADD CONSTRAINT student_subject_selections_subject_id_fkey
      FOREIGN KEY (subject_id) REFERENCES public.academic_subjects(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_student_subject_selections_profile
  ON public.student_subject_selections (student_profile_id);

CREATE INDEX IF NOT EXISTS idx_student_subject_selections_subject
  ON public.student_subject_selections (subject_id);

GRANT ALL ON TABLE public.student_subject_selections TO anon;
GRANT ALL ON TABLE public.student_subject_selections TO authenticated;
GRANT ALL ON TABLE public.student_subject_selections TO service_role;


-- =============================================================================
-- TABLE 3: student_language_preferences
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.student_language_preferences (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_profile_id  UUID        NOT NULL,
  language_id         UUID        NOT NULL,
  proficiency_level   TEXT        NOT NULL,
  is_primary          BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT student_language_preferences_proficiency_level_check
    CHECK (proficiency_level IN ('basic', 'intermediate', 'advanced', 'native'))
);

COMMENT ON TABLE public.student_language_preferences IS
  'RECONSTRUCTED base table (WP-DB-01B). Child of student_academic_profiles: '
  'one row per language a student has selected. Evolved by 20260527000003 to '
  'add denormalized user_id / language_code / sort_order columns.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_language_preferences_student_profile_id_fkey'
      AND conrelid = 'public.student_language_preferences'::regclass
  ) THEN
    ALTER TABLE public.student_language_preferences
      ADD CONSTRAINT student_language_preferences_student_profile_id_fkey
      FOREIGN KEY (student_profile_id)
      REFERENCES public.student_academic_profiles(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_language_preferences_language_id_fkey'
      AND conrelid = 'public.student_language_preferences'::regclass
  ) THEN
    ALTER TABLE public.student_language_preferences
      ADD CONSTRAINT student_language_preferences_language_id_fkey
      FOREIGN KEY (language_id) REFERENCES public.academic_languages(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_student_language_preferences_profile
  ON public.student_language_preferences (student_profile_id);

GRANT ALL ON TABLE public.student_language_preferences TO anon;
GRANT ALL ON TABLE public.student_language_preferences TO authenticated;
GRANT ALL ON TABLE public.student_language_preferences TO service_role;

COMMIT;
