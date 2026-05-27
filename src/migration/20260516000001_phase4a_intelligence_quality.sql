-- ============================================================
-- Phase 4A: Signal Coverage & Cluster Stability Intelligence
-- Supabase Migration
--
-- Adds four new intelligence quality persistence tables:
--   1. signal_coverage_profiles
--   2. signal_reliability_scores
--   3. cluster_stability_profiles
--   4. cluster_drift_history
--
-- Design principles:
--   - Immutable scoring history (insert-only, never updated)
--   - Versionable (engine_version column on every table)
--   - Analytics-safe (no PII in aggregatable columns)
--   - Longitudinal compatible (user_id + scored_at ordering)
--   - Governance-safe (RLS enabled, created_at immutable)
--
-- SAFE TO RUN MULTIPLE TIMES: all DDL uses IF NOT EXISTS guards.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- TABLE 1: signal_coverage_profiles
-- One row per assessment evaluation.
-- Records the complete signal coverage result for a user session.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signal_coverage_profiles (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL,
  assessment_id         TEXT        NOT NULL,

  -- Core scoring
  coverage_score        NUMERIC(5,2) NOT NULL CHECK (coverage_score BETWEEN 0 AND 100),
  coverage_level        TEXT         NOT NULL CHECK (coverage_level IN ('HIGH', 'MEDIUM', 'LOW')),

  -- Factor breakdown (analytics-safe JSONB)
  factors               JSONB        DEFAULT NULL,

  -- Trait gaps (array of { trait, reason })
  trait_gaps            JSONB        DEFAULT NULL,

  -- Coverage notes (string array)
  coverage_notes        JSONB        DEFAULT NULL,

  -- Meta
  engine_version        TEXT         NOT NULL DEFAULT 'signal-coverage-v1',
  evaluated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE signal_coverage_profiles IS
  'Phase 4A: Immutable signal coverage evaluation per assessment. '
  'One row per user assessment session. Never updated after insert.';

COMMENT ON COLUMN signal_coverage_profiles.coverage_score IS
  'Composite signal coverage 0–100. Considers trait breadth, stage completeness, '
  'sample adequacy, question diversity, contradiction penalty, sparsity.';

COMMENT ON COLUMN signal_coverage_profiles.factors IS
  'JSONB breakdown: { traitBreadth, stageCompleteness, sampleAdequacy, '
  'questionDiversity, contradictionPenalty, sparsityPenalty, adaptiveBonus }';

CREATE INDEX IF NOT EXISTS idx_signal_coverage_user_id
  ON signal_coverage_profiles (user_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_coverage_level
  ON signal_coverage_profiles (coverage_level)
  WHERE coverage_level IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_signal_coverage_assessment
  ON signal_coverage_profiles (assessment_id);

-- ─────────────────────────────────────────────────────────────
-- TABLE 2: signal_reliability_scores
-- One row per trait per assessment evaluation.
-- Stores per-trait reliability alongside the raw score (read-only reference).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signal_reliability_scores (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL,
  assessment_id         TEXT        NOT NULL,

  -- Trait identification
  trait_key             TEXT        NOT NULL,

  -- Raw signal score (immutable reference — never altered by reliability)
  raw_score             NUMERIC(5,2) NOT NULL CHECK (raw_score BETWEEN 0 AND 100),

  -- Reliability scoring
  reliability_score     NUMERIC(5,2) NOT NULL CHECK (reliability_score BETWEEN 0 AND 100),
  reliability_level     TEXT         NOT NULL CHECK (reliability_level IN ('HIGH', 'MEDIUM', 'LOW')),

  -- Factor breakdown
  factors               JSONB        DEFAULT NULL,

  -- Meta
  sample_count          INT          DEFAULT NULL,
  last_assessed_at      TIMESTAMPTZ  DEFAULT NULL,
  engine_version        TEXT         NOT NULL DEFAULT 'signal-reliability-v1',
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE signal_reliability_scores IS
  'Phase 4A: Per-trait reliability scoring. One row per trait per assessment. '
  'raw_score is stored for reference only — reliability NEVER alters raw signal values.';

COMMENT ON COLUMN signal_reliability_scores.raw_score IS
  'The original signal score for this trait. This column is informational only. '
  'Reliability evaluation does not modify or replace this value.';

COMMENT ON COLUMN signal_reliability_scores.reliability_score IS
  'Trustworthiness score 0–100 for this specific trait signal, based on sample volume, '
  'answer consistency, cross-trait consistency, and recency.';

CREATE INDEX IF NOT EXISTS idx_signal_reliability_user_assessment
  ON signal_reliability_scores (user_id, assessment_id);

CREATE INDEX IF NOT EXISTS idx_signal_reliability_trait
  ON signal_reliability_scores (trait_key, reliability_level);

CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_reliability_unique_trait
  ON signal_reliability_scores (user_id, assessment_id, trait_key);

-- ─────────────────────────────────────────────────────────────
-- TABLE 3: cluster_stability_profiles
-- One row per cluster per stability evaluation.
-- Tracks how stable a user's cluster identity is over time.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cluster_stability_profiles (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL,

  -- Cluster identification
  cluster_id            TEXT        NOT NULL,
  cluster_label         TEXT        NOT NULL,

  -- Stability scoring
  stability_score       NUMERIC(5,2) NOT NULL CHECK (stability_score BETWEEN 0 AND 100),
  stability_level       TEXT         NOT NULL CHECK (stability_level IN ('HIGH', 'EMERGING', 'UNSTABLE')),
  trend_direction       TEXT         NOT NULL CHECK (trend_direction IN ('RISING', 'STABLE', 'DECLINING')),

  -- Historical stats
  appearance_count      INT          NOT NULL DEFAULT 0,
  average_score         NUMERIC(5,2) DEFAULT NULL,
  last_score            NUMERIC(5,2) DEFAULT NULL,

  -- Factor breakdown
  factors               JSONB        DEFAULT NULL,

  -- Meta
  total_assessments     INT          NOT NULL DEFAULT 0,
  first_seen_at         TIMESTAMPTZ  DEFAULT NULL,
  last_seen_at          TIMESTAMPTZ  DEFAULT NULL,
  engine_version        TEXT         NOT NULL DEFAULT 'cluster-stability-v1',
  evaluated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE cluster_stability_profiles IS
  'Phase 4A: Cluster stability snapshot per user. '
  'One row per cluster per evaluation run. Immutable after insert. '
  'Longitudinal queries should select MAX(evaluated_at) per cluster.';

CREATE INDEX IF NOT EXISTS idx_cluster_stability_user_id
  ON cluster_stability_profiles (user_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_cluster_stability_cluster
  ON cluster_stability_profiles (cluster_id, stability_level);

CREATE INDEX IF NOT EXISTS idx_cluster_stability_level
  ON cluster_stability_profiles (stability_level, trend_direction);

-- ─────────────────────────────────────────────────────────────
-- TABLE 4: cluster_drift_history
-- One row per pair of consecutive assessments.
-- Tracks how and when a user's cluster identity shifted.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cluster_drift_history (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID        NOT NULL,

  -- Assessment pair
  previous_assessment_id      TEXT        NOT NULL,
  current_assessment_id       TEXT        NOT NULL,
  previous_assessed_at        TIMESTAMPTZ DEFAULT NULL,
  current_assessed_at         TIMESTAMPTZ DEFAULT NULL,

  -- Drift result
  drift_score                 NUMERIC(5,2) NOT NULL CHECK (drift_score BETWEEN 0 AND 100),
  drift_level                 TEXT         NOT NULL CHECK (drift_level IN ('None', 'Minor', 'Moderate', 'Significant')),
  cluster_swapped             BOOLEAN      NOT NULL DEFAULT FALSE,
  primary_score_delta         NUMERIC(6,2) DEFAULT NULL,

  -- Previous cluster
  previous_primary_cluster_id TEXT        DEFAULT NULL,
  previous_primary_label      TEXT        DEFAULT NULL,

  -- Current cluster
  current_primary_cluster_id  TEXT        DEFAULT NULL,
  current_primary_label       TEXT        DEFAULT NULL,

  -- Cluster deltas (array of { clusterId, scoreDelta, rankDelta, status })
  cluster_deltas              JSONB       DEFAULT NULL,

  -- Explanation text
  explanation                 TEXT        DEFAULT NULL,

  -- Meta
  engine_version              TEXT        NOT NULL DEFAULT 'cluster-drift-v1',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE cluster_drift_history IS
  'Phase 4A: Immutable record of cluster identity drift between consecutive assessments. '
  'One row per assessment transition. Ordered by current_assessed_at for longitudinal queries.';

COMMENT ON COLUMN cluster_drift_history.cluster_swapped IS
  'TRUE when the primary cluster identity changed between assessments. '
  'Key signal for significant capability profile shifts.';

COMMENT ON COLUMN cluster_drift_history.cluster_deltas IS
  'JSONB array: each entry has { clusterId, clusterLabel, previousScore, '
  'currentScore, scoreDelta, rankDelta, status: NEW|CONTINUED|DROPPED }';

CREATE INDEX IF NOT EXISTS idx_cluster_drift_user_id
  ON cluster_drift_history (user_id, current_assessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_cluster_drift_level
  ON cluster_drift_history (drift_level)
  WHERE drift_level != 'None';

CREATE INDEX IF NOT EXISTS idx_cluster_drift_swapped
  ON cluster_drift_history (cluster_swapped)
  WHERE cluster_swapped = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cluster_drift_unique_pair
  ON cluster_drift_history (user_id, previous_assessment_id, current_assessment_id);

-- ─────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- All four tables follow the same pattern as existing intelligence tables.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE signal_coverage_profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_reliability_scores   ENABLE ROW LEVEL SECURITY;
ALTER TABLE cluster_stability_profiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cluster_drift_history       ENABLE ROW LEVEL SECURITY;

-- Users can read their own records
CREATE POLICY IF NOT EXISTS signal_coverage_profiles_user_read
  ON signal_coverage_profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY IF NOT EXISTS signal_reliability_scores_user_read
  ON signal_reliability_scores FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY IF NOT EXISTS cluster_stability_profiles_user_read
  ON cluster_stability_profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY IF NOT EXISTS cluster_drift_history_user_read
  ON cluster_drift_history FOR SELECT
  USING (auth.uid() = user_id);

-- Service role has full access (analytics pipelines, admin)
CREATE POLICY IF NOT EXISTS signal_coverage_profiles_service_all
  ON signal_coverage_profiles FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY IF NOT EXISTS signal_reliability_scores_service_all
  ON signal_reliability_scores FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY IF NOT EXISTS cluster_stability_profiles_service_all
  ON cluster_stability_profiles FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY IF NOT EXISTS cluster_drift_history_service_all
  ON cluster_drift_history FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────
-- ANALYTICS VIEW: latest intelligence quality per user
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW latest_intelligence_quality AS
SELECT
  scp.user_id,
  scp.coverage_score,
  scp.coverage_level,
  scp.engine_version AS coverage_engine_version,
  scp.evaluated_at   AS coverage_evaluated_at,

  -- Latest average reliability (aggregated from most recent assessment)
  (
    SELECT ROUND(AVG(rs.reliability_score)::NUMERIC, 2)
    FROM signal_reliability_scores rs
    WHERE rs.user_id = scp.user_id
      AND rs.assessment_id = (
        SELECT assessment_id FROM signal_coverage_profiles
        WHERE user_id = scp.user_id
        ORDER BY evaluated_at DESC
        LIMIT 1
      )
  ) AS avg_reliability_score,

  -- Latest primary cluster stability
  (
    SELECT stability_level FROM cluster_stability_profiles
    WHERE user_id = scp.user_id
    ORDER BY evaluated_at DESC, stability_score DESC
    LIMIT 1
  ) AS primary_cluster_stability_level,

  -- Last drift event
  (
    SELECT drift_level FROM cluster_drift_history
    WHERE user_id = scp.user_id
    ORDER BY current_assessed_at DESC
    LIMIT 1
  ) AS latest_drift_level

FROM signal_coverage_profiles scp
WHERE scp.evaluated_at = (
  SELECT MAX(evaluated_at)
  FROM signal_coverage_profiles
  WHERE user_id = scp.user_id
);

COMMENT ON VIEW latest_intelligence_quality IS
  'Phase 4A convenience view: latest intelligence quality metrics per user. '
  'Joins coverage, reliability, stability, and drift for dashboard queries.';
