-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260905020000_phase1_recommendation_results_career_area_key.sql
-- Phase 1 — Recommendation Engine, Controlled Implementation Pass 1
-- Adds the additive `career_area_key` column (JS: careerAreaKey) required by
-- Section 10 of the Phase 1 spec.
--
-- DOES NOT modify or recreate:
--   20260905010000_phase0_student_recommendation_results_foundation.sql
-- (Phase 0 is frozen — this is a separate, additive migration file.)
--
-- WHY A NEW COLUMN, NOT A REPLACEMENT:
--   `top_domain_id` (existing, free-text/slug) remains the existing field
--   for the AI's top recommended domain id. `career_area_key` is additive —
--   a separate, governed classification of that recommendation against the
--   frozen 8-value Career Area vocabulary. Per spec §7, this migration does
--   not force ambiguous aspiration/output values into a Career Area: the
--   column is nullable, and application-layer validation
--   (recommendation-output.validator.js) is the only place that decides
--   whether a given AI output's careerAreaKey is accepted.
--
-- WHY AN FK TO cms_career_domains.canonical_key, NOT A NEW ENUM/CHECK:
--   cms_career_domains.canonical_key already is the governed, frozen
--   8-value Career Area vocabulary (see
--   20260904010000_phase3b6e3_career_area_governed_vocabulary.sql), with a
--   UNIQUE constraint on canonical_key. Referencing it directly means the
--   frozen vocabulary is enforced in exactly one place at the DB level —
--   this migration does not hardcode a second, competing list, and does
--   not touch Career Area governance itself (no change to
--   cms_career_domains, its CHECK constraint, or its seed data).
--
-- REVERSIBLE:
--   ALTER TABLE public.student_recommendation_results
--     DROP CONSTRAINT IF EXISTS student_recommendation_results_career_area_key_fkey;
--   ALTER TABLE public.student_recommendation_results
--     DROP COLUMN IF EXISTS career_area_key;
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE "public"."student_recommendation_results"
  ADD COLUMN IF NOT EXISTS "career_area_key" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'student_recommendation_results_career_area_key_fkey'
  ) THEN
    ALTER TABLE "public"."student_recommendation_results"
      ADD CONSTRAINT "student_recommendation_results_career_area_key_fkey"
      FOREIGN KEY ("career_area_key")
      REFERENCES "public"."cms_career_domains" ("canonical_key");
  END IF;
END $$;

COMMENT ON COLUMN "public"."student_recommendation_results"."career_area_key" IS
  'Phase 1 (JS: careerAreaKey). Nullable, additive classification of the '
  'Recommendation against the frozen 8-value governed Career Area '
  'vocabulary (cms_career_domains.canonical_key). Additive to, and '
  'independent of, top_domain_id (the existing free-text/slug top '
  'recommended domain). NULL when the AI output omits it or when the '
  'aspiration/output data is too ambiguous to map to one of the 8 '
  'governed values — never force-fit an ambiguous value here.';

COMMIT;
