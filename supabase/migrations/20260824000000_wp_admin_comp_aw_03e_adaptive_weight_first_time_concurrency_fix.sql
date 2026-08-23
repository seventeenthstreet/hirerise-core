-- =============================================================================
-- WP-ADMIN-COMP-AW-03E — Adaptive Weight First-Time Segment Concurrency
-- Corrective Implementation
-- =============================================================================
--
-- Implements the corrective design certified by AW-03D. Both
-- record_adaptive_outcome() and apply_adaptive_override() contained the same
-- unsafe first-time segment creation pattern:
--
--   SELECT -> IF NULL -> INSERT
--
-- A real two-session concurrency test reproduced the defect for both RPCs:
-- the losing concurrent caller received PostgreSQL 23505 from the canonical
-- unique constraint adaptive_weights_role_family_experience_bucket_industry_tag_key.
--
-- This migration replaces only the first-time INSERT branch of each RPC with
-- the AW-03D-approved concurrency-safe pattern:
--
--   INSERT ... ON CONFLICT (role_family, experience_bucket, industry_tag)
--   DO NOTHING
--   RETURNING *
--
-- followed by a canonical-key re-SELECT when the INSERT loses the race.
--
-- Everything else — freeze-learning gate, prediction-error/delta calculation,
-- clamp, normalization, EMA performance smoothing, confidence adjustment,
-- UPDATE behavior, override clamp/normalize/manual_override/freeze_learning
-- behavior, and both functions' return shapes — is unchanged.
--
-- NOTE on record_adaptive_outcome() parameter names: the AW-03E work order's
-- Section 5 stated an expected signature using p_outcome_score/p_confidence.
-- Pre-implementation audit against the frozen, certified definition in
-- 000_initial_schema.sql (unmodified by db_fr_005b, AW-03, and AW-03C, and
-- independently corroborated by supabase/tests/WP-ADMIN-COMP-AW-03C_role_id_
-- nullable_regression.sql) found the actual, authoritative parameter names to
-- be p_predicted_score and p_actual_outcome. That drift was confirmed to be a
-- transcription error in the work order (not an architectural change) and
-- explicit correction was authorized before this migration was written. This
-- migration uses the authoritative existing parameter names, unchanged.
--
-- Governance status: AW-03, AW-03C, the canonical Adaptive Weight identity
-- (role_family, experience_bucket, industry_tag), the canonical unique
-- constraint, both RPC signatures, RLS/security model, and application
-- caller architecture are treated as frozen and are not touched by this
-- migration. role_id is not used to solve concurrency.
--
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- record_adaptive_outcome() — corrective first-time segment creation only
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."record_adaptive_outcome"(
    "p_role_family" "text",
    "p_experience_bucket" "text",
    "p_industry_tag" "text",
    "p_predicted_score" numeric,
    "p_actual_outcome" numeric
) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  rec RECORD;

  -- Constants
  learning_rate NUMERIC := 0.02;
  smoothing NUMERIC := 0.10;

  -- Variables
  prediction NUMERIC;
  error NUMERIC;
  delta NUMERIC;

  new_skills NUMERIC;
  new_experience NUMERIC;
  new_education NUMERIC;
  new_projects NUMERIC;

  total NUMERIC;
  accuracy NUMERIC;

  new_performance NUMERIC;
  new_confidence NUMERIC;

