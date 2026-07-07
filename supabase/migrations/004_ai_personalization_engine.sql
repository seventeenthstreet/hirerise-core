-- =============================================================================
-- HireRise — AI Personalization Engine Migration
-- File: migrations/004_ai_personalization_engine.sql
-- Depends on: trigger_set_updated_at() from 001_semantic_ai_upgrade.sql
-- =============================================================================

-- =============================================================================
-- TABLE 1 — user_behavior_events
-- Raw event log of every user interaction with the platform.
-- Append-only. Never updated. Used by updateBehaviorProfile() for analysis.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_behavior_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT        NOT NULL,
  event_type   TEXT        NOT NULL
                CHECK (event_type IN (
                  'job_click',
                  'job_apply',
                  'skill_view',
                  'course_view',
                  'career_path_view',
                  'opportunity_click',
                  'dashboard_module_usage',
                  -- Extended types for richer signal collection
                  'job_save',
                  'skill_search',
                  'role_explore',
                  'advice_read',
                  'learning_path_start',
                  'salary_check'
                )),
  entity_type  TEXT,              -- e.g. 'role', 'skill', 'course', 'module'
  entity_id    TEXT,              -- e.g. role_name, skill_name, module slug
  entity_label TEXT,              -- human-readable name (denormalised for analysis)
  metadata     JSONB,             -- additional context { source, duration_ms, position }
  session_id   TEXT,              -- client session identifier for sequence analysis
  "timestamp"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for behaviour analysis queries
CREATE INDEX IF NOT EXISTS idx_behavior_events_user_time
  ON user_behavior_events (user_id, "timestamp" DESC);

CREATE INDEX IF NOT EXISTS idx_behavior_events_type
  ON user_behavior_events (user_id, event_type, "timestamp" DESC);

CREATE INDEX IF NOT EXISTS idx_behavior_events_entity
  ON user_behavior_events (user_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_behavior_events_cleanup
  ON user_behavior_events ("timestamp");

-- =============================================================================
-- TABLE 2 — user_personalization_profile
-- Derived signal profile computed from behavior events.
-- One row per user. Updated by updateBehaviorProfile().
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_personalization_profile (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT        NOT NULL UNIQUE,

  -- Derived preference signals (JSONB arrays of { name, score, count } objects)
  preferred_roles     JSONB       NOT NULL DEFAULT '[]',
  -- e.g. [{ "name": "Data Analyst", "score": 0.82, "click_count": 5, "apply_count": 1 }]

  preferred_skills    JSONB       NOT NULL DEFAULT '[]',
  -- e.g. [{ "name": "Power BI", "score": 0.75, "view_count": 8 }]

  career_interests    JSONB       NOT NULL DEFAULT '[]',
  -- e.g. [{ "industry": "Technology", "score": 0.9 }, { "industry": "Finance", "score": 0.6 }]

  -- Dashboard usage signals
  active_modules      JSONB       NOT NULL DEFAULT '[]',
  -- e.g. ["job_matches", "opportunity_radar", "skill_graph"]

  -- Computed summary metrics
  engagement_score    NUMERIC(5,2) NOT NULL DEFAULT 0
                      CHECK (engagement_score BETWEEN 0 AND 100),
  total_events        INT          NOT NULL DEFAULT 0,
  profile_completeness NUMERIC(5,2) NOT NULL DEFAULT 0
                      CHECK (profile_completeness BETWEEN 0 AND 100),

  -- Analysis window
  analyzed_from       TIMESTAMPTZ,
  analyzed_to         TIMESTAMPTZ,

  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_personalization_profile_updated_at ON user_personalization_profile;
CREATE TRIGGER set_personalization_profile_updated_at
  BEFORE UPDATE ON user_personalization_profile
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- =============================================================================
-- TABLE 3 — personalized_recommendations
-- Cached output of recommendPersonalizedCareers().
-- One row per user, overwritten on each computation.
-- =============================================================================

CREATE TABLE IF NOT EXISTS personalized_recommendations (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              TEXT        NOT NULL UNIQUE,

  personalized_roles   JSONB       NOT NULL DEFAULT '[]',
  -- e.g. [{ "role": "Data Analyst", "score": 86, "breakdown": {...}, "match_reason": "..." }]

  personalized_skills  JSONB       NOT NULL DEFAULT '[]',
  -- skills boosted by behavior signal

  personalized_paths   JSONB       NOT NULL DEFAULT '[]',
  -- career paths aligned with interests

  personalization_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  signal_strength       TEXT         NOT NULL DEFAULT 'low'
                        CHECK (signal_strength IN ('none','low','medium','high','very_high')),

  -- Score breakdown for transparency
  score_breakdown      JSONB        NOT NULL DEFAULT '{}',
  -- e.g. { "behavior_signals": 32, "skill_alignment": 24, "opportunity_score": 18, "market_demand": 8 }

  computed_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at           TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_personalized_recs_user
  ON personalized_recommendations (user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_personalized_recs_cleanup
  ON personalized_recommendations (expires_at);

-- =============================================================================
-- RLS
-- =============================================================================

ALTER TABLE user_behavior_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_personalization_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE personalized_recommendations ENABLE ROW LEVEL SECURITY;

-- Users can only read/write their own rows
CREATE POLICY "own_behavior_events"
  ON user_behavior_events FOR ALL
  USING (user_id = auth.uid()::text);

CREATE POLICY "own_personalization_profile"
  ON user_personalization_profile FOR ALL
  USING (user_id = auth.uid()::text);

CREATE POLICY "own_personalized_recs"
  ON personalized_recommendations FOR SELECT
  USING (user_id = auth.uid()::text);

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE user_behavior_events IS
  'Raw append-only event log of user interactions. Analyzed by AIPersonalizationEngine.updateBehaviorProfile().';

COMMENT ON TABLE user_personalization_profile IS
  'Derived signal profile per user. Updated after every N events or explicit trigger. Used by recommendPersonalizedCareers().';

COMMENT ON TABLE personalized_recommendations IS
  'Pre-computed personalized career recommendations. 10-minute TTL mirrors Redis layer.';

COMMENT ON COLUMN user_personalization_profile.preferred_roles IS
  'Roles the user has clicked/applied for, scored by frequency and recency. Used to boost job matches.';

COMMENT ON COLUMN user_personalization_profile.engagement_score IS
  'Composite 0-100 score measuring how richly the user has interacted with the platform.';
