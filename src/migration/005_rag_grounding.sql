-- =============================================================================
-- HireRise — Career Copilot RAG Grounding Migration
-- File: migrations/005_rag_grounding.sql
-- Depends on: trigger_set_updated_at() from 001_semantic_ai_upgrade.sql
-- =============================================================================
-- Purpose: Persistence layer for the RAG system.
--   - copilot_rag_contexts      : stores retrieved data snapshots per query
--   - copilot_conversations     : grounded conversation history (job seekers)
--   - copilot_grounding_failures: audit log of queries that lacked data
-- =============================================================================

-- =============================================================================
-- TABLE 1 — copilot_rag_contexts
-- Stores the full retrieved context used to ground each Copilot response.
-- Enables auditability: every answer can be traced back to the exact data used.
-- =============================================================================

CREATE TABLE IF NOT EXISTS copilot_rag_contexts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT        NOT NULL,
  conversation_id     TEXT        NOT NULL,   -- groups turns in same session
  turn_index          INT         NOT NULL DEFAULT 0,

  -- The user's original question
  user_query          TEXT        NOT NULL,

  -- Retrieved context snapshot (what was injected into the LLM prompt)
  retrieved_context   JSONB       NOT NULL DEFAULT '{}',
  -- {
  --   chi_score, skill_gaps, job_matches, opportunity_radar,
  --   risk_analysis, salary_benchmarks, personalization_profile,
  --   user_profile
  -- }

  -- Data sources actually used (non-null fields from retrieved_context)
  data_sources_used   TEXT[]      NOT NULL DEFAULT '{}',

  -- Grounding metadata
  confidence_score    NUMERIC(4,3) CHECK (confidence_score BETWEEN 0 AND 1),
  data_completeness   NUMERIC(4,3) CHECK (data_completeness BETWEEN 0 AND 1),
  -- 0 = no data available, 1 = all 7 sources populated

  -- The AI response that was generated from this context
  ai_response         TEXT,

  -- Hallucination guard flags
  refused_generation  BOOLEAN     NOT NULL DEFAULT false,
  -- true when data_completeness < threshold and we refused to speculate

  refusal_reason      TEXT,
  -- populated when refused_generation = true

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_contexts_user
  ON copilot_rag_contexts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rag_contexts_conversation
  ON copilot_rag_contexts (conversation_id, turn_index);

CREATE INDEX IF NOT EXISTS idx_rag_contexts_cleanup
  ON copilot_rag_contexts (created_at);

-- =============================================================================
-- TABLE 2 — copilot_conversations
-- Job-seeker path conversation history (mirrors edu_career_conversations
-- which is used by the student advisor path).
-- Stores grounded Q&A turns with source attribution.
-- =============================================================================

CREATE TABLE IF NOT EXISTS copilot_conversations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL,
  conversation_id TEXT        NOT NULL,
  turn_index      INT         NOT NULL DEFAULT 0,

  user_message    TEXT        NOT NULL,
  ai_response     TEXT        NOT NULL,

  -- Lightweight source attribution stored per turn
  data_sources    TEXT[]      NOT NULL DEFAULT '{}',
  confidence      NUMERIC(4,3),

  -- Link to full context snapshot
  rag_context_id  UUID        REFERENCES copilot_rag_contexts(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_copilot_convos_user
  ON copilot_conversations (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_copilot_convos_session
  ON copilot_conversations (conversation_id, turn_index);

-- =============================================================================
-- TABLE 3 — copilot_grounding_failures
-- Audit log of queries where the Copilot could not ground its answer.
-- Used to identify which data is most commonly missing.
-- =============================================================================

CREATE TABLE IF NOT EXISTS copilot_grounding_failures (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL,
  user_query      TEXT        NOT NULL,
  missing_sources TEXT[]      NOT NULL DEFAULT '{}',
  -- which of the 7 sources were null/empty
  data_completeness NUMERIC(4,3),
  refusal_message TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grounding_failures_user
  ON copilot_grounding_failures (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_grounding_failures_missing
  ON copilot_grounding_failures USING GIN (missing_sources);

-- =============================================================================
-- RLS
-- =============================================================================

ALTER TABLE copilot_rag_contexts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE copilot_conversations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE copilot_grounding_failures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_rag_contexts"
  ON copilot_rag_contexts FOR SELECT
  USING (user_id = auth.uid()::text);

CREATE POLICY "own_copilot_convos"
  ON copilot_conversations FOR SELECT
  USING (user_id = auth.uid()::text);

CREATE POLICY "own_grounding_failures"
  ON copilot_grounding_failures FOR SELECT
  USING (user_id = auth.uid()::text);

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE copilot_rag_contexts IS
  'Full retrieved context snapshot per Copilot query. Enables complete auditability of every grounded AI response.';

COMMENT ON TABLE copilot_conversations IS
  'Job-seeker path Copilot conversation history with source attribution per turn.';

COMMENT ON TABLE copilot_grounding_failures IS
  'Audit log of queries refused due to insufficient platform data. Used to prioritise data collection.';

COMMENT ON COLUMN copilot_rag_contexts.confidence_score IS
  'Composite confidence: 0.4×data_completeness + 0.3×source_count/7 + 0.3×profile_completeness';

COMMENT ON COLUMN copilot_rag_contexts.refused_generation IS
  'True when data_completeness < MIN_COMPLETENESS_THRESHOLD (0.25). The Copilot refused to speculate.';
