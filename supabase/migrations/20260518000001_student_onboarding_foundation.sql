-- ─────────────────────────────────────────────────────────────────────────────
-- migration: 20260518000001_student_onboarding_foundation.sql
--
-- Phase 1 — Student Onboarding Backend Foundation
-- Creates: student_onboarding_sessions, student_education_profiles
-- Includes: constraints, indexes, triggers, RLS policies
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- student_onboarding_sessions
-- One row per user. Tracks step progression through the onboarding flow.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_onboarding_sessions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  current_step     TEXT        NOT NULL DEFAULT 'education',
  completed_steps  TEXT[]      NOT NULL DEFAULT '{}',
  is_complete      BOOLEAN     NOT NULL DEFAULT FALSE,
  engine_version   TEXT        NOT NULL DEFAULT '1.0.0',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT student_onboarding_sessions_user_id_key
    UNIQUE (user_id),

  CONSTRAINT student_onboarding_sessions_current_step_check
    CHECK (current_step IN (
      'education', 'academics', 'activities',
      'cognitive', 'aspiration', 'processing', 'result'
    ))
);

COMMENT ON TABLE student_onboarding_sessions IS
  'Tracks per-user progress through the student onboarding multi-step flow. One row per user, upsert-safe.';

COMMENT ON COLUMN student_onboarding_sessions.current_step IS
  'The step the user should see next. Updated by each step submission.';

COMMENT ON COLUMN student_onboarding_sessions.completed_steps IS
  'Ordered array of completed step identifiers. Never shrinks — steps are only added.';

COMMENT ON COLUMN student_onboarding_sessions.engine_version IS
  'Version of the intelligence engine used at time of onboarding. Used for future migration targeting.';

-- ─────────────────────────────────────────────────────────────────────────────
-- student_education_profiles
-- One row per user. Stores class level, board type, and school type.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_education_profiles (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  education_level   TEXT        NOT NULL,
  board_type        TEXT,
  school_type       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT student_education_profiles_user_id_key
    UNIQUE (user_id),

  CONSTRAINT student_education_profiles_education_level_check
    CHECK (education_level IN (
      'class_8', 'class_9', 'class_10', 'class_11', 'class_12'
    )),

  CONSTRAINT student_education_profiles_board_type_check
    CHECK (board_type IS NULL OR board_type IN (
      'cbse', 'icse', 'state', 'ib', 'other'
    )),

  CONSTRAINT student_education_profiles_school_type_check
    CHECK (school_type IS NULL OR school_type IN (
      'government', 'private', 'aided'
    ))
);

COMMENT ON TABLE student_education_profiles IS
  'Stores the student education level, board type and school type captured in onboarding Step 2.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_sos_user_id
  ON student_onboarding_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_sos_user_step
  ON student_onboarding_sessions (user_id, current_step);

CREATE INDEX IF NOT EXISTS idx_sep_user_id
  ON student_education_profiles (user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at auto-bump trigger
-- Reuses function name pattern from existing HireRise migrations.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sos_updated_at ON student_onboarding_sessions;
CREATE TRIGGER trg_sos_updated_at
  BEFORE UPDATE ON student_onboarding_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_sep_updated_at ON student_education_profiles;
CREATE TRIGGER trg_sep_updated_at
  BEFORE UPDATE ON student_education_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security — student_onboarding_sessions
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE student_onboarding_sessions ENABLE ROW LEVEL SECURITY;

-- Users may only read their own session
CREATE POLICY "sos_select_own"
  ON student_onboarding_sessions
  FOR SELECT
  USING (user_id = auth.uid());

-- Users may only create their own session
CREATE POLICY "sos_insert_own"
  ON student_onboarding_sessions
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users may only update their own session
CREATE POLICY "sos_update_own"
  ON student_onboarding_sessions
  FOR UPDATE
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security — student_education_profiles
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE student_education_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sep_select_own"
  ON student_education_profiles
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "sep_insert_own"
  ON student_education_profiles
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "sep_update_own"
  ON student_education_profiles
  FOR UPDATE
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMIT;
