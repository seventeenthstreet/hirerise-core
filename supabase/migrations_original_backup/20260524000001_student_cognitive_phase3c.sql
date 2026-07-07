-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260524000001_student_cognitive_phase3c.sql
-- Phase 3C — Cognitive & Processing Intelligence
--
-- DESIGN PRINCIPLES:
--   • cognitive_taxonomy        — backend-driven, never hardcoded in UI
--   • cognitive_questions       — scenario-based questions (not personality prompts)
--   • cognitive_options         — weighted option rows per question
--   • student_cognitive_responses — raw per-question responses (immutable once written)
--   • student_cognitive_signals   — normalized derived signal layer (engine-writable)
--   • RLS-compatible            — user_id gated on every student table
--   • Future-AI-safe            — signal columns nullable for engine writes
--   • Progressive persistence   — partial saves supported at every layer
--   • Audit-safe                — immutable created_at, auto-updated updated_at
--   • Idempotent                — all DDL uses IF NOT EXISTS / DO $$ BEGIN
--
-- COGNITIVE DOMAIN MAP:
--   problem_solving    — how the student approaches unknowns
--   learning_preference — how they absorb new material
--   decision_making    — how they choose under uncertainty
--   execution_pattern  — how they deliver work
--   information_processing — how they structure knowledge
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: cognitive_domain_enum
-- Top-level taxonomy groupings. Never remove values; deprecate with comment.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE cognitive_domain_enum AS ENUM (
    'problem_solving',
    'learning_preference',
    'decision_making',
    'execution_pattern',
    'information_processing'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: cognitive_signal_tag_enum
-- Normalized signal tags. Each option maps to one or more of these tags.
-- These are the atomic units the intelligence engine will consume.
-- Never remove values; add new ones with a migration comment.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE cognitive_signal_tag_enum AS ENUM (
    -- Problem-solving signals
    'analytical',
    'experimental',
    'structured',
    'intuitive',
    'iterative',
    'visual_first',
    'logic_first',

    -- Learning preference signals
    'reading_learner',
    'visual_learner',
    'hands_on_learner',
    'guided_learner',
    'independent_explorer',
    'collaborative_learner',

    -- Decision-making signals
    'fast_decider',
    'research_heavy',
    'risk_balanced',
    'exploratory_decider',
    'certainty_seeker',

    -- Execution pattern signals
    'planner',
    'rapid_executor',
    'perfection_oriented',
    'adaptive_worker',
    'multitask_oriented',

    -- Information processing signals
    'detail_focused',
    'big_picture_oriented',
    'systems_thinker',
    'sequential_thinker',
    'abstract_thinker'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: cognitive_taxonomy
-- Backend-driven domain taxonomy. Defines the five cognitive domains.
-- Seeded once; updated by migrations only.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cognitive_taxonomy (
  id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  domain         cognitive_domain_enum NOT NULL UNIQUE,
  display_name   text         NOT NULL,
  description    text,
  display_order  smallint     NOT NULL DEFAULT 0,
  is_active      boolean      NOT NULL DEFAULT true,
  created_at     timestamptz  NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: cognitive_questions
-- Scenario-based questions, grouped by domain.
-- is_required = true  → student must answer to commit the step
-- is_required = false → optional enrichment signal
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cognitive_questions (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  taxonomy_id     uuid         NOT NULL REFERENCES cognitive_taxonomy(id) ON DELETE CASCADE,
  question_key    text         NOT NULL UNIQUE,   -- stable string key, e.g. 'learn_new_skill'
  question_text   text         NOT NULL,
  hint_text       text,                            -- optional contextual hint shown in UI
  allows_multi    boolean      NOT NULL DEFAULT false, -- true = multi-select; false = single-select
  is_required     boolean      NOT NULL DEFAULT false,
  display_order   smallint     NOT NULL DEFAULT 0,
  is_active       boolean      NOT NULL DEFAULT true,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: cognitive_options
-- Answer options for each question. Each option carries weighted signal tags
-- as a JSONB payload so the intelligence engine can read them without joins.
--
-- signal_weights shape:
--   { "systems_thinker": 0.8, "hands_on_learner": 0.6 }
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cognitive_options (
  id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id    uuid         NOT NULL REFERENCES cognitive_questions(id) ON DELETE CASCADE,
  option_key     text         NOT NULL,          -- e.g. 'watch_demo'
  option_text    text         NOT NULL,
  signal_weights jsonb        NOT NULL DEFAULT '{}', -- { signal_tag: weight (0.0–1.0) }
  display_order  smallint     NOT NULL DEFAULT 0,
  is_active      boolean      NOT NULL DEFAULT true,
  created_at     timestamptz  NOT NULL DEFAULT now(),

  UNIQUE (question_id, option_key)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: student_cognitive_responses
-- Raw, immutable response records — one row per question per student.
-- Upserted on user_id + question_id (user can change answer before commit).
-- After commit, treated as audit-safe.
--
-- selected_option_keys: array of option_key values (supports multi-select).
-- response_metadata: future-safe bag for UI timing, revision_count, etc.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_cognitive_responses (
  id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question_id           uuid         NOT NULL REFERENCES cognitive_questions(id) ON DELETE RESTRICT,
  selected_option_keys  text[]       NOT NULL DEFAULT '{}',
  is_partial            boolean      NOT NULL DEFAULT true,  -- true until commit
  response_metadata     jsonb        NOT NULL DEFAULT '{}',  -- future: timing, revision count
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),

  UNIQUE (user_id, question_id)
);

-- auto-update updated_at
CREATE OR REPLACE FUNCTION update_cognitive_responses_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cognitive_responses_updated_at ON student_cognitive_responses;
CREATE TRIGGER trg_cognitive_responses_updated_at
  BEFORE UPDATE ON student_cognitive_responses
  FOR EACH ROW EXECUTE FUNCTION update_cognitive_responses_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: student_cognitive_signals
-- Derived signal layer — written by the signal extraction infrastructure
-- (and eventually by the intelligence engine). NOT written by the API directly.
--
-- signal_tags: aggregated tags across all responses for this student
-- signal_weights: weighted score per tag, e.g. { "systems_thinker": 0.72 }
-- domain_vectors: per-domain aggregated weight vector
-- metadata: engine version, extraction timestamp, processing flags
--
-- One row per student. Upserted on commit + any future engine re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_cognitive_signals (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid         NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_tags       text[]       NOT NULL DEFAULT '{}',      -- sorted tag list
  signal_weights    jsonb        NOT NULL DEFAULT '{}',      -- { tag: float }
  domain_vectors    jsonb        NOT NULL DEFAULT '{}',      -- { domain: { tag: float } }
  response_count    smallint     NOT NULL DEFAULT 0,         -- how many questions answered
  is_partial        boolean      NOT NULL DEFAULT true,
  engine_version    text,                                    -- NULL until engine processes
  extracted_at      timestamptz,                             -- NULL until signal extracted
  metadata          jsonb        NOT NULL DEFAULT '{}',
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_cognitive_signals_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cognitive_signals_updated_at ON student_cognitive_signals;
CREATE TRIGGER trg_cognitive_signals_updated_at
  BEFORE UPDATE ON student_cognitive_signals
  FOR EACH ROW EXECUTE FUNCTION update_cognitive_signals_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_cognitive_questions_taxonomy_id
  ON cognitive_questions(taxonomy_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_cognitive_options_question_id
  ON cognitive_options(question_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_student_cognitive_responses_user_id
  ON student_cognitive_responses(user_id);

CREATE INDEX IF NOT EXISTS idx_student_cognitive_responses_user_question
  ON student_cognitive_responses(user_id, question_id);

CREATE INDEX IF NOT EXISTS idx_student_cognitive_signals_user_id
  ON student_cognitive_signals(user_id);

-- JSONB GIN indexes for future engine queries
CREATE INDEX IF NOT EXISTS idx_cognitive_signals_weights_gin
  ON student_cognitive_signals USING gin(signal_weights);

CREATE INDEX IF NOT EXISTS idx_cognitive_options_signal_weights_gin
  ON cognitive_options USING gin(signal_weights);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────────────────────────────────────────

-- cognitive_taxonomy, cognitive_questions, cognitive_options are public reads
ALTER TABLE cognitive_taxonomy       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cognitive_questions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE cognitive_options        ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_cognitive_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_cognitive_signals   ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

-- Taxonomy, questions, options: read-only for authenticated users

DROP POLICY IF EXISTS "cognitive_taxonomy_read"
ON cognitive_taxonomy;

CREATE POLICY "cognitive_taxonomy_read"
ON cognitive_taxonomy
FOR SELECT
TO authenticated
USING (is_active = true);

DROP POLICY IF EXISTS "cognitive_questions_read"
ON cognitive_questions;

CREATE POLICY "cognitive_questions_read"
ON cognitive_questions
FOR SELECT
TO authenticated
USING (is_active = true);

DROP POLICY IF EXISTS "cognitive_options_read"
ON cognitive_options;

CREATE POLICY "cognitive_options_read"
ON cognitive_options
FOR SELECT
TO authenticated
USING (is_active = true);

-- =============================================================================
-- STUDENT RESPONSES
-- =============================================================================

DROP POLICY IF EXISTS "cognitive_responses_own_select"
ON student_cognitive_responses;

CREATE POLICY "cognitive_responses_own_select"
ON student_cognitive_responses
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "cognitive_responses_own_insert"
ON student_cognitive_responses;

CREATE POLICY "cognitive_responses_own_insert"
ON student_cognitive_responses
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "cognitive_responses_own_update"
ON student_cognitive_responses;

CREATE POLICY "cognitive_responses_own_update"
ON student_cognitive_responses
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- =============================================================================
-- STUDENT SIGNALS
-- =============================================================================

DROP POLICY IF EXISTS "cognitive_signals_own_select"
ON student_cognitive_signals;

CREATE POLICY "cognitive_signals_own_select"
ON student_cognitive_signals
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED: cognitive_taxonomy
-- Five canonical domains. Ordered for UX flow.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO cognitive_taxonomy (domain, display_name, description, display_order) VALUES
  ('learning_preference',    'Learning Style',         'How you absorb and process new information',              1),
  ('problem_solving',        'Problem-Solving Style',  'How you approach challenges and unknowns',                2),
  ('decision_making',        'Decision-Making Style',  'How you evaluate options and make choices',               3),
  ('execution_pattern',      'Work & Execution Style', 'How you plan and deliver tasks',                         4),
  ('information_processing', 'Information Processing', 'How you structure and reason about knowledge',            5)
ON CONFLICT (domain) DO UPDATE SET
  display_name  = EXCLUDED.display_name,
  description   = EXCLUDED.description,
  display_order = EXCLUDED.display_order;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED: cognitive_questions + cognitive_options
-- All questions are scenario-based (not personality statements).
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_learning_id     uuid;
  v_problem_id      uuid;
  v_decision_id     uuid;
  v_execution_id    uuid;
  v_processing_id   uuid;

  v_q1  uuid; v_q2  uuid; v_q3  uuid;
  v_q4  uuid; v_q5  uuid; v_q6  uuid;
  v_q7  uuid; v_q8  uuid; v_q9  uuid;
  v_q10 uuid;
BEGIN

  SELECT id INTO v_learning_id     FROM cognitive_taxonomy WHERE domain = 'learning_preference';
  SELECT id INTO v_problem_id      FROM cognitive_taxonomy WHERE domain = 'problem_solving';
  SELECT id INTO v_decision_id     FROM cognitive_taxonomy WHERE domain = 'decision_making';
  SELECT id INTO v_execution_id    FROM cognitive_taxonomy WHERE domain = 'execution_pattern';
  SELECT id INTO v_processing_id   FROM cognitive_taxonomy WHERE domain = 'information_processing';

  -- ── Q1: Learning a new skill ────────────────────────────────────────────────
  INSERT INTO cognitive_questions (taxonomy_id, question_key, question_text, hint_text, allows_multi, is_required, display_order)
  VALUES (v_learning_id, 'learn_new_skill',
    'When you need to learn something completely new, what usually works best for you?',
    'Think about a subject or skill you picked up recently.',
    false, true, 1)
  ON CONFLICT (question_key) DO NOTHING
  RETURNING id INTO v_q1;

  IF v_q1 IS NOT NULL THEN
    INSERT INTO cognitive_options (question_id, option_key, option_text, signal_weights, display_order) VALUES
      (v_q1, 'watch_demo',   'Watch someone do it first, then copy',           '{"visual_learner": 0.9, "guided_learner": 0.5}',             1),
      (v_q1, 'try_myself',   'Dive in and figure it out as I go',              '{"hands_on_learner": 0.9, "experimental": 0.6}',             2),
      (v_q1, 'read_docs',    'Read through documentation or a detailed guide', '{"reading_learner": 0.9, "analytical": 0.5}',                3),
      (v_q1, 'break_system', 'Break it into smaller pieces and learn each part','{"systems_thinker": 0.8, "sequential_thinker": 0.7}',       4),
      (v_q1, 'ask_discuss',  'Discuss it with someone who already knows it',   '{"collaborative_learner": 0.9, "guided_learner": 0.6}',      5)
    ON CONFLICT (question_id, option_key) DO NOTHING;
  END IF;

  -- ── Q2: Facing a hard problem ───────────────────────────────────────────────
  SELECT id INTO v_q2 FROM cognitive_questions WHERE question_key = 'hard_problem_approach';
  IF v_q2 IS NULL THEN
    INSERT INTO cognitive_questions (taxonomy_id, question_key, question_text, hint_text, allows_multi, is_required, display_order)
    VALUES (v_problem_id, 'hard_problem_approach',
      'You are stuck on a difficult problem you have never seen before. What do you usually do first?',
      NULL, false, true, 1)
    RETURNING id INTO v_q2;

    INSERT INTO cognitive_options (question_id, option_key, option_text, signal_weights, display_order) VALUES
      (v_q2, 'research_first',  'Search for information before attempting anything',  '{"research_heavy": 0.9, "analytical": 0.6}',            1),
      (v_q2, 'trial_error',     'Try different approaches until something works',     '{"experimental": 0.9, "iterative": 0.8}',               2),
      (v_q2, 'draw_diagram',    'Sketch or diagram the problem to visualize it',      '{"visual_first": 0.9, "systems_thinker": 0.6}',         3),
      (v_q2, 'structured_plan', 'Write out a structured plan before doing anything',  '{"structured": 0.9, "planner": 0.7}',                   4),
      (v_q2, 'gut_instinct',    'Go with instinct and adjust as new info comes in',   '{"intuitive": 0.9, "adaptive_worker": 0.6}',            5)
    ON CONFLICT (question_id, option_key) DO NOTHING;
  END IF;

  -- ── Q3: Learning preference enrichment (multi-select) ──────────────────────
  SELECT id INTO v_q3 FROM cognitive_questions WHERE question_key = 'learning_context_preference';
  IF v_q3 IS NULL THEN
    INSERT INTO cognitive_questions (taxonomy_id, question_key, question_text, hint_text, allows_multi, is_required, display_order)
    VALUES (v_learning_id, 'learning_context_preference',
      'Which of these usually makes learning easiest for you? Choose all that apply.',
      NULL, true, false, 2)
    RETURNING id INTO v_q3;

    INSERT INTO cognitive_options (question_id, option_key, option_text, signal_weights, display_order) VALUES
      (v_q3, 'visuals',         'Charts, diagrams, or videos',          '{"visual_learner": 0.8}',          1),
      (v_q3, 'practice',        'Practice problems or projects',        '{"hands_on_learner": 0.8}',        2),
      (v_q3, 'reading',         'Textbooks or detailed articles',       '{"reading_learner": 0.8}',         3),
      (v_q3, 'discussion',      'Talking it through with others',       '{"collaborative_learner": 0.8}',   4),
      (v_q3, 'self_discovery',  'Exploring on my own without guidance', '{"independent_explorer": 0.8}',    5)
    ON CONFLICT (question_id, option_key) DO NOTHING;
  END IF;

  -- ── Q4: Decision under uncertainty ─────────────────────────────────────────
  SELECT id INTO v_q4 FROM cognitive_questions WHERE question_key = 'decide_under_uncertainty';
  IF v_q4 IS NULL THEN
    INSERT INTO cognitive_questions (taxonomy_id, question_key, question_text, hint_text, allows_multi, is_required, display_order)
    VALUES (v_decision_id, 'decide_under_uncertainty',
      'You need to make an important choice but you do not have all the information. What do you typically do?',
      'Think about a real decision you had to make at school or outside it.',
      false, true, 1)
    RETURNING id INTO v_q4;

    INSERT INTO cognitive_options (question_id, option_key, option_text, signal_weights, display_order) VALUES
      (v_q4, 'gather_more',    'Keep gathering information until I feel confident',    '{"certainty_seeker": 0.9, "research_heavy": 0.6}',     1),
      (v_q4, 'decide_quickly', 'Decide quickly and adjust later if needed',            '{"fast_decider": 0.9, "adaptive_worker": 0.5}',         2),
      (v_q4, 'weigh_options',  'List pros and cons of each option carefully',         '{"risk_balanced": 0.9, "analytical": 0.7}',              3),
      (v_q4, 'explore_freely', 'Try a few options in parallel to see what works',     '{"exploratory_decider": 0.9, "iterative": 0.6}',        4)
    ON CONFLICT (question_id, option_key) DO NOTHING;
  END IF;

  -- ── Q5: Starting a big task ─────────────────────────────────────────────────
  SELECT id INTO v_q5 FROM cognitive_questions WHERE question_key = 'starting_big_task';
  IF v_q5 IS NULL THEN
    INSERT INTO cognitive_questions (taxonomy_id, question_key, question_text, hint_text, allows_multi, is_required, display_order)
    VALUES (v_execution_id, 'starting_big_task',
      'When you have a large assignment or project to complete, how do you usually begin?',
      NULL, false, true, 1)
    RETURNING id INTO v_q5;

    INSERT INTO cognitive_options (question_id, option_key, option_text, signal_weights, display_order) VALUES
      (v_q5, 'detailed_plan',  'Write out a detailed plan with milestones first',      '{"planner": 0.9, "structured": 0.7}',                   1),
      (v_q5, 'start_now',      'Start immediately and plan as I go',                   '{"rapid_executor": 0.9, "adaptive_worker": 0.6}',       2),
      (v_q5, 'perfect_first',  'Spend time upfront making sure my approach is right',  '{"perfection_oriented": 0.9, "structured": 0.5}',       3),
      (v_q5, 'parallel_tasks', 'Work on multiple parts at the same time',              '{"multitask_oriented": 0.9, "adaptive_worker": 0.4}',   4)
    ON CONFLICT (question_id, option_key) DO NOTHING;
  END IF;

  -- ── Q6: Understanding a new complex topic ──────────────────────────────────
  SELECT id INTO v_q6 FROM cognitive_questions WHERE question_key = 'understanding_new_topic';
  IF v_q6 IS NULL THEN
    INSERT INTO cognitive_questions (taxonomy_id, question_key, question_text, hint_text, allows_multi, is_required, display_order)
    VALUES (v_processing_id, 'understanding_new_topic',
      'When you encounter a new complex topic — like economics or genetics — what helps you understand it best?',
      NULL, false, true, 1)
    RETURNING id INTO v_q6;

    INSERT INTO cognitive_options (question_id, option_key, option_text, signal_weights, display_order) VALUES
      (v_q6, 'big_picture',   'Start with the big picture, then fill in details',      '{"big_picture_oriented": 0.9, "systems_thinker": 0.6}', 1),
      (v_q6, 'step_by_step',  'Build understanding step by step from the basics',      '{"sequential_thinker": 0.9, "structured": 0.5}',        2),
      (v_q6, 'find_patterns', 'Look for patterns and relationships between ideas',     '{"systems_thinker": 0.8, "analytical": 0.7}',           3),
      (v_q6, 'specific_facts','Focus on specific facts and examples first',            '{"detail_focused": 0.9, "sequential_thinker": 0.4}',    4),
      (v_q6, 'abstract_model','Try to build a mental model of how it works overall',   '{"abstract_thinker": 0.9, "systems_thinker": 0.7}',     5)
    ON CONFLICT (question_id, option_key) DO NOTHING;
  END IF;

  -- ── Q7: Working on something that goes wrong ────────────────────────────────
  SELECT id INTO v_q7 FROM cognitive_questions WHERE question_key = 'handling_setback';
  IF v_q7 IS NULL THEN
    INSERT INTO cognitive_questions (taxonomy_id, question_key, question_text, hint_text, allows_multi, is_required, display_order)
    VALUES (v_problem_id, 'handling_setback',
      'You are working on something important and it stops going according to plan. What do you tend to do?',
      NULL, false, false, 2)
    RETURNING id INTO v_q7;

    INSERT INTO cognitive_options (question_id, option_key, option_text, signal_weights, display_order) VALUES
      (v_q7, 'pause_analyse',  'Pause, figure out what went wrong, then restart',      '{"analytical": 0.8, "structured": 0.6}',                1),
      (v_q7, 'keep_trying',    'Keep trying variations until I find what works',       '{"iterative": 0.9, "experimental": 0.7}',               2),
      (v_q7, 'ask_someone',    'Ask someone with more experience for a direction',     '{"guided_learner": 0.7, "collaborative_learner": 0.5}', 3),
      (v_q7, 'adapt_pivot',    'Adapt the approach based on what the situation needs', '{"adaptive_worker": 0.9, "intuitive": 0.5}',            4),
      (v_q7, 'revisit_logic',  'Go back and re-check my original reasoning',          '{"logic_first": 0.9, "analytical": 0.7}',               5)
    ON CONFLICT (question_id, option_key) DO NOTHING;
  END IF;

  -- ── Q8: Checking your own work ──────────────────────────────────────────────
  SELECT id INTO v_q8 FROM cognitive_questions WHERE question_key = 'reviewing_own_work';
  IF v_q8 IS NULL THEN
    INSERT INTO cognitive_questions (taxonomy_id, question_key, question_text, hint_text, allows_multi, is_required, display_order)
    VALUES (v_execution_id, 'reviewing_own_work',
      'When you finish a piece of work, how do you usually review it before submitting?',
      NULL, false, false, 2)
    RETURNING id INTO v_q8;

    INSERT INTO cognitive_options (question_id, option_key, option_text, signal_weights, display_order) VALUES
      (v_q8, 'detailed_review', 'Go through it carefully line by line',               '{"perfection_oriented": 0.8, "detail_focused": 0.8}',   1),
      (v_q8, 'quick_scan',      'Do a quick scan for obvious errors and submit',      '{"rapid_executor": 0.7, "fast_decider": 0.5}',           2),
      (v_q8, 'peer_check',      'Ask someone else to look at it first',               '{"collaborative_learner": 0.7, "risk_balanced": 0.5}',   3),
      (v_q8, 'meets_goal',      'Check that it meets the original goal, not perfection','{"big_picture_oriented": 0.7, "adaptive_worker": 0.5}',4)
    ON CONFLICT (question_id, option_key) DO NOTHING;
  END IF;

  -- ── Q9: Exploring a new interest ────────────────────────────────────────────
  SELECT id INTO v_q9 FROM cognitive_questions WHERE question_key = 'exploring_new_interest';
  IF v_q9 IS NULL THEN
    INSERT INTO cognitive_questions (taxonomy_id, question_key, question_text, hint_text, allows_multi, is_required, display_order)
    VALUES (v_decision_id, 'exploring_new_interest',
      'You discover a new topic you find interesting — coding, psychology, design. What do you do?',
      NULL, false, false, 2)
    RETURNING id INTO v_q9;

    INSERT INTO cognitive_options (question_id, option_key, option_text, signal_weights, display_order) VALUES
      (v_q9, 'dive_deep',       'Spend hours going deep into it immediately',         '{"independent_explorer": 0.9, "fast_decider": 0.5}',    1),
      (v_q9, 'structured_path', 'Find a structured course or learning path first',    '{"guided_learner": 0.8, "structured": 0.6}',             2),
      (v_q9, 'sample_explore',  'Sample a bit of several things before committing',   '{"exploratory_decider": 0.9, "iterative": 0.5}',        3),
      (v_q9, 'compare_options', 'Research what the best way to learn it is first',    '{"research_heavy": 0.8, "certainty_seeker": 0.5}',      4)
    ON CONFLICT (question_id, option_key) DO NOTHING;
  END IF;

  -- ── Q10: Processing feedback ─────────────────────────────────────────────────
  SELECT id INTO v_q10 FROM cognitive_questions WHERE question_key = 'processing_feedback';
  IF v_q10 IS NULL THEN
    INSERT INTO cognitive_questions (taxonomy_id, question_key, question_text, hint_text, allows_multi, is_required, display_order)
    VALUES (v_processing_id, 'processing_feedback',
      'A teacher gives you feedback on a project. How do you typically process it?',
      NULL, false, false, 2)
    RETURNING id INTO v_q10;

    INSERT INTO cognitive_options (question_id, option_key, option_text, signal_weights, display_order) VALUES
      (v_q10, 'note_details',   'Write down every point and act on each one',          '{"detail_focused": 0.9, "sequential_thinker": 0.6}',    1),
      (v_q10, 'find_theme',     'Look for the main theme in the feedback',             '{"big_picture_oriented": 0.8, "analytical": 0.6}',      2),
      (v_q10, 'ask_clarify',    'Ask clarifying questions to fully understand it',     '{"certainty_seeker": 0.7, "guided_learner": 0.5}',      3),
      (v_q10, 'mental_model',   'Update my internal model of how things should be done','{"abstract_thinker": 0.8, "systems_thinker": 0.6}',   4)
    ON CONFLICT (question_id, option_key) DO NOTHING;
  END IF;

END $$;
