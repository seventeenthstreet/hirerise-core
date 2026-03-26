-- =============================================================================
-- HireRise — AI Event Bus Result Tables
-- File: migrations/003_ai_event_bus.sql
-- Depends on: 001_semantic_ai_upgrade.sql (trigger_set_updated_at exists)
-- =============================================================================
-- Purpose: Dedicated result storage for each async AI worker.
--          Dashboard reads from these tables instead of triggering engines
--          directly. Results are written by BullMQ workers after processing.
-- =============================================================================

-- =============================================================================
-- TABLE 1 — ai_pipeline_jobs
-- Master job registry for every event published to the AIEventBus.
-- Tracks lifecycle: pending → processing → completed | failed
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_pipeline_jobs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL,
  event_type      TEXT        NOT NULL,
  -- e.g. CV_PARSED | SKILLS_EXTRACTED | JOB_MATCH_REQUESTED | RISK_ANALYSIS_REQUESTED
  -- | OPPORTUNITY_SCAN_REQUESTED | CAREER_ADVICE_REQUESTED | CAREER_ANALYSIS_REQUESTED

  bullmq_job_id   TEXT,                    -- BullMQ internal job ID for correlation
  queue_name      TEXT        NOT NULL,    -- which BullMQ queue handled this
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','completed','failed','retrying')),
  attempt_count   INT         NOT NULL DEFAULT 0,
  max_attempts    INT         NOT NULL DEFAULT 3,

  input_payload   JSONB,                   -- event payload that triggered the job
  error_message   TEXT,                    -- populated on failure
  error_code      TEXT,

  queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_user
  ON ai_pipeline_jobs (user_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_status
  ON ai_pipeline_jobs (status, queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_event
  ON ai_pipeline_jobs (event_type, status);
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_cleanup
  ON ai_pipeline_jobs (expires_at);

-- =============================================================================
-- TABLE 2 — career_health_results
-- Stored output from CareerHealthWorker (CHI engine).
-- =============================================================================

CREATE TABLE IF NOT EXISTS career_health_results (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL UNIQUE,
  job_id          UUID        REFERENCES ai_pipeline_jobs(id) ON DELETE SET NULL,

  chi_score       NUMERIC(5,2) CHECK (chi_score BETWEEN 0 AND 100),
  dimensions      JSONB,       -- { skillMatch, skillDepth, careerDistance, experience, education, marketSalary }
  skill_gaps      JSONB,       -- array of { name, priority, demand_score }
  analysis_source TEXT,        -- 'bullmq_async' | 'provisional'

  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_career_health_updated_at ON career_health_results;
CREATE TRIGGER set_career_health_updated_at
  BEFORE UPDATE ON career_health_results
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- =============================================================================
-- TABLE 3 — job_match_results
-- Stored output from JobMatchingWorker.
-- =============================================================================

CREATE TABLE IF NOT EXISTS job_match_results (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL UNIQUE,
  job_id          UUID        REFERENCES ai_pipeline_jobs(id) ON DELETE SET NULL,

  recommended_jobs JSONB      NOT NULL DEFAULT '[]',
  -- array of { title, company, match_score, semantic_score, missing_skills, breakdown }
  total_evaluated  INT        NOT NULL DEFAULT 0,
  user_skills_count INT       NOT NULL DEFAULT 0,
  scoring_mode    TEXT        NOT NULL DEFAULT 'keyword',  -- 'keyword' | 'semantic'

  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_job_match_updated_at ON job_match_results;
CREATE TRIGGER set_job_match_updated_at
  BEFORE UPDATE ON job_match_results
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- =============================================================================
-- TABLE 4 — risk_analysis_results
-- Stored output from RiskAnalysisWorker (Career Risk Predictor).
-- =============================================================================

CREATE TABLE IF NOT EXISTS risk_analysis_results (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL UNIQUE,
  job_id          UUID        REFERENCES ai_pipeline_jobs(id) ON DELETE SET NULL,

  overall_risk_score  NUMERIC(5,2) CHECK (overall_risk_score BETWEEN 0 AND 100),
  risk_level          TEXT         CHECK (risk_level IN ('Low','Medium','High','Critical')),
  risk_factors        JSONB        NOT NULL DEFAULT '[]',
  -- array of { factor, score, description, mitigation }
  recommendations     JSONB        NOT NULL DEFAULT '[]',
  market_stability    TEXT,

  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_risk_analysis_updated_at ON risk_analysis_results;
CREATE TRIGGER set_risk_analysis_updated_at
  BEFORE UPDATE ON risk_analysis_results
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- =============================================================================
-- TABLE 5 — opportunity_radar_results
-- Stored output from OpportunityRadarWorker (already has career_opportunity_signals,
-- this table stores the *personalised* computed match for a user).
-- =============================================================================

CREATE TABLE IF NOT EXISTS opportunity_radar_results (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL UNIQUE,
  job_id          UUID        REFERENCES ai_pipeline_jobs(id) ON DELETE SET NULL,

  emerging_opportunities JSONB  NOT NULL DEFAULT '[]',
  -- array of { role, opportunity_score, match_score, growth_trend, average_salary, skills_to_learn }
  total_signals_evaluated INT  NOT NULL DEFAULT 0,

  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_opp_radar_updated_at ON opportunity_radar_results;
CREATE TRIGGER set_opp_radar_updated_at
  BEFORE UPDATE ON opportunity_radar_results
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- =============================================================================
-- TABLE 6 — career_advice_results
-- Stored output from CareerAdvisorWorker.
-- (Supplements the existing career_advice_cache table with job tracking.)
-- =============================================================================

CREATE TABLE IF NOT EXISTS career_advice_results (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL UNIQUE,
  job_id          UUID        REFERENCES ai_pipeline_jobs(id) ON DELETE SET NULL,

  career_insight        TEXT,
  key_opportunity       TEXT,
  salary_potential      TEXT,
  timeline              TEXT,
  skills_to_prioritise  JSONB   NOT NULL DEFAULT '[]',
  profile_hash          TEXT,   -- MD5 snapshot — same as career_advice_cache

  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_career_advice_updated_at ON career_advice_results;
CREATE TRIGGER set_career_advice_updated_at
  BEFORE UPDATE ON career_advice_results
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- =============================================================================
-- RLS
-- =============================================================================

ALTER TABLE ai_pipeline_jobs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE career_health_results     ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_match_results         ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_analysis_results     ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_radar_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE career_advice_results     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_pipeline_jobs"   ON ai_pipeline_jobs          FOR SELECT USING (user_id = auth.uid()::text);
CREATE POLICY "own_health_results"  ON career_health_results     FOR SELECT USING (user_id = auth.uid()::text);
CREATE POLICY "own_match_results"   ON job_match_results         FOR SELECT USING (user_id = auth.uid()::text);
CREATE POLICY "own_risk_results"    ON risk_analysis_results     FOR SELECT USING (user_id = auth.uid()::text);
CREATE POLICY "own_radar_results"   ON opportunity_radar_results FOR SELECT USING (user_id = auth.uid()::text);
CREATE POLICY "own_advice_results"  ON career_advice_results     FOR SELECT USING (user_id = auth.uid()::text);

-- =============================================================================
-- Comments
-- =============================================================================
COMMENT ON TABLE ai_pipeline_jobs IS
  'Master job registry for every event published to the AIEventBus. BullMQ job IDs correlate here.';
COMMENT ON TABLE career_health_results IS
  'Stored CHI engine output written by CareerHealthWorker. Dashboard reads from here.';
COMMENT ON TABLE job_match_results IS
  'Stored job matching output written by JobMatchingWorker. Dashboard reads from here.';
COMMENT ON TABLE risk_analysis_results IS
  'Stored risk predictor output written by RiskAnalysisWorker. Dashboard reads from here.';
COMMENT ON TABLE opportunity_radar_results IS
  'Stored personalised opportunity radar output written by OpportunityRadarWorker.';
COMMENT ON TABLE career_advice_results IS
  'Stored AI career advice output written by CareerAdvisorWorker.';
