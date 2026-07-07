-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260522000001_student_academic_records.sql
-- Phase 3A — Academic Signal Collection
--
-- DESIGN PRINCIPLES:
--   • Normalized — one row per student per academic year (student_academic_records)
--                  one row per subject result (student_academic_subjects)
--   • Future-compatible — supports velocity analysis, trend engines, affinity scoring
--   • Privacy-preserving — no marks in snapshot payloads (enforced at app layer)
--   • Partial-save-safe — no NOT NULL on subject-level fields
--   • Idempotent — all DDL is safe to re-run
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: academic year
-- Mirrors: ACADEMIC_YEARS constant in backend constants/academics.js
-- Mirrors: AcademicYear type in frontend academic.types.ts
-- CONTRACT: Never remove values. Deprecate with a comment if a class is retired.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE academic_year_enum AS ENUM (
    'class_8',
    'class_9',
    'class_10',
    'class_11',
    'class_12'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: academic subject
-- Mirrors: ACADEMIC_SUBJECTS constant in backend constants/academics.js
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE academic_subject_enum AS ENUM (
    'mathematics',
    'physics',
    'chemistry',
    'biology',
    'computer_science',
    'english',
    'social_science',
    'economics',
    'commerce',
    'accountancy',
    'business_studies',
    'history',
    'geography',
    'political_science',
    'language_optional'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: board type (reuses existing domain concept — kept local for portability)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE academic_board_type_enum AS ENUM (
    'cbse',
    'icse',
    'state',
    'ib',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: grade — standard letter grades, normalized across boards
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE academic_grade_enum AS ENUM (
    'A_plus',   -- 90–100
    'A',        -- 80–89
    'B_plus',   -- 70–79
    'B',        -- 60–69
    'C',        -- 50–59
    'D',        -- 40–49
    'F'         -- <40
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: source type — distinguishes how the data was collected
--   manual    → student typed it in
--   ocr       → future: auto-parsed from marksheet image
--   imported  → future: imported from external service
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE academic_source_type_enum AS ENUM (
    'manual',
    'ocr',
    'imported'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: student_academic_records
-- One row per student per academic year.
-- This is the "header" row — board info, year, completion state.
-- Subject-level data lives in student_academic_subjects.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_academic_records (
  id                UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID              NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Academic year this record covers
  academic_year     academic_year_enum NOT NULL,

  -- Board the student was enrolled under for this year
  -- May differ from student_education_profiles.board_type if the student transferred
  board_type        academic_board_type_enum NOT NULL DEFAULT 'cbse',

  -- Whether this year's record is partially or fully complete
  -- is_partial = true → saved as draft, does not count toward signal quality
  -- is_partial = false → committed, counts toward signal quality
  is_partial        BOOLEAN           NOT NULL DEFAULT TRUE,

  -- Whether this year's marks are predicted (e.g. Class 12, awaiting results)
  is_predicted      BOOLEAN           NOT NULL DEFAULT FALSE,

  -- Completion metadata
  subject_count     INTEGER           NOT NULL DEFAULT 0 CHECK (subject_count >= 0),
  completed_at      TIMESTAMPTZ       NULL,  -- NULL until is_partial = false

  -- Audit timestamps
  created_at        TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ       NOT NULL DEFAULT NOW(),

  -- Uniqueness: one record per student per academic year
  CONSTRAINT uq_academic_record_user_year UNIQUE (user_id, academic_year)
);

-- Trigger: keep updated_at in sync
CREATE OR REPLACE FUNCTION update_academic_records_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_academic_records_updated_at ON student_academic_records;
CREATE TRIGGER trg_academic_records_updated_at
  BEFORE UPDATE ON student_academic_records
  FOR EACH ROW EXECUTE FUNCTION update_academic_records_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: student_academic_subjects
-- One row per subject result, per academic year.
-- Never store subject results as JSON — normalization enables future analytics.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_academic_subjects (
  id                  UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id           UUID                   NOT NULL
                        REFERENCES student_academic_records(id) ON DELETE CASCADE,
  user_id             UUID                   NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  academic_year       academic_year_enum     NOT NULL,

  -- Subject identification
  subject             academic_subject_enum  NOT NULL,

  -- Marks — nullable to support partial saves
  marks_obtained      NUMERIC(6, 2)          NULL CHECK (marks_obtained IS NULL OR marks_obtained >= 0),
  max_marks           NUMERIC(6, 2)          NULL CHECK (max_marks IS NULL OR max_marks > 0),

  -- Grade — normalized letter grade
  grade               academic_grade_enum    NULL,

  -- Computed percentage — stored for analytics performance
  -- NULL when marks_obtained or max_marks is NULL
  percentage          NUMERIC(5, 2)          NULL
                        CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100)),

  -- How was this data entered?
  source_type         academic_source_type_enum NOT NULL DEFAULT 'manual',

  -- Whether marks are predicted vs actual
  is_predicted        BOOLEAN                NOT NULL DEFAULT FALSE,

  -- Audit timestamps
  created_at          TIMESTAMPTZ            NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ            NOT NULL DEFAULT NOW(),

  -- Uniqueness: one row per subject per year per user
  CONSTRAINT uq_academic_subject_user_year_subject
    UNIQUE (user_id, academic_year, subject)
);

-- Trigger: keep updated_at in sync
CREATE OR REPLACE FUNCTION update_academic_subjects_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_academic_subjects_updated_at ON student_academic_subjects;
CREATE TRIGGER trg_academic_subjects_updated_at
  BEFORE UPDATE ON student_academic_subjects
  FOR EACH ROW EXECUTE FUNCTION update_academic_subjects_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- Designed for query patterns used in analytics and onboarding flows
-- ─────────────────────────────────────────────────────────────────────────────

-- student_academic_records
CREATE INDEX IF NOT EXISTS idx_academic_records_user_id
  ON student_academic_records (user_id);

CREATE INDEX IF NOT EXISTS idx_academic_records_user_year
  ON student_academic_records (user_id, academic_year);

CREATE INDEX IF NOT EXISTS idx_academic_records_partial
  ON student_academic_records (user_id, is_partial);

-- student_academic_subjects
CREATE INDEX IF NOT EXISTS idx_academic_subjects_record_id
  ON student_academic_subjects (record_id);

CREATE INDEX IF NOT EXISTS idx_academic_subjects_user_id
  ON student_academic_subjects (user_id);

CREATE INDEX IF NOT EXISTS idx_academic_subjects_user_year
  ON student_academic_subjects (user_id, academic_year);

CREATE INDEX IF NOT EXISTS idx_academic_subjects_subject
  ON student_academic_subjects (subject);

-- Future velocity analysis: subject trend across years
CREATE INDEX IF NOT EXISTS idx_academic_subjects_subject_year
  ON student_academic_subjects (subject, academic_year);

-- Future: stream affinity — filter by high-scoring subjects
CREATE INDEX IF NOT EXISTS idx_academic_subjects_percentage
  ON student_academic_subjects (user_id, percentage DESC NULLS LAST);
