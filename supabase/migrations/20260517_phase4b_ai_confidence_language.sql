-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Phase 4B — AI Confidence Language Governance Tables
-- File: migrations/20260517_phase4b_ai_confidence_language.sql
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS CREATES:
--   1. ai_explanation_snapshots     — append-only AI narrative persistence
--   2. ai_confidence_language_log   — governance audit log for validation events
--   3. ai_intelligence_snapshots    — governed view over deterministic tables
--      (AI routes consume this view only — never raw assessment tables)
--
-- GOVERNANCE RULES:
--   - ai_explanation_snapshots is APPEND-ONLY (enforced via RLS + trigger)
--   - No UPDATE or DELETE permitted on AI narrative tables
--   - AI may NOT write to: assessments, score_results, recommendations,
--     capability_clusters, or any deterministic intelligence table
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE 1: ai_explanation_snapshots
-- Persists validated AI narrative explanations.
-- Append-only. Never mutated post-insert.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_explanation_snapshots (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id     UUID        NOT NULL,
  user_id           UUID        NOT NULL,
  snapshot_version  TEXT        NOT NULL,
  prompt_id         TEXT        NOT NULL,
  prompt_version    TEXT        NOT NULL,
  model_version     TEXT        NOT NULL,
  capability        TEXT        NOT NULL,
  narrative         TEXT        NOT NULL,
  tier              TEXT        NOT NULL   CHECK (tier IN ('HIGH', 'MEDIUM', 'LOW', 'NO_DATA')),
  is_fallback       BOOLEAN     NOT NULL DEFAULT false,
  validated         BOOLEAN     NOT NULL DEFAULT true,
  registry_version  TEXT        NOT NULL,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  -- NOTE: No updated_at — this table is append-only by design
);

