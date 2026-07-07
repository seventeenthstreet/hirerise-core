-- =============================================================================
-- Phase 4B Governance Hardening — Persistence Additions
-- Migration: add-phase4b-governance-observability
--
-- Tables introduced:
--   ai_validation_provenance_log     — phrase match provenance records
--   ai_prompt_validation_log         — prompt registry validation outcomes
--   ai_validation_metrics_snapshot   — periodic suppression metric snapshots
--
-- GOVERNANCE CONSTRAINTS:
--   ✅ Append-only — no UPDATE, no DELETE (use INSERT only)
--   ✅ Immutable records — enforced via trigger on each table
--   ✅ Privacy-safe — no raw AI output, no prompt text, no user PII
--   ✅ Governance-safe indexing — indexed on governance dimensions only
-- =============================================================================

-- =============================================================================
-- TABLE 1: ai_validation_provenance_log
--
-- Purpose: append-only log of phrase match provenance events.
-- One record per validator rule trigger (suppression event).
--
-- Privacy guarantees:
--   - matched_phrase: stores the matched vocabulary token only (e.g. "guaranteed")
--     Never stores the surrounding AI narrative text.
--   - No user_id, no resume_id, no identifiable payload.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_validation_provenance_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_type      TEXT        NOT NULL,           -- e.g. 'prohibited_phrase', 'cross_tier_escalation'
  matched_phrase      TEXT        NOT NULL DEFAULT '', -- matched vocabulary token only
  detected_tier       TEXT        NOT NULL,           -- tier detected in AI output
  expected_tier       TEXT        NOT NULL,           -- tier the engine required
  validator_stage     TEXT        NOT NULL,           -- e.g. 'confidence_alignment'
  capability          TEXT        NOT NULL,           -- e.g. 'recommendation_narrative'
  prompt_version      TEXT        NOT NULL,           -- e.g. '1.0.0'
  registry_version    TEXT        NOT NULL,           -- from REGISTRY_VERSION
  logged_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Governance: reject any cross-tier event where tiers are identical
  CONSTRAINT chk_cross_tier_has_different_tiers CHECK (
    violation_type != 'cross_tier_escalation' OR detected_tier != expected_tier
  )
);

-- Governance-safe indexes (dimension-based, not user/content-based)
CREATE INDEX IF NOT EXISTS idx_provenance_violation_type
  ON ai_validation_provenance_log (violation_type);

CREATE INDEX IF NOT EXISTS idx_provenance_capability
  ON ai_validation_provenance_log (capability);

CREATE INDEX IF NOT EXISTS idx_provenance_expected_tier
  ON ai_validation_provenance_log (expected_tier);

CREATE INDEX IF NOT EXISTS idx_provenance_logged_at
  ON ai_validation_provenance_log (logged_at DESC);

-- Immutability trigger: prevent UPDATE and DELETE on this table
CREATE OR REPLACE FUNCTION enforce_provenance_immutability()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_validation_provenance_log is append-only. UPDATE and DELETE are prohibited.';
END;
$$;

CREATE TRIGGER trg_provenance_no_update
  BEFORE UPDATE ON ai_validation_provenance_log
  FOR EACH ROW EXECUTE FUNCTION enforce_provenance_immutability();

CREATE TRIGGER trg_provenance_no_delete
  BEFORE DELETE ON ai_validation_provenance_log
  FOR EACH ROW EXECUTE FUNCTION enforce_provenance_immutability();


-- =============================================================================
-- TABLE 2: ai_prompt_validation_log
--
-- Purpose: append-only log of prompt registry validation outcomes.
-- Used for pre-deployment governance gate auditing.
--
-- Privacy guarantees:
--   - prompt_text is explicitly NOT stored — only structural metadata.
--   - forbidden_labels is an array of pattern label strings (not matched text).
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_prompt_validation_log (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id             TEXT        NOT NULL,           -- stable prompt registry ID
  prompt_version        TEXT        NOT NULL,           -- semver
  is_valid              BOOLEAN     NOT NULL,
  missing_instructions  TEXT[]      NOT NULL DEFAULT '{}', -- label array
  forbidden_labels      TEXT[]      NOT NULL DEFAULT '{}', -- pattern label array
  error_count           INTEGER     NOT NULL DEFAULT 0,
  registry_version      TEXT        NOT NULL,
  validation_context    TEXT        NOT NULL DEFAULT 'ci_deployment', -- 'ci_deployment' | 'runtime_check'
  validated_at          TIMESTAMPTZ NOT NULL DEFAULT now()

  -- NOTE: prompt_text is deliberately excluded — governance constraint.
);

-- Indexes for deployment audit queries
CREATE INDEX IF NOT EXISTS idx_prompt_validation_prompt_id
  ON ai_prompt_validation_log (prompt_id);

CREATE INDEX IF NOT EXISTS idx_prompt_validation_is_valid
  ON ai_prompt_validation_log (is_valid);

CREATE INDEX IF NOT EXISTS idx_prompt_validation_validated_at
  ON ai_prompt_validation_log (validated_at DESC);

-- Immutability triggers
CREATE OR REPLACE FUNCTION enforce_prompt_validation_immutability()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_prompt_validation_log is append-only. UPDATE and DELETE are prohibited.';
END;
$$;

CREATE TRIGGER trg_prompt_validation_no_update
  BEFORE UPDATE ON ai_prompt_validation_log
  FOR EACH ROW EXECUTE FUNCTION enforce_prompt_validation_immutability();

