-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260523000001_student_activities_phase3b.sql
-- Phase 3B — Activities & Achievement Intelligence
--
-- DESIGN PRINCIPLES:
--   • activity_taxonomy       — backend-driven taxonomy, never hardcoded in UI
--   • student_activities      — one row per student per activity
--   • student_activity_achievements — separate from activity records (normalized)
--   • RLS-compatible          — user_id gated on every table
--   • Future-AI-safe          — signal columns left nullable for engine writes
--   • Progressive persistence — partial saves supported at every layer
--   • Audit-safe              — immutable created_at, auto-updated updated_at
--   • Idempotent              — all DDL uses IF NOT EXISTS / DO $$ BEGIN
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: activity_category_enum
-- Top-level grouping for the activity taxonomy.
-- Mirrors: ACTIVITY_CATEGORIES constant in backend constants/activities.js
-- CONTRACT: Never remove values. Deprecate with a 'deprecated_' prefix comment.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE activity_category_enum AS ENUM (
    'technical',
    'creative',
    'leadership',
    'academic',
    'social',
    'athletic'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: proficiency_level_enum
-- Normalized proficiency scale: 1–5.
-- Maps: beginner → developing → proficient → advanced → expert
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE proficiency_level_enum AS ENUM (
    'beginner',       -- 1
    'developing',     -- 2
    'proficient',     -- 3
    'advanced',       -- 4
    'expert'          -- 5
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: leadership_level_enum
-- Normalized leadership/responsibility scale.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE leadership_level_enum AS ENUM (
    'none',
    'participant',
    'coordinator',
    'lead',
    'captain',
    'founder'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: achievement_level_enum
-- Normalized achievement tier. 0 = participation, 6 = international.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE achievement_level_enum AS ENUM (
    'participation',    -- 0
    'school',           -- 1
    'inter_school',     -- 2
    'district',         -- 3
    'state',            -- 4
    'national',         -- 5
    'international'     -- 6
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: achievement_position_enum
-- Where the student placed.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE achievement_position_enum AS ENUM (
    'participant',
    'finalist',
    'runner_up',
    'winner'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: activity_taxonomy
-- Backend-driven taxonomy. Never hardcode activity names in UI components.
-- Populated by seed script / CMS. Read-only from RLS perspective (users SELECT only).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activity_taxonomy (
  id                  UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Slug used as the stable key (never shown to users directly)
  activity_key        TEXT                   NOT NULL UNIQUE
                        CHECK (activity_key ~ '^[a-z][a-z0-9_]{0,63}$'),

  -- Display label shown in the UI
  display_name        TEXT                   NOT NULL,

  -- Top-level category bucket
  category            activity_category_enum NOT NULL,

  -- Optional richer description for expanded activity cards
  description         TEXT                   NULL,

  -- Tags for searchable taxonomy (e.g. ['robotics', 'stem', 'competition'])
  -- Stored as TEXT[] to support full-text search and future embedding
  tags                TEXT[]                 NOT NULL DEFAULT '{}',

  -- Future: stream_affinity_hints stores JSON hints for the intelligence engine
  -- e.g. {"technical": 0.9, "creative": 0.2} — written by AI, never by UI
  stream_affinity_hints  JSONB               NULL,

  -- Ordering within category (lower = shown first)
  display_order       INTEGER                NOT NULL DEFAULT 100,

  -- Whether this activity is currently shown to users
  is_active           BOOLEAN                NOT NULL DEFAULT TRUE,

  -- Audit
  created_at          TIMESTAMPTZ            NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ            NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_taxonomy_category
  ON activity_taxonomy (category, display_order);

CREATE INDEX IF NOT EXISTS idx_activity_taxonomy_active
  ON activity_taxonomy (is_active, category);

CREATE INDEX IF NOT EXISTS idx_activity_taxonomy_tags
  ON activity_taxonomy USING gin (tags);

-- Trigger: keep updated_at in sync
CREATE OR REPLACE FUNCTION update_activity_taxonomy_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_activity_taxonomy_updated_at ON activity_taxonomy;
CREATE TRIGGER trg_activity_taxonomy_updated_at
  BEFORE UPDATE ON activity_taxonomy
  FOR EACH ROW EXECUTE FUNCTION update_activity_taxonomy_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: student_activities
-- One row per student per activity.
-- Stores participation depth, proficiency, leadership, and duration signals.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_activities (
  id                  UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID                   NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- FK to activity_taxonomy — the canonical activity definition
  activity_key        TEXT                   NOT NULL
                        REFERENCES activity_taxonomy(activity_key) ON DELETE RESTRICT,

  -- Denormalized for fast analytics queries (avoids join in signal extraction)
  activity_category   activity_category_enum NOT NULL,

  -- ── Participation Depth ───────────────────────────────────────────────────

  -- Proficiency level (1–5 scale)
  proficiency_level   proficiency_level_enum NULL,

  -- Duration in months (nullable → partial save supported)
  duration_months     INTEGER                NULL
                        CHECK (duration_months IS NULL OR duration_months >= 0),

  -- Weekly frequency in hours (nullable → partial save supported)
  weekly_frequency    NUMERIC(5, 1)          NULL
                        CHECK (weekly_frequency IS NULL OR weekly_frequency >= 0),

  -- Whether still actively doing this activity
  currently_active    BOOLEAN                NOT NULL DEFAULT TRUE,

  -- ── Leadership Signal ─────────────────────────────────────────────────────

  leadership_level    leadership_level_enum  NOT NULL DEFAULT 'participant',

  -- ── Partial Save State ────────────────────────────────────────────────────

  -- TRUE = depth details not yet filled in (activity just added to the list)
  -- FALSE = depth step completed for this activity
  is_partial          BOOLEAN                NOT NULL DEFAULT TRUE,

  -- ── Future Intelligence Engine Slots ─────────────────────────────────────
  -- These columns are reserved for the signal extraction engine.
  -- NEVER populated from the UI. Written only by backend signal processors.

  -- Normalized composite signal score (0.0–1.0). NULL until engine writes.
  signal_score        NUMERIC(4, 3)          NULL
                        CHECK (signal_score IS NULL OR (signal_score >= 0 AND signal_score <= 1)),

  -- Raw signal metadata JSON for the intelligence engine (opaque to UI)
  signal_metadata     JSONB                  NULL,

  -- Audit
  created_at          TIMESTAMPTZ            NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ            NOT NULL DEFAULT NOW(),

  -- Uniqueness: one row per student per activity
  CONSTRAINT uq_student_activity_user_key UNIQUE (user_id, activity_key)
);

-- Trigger: keep updated_at in sync
CREATE OR REPLACE FUNCTION update_student_activities_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_student_activities_updated_at ON student_activities;
CREATE TRIGGER trg_student_activities_updated_at
  BEFORE UPDATE ON student_activities
  FOR EACH ROW EXECUTE FUNCTION update_student_activities_updated_at();

CREATE INDEX IF NOT EXISTS idx_student_activities_user_id
  ON student_activities (user_id);

CREATE INDEX IF NOT EXISTS idx_student_activities_user_category
  ON student_activities (user_id, activity_category);

CREATE INDEX IF NOT EXISTS idx_student_activities_leadership
  ON student_activities (user_id, leadership_level);

CREATE INDEX IF NOT EXISTS idx_student_activities_proficiency
  ON student_activities (user_id, proficiency_level);

CREATE INDEX IF NOT EXISTS idx_student_activities_partial
  ON student_activities (user_id, is_partial);

-- Future signal extraction: filter by score
CREATE INDEX IF NOT EXISTS idx_student_activities_signal_score
  ON student_activities (user_id, signal_score DESC NULLS LAST);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: student_activity_achievements
-- Normalized achievement records. One row per achievement per activity.
-- DO NOT store achievements as JSON in student_activities — normalization enables
-- future analytics: achievement level distribution, velocity, affinity scoring.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_activity_achievements (
  id                  UUID                      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID                      NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- FK to student_activities — achievements belong to a specific activity record
  student_activity_id UUID                      NOT NULL
                        REFERENCES student_activities(id) ON DELETE CASCADE,

  -- ── Achievement Metadata ──────────────────────────────────────────────────

  -- Free-text title (e.g. "Inter-school Robotics Championship")
  achievement_title   TEXT                      NOT NULL
                        CHECK (char_length(achievement_title) >= 2 AND char_length(achievement_title) <= 200),

  -- Normalized tier level (0=participation → 6=international)
  achievement_level   achievement_level_enum    NOT NULL,

  -- Position / outcome
  achievement_position achievement_position_enum NULL,

  -- Year of achievement (4-digit year, validated range)
  achievement_year    SMALLINT                  NULL
                        CHECK (achievement_year IS NULL OR (achievement_year >= 2000 AND achievement_year <= 2030)),

  -- ── Future Intelligence Engine Slots ─────────────────────────────────────
  -- Normalized achievement score (0.0–1.0). Written by signal engine, not UI.
  normalized_score    NUMERIC(4, 3)             NULL
                        CHECK (normalized_score IS NULL OR (normalized_score >= 0 AND normalized_score <= 1)),

  -- Raw signal metadata for the intelligence engine (opaque to UI)
  signal_metadata     JSONB                     NULL,

  -- Audit
  created_at          TIMESTAMPTZ               NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ               NOT NULL DEFAULT NOW()
);

-- Trigger: keep updated_at in sync
CREATE OR REPLACE FUNCTION update_achievements_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_achievements_updated_at ON student_activity_achievements;
CREATE TRIGGER trg_achievements_updated_at
  BEFORE UPDATE ON student_activity_achievements
  FOR EACH ROW EXECUTE FUNCTION update_achievements_updated_at();

CREATE INDEX IF NOT EXISTS idx_achievements_user_id
  ON student_activity_achievements (user_id);

CREATE INDEX IF NOT EXISTS idx_achievements_student_activity_id
  ON student_activity_achievements (student_activity_id);

CREATE INDEX IF NOT EXISTS idx_achievements_level
  ON student_activity_achievements (user_id, achievement_level);

CREATE INDEX IF NOT EXISTS idx_achievements_year
  ON student_activity_achievements (user_id, achievement_year DESC NULLS LAST);

-- Future: achievement tier analytics across cohorts
CREATE INDEX IF NOT EXISTS idx_achievements_level_position
  ON student_activity_achievements (achievement_level, achievement_position);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: student_activity_reflections
-- Optional lightweight reflection signals (Step 5).
-- One row per student — upserted, not versioned.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_activity_reflections (
  id                        UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,

  -- FK references — nullable because reflection is optional
  favorite_activity_key     TEXT    NULL REFERENCES activity_taxonomy(activity_key) ON DELETE SET NULL,
  pursue_seriously_key      TEXT    NULL REFERENCES activity_taxonomy(activity_key) ON DELETE SET NULL,

  -- Free text: proudest achievement (max 500 chars)
  proudest_achievement_text TEXT    NULL
                              CHECK (proudest_achievement_text IS NULL OR char_length(proudest_achievement_text) <= 500),

  -- Audit
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_reflections_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reflections_updated_at ON student_activity_reflections;
CREATE TRIGGER trg_reflections_updated_at
  BEFORE UPDATE ON student_activity_reflections
  FOR EACH ROW EXECUTE FUNCTION update_reflections_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS POLICIES
-- activity_taxonomy: all authenticated users may SELECT
-- student_activities: users own their rows
-- student_activity_achievements: users own their rows
-- student_activity_reflections: users own their rows
-- ─────────────────────────────────────────────────────────────────────────────

-- activity_taxonomy — read-only for all authenticated users
ALTER TABLE activity_taxonomy ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "taxonomy_select_authenticated" ON activity_taxonomy;
CREATE POLICY "taxonomy_select_authenticated"
  ON activity_taxonomy
  FOR SELECT
  TO authenticated
  USING (is_active = TRUE);

-- student_activities
ALTER TABLE student_activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "student_activities_select_own" ON student_activities;
CREATE POLICY "student_activities_select_own"
  ON student_activities FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "student_activities_insert_own" ON student_activities;
CREATE POLICY "student_activities_insert_own"
  ON student_activities FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "student_activities_update_own" ON student_activities;
CREATE POLICY "student_activities_update_own"
  ON student_activities FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "student_activities_delete_own" ON student_activities;
CREATE POLICY "student_activities_delete_own"
  ON student_activities FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- student_activity_achievements
ALTER TABLE student_activity_achievements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "achievements_select_own" ON student_activity_achievements;
CREATE POLICY "achievements_select_own"
  ON student_activity_achievements FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "achievements_insert_own" ON student_activity_achievements;
CREATE POLICY "achievements_insert_own"
  ON student_activity_achievements FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "achievements_update_own" ON student_activity_achievements;
CREATE POLICY "achievements_update_own"
  ON student_activity_achievements FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "achievements_delete_own" ON student_activity_achievements;
CREATE POLICY "achievements_delete_own"
  ON student_activity_achievements FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- student_activity_reflections
ALTER TABLE student_activity_reflections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reflections_select_own" ON student_activity_reflections;
CREATE POLICY "reflections_select_own"
  ON student_activity_reflections FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "reflections_insert_own" ON student_activity_reflections;
CREATE POLICY "reflections_insert_own"
  ON student_activity_reflections FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "reflections_update_own" ON student_activity_reflections;
CREATE POLICY "reflections_update_own"
  ON student_activity_reflections FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED: activity_taxonomy
-- Initial taxonomy data. Run once. Safe to re-run (INSERT ... ON CONFLICT DO NOTHING).
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO activity_taxonomy (activity_key, display_name, category, description, tags, display_order) VALUES
  -- TECHNICAL
  ('robotics',         'Robotics',            'technical',  'Building and programming robots',                ARRAY['stem','engineering','competition'],       10),
  ('coding',           'Coding & Programming','technical',  'Writing code and building software',             ARRAY['programming','software','stem'],          20),
  ('electronics',      'Electronics & IoT',   'technical',  'Hardware projects, Arduino, Raspberry Pi',       ARRAY['hardware','stem','engineering'],          30),
  ('app_development',  'App Development',     'technical',  'Building mobile or web applications',            ARRAY['software','mobile','web'],                40),
  ('data_science',     'Data & AI Projects',  'technical',  'Data analysis, machine learning projects',       ARRAY['data','ai','math'],                       50),
  ('cybersecurity',    'Cybersecurity',        'technical',  'Ethical hacking, security research',             ARRAY['security','programming','stem'],          60),

  -- CREATIVE
  ('music',            'Music',               'creative',   'Playing instruments, composing, singing',        ARRAY['instrument','performance','arts'],        10),
  ('visual_arts',      'Visual Arts',         'creative',   'Drawing, painting, sculpture',                   ARRAY['drawing','painting','arts'],              20),
  ('photography',      'Photography',         'creative',   'Photography and photo editing',                  ARRAY['visual','media','arts'],                  30),
  ('filmmaking',       'Filmmaking & Video',  'creative',   'Making films, YouTube, short films',             ARRAY['video','media','storytelling'],           40),
  ('design',           'Graphic Design & UI', 'creative',   'Visual communication, UI/UX design',             ARRAY['design','visual','digital'],              50),
  ('writing',          'Creative Writing',    'creative',   'Fiction, poetry, blogging',                      ARRAY['writing','storytelling','language'],      60),
  ('theatre',          'Theatre & Drama',     'creative',   'Acting, directing, stage performance',           ARRAY['performance','arts','expression'],        70),
  ('dance',            'Dance',               'creative',   'Classical, contemporary, or folk dance',         ARRAY['performance','arts','physical'],          80),

  -- LEADERSHIP
  ('student_council',  'Student Council',     'leadership', 'Student government and school leadership',       ARRAY['governance','school','leadership'],       10),
  ('entrepreneurship', 'Entrepreneurship',    'leadership', 'Starting ventures, business projects',           ARRAY['business','startup','innovation'],        20),
  ('public_speaking',  'Public Speaking',     'leadership', 'Speeches, presentations, oratory',               ARRAY['communication','rhetoric','confidence'],  30),
  ('ngo_founding',     'NGO / Social Venture','leadership', 'Starting or running a social initiative',        ARRAY['social','impact','leadership'],           40),
  ('event_organizing', 'Event Organizing',    'leadership', 'Planning and managing events or fests',          ARRAY['management','coordination','leadership'], 50),

  -- ACADEMIC
  ('debate',           'Debate',              'academic',   'Formal debate, MUN, parliamentary',              ARRAY['argumentation','rhetoric','critical'],    10),
  ('mun',              'Model United Nations','academic',   'Simulating international diplomacy',              ARRAY['diplomacy','speech','debate'],            20),
  ('olympiads',        'Science Olympiads',   'academic',   'Physics, Chemistry, Math olympiads',             ARRAY['competition','stem','academic'],          30),
  ('math_competitions','Math Competitions',   'academic',   'Competitive mathematics',                        ARRAY['math','competition','problem-solving'],   40),
  ('research',         'Research Projects',   'academic',   'Independent academic research',                  ARRAY['science','inquiry','academic'],           50),
  ('quiz',             'Quiz & Trivia',        'academic',   'Academic quiz competitions',                     ARRAY['knowledge','competition','academic'],     60),

  -- SOCIAL
  ('volunteering',     'Volunteering / NGO',  'social',     'Community service, working with NGOs',           ARRAY['service','community','empathy'],          10),
  ('environmental',    'Environmental Action','social',      'Sustainability, eco-initiatives, cleanups',     ARRAY['environment','climate','community'],      20),
  ('mentoring',        'Peer Mentoring',       'social',     'Helping and guiding classmates',                 ARRAY['teaching','leadership','empathy'],        30),
  ('journalism',       'School Journalism',   'social',     'Writing for school newspaper or magazine',       ARRAY['writing','media','communication'],        40),

  -- ATHLETIC
  ('team_sports',      'Team Sports',         'athletic',   'Cricket, football, basketball, etc.',            ARRAY['sports','teamwork','competition'],        10),
  ('individual_sports','Individual Sports',   'athletic',   'Athletics, swimming, badminton, tennis',         ARRAY['sports','fitness','competition'],         20),
  ('martial_arts',     'Martial Arts',        'athletic',   'Karate, judo, taekwondo, wrestling',             ARRAY['sports','discipline','self-defense'],     30),
  ('yoga_fitness',     'Yoga & Fitness',       'athletic',   'Yoga practice, strength training',               ARRAY['fitness','wellness','discipline'],        40),
  ('esports',          'Esports & Gaming',    'athletic',   'Competitive gaming, esports teams',              ARRAY['gaming','strategy','competition'],        50)
ON CONFLICT (activity_key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- COMMENT DOCUMENTATION
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE activity_taxonomy IS
  'Backend-driven activity taxonomy. Never hardcode activity names in UI. Seeded and CMS-managed.';

COMMENT ON TABLE student_activities IS
  'One row per student per activity. Stores participation depth, proficiency, and leadership signals. '
  'signal_score and signal_metadata are reserved for the intelligence engine — never written by UI.';

COMMENT ON TABLE student_activity_achievements IS
  'Normalized achievement records. One row per achievement per activity. '
  'Separate from student_activities to enable achievement-level analytics and future tier scoring.';

COMMENT ON TABLE student_activity_reflections IS
  'Optional reflection signals collected in Step 5. One row per student (upserted).';

COMMENT ON COLUMN student_activities.signal_score IS
  'Reserved for intelligence engine. Composite normalized signal (0–1). Never written by UI layer.';

COMMENT ON COLUMN student_activity_achievements.normalized_score IS
  'Reserved for intelligence engine. Normalized achievement weight (0–1). Never written by UI layer.';