COMMENT ON TABLE public.ai_explanation_snapshots IS
  'Phase 4B — Append-only AI narrative explanation persistence. '
  'AI output only. Never contains deterministic scores or rankings.';

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_ai_explanation_snapshots_assessment
  ON public.ai_explanation_snapshots (assessment_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_explanation_snapshots_user
  ON public.ai_explanation_snapshots (user_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_explanation_snapshots_capability
  ON public.ai_explanation_snapshots (capability, tier);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.ai_explanation_snapshots ENABLE ROW LEVEL SECURITY;

-- Users can only read their own explanation snapshots
CREATE POLICY "ai_explanation_snapshots_select_own"
  ON public.ai_explanation_snapshots
  FOR SELECT
  USING (user_id = auth.uid());

-- Service role (backend) may insert
CREATE POLICY "ai_explanation_snapshots_insert_service"
  ON public.ai_explanation_snapshots
  FOR INSERT
  WITH CHECK (true);

-- NO UPDATE policy — append-only enforced
-- NO DELETE policy — immutability enforced

-- ── Append-only trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.prevent_ai_snapshot_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'ai_explanation_snapshots is append-only. UPDATE and DELETE are prohibited. '
    'This table is governed under HireRise Phase 4B AI Governance Policy.';
END;
$$;

CREATE TRIGGER trg_ai_explanation_snapshots_immutable
  BEFORE UPDATE OR DELETE ON public.ai_explanation_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ai_snapshot_mutation();


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE 2: ai_confidence_language_log
-- Governance audit log for confidence language validation events.
-- Used by observability dashboard for rejection rate tracking.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_confidence_language_log (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name        TEXT        NOT NULL,  -- TELEMETRY_EVENTS values
  capability        TEXT        NOT NULL,
  tier              TEXT        NOT NULL   CHECK (tier IN ('HIGH', 'MEDIUM', 'LOW', 'NO_DATA')),
  prompt_id         TEXT,
  prompt_version    TEXT,
  violation_code    TEXT,                  -- REJECTION_CODES value, if applicable
  is_fallback       BOOLEAN     NOT NULL DEFAULT false,
  fallback_reason   TEXT,
  registry_version  TEXT        NOT NULL,
  emitted_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  -- NOTE: No user_id — privacy-safe. No raw AI output — never persisted.
);

COMMENT ON TABLE public.ai_confidence_language_log IS
  'Phase 4B — Governance audit log for AI confidence language validation. '
  'Privacy-safe: no user_id, no raw AI output, no PII.';

CREATE INDEX IF NOT EXISTS idx_ai_cl_log_event
  ON public.ai_confidence_language_log (event_name, emitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_cl_log_violation
  ON public.ai_confidence_language_log (violation_code, tier, emitted_at DESC)
  WHERE violation_code IS NOT NULL;

-- Append-only
CREATE TRIGGER trg_ai_cl_log_immutable
  BEFORE UPDATE OR DELETE ON public.ai_confidence_language_log
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ai_snapshot_mutation();


-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW: ai_intelligence_snapshots — DEFERRED (WP-DB-01A.8/9 reconciliation)
--
-- This view originally read `FROM public.assessments a`. Investigation
-- (WP-DB-01A.8) confirmed public.assessments does not exist anywhere in this
-- repository, was never renamed, and has no canonical replacement:
--   - docs/tables_inventory.csv (271 tables, all migrations) has no entry
--     for `assessments`.
--   - No other migration, function, or view references it.
--   - The columns the view selects (domain_scores, capability_clusters,
--     confidence_level, confidence_score, signal_count,
--     covered_domain_count, weighted_reliability, explanation_summary,
--     recommendation_metadata, status) do not match resume_analyses,
--     chi_scores, or the Phase 4A tables created just above
--     (signal_coverage_profiles, signal_reliability_scores,
--     cluster_stability_profiles, cluster_drift_history) — those only carry
--     a loose `assessment_id TEXT` session identifier, not a consolidated
--     source table with this shape.
--   - The migration itself contains template scaffolding language
--     ("Replace table references with your actual deterministic table
--     names."), confirming it was never adapted from reference/template
--     code to this schema.
--   - Nothing downstream in the migration chain depends on this view.
--
-- Per the minimum-change principle, this CREATE VIEW is commented out rather
-- than rewritten against a guessed join or backed by an invented placeholder
-- table — either would fabricate business logic (which table constitutes
-- "an assessment", how confidence/coverage/reliability combine) that no
-- source of truth in this repository specifies. The two real tables above
-- (ai_explanation_snapshots, ai_confidence_language_log) are unaffected and
-- still created normally. Re-enabling this view is tracked as follow-up
-- work once the Phase 4B AI-governance data model is defined.
--
-- Original definition, preserved verbatim for history:
--
-- CREATE OR REPLACE VIEW public.ai_intelligence_snapshots AS
-- SELECT
--   a.id                                      AS assessment_id,
--   a.user_id,
--   a.engine_version                          AS snapshot_version,
--   a.domain_scores                           AS domain_scores,
--   a.capability_clusters                     AS capability_clusters,
--   jsonb_build_object(
--     'tier',     a.confidence_level,
--     'composite', a.confidence_score
--   )                                         AS confidence,
--   jsonb_build_object(
--     'signalCount',    a.signal_count,
--     'coveredDomains', a.covered_domain_count
--   )                                         AS coverage,
--   jsonb_build_object(
--     'weightedReliability', a.weighted_reliability
--   )                                         AS reliability,
--   jsonb_build_object(
--     'summary', a.explanation_summary
--   )                                         AS explanations,
--   a.recommendation_metadata                 AS recommendation_metadata
-- FROM public.assessments a
-- WHERE
--   a.status = 'completed'
--   AND a.confidence_level IS NOT NULL;
--
-- COMMENT ON VIEW public.ai_intelligence_snapshots IS
--   'Phase 4B — AI-safe view of deterministic intelligence outputs. '
--   'Excludes: raw scores, PII (name/email), factor breakdowns, salary data. '
--   'AI routes MUST use this view. Direct assessment table access is prohibited.';
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- GRANT — service role access only
-- Application users have no direct table access
-- (GRANT on ai_intelligence_snapshots removed: the view above is deferred,
-- so the object does not exist to grant on.)
-- ─────────────────────────────────────────────────────────────────────────────

GRANT INSERT ON public.ai_explanation_snapshots  TO service_role;
GRANT INSERT ON public.ai_confidence_language_log TO service_role;