BEGIN
  -- Fetch or create
  SELECT *
  INTO rec
  FROM adaptive_weights
  WHERE role_family = p_role_family
    AND experience_bucket = p_experience_bucket
    AND industry_tag = p_industry_tag
  LIMIT 1;

  IF rec IS NULL THEN
    -- Concurrency-safe first-time creation (AW-03D/AW-03E). If a concurrent
    -- caller wins the race for this canonical key, this INSERT yields no row
    -- instead of raising 23505; the re-SELECT below then fetches the
    -- winning caller's row.
    INSERT INTO adaptive_weights (
      role_family,
      experience_bucket,
      industry_tag,
      skills,
      experience,
      education,
      projects,
      performance_score,
      confidence_score
    )
    VALUES (
      p_role_family,
      p_experience_bucket,
      p_industry_tag,
      0.40, 0.25, 0.15, 0.20,
      0.50,
      0.50
    )
    ON CONFLICT (role_family, experience_bucket, industry_tag)
    DO NOTHING
    RETURNING * INTO rec;

    IF rec IS NULL THEN
      SELECT *
      INTO rec
      FROM adaptive_weights
      WHERE role_family = p_role_family
        AND experience_bucket = p_experience_bucket
        AND industry_tag = p_industry_tag
      LIMIT 1;
    END IF;
  END IF;

  -- Freeze learning
  IF rec.freeze_learning = TRUE THEN
    RETURN jsonb_build_object('updated', false);
  END IF;

  -- Prediction error
  prediction := p_predicted_score / 100;
  error := p_actual_outcome - prediction;
  delta := learning_rate * error;

  -- Apply delta + clamp
  new_skills     := LEAST(0.60, GREATEST(0.10, rec.skills + delta));
  new_experience := LEAST(0.60, GREATEST(0.10, rec.experience + delta));
  new_education  := LEAST(0.60, GREATEST(0.10, rec.education + delta));
  new_projects   := LEAST(0.60, GREATEST(0.10, rec.projects + delta));

  -- Normalize
  total := new_skills + new_experience + new_education + new_projects;

  new_skills     := new_skills / total;
  new_experience := new_experience / total;
  new_education  := new_education / total;
  new_projects   := new_projects / total;

  -- Accuracy + EMA
  accuracy := 1 - ABS(error);

  new_performance :=
    smoothing * accuracy +
    (1 - smoothing) * rec.performance_score;

  -- Confidence
  IF new_performance > 0.55 THEN
    new_confidence := rec.confidence_score + 0.02;
  ELSE
    new_confidence := rec.confidence_score - 0.03;
  END IF;

  new_confidence := LEAST(0.99, GREATEST(0.01, new_confidence));

  -- Update
  UPDATE adaptive_weights
  SET
    skills = new_skills,
    experience = new_experience,
    education = new_education,
    projects = new_projects,
    performance_score = new_performance,
    confidence_score = new_confidence,
    updated_at = NOW()
  WHERE role_family = p_role_family
    AND experience_bucket = p_experience_bucket
    AND industry_tag = p_industry_tag;

  RETURN jsonb_build_object(
    'updated', true,
    'weights', jsonb_build_object(
      'skills', new_skills,
      'experience', new_experience,
      'education', new_education,
      'projects', new_projects
    ),
    'performanceScore', new_performance,
    'confidenceScore', new_confidence
  );
END;
$$;

ALTER FUNCTION "public"."record_adaptive_outcome"(
    "p_role_family" "text",
    "p_experience_bucket" "text",
    "p_industry_tag" "text",
    "p_predicted_score" numeric,
    "p_actual_outcome" numeric
) OWNER TO "postgres";

-- -----------------------------------------------------------------------------
-- apply_adaptive_override() — corrective first-time segment creation only
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."apply_adaptive_override"(
    "p_role_family" "text",
    "p_experience_bucket" "text",
    "p_industry_tag" "text",
    "p_skills" numeric,
    "p_experience" numeric,
    "p_education" numeric,
    "p_projects" numeric
) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  rec RECORD;

  clamped_skills NUMERIC;
  clamped_experience NUMERIC;
  clamped_education NUMERIC;
  clamped_projects NUMERIC;

  total NUMERIC;

  norm_skills NUMERIC;
  norm_experience NUMERIC;
  norm_education NUMERIC;
  norm_projects NUMERIC;
