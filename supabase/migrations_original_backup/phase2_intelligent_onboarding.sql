-- ============================================================
-- Phase 2: Intelligent Onboarding — Supabase Migration
-- 
-- Adds confidence, quality, and parser_version columns to the
-- onboarding_progress table.
--
-- SAFE TO RUN MULTIPLE TIMES: all statements use IF NOT EXISTS
-- or ADD COLUMN IF NOT EXISTS guards.
--
-- Apply via Supabase dashboard → SQL editor, or Supabase CLI:
--   supabase db push
-- ============================================================

-- ── 1. onboarding_progress: add Phase 2 intelligence columns ─────────────────

ALTER TABLE onboarding_progress
  ADD COLUMN IF NOT EXISTS confidence     JSONB    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS quality        JSONB    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS parser_version TEXT     DEFAULT NULL;

COMMENT ON COLUMN onboarding_progress.confidence IS
  'Phase 2: Field-level and overall confidence scores from confidence.service.js. '
  'Shape: { overall: number, level: text, fields: { name, email, phone, skills, experience, education } }';

COMMENT ON COLUMN onboarding_progress.quality IS
  'Phase 2: Resume quality / completeness scoring from quality.service.js. '
  'Shape: { completenessScore: number, missingFields: text[], suggestions: text[] }';

COMMENT ON COLUMN onboarding_progress.parser_version IS
  'Phase 2: Semantic version of the parser that produced this row (e.g. "2.0.0"). '
  'Used for future schema migrations and re-parsing decisions.';

-- ── 2. Indexes for analytics queries ──────────────────────────────────────────
-- Allow filtering/sorting by overall confidence level and completeness score.

CREATE INDEX IF NOT EXISTS idx_onboarding_progress_confidence_level
  ON onboarding_progress ((confidence->>'level'))
  WHERE confidence IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_onboarding_progress_quality_score
  ON onboarding_progress (((quality->>'completenessScore')::numeric))
  WHERE quality IS NOT NULL;

-- ── 3. resumes table: mirror Phase 2 fields for CV-generation path ────────────
-- The resumes table stores the final generated CV.
-- We mirror parser_version so we can track which parser produced each resume.

ALTER TABLE resumes
  ADD COLUMN IF NOT EXISTS confidence     JSONB    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS quality        JSONB    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS parser_version TEXT     DEFAULT NULL;

COMMENT ON COLUMN resumes.confidence IS
  'Phase 2: Confidence scores at the time the resume was saved.';

COMMENT ON COLUMN resumes.quality IS
  'Phase 2: Quality scores at the time the resume was saved.';

COMMENT ON COLUMN resumes.parser_version IS
  'Phase 2: Parser version that produced this resume.';
