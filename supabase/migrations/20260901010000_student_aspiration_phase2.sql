-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260901010000_student_aspiration_phase2.sql
-- Phase 2 — Aspiration Persistence (Student MVP, Option C)
--
-- Persists the three aspiration fields already collected by
-- front/src/modules/student-onboarding/steps/aspiration-step.tsx and
-- previously discarded on submit:
--   careerInterests   → career_interests   (required, non-empty)
--   motivationDriver  → motivation_driver  (optional)
--   timeHorizon       → time_horizon       (optional)
--
-- DESIGN PRINCIPLES (matching student_cognitive_phase3c / student_activities_phase3b):
--   • One row per student — upserted on save, not appended.
--   • RLS-compatible          — user_id gated, self-only.
--   • Audit-safe              — immutable created_at, auto-updated updated_at.
--   • Idempotent               — all DDL uses IF NOT EXISTS / DO $$ BEGIN.
--   • Enum values mirror the frontend constants verbatim (aspiration-step.tsx
--     CAREER_DOMAINS / MOTIVATION_DRIVERS / TIME_HORIZONS) and the backend
--     constants/aspiration.js mirror of the same — never diverge from either
--     without updating all three in the same change.
--
-- SCOPE NOTE: this migration does not touch student_onboarding_sessions,
-- users, or any Admin/Education-Intelligence/Knowledge-Runtime table.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: career_domain_enum
-- Mirrors: CAREER_DOMAINS ids in aspiration-step.tsx / CAREER_DOMAINS in
-- constants/aspiration.js. Never remove values; deprecate with a comment.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE career_domain_enum AS ENUM (
    'medicine',
    'engineering',
    'law',
    'arts_design',
    'business',
    'science',
    'teaching',
    'social',
    'defence',
    'sports_fitness',
    'undecided'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: motivation_driver_enum
-- Mirrors: MOTIVATION_DRIVERS values in aspiration-step.tsx.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE motivation_driver_enum AS ENUM (
    'impact',
    'financial',
    'passion',
    'prestige',
    'autonomy'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: time_horizon_enum
-- Mirrors: TIME_HORIZONS values in aspiration-step.tsx.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE time_horizon_enum AS ENUM (
    'short',
    'medium',
    'long',
    'open'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: student_aspirations
-- One row per student. Upserted on (user_id) — later saves overwrite, they
-- do not append. motivation_driver / time_horizon are optional in the UI
-- (aspiration-step.tsx submits them as null when unselected); career_interests
-- is required and non-empty (enforced by both the API validator and the
-- CHECK constraint below, defense-in-depth).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_aspirations (
  id                 uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid                    NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  career_interests   career_domain_enum[]    NOT NULL DEFAULT '{}',
  motivation_driver  motivation_driver_enum,
  time_horizon       time_horizon_enum,
  created_at         timestamptz             NOT NULL DEFAULT now(),
  updated_at         timestamptz             NOT NULL DEFAULT now(),

  CONSTRAINT student_aspirations_career_interests_nonempty
    CHECK (array_length(career_interests, 1) > 0)
);

-- auto-update updated_at
CREATE OR REPLACE FUNCTION update_student_aspirations_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_student_aspirations_updated_at ON student_aspirations;
CREATE TRIGGER trg_student_aspirations_updated_at
  BEFORE UPDATE ON student_aspirations
  FOR EACH ROW EXECUTE FUNCTION update_student_aspirations_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

-- Redundant with the UNIQUE constraint's implicit index, but added explicitly
-- to match the established convention on student_cognitive_signals (which
-- also carries both a UNIQUE(user_id) and an explicit idx_..._user_id index).
CREATE INDEX IF NOT EXISTS idx_student_aspirations_user_id
  ON student_aspirations(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- No admin-override policy is added here — matching the established
-- convention on student_cognitive_responses / student_cognitive_signals /
-- student_activities, none of which carry an admin RLS policy either.
-- Admin/service-role access is a backend, application-layer concern
-- (service-role client bypasses RLS), not a client-facing RLS grant.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE student_aspirations ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- RLS POLICIES — self-only, matching cognitive_responses_own_* naming
-- =============================================================================

DROP POLICY IF EXISTS "student_aspirations_own_select" ON student_aspirations;

CREATE POLICY "student_aspirations_own_select"
ON student_aspirations
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "student_aspirations_own_insert" ON student_aspirations;

CREATE POLICY "student_aspirations_own_insert"
ON student_aspirations
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "student_aspirations_own_update" ON student_aspirations;

CREATE POLICY "student_aspirations_own_update"
ON student_aspirations
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- No DELETE policy — matching the established convention (students never
-- delete onboarding step data; a re-save is an upsert/overwrite instead).
