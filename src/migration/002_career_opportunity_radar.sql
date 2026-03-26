-- =============================================================================
-- HireRise — AI Career Opportunity Radar Migration
-- File: migrations/002_career_opportunity_radar.sql
-- Depends on: 001_semantic_ai_upgrade.sql (pgvector already enabled)
-- =============================================================================

-- =============================================================================
-- TABLE 1 — career_opportunity_signals
-- Master registry of detected emerging/high-growth roles.
-- Populated by OpportunityRadarEngine on a scheduled basis.
-- =============================================================================

CREATE TABLE IF NOT EXISTS career_opportunity_signals (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  role_name        TEXT         NOT NULL,
  industry         TEXT         NOT NULL,

  -- Growth metrics (raw, from LMI data)
  growth_rate      NUMERIC(6,2) NOT NULL DEFAULT 0,   -- YoY % e.g. 42.5 = 42.5%
  salary_growth_rate NUMERIC(6,2) NOT NULL DEFAULT 0, -- YoY salary growth %
  average_salary   TEXT         NOT NULL DEFAULT '0', -- human-readable e.g. "₹12L"
  average_salary_raw BIGINT     NOT NULL DEFAULT 0,   -- INR annual for sorting

  -- Demand metrics
  demand_score     NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (demand_score    BETWEEN 0 AND 100),
  emerging_score   NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (emerging_score  BETWEEN 0 AND 100),
  opportunity_score NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (opportunity_score BETWEEN 0 AND 100),

  -- Scoring components (stored for transparency / debugging)
  score_breakdown  JSONB        NOT NULL DEFAULT '{}',
  -- e.g. { "job_growth": 35, "salary_growth": 25, "skill_demand": 22, "industry_growth": 16 }

  -- Skill data
  required_skills  JSONB        NOT NULL DEFAULT '[]',
  -- e.g. ["Power BI", "SQL", "Process Optimization"]

  -- Metadata
  growth_trend     TEXT         NOT NULL DEFAULT 'Moderate'
                   CHECK (growth_trend IN ('Very High', 'High', 'Moderate', 'Emerging', 'Stable')),
  is_emerging      BOOLEAN      NOT NULL DEFAULT false,  -- true = new role < 3 years mainstream
  data_source      TEXT         NOT NULL DEFAULT 'lmi',  -- 'lmi' | 'seed' | 'manual'
  signal_date      DATE         NOT NULL DEFAULT CURRENT_DATE,

  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Unique per role+industry combination; safe to upsert on refresh
  UNIQUE (role_name, industry)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_opp_signals_score
  ON career_opportunity_signals (opportunity_score DESC);

CREATE INDEX IF NOT EXISTS idx_opp_signals_industry
  ON career_opportunity_signals (industry);

CREATE INDEX IF NOT EXISTS idx_opp_signals_emerging
  ON career_opportunity_signals (is_emerging, opportunity_score DESC);

CREATE INDEX IF NOT EXISTS idx_opp_signals_trend
  ON career_opportunity_signals (growth_trend, opportunity_score DESC);

-- Auto-update updated_at
DROP TRIGGER IF EXISTS set_opp_signals_updated_at ON career_opportunity_signals;
CREATE TRIGGER set_opp_signals_updated_at
  BEFORE UPDATE ON career_opportunity_signals
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- =============================================================================
-- TABLE 2 — user_opportunity_matches
-- Per-user match scores against opportunity signals.
-- Computed by OpportunityRadarEngine, cached here for analytics.
-- Short-lived: expires after 30 minutes (mirrors Redis TTL).
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_opportunity_matches (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT         NOT NULL,
  signal_id        UUID         NOT NULL REFERENCES career_opportunity_signals(id) ON DELETE CASCADE,

  match_score      NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (match_score BETWEEN 0 AND 100),
  skills_overlap   TEXT[]       NOT NULL DEFAULT '{}',   -- skills user already has
  skills_to_learn  TEXT[]       NOT NULL DEFAULT '{}',   -- skills user needs

  computed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),

  UNIQUE (user_id, signal_id)
);

CREATE INDEX IF NOT EXISTS idx_user_opp_matches_user
  ON user_opportunity_matches (user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_opp_matches_cleanup
  ON user_opportunity_matches (expires_at);

-- =============================================================================
-- TABLE 3 — opportunity_radar_runs
-- Audit log of each engine refresh run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS opportunity_radar_runs (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  signals_upserted INT          NOT NULL DEFAULT 0,
  signals_total    INT          NOT NULL DEFAULT 0,
  duration_ms      INT          NOT NULL DEFAULT 0,
  status           TEXT         NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'partial', 'failed')),
  error_message    TEXT,
  ran_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- RLS — row-level security
-- =============================================================================

ALTER TABLE user_opportunity_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_opp_matches"
  ON user_opportunity_matches FOR SELECT
  USING (user_id = auth.uid()::text);

-- career_opportunity_signals is public read (no sensitive data)
ALTER TABLE career_opportunity_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "signals_public_read"
  ON career_opportunity_signals FOR SELECT
  USING (true);

