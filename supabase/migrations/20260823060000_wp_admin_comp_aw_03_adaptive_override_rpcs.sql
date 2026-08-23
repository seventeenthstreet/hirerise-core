-- =============================================================================
-- WP-ADMIN-COMP-AW-03 — Adaptive Weight Manual Override RPC Foundation
-- =============================================================================
--
-- Implements the two RPCs required by the AW-02 specification and consumed
-- by the existing, unmodified adaptiveWeight.repository.js:
--
--   apply_adaptive_override(p_role_family, p_experience_bucket,
--                            p_industry_tag, p_skills, p_experience,
--                            p_education, p_projects) RETURNS jsonb
--
--   release_adaptive_override(p_role_family, p_experience_bucket,
--                              p_industry_tag) RETURNS jsonb
--
-- These follow the same pure-RPC, fetch-or-create architecture already
-- certified by get_adaptive_weights() / record_adaptive_outcome()
-- (000_initial_schema.sql) and reconciled by DB-FR-005B
-- (20260727084123_db_fr_005b_adaptive_weights_schema_reconciliation.sql).
--
-- This migration does NOT alter get_adaptive_weights() or
-- record_adaptive_outcome() — both remain certified and untouched — and
-- does not modify RLS policy or table-level grants beyond the two new
-- functions.
--
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- apply_adaptive_override()
-- -----------------------------------------------------------------------------
-- Fetch-or-create semantics consistent with record_adaptive_outcome():
--   1. If no row exists for (role_family, experience_bucket, industry_tag),
--      create it using the canonical/default weight state (same defaults
--      used by record_adaptive_outcome()'s INSERT branch).
--   2. Apply the supplied override, clamped to WEIGHT_BOUNDS [0.10, 0.60]
--      (same bounds enforced client-side by adaptiveWeight.validator.js and
--      server-side by record_adaptive_outcome()'s clamp step), then
--      normalized so skills + experience + education + projects = 1.0
--      (same normalize step as record_adaptive_outcome()).
--   3. Set manual_override = true and freeze_learning = true together.
--
-- Returns a jsonb shape consistent with the existing Adaptive Weight RPC
-- conventions (get_adaptive_weights()/record_adaptive_outcome() both
-- return a top-level "weights" object) and the controller contract
-- { weights, manualOverride: true }.

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
    RETURNING * INTO rec;
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

-- -----------------------------------------------------------------------------
-- release_adaptive_override()
-- -----------------------------------------------------------------------------
-- Locates the matching segment and clears manual_override / freeze_learning
-- together. If no row exists, this is treated as a safe no-op (consistent
-- with get_adaptive_weights()'s no-record handling, which also returns a
-- normal response rather than an error) — no new error code is introduced.

CREATE OR REPLACE FUNCTION "public"."release_adaptive_override"(
    "p_role_family" "text",
    "p_experience_bucket" "text",
    "p_industry_tag" "text"
) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  rec RECORD;
BEGIN
  SELECT *
  INTO rec
  FROM adaptive_weights
  WHERE role_family = p_role_family
    AND experience_bucket = p_experience_bucket
    AND industry_tag = p_industry_tag
  LIMIT 1;

  IF rec IS NULL THEN
    RETURN jsonb_build_object('released', false);
  END IF;

  UPDATE adaptive_weights
  SET
    manual_override = FALSE,
    freeze_learning = FALSE,
    updated_at = NOW()
  WHERE role_family = p_role_family
    AND experience_bucket = p_experience_bucket
    AND industry_tag = p_industry_tag;

  RETURN jsonb_build_object('released', true);
END;
$$;

ALTER FUNCTION "public"."release_adaptive_override"(
    "p_role_family" "text",
    "p_experience_bucket" "text",
    "p_industry_tag" "text"
) OWNER TO "postgres";

-- -----------------------------------------------------------------------------
-- Grants — matched to the established get_adaptive_weights() /
-- record_adaptive_outcome() grant pattern (000_initial_schema.sql). No
-- broader privilege is introduced and no RLS policy is modified.
-- -----------------------------------------------------------------------------

GRANT ALL ON FUNCTION "public"."apply_adaptive_override"(
    "p_role_family" "text",
    "p_experience_bucket" "text",
    "p_industry_tag" "text",
    "p_skills" numeric,
    "p_experience" numeric,
    "p_education" numeric,
    "p_projects" numeric
) TO "anon";
GRANT ALL ON FUNCTION "public"."apply_adaptive_override"(
    "p_role_family" "text",
    "p_experience_bucket" "text",
    "p_industry_tag" "text",
    "p_skills" numeric,
    "p_experience" numeric,
    "p_education" numeric,
    "p_projects" numeric
) TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_adaptive_override"(
    "p_role_family" "text",
    "p_experience_bucket" "text",
    "p_industry_tag" "text",
    "p_skills" numeric,
    "p_experience" numeric,
    "p_education" numeric,
    "p_projects" numeric
) TO "service_role";

GRANT ALL ON FUNCTION "public"."release_adaptive_override"(
    "p_role_family" "text",
    "p_experience_bucket" "text",
    "p_industry_tag" "text"
) TO "anon";
GRANT ALL ON FUNCTION "public"."release_adaptive_override"(
    "p_role_family" "text",
    "p_experience_bucket" "text",
    "p_industry_tag" "text"
) TO "authenticated";
GRANT ALL ON FUNCTION "public"."release_adaptive_override"(
    "p_role_family" "text",
    "p_experience_bucket" "text",
    "p_industry_tag" "text"
) TO "service_role";

COMMIT;

-- =============================================================================
-- POST-DEPLOYMENT VERIFICATION
-- =============================================================================
-- Schema-only checks. Does not mutate adaptive_weights data.

-- A. Both functions exist with the exact signatures the repository calls.
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('apply_adaptive_override', 'release_adaptive_override')
ORDER BY p.proname;
-- expect 2 rows matching adaptiveWeight.repository.js's rpc() calls exactly.

-- B. Certified RPCs remain unmodified by this migration (name/arg check
--    only — this migration contains no statement that alters either).
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('get_adaptive_weights', 'record_adaptive_outcome')
ORDER BY p.proname;
-- expect 2 rows, unchanged from 000_initial_schema.sql.