BEGIN
  -- Fetch or create (same pattern as record_adaptive_outcome())
  SELECT *
  INTO rec
  FROM adaptive_weights
  WHERE role_family = p_role_family
    AND experience_bucket = p_experience_bucket
    AND industry_tag = p_industry_tag
  LIMIT 1;

  IF rec IS NULL THEN
    -- Concurrency-safe first-time creation (AW-03D/AW-03E).
    INSERT INTO adaptive_weights (
      role_family,
      experience_bucket,
      industry_tag,
      skills,
      experience,
      education,
      projects,
      performance_score,
      confidence_score
    )
    VALUES (
      p_role_family,
      p_experience_bucket,
      p_industry_tag,
      0.40, 0.25, 0.15, 0.20,
      0.50,
      0.50
    )
    ON CONFLICT (role_family, experience_bucket, industry_tag)
    DO NOTHING
    RETURNING * INTO rec;

    IF rec IS NULL THEN
      SELECT *
      INTO rec
      FROM adaptive_weights
      WHERE role_family = p_role_family
        AND experience_bucket = p_experience_bucket
        AND industry_tag = p_industry_tag
      LIMIT 1;
    END IF;
  END IF;

  -- Clamp the supplied override to the established weight bounds
  -- (defense in depth — the application validator already enforces this).
  clamped_skills     := LEAST(0.60, GREATEST(0.10, p_skills));
  clamped_experience := LEAST(0.60, GREATEST(0.10, p_experience));
  clamped_education  := LEAST(0.60, GREATEST(0.10, p_education));
  clamped_projects   := LEAST(0.60, GREATEST(0.10, p_projects));

  total := clamped_skills + clamped_experience + clamped_education + clamped_projects;

  -- Normalize so the four weights sum to 1.0 (same invariant enforced by
  -- record_adaptive_outcome()). Bounds guarantee total >= 0.40 for any
  -- finite numeric input, but guard defensively rather than assume.
  IF total IS NULL OR total <= 0 THEN
    norm_skills     := 0.40;
    norm_experience := 0.25;
    norm_education  := 0.15;
    norm_projects   := 0.20;
  ELSE
    norm_skills     := clamped_skills / total;
    norm_experience := clamped_experience / total;
    norm_education  := clamped_education / total;
    norm_projects   := clamped_projects / total;
  END IF;

  UPDATE adaptive_weights
  SET
    skills = norm_skills,
    experience = norm_experience,
    education = norm_education,
    projects = norm_projects,
    manual_override = TRUE,
    freeze_learning = TRUE,
    updated_at = NOW()
  WHERE role_family = p_role_family
    AND experience_bucket = p_experience_bucket
    AND industry_tag = p_industry_tag;

  RETURN jsonb_build_object(
    'weights', jsonb_build_object(
      'skills', norm_skills,
      'experience', norm_experience,
      'education', norm_education,
      'projects', norm_projects
    ),
    'manualOverride', true,
    'freezeLearning', true
  );
END;
$$;

ALTER FUNCTION "public"."apply_adaptive_override"(
    "p_role_family" "text",
    "p_experience_bucket" "text",
    "p_industry_tag" "text",
    "p_skills" numeric,
    "p_experience" numeric,
    "p_education" numeric,
    "p_projects" numeric
) OWNER TO "postgres";

COMMIT;

-- =============================================================================
-- POST-DEPLOYMENT VERIFICATION
-- =============================================================================
-- Schema-only / metadata checks. Does not mutate adaptive_weights data.

-- A. Signatures unchanged from AW-03 / AW-03C.
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('record_adaptive_outcome', 'apply_adaptive_override')
ORDER BY p.proname;
-- expect 2 rows, identical args/security mode to pre-AW-03E state.

-- B. Both function bodies contain the approved corrective pattern.
SELECT
  p.proname,
  pg_get_functiondef(p.oid) LIKE '%ON CONFLICT (role_family, experience_bucket, industry_tag)%DO NOTHING%RETURNING * INTO rec%' AS has_corrective_pattern
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('record_adaptive_outcome', 'apply_adaptive_override')
ORDER BY p.proname;
-- expect has_corrective_pattern = true for both rows.

-- C. Canonical unique constraint, RLS, and role_id nullability unchanged.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.adaptive_weights'::regclass
  AND conname = 'adaptive_weights_role_family_experience_bucket_industry_tag_key';

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'adaptive_weights';

SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'adaptive_weights'
  AND column_name = 'role_id';