-- =============================================================================
-- SEED DATA — Initial emerging roles for Indian job market
-- Provides immediate data before the first LMI refresh runs.
-- opportunity_score is pre-calculated from the scoring formula.
-- =============================================================================

INSERT INTO career_opportunity_signals
  (role_name, industry, growth_rate, salary_growth_rate, average_salary, average_salary_raw,
   demand_score, emerging_score, opportunity_score, score_breakdown,
   required_skills, growth_trend, is_emerging, data_source)
VALUES
  ('AI Product Manager', 'Technology', 65.0, 28.0, '₹22L', 2200000,
   88, 92, 89,
   '{"job_growth":35,"salary_growth":25,"skill_demand":22,"industry_growth":7}',
   '["Product Management","AI/ML Fundamentals","Prompt Engineering","Data Analysis","Stakeholder Management"]',
   'Very High', true, 'seed'),

  ('Data Operations Specialist', 'Technology', 48.0, 22.0, '₹14L', 1400000,
   82, 78, 82,
   '{"job_growth":35,"salary_growth":22,"skill_demand":18,"industry_growth":7}',
   '["SQL","Python","Data Pipelines","Power BI","Process Optimization"]',
   'High', true, 'seed'),

  ('Automation Consultant', 'Operations', 55.0, 25.0, '₹18L', 1800000,
   85, 80, 85,
   '{"job_growth":35,"salary_growth":25,"skill_demand":19,"industry_growth":6}',
   '["RPA Tools","Process Mapping","Python","Business Analysis","Change Management"]',
   'Very High', true, 'seed'),

  ('Growth Analyst', 'Marketing & Technology', 42.0, 20.0, '₹12L', 1200000,
   78, 72, 79,
   '{"job_growth":35,"salary_growth":20,"skill_demand":18,"industry_growth":6}',
   '["Google Analytics","SQL","A/B Testing","Excel","Python"]',
   'High', false, 'seed'),

  ('Sustainability Manager', 'Consulting & Manufacturing', 38.0, 18.0, '₹16L', 1600000,
   72, 85, 76,
   '{"job_growth":35,"salary_growth":18,"skill_demand":17,"industry_growth":6}',
   '["ESG Reporting","Carbon Accounting","Project Management","Stakeholder Engagement","Regulatory Compliance"]',
   'High', true, 'seed'),

  ('MLOps Engineer', 'Technology', 72.0, 32.0, '₹25L', 2500000,
   91, 88, 91,
   '{"job_growth":35,"salary_growth":25,"skill_demand":23,"industry_growth":8}',
   '["Python","Docker","Kubernetes","ML Frameworks","CI/CD","Cloud Platforms"]',
   'Very High', true, 'seed'),

  ('Operations Analyst', 'Operations & Finance', 35.0, 18.0, '₹12L', 1200000,
   75, 68, 75,
   '{"job_growth":35,"salary_growth":18,"skill_demand":17,"industry_growth":5}',
   '["Power BI","SQL","Process Optimization","Excel","Business Analysis"]',
   'High', false, 'seed'),

  ('Prompt Engineer', 'Technology', 120.0, 45.0, '₹20L', 2000000,
   86, 95, 88,
   '{"job_growth":35,"salary_growth":25,"skill_demand":21,"industry_growth":7}',
   '["LLM APIs","Python","NLP","Technical Writing","AI/ML Fundamentals"]',
   'Very High', true, 'seed'),

  ('Climate Risk Analyst', 'Finance & Insurance', 40.0, 22.0, '₹18L', 1800000,
   70, 82, 73,
   '{"job_growth":35,"salary_growth":22,"skill_demand":16,"industry_growth":0}',
   '["Risk Modelling","ESG Frameworks","Financial Analysis","Python","Data Visualization"]',
   'Emerging', true, 'seed'),

  ('Cybersecurity Analyst', 'Technology & Banking', 60.0, 30.0, '₹18L', 1800000,
   90, 75, 88,
   '{"job_growth":35,"salary_growth":25,"skill_demand":21,"industry_growth":7}',
   '["Network Security","Python","SIEM Tools","Threat Analysis","Cloud Security"]',
   'Very High', false, 'seed')

ON CONFLICT (role_name, industry) DO NOTHING;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE career_opportunity_signals IS
  'Master registry of AI-detected emerging/high-growth roles. Populated by OpportunityRadarEngine.';

COMMENT ON TABLE user_opportunity_matches IS
  'Per-user match scores against opportunity signals. 30-min TTL mirrors Redis cache.';

COMMENT ON COLUMN career_opportunity_signals.opportunity_score IS
  '0.35 × job_growth_rate + 0.25 × salary_growth_rate + 0.25 × skill_demand_growth + 0.15 × industry_growth';

COMMENT ON COLUMN career_opportunity_signals.emerging_score IS
  'How "new" the role is to the mainstream market (0=established, 100=very new). Used to highlight novel opportunities.';