CREATE TRIGGER trg_prompt_validation_no_delete
  BEFORE DELETE ON ai_prompt_validation_log
  FOR EACH ROW EXECUTE FUNCTION enforce_prompt_validation_immutability();


-- =============================================================================
-- TABLE 3: ai_validation_metrics_snapshot
--
-- Purpose: periodic snapshots of the in-process suppression metrics store.
-- The application emits snapshots at configured intervals (e.g. every 5 min).
-- Raw counter values and computed rates are both stored for trend analysis.
--
-- Privacy guarantees:
--   - All keys are dimension strings (capability, tier, version) — never user data.
--   - No raw AI output, no narrative content.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_validation_metrics_snapshot (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Dimension identification
  capability       TEXT        NOT NULL,
  confidence_tier  TEXT        NOT NULL,
  prompt_version   TEXT        NOT NULL,
  validator_stage  TEXT        NOT NULL,
  failure_type     TEXT        NOT NULL,

  -- Raw counters (append-only snapshot values)
  total_attempts   INTEGER     NOT NULL DEFAULT 0,
  suppressed_count INTEGER     NOT NULL DEFAULT 0,
  fallback_count   INTEGER     NOT NULL DEFAULT 0,
  violation_count  INTEGER     NOT NULL DEFAULT 0,
  cross_tier_count INTEGER     NOT NULL DEFAULT 0,
  prohibited_count INTEGER     NOT NULL DEFAULT 0,

  -- Derived rates (computed at snapshot time)
  suppression_rate            NUMERIC(6,4) NOT NULL DEFAULT 0,
  fallback_rate               NUMERIC(6,4) NOT NULL DEFAULT 0,
  violation_rate              NUMERIC(6,4) NOT NULL DEFAULT 0,
  cross_tier_escalation_rate  NUMERIC(6,4) NOT NULL DEFAULT 0,
  prohibited_phrase_rate      NUMERIC(6,4) NOT NULL DEFAULT 0,

  -- Metadata
  registry_version TEXT        NOT NULL,
  snapshot_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Governance-safe indexes for trend dashboards
CREATE INDEX IF NOT EXISTS idx_metrics_snapshot_capability
  ON ai_validation_metrics_snapshot (capability);

CREATE INDEX IF NOT EXISTS idx_metrics_snapshot_confidence_tier
  ON ai_validation_metrics_snapshot (confidence_tier);

CREATE INDEX IF NOT EXISTS idx_metrics_snapshot_at
  ON ai_validation_metrics_snapshot (snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_metrics_snapshot_suppression
  ON ai_validation_metrics_snapshot (suppression_rate DESC);

-- Immutability triggers
CREATE OR REPLACE FUNCTION enforce_metrics_snapshot_immutability()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_validation_metrics_snapshot is append-only. UPDATE and DELETE are prohibited.';
END;
$$;

CREATE TRIGGER trg_metrics_snapshot_no_update
  BEFORE UPDATE ON ai_validation_metrics_snapshot
  FOR EACH ROW EXECUTE FUNCTION enforce_metrics_snapshot_immutability();

CREATE TRIGGER trg_metrics_snapshot_no_delete
  BEFORE DELETE ON ai_validation_metrics_snapshot
  FOR EACH ROW EXECUTE FUNCTION enforce_metrics_snapshot_immutability();


-- =============================================================================
-- GOVERNANCE VIEWS (read-only analytics — no mutation possible)
-- =============================================================================

-- Cross-tier escalation rate by capability (last 24h)
CREATE OR REPLACE VIEW v_cross_tier_escalation_by_capability AS
SELECT
  capability,
  confidence_tier AS expected_tier,
  SUM(cross_tier_count)                                          AS total_cross_tier_events,
  ROUND(AVG(cross_tier_escalation_rate)::NUMERIC, 4)            AS avg_escalation_rate,
  MAX(snapshot_at)                                               AS last_snapshot_at
FROM ai_validation_metrics_snapshot
WHERE snapshot_at >= NOW() - INTERVAL '24 hours'
GROUP BY capability, confidence_tier
ORDER BY avg_escalation_rate DESC;

-- Suppression rate trend by capability (hourly buckets, last 48h)
CREATE OR REPLACE VIEW v_suppression_rate_trend AS
SELECT
  DATE_TRUNC('hour', snapshot_at)                AS hour_bucket,
  capability,
  ROUND(AVG(suppression_rate)::NUMERIC, 4)       AS avg_suppression_rate,
  SUM(suppressed_count)                          AS total_suppressed,
  SUM(total_attempts)                            AS total_attempts
FROM ai_validation_metrics_snapshot
WHERE snapshot_at >= NOW() - INTERVAL '48 hours'
GROUP BY DATE_TRUNC('hour', snapshot_at), capability
ORDER BY hour_bucket DESC, capability;

-- Prompt validation failure summary
CREATE OR REPLACE VIEW v_prompt_validation_failures AS
SELECT
  prompt_id,
  prompt_version,
  validation_context,
  COUNT(*)                                       AS total_validations,
  SUM(CASE WHEN NOT is_valid THEN 1 ELSE 0 END) AS failure_count,
  ROUND(
    (SUM(CASE WHEN NOT is_valid THEN 1 ELSE 0 END)::NUMERIC / COUNT(*)) * 100,
    2
  )                                              AS failure_rate_pct,
  MAX(validated_at)                              AS last_validated_at
FROM ai_prompt_validation_log
GROUP BY prompt_id, prompt_version, validation_context
ORDER BY failure_rate_pct DESC;
