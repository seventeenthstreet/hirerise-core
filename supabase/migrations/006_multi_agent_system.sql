-- =============================================================================
-- HireRise — Multi-Agent Career Copilot
-- Migration: 006_multi_agent_system.sql
-- Depends on: trigger_set_updated_at() from 001_semantic_ai_upgrade.sql
-- =============================================================================

-- =============================================================================
-- TABLE 1 — agent_responses
-- Persists every coordinator response for session continuity + analytics.
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_responses (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT         NOT NULL,
  session_id    TEXT         NOT NULL,
  turn_index    INT          NOT NULL DEFAULT 0,

  user_query    TEXT,                           -- null for full-analysis calls
  intent        TEXT         NOT NULL,
  -- skill | jobs | salary | risk | opportunity | transition | general | full

  agents_used   TEXT[]       NOT NULL DEFAULT '{}',
  -- e.g. ['SkillIntelligenceAgent','JobMatchingAgent','CareerAdvisorAgent']

  agent_errors  JSONB        NOT NULL DEFAULT '[]',
  -- [{ "agent": "CareerRiskAgent", "error": "Engine unavailable" }]

  response      JSONB        NOT NULL DEFAULT '{}',
  -- full structured output: skills_to_learn, job_matches, career_risk, etc.

  confidence        NUMERIC(4,3) CHECK (confidence BETWEEN 0 AND 1),
  data_completeness NUMERIC(4,3) CHECK (data_completeness BETWEEN 0 AND 1),
  duration_ms       INT,
  cached_agents     INT NOT NULL DEFAULT 0,   -- how many agents returned cached data

  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_responses_user
  ON agent_responses (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_responses_session
  ON agent_responses (session_id, turn_index ASC);

CREATE INDEX IF NOT EXISTS idx_agent_responses_intent
  ON agent_responses (intent, created_at DESC);

-- =============================================================================
-- TABLE 2 — agent_sessions
-- Groups multi-turn agent conversations into sessions.
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_sessions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT        NOT NULL UNIQUE,
  user_id         TEXT        NOT NULL,
  turn_count      INT         NOT NULL DEFAULT 0,
  detected_intents TEXT[]     NOT NULL DEFAULT '{}',
  agents_activated TEXT[]     NOT NULL DEFAULT '{}',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_agent_sessions_updated_at ON agent_sessions;
CREATE TRIGGER set_agent_sessions_updated_at
  BEFORE UPDATE ON agent_sessions
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

CREATE INDEX IF NOT EXISTS idx_agent_sessions_user
  ON agent_sessions (user_id, last_active_at DESC);

-- =============================================================================
-- RLS
-- =============================================================================

ALTER TABLE agent_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_agent_responses" ON agent_responses
  FOR SELECT USING (user_id = auth.uid()::text);

CREATE POLICY "own_agent_sessions" ON agent_sessions
  FOR SELECT USING (user_id = auth.uid()::text);

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE agent_responses IS
  'Full multi-agent coordinator response per turn. Enables session history, analytics, and replay.';

COMMENT ON TABLE agent_sessions IS
  'Groups agent_responses into conversation sessions. One session_id = one Copilot conversation.';

COMMENT ON COLUMN agent_responses.agents_used IS
  'Ordered list of agent names that contributed data to this response.';

COMMENT ON COLUMN agent_responses.intent IS
  'Intent classified from user query. Determines which agents are activated.';

COMMENT ON COLUMN agent_responses.cached_agents IS
  'Number of agents that returned Redis-cached data (vs live engine calls).';
