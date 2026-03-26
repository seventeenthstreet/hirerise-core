-- =============================================================================
-- HireRise — Semantic AI Upgrade Migrations
-- File: 001_semantic_ai_upgrade.sql
-- Run against: Supabase (PostgreSQL)
-- =============================================================================

-- Enable pgvector extension (required for vector similarity search)
-- Run once per Supabase project — safe to re-run, it's idempotent
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- UPGRADE 1 — Skill Embeddings Table
-- Stores OpenAI/compatible embedding vectors per unique skill name.
-- Indexed for fast cosine similarity search via pgvector ivfflat.
-- =============================================================================

CREATE TABLE IF NOT EXISTS skill_embeddings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_name      TEXT        NOT NULL UNIQUE,
  -- text-embedding-3-small → 1536 dims
  -- text-embedding-3-large → 3072 dims
  -- Use 1536 as default (cost-effective for this use case)
  embedding_vector VECTOR(1536) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- IVFFlat index for approximate nearest-neighbour search
-- lists = sqrt(row count) — start with 100, tune as data grows
CREATE INDEX IF NOT EXISTS idx_skill_embeddings_vector
  ON skill_embeddings
  USING ivfflat (embedding_vector vector_cosine_ops)
  WITH (lists = 100);

-- Exact index on skill name for quick lookups
CREATE INDEX IF NOT EXISTS idx_skill_embeddings_name
  ON skill_embeddings (LOWER(skill_name));

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_skill_embeddings_updated_at ON skill_embeddings;
CREATE TRIGGER set_skill_embeddings_updated_at
  BEFORE UPDATE ON skill_embeddings
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- =============================================================================
-- UPGRADE 2 — Job Embeddings Table
-- Stores combined embedding vectors per job listing.
-- Combines: title + description + required skills into one vector.
-- =============================================================================

CREATE TABLE IF NOT EXISTS job_embeddings (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- References jobs table if it exists; otherwise store inline
  job_id           TEXT        NOT NULL UNIQUE,
  embedding_vector VECTOR(1536) NOT NULL,
  -- Denormalised metadata for fast retrieval without joins
  job_title        TEXT,
  company          TEXT,
  location         TEXT,
  -- Serialised skill list used to generate this embedding (for invalidation)
  skills_snapshot  TEXT[],
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_embeddings_vector
  ON job_embeddings
  USING ivfflat (embedding_vector vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_job_embeddings_job_id
  ON job_embeddings (job_id);

DROP TRIGGER IF EXISTS set_job_embeddings_updated_at ON job_embeddings;
CREATE TRIGGER set_job_embeddings_updated_at
  BEFORE UPDATE ON job_embeddings
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- =============================================================================
-- UPGRADE 2 — Semantic Match Scores Cache Table
-- Persists computed match results so the same user/job pair is never
-- re-computed within the cache window.
-- =============================================================================

CREATE TABLE IF NOT EXISTS semantic_match_cache (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL,
  job_id          TEXT        NOT NULL,
  semantic_score  NUMERIC(5,2) NOT NULL CHECK (semantic_score BETWEEN 0 AND 100),
  final_score     NUMERIC(5,2) NOT NULL CHECK (final_score BETWEEN 0 AND 100),
  score_breakdown JSONB,          -- { semantic, experience, industry, location }
  missing_skills  TEXT[],
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  UNIQUE (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_semantic_match_user
  ON semantic_match_cache (user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_semantic_match_cleanup
  ON semantic_match_cache (expires_at);

-- Scheduled cleanup — run via pg_cron or application-side:
-- DELETE FROM semantic_match_cache WHERE expires_at < NOW();

-- =============================================================================
-- UPGRADE 3 — Career Advice Cache Table
-- Persists AI-generated career advice to avoid redundant LLM calls.
-- =============================================================================

CREATE TABLE IF NOT EXISTS career_advice_cache (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT        NOT NULL UNIQUE,
  advice_text TEXT        NOT NULL,
  profile_hash TEXT       NOT NULL,  -- MD5 of profile snapshot; if changed, invalidate
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_career_advice_user
  ON career_advice_cache (user_id, expires_at DESC);

-- =============================================================================
-- UPGRADE 4 — Learning Path Cache Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS learning_path_cache (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_name    TEXT        NOT NULL UNIQUE,
  learning_path JSONB       NOT NULL,   -- Array of step objects
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour')
);

-- =============================================================================
-- Row Level Security (RLS) — enable and restrict per user
-- =============================================================================

ALTER TABLE semantic_match_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE career_advice_cache   ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS — backend uses service role key
-- Authenticated users can only read their own rows (if you ever expose via REST)
CREATE POLICY "users_own_match_cache"
  ON semantic_match_cache FOR SELECT
  USING (user_id = auth.uid()::text);

CREATE POLICY "users_own_advice_cache"
  ON career_advice_cache FOR SELECT
  USING (user_id = auth.uid()::text);

-- =============================================================================
-- Helper SQL function for pgvector cosine similarity search
-- Called by SemanticSkillEngine.findSimilarSkills()
-- =============================================================================

CREATE OR REPLACE FUNCTION find_similar_skills(
  query_vector VECTOR(1536),
  top_k        INT DEFAULT 5,
  min_score    FLOAT DEFAULT 0.6
)
RETURNS TABLE (
  skill_name   TEXT,
  similarity   FLOAT
)
LANGUAGE sql STABLE AS $$
  SELECT
    skill_name,
    1 - (embedding_vector <=> query_vector) AS similarity
  FROM skill_embeddings
  ORDER BY embedding_vector <=> query_vector
  LIMIT top_k;
$$;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE skill_embeddings IS
  'Stores OpenAI embedding vectors for each skill. Used by SemanticSkillEngine for cosine similarity search.';

COMMENT ON TABLE job_embeddings IS
  'Stores combined embedding vectors for job listings. Used by SemanticJobMatchingEngine.';

COMMENT ON TABLE semantic_match_cache IS
  'Short-lived cache for user↔job semantic match scores. TTL 10 min mirrors Redis layer.';

COMMENT ON TABLE career_advice_cache IS
  'Persists AI-generated career advice. Invalidated when profile hash changes or TTL expires.';
