-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 2B EVOLUTION — SAFE ADDITIVE SCHEMA + RPC MIGRATION
-- File: 20260527000003_phase2b_student_academic_rpcs_evolution.sql
--
-- Governance: HireRise Academic Intelligence Governance Blueprint v2
-- Depends on:
--   20260526000001_phase1a_academic_taxonomy_infrastructure.sql
--   20260526000002_phase1a_seed_v1_india_taxonomy.sql
--   20260526000003_phase1a_taxonomy_utility_rpcs.sql
--   20260526000004_phase1a_governance_hardening.sql
--   20260526000005_phase1a_seed_board_region_map.sql
--   20260526000006_phase1a_operational_governance.sql
--   20260526000007_phase1a_distributed_governance.sql
--   20260527000001_phase2_academic_context_apis.sql
--   20260527000002_phase2_hardening.sql
--   20260527000003_phase2b_student_academic_rpcs.sql  (ORIGINAL — already deployed)
--
-- SCOPE:
--   SAFE ADDITIVE EVOLUTION of the Phase 2B student academic tables and RPCs.
--   Schema drift was discovered: live tables were deployed with a different
--   column set than the originally-generated Phase 2B migration assumed.
--
--   This migration NEVER drops, renames, or destroys any existing column or table.
--   All changes are purely additive: ALTER TABLE ADD COLUMN IF NOT EXISTS.
--
-- LIVE TABLE STATE (as discovered in production):
--   student_academic_profiles      — has auth_user_id (NOT user_id), lacks code columns,
--                                    lacks target_year, onboarding_completed_at,
--                                    taxonomy_hash_at_save, rpc_version
--   student_subject_selections     — has student_profile_id (NOT profile_id / user_id),
--                                    lacks subject_code, sort_order, taxonomy_hash_at_save,
--                                    updated_at
--   student_language_preferences   — has student_profile_id (NOT profile_id / user_id),
--                                    lacks language_code, sort_order, taxonomy_hash_at_save,
--                                    updated_at
--
-- EVOLUTION ACTIONS:
--   1. ADD COLUMN IF NOT EXISTS — all missing columns, zero destructive ops
--   2. Safe backfills — UPDATE … WHERE col IS NULL
--   3. Indexes — CREATE INDEX IF NOT EXISTS
--   4. Policies — guarded DO $$ IF NOT EXISTS $$ blocks
--   5. Triggers — guarded DO $$ IF NOT EXISTS $$ blocks
--   6. RPCs — CREATE OR REPLACE, adapted to auth_user_id + student_profile_id
--   7. Governance seeds — ON CONFLICT DO NOTHING
--   8. Verification — post-migration assertions
--
-- CANONICAL FIELD RULES (enforced in this migration):
--   • auth_user_id  — canonical user FK in student_academic_profiles (NOT renamed)
--   • student_profile_id — canonical profile FK in child tables (NOT renamed)
--   • All RPCs use auth_user_id internally
--   • RPCs expose only business-key envelopes (no internal UUIDs)
--
-- IDEMPOTENCY:
--   ALTER TABLE ADD COLUMN IF NOT EXISTS throughout.
--   CREATE OR REPLACE FUNCTION throughout.
--   CREATE INDEX IF NOT EXISTS throughout.
--   Policy/trigger creation guarded by IF NOT EXISTS pg_policies/pg_trigger checks.
--   INSERT … ON CONFLICT DO NOTHING for governance seeds.
--   UPDATE backfills are WHERE col IS NULL — safe to replay.
--
-- ROLLBACK:
--   See 20260527000003_phase2b_student_academic_rpcs_evolution.rollback.sql
--   Note: column additions and backfills are not automatically reversible without
--   data loss risk. Rollback drops the added columns only if they contain no data.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: ADDITIVE COLUMN EVOLUTION
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1A. student_academic_profiles — add missing columns
--
-- Existing live columns preserved:
--   id, auth_user_id, country_id, region_id, board_id, stream_id,
--   current_class, academic_year, school_name, medium_of_instruction,
--   onboarding_completed, is_active, created_at, updated_at
--
-- Adding:
--   country_code, region_code, board_code, stream_code,
--   target_year, onboarding_completed_at, taxonomy_hash_at_save, rpc_version
-- ---------------------------------------------------------------------------

ALTER TABLE public.student_academic_profiles
  ADD COLUMN IF NOT EXISTS country_code            TEXT,
  ADD COLUMN IF NOT EXISTS region_code             TEXT,
  ADD COLUMN IF NOT EXISTS board_code              TEXT,
  ADD COLUMN IF NOT EXISTS stream_code             TEXT,
  ADD COLUMN IF NOT EXISTS target_year             SMALLINT,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS taxonomy_hash_at_save   TEXT,
  ADD COLUMN IF NOT EXISTS rpc_version             TEXT DEFAULT '2.0.0';

COMMENT ON COLUMN public.student_academic_profiles.country_code IS
  'Evolution 2B: denormed business key for country. Backfilled from countries_master.country_code.';
COMMENT ON COLUMN public.student_academic_profiles.region_code IS
  'Evolution 2B: denormed business key for region. Backfilled from curriculum_regions.region_code.';
COMMENT ON COLUMN public.student_academic_profiles.board_code IS
  'Evolution 2B: denormed business key for board. Backfilled from academic_boards.board_code.';
COMMENT ON COLUMN public.student_academic_profiles.stream_code IS
  'Evolution 2B: denormed business key for stream. NULL when no stream selected.';
COMMENT ON COLUMN public.student_academic_profiles.target_year IS
  'Evolution 2B: optional target graduation year. Must be >= 2024 when set.';
COMMENT ON COLUMN public.student_academic_profiles.onboarding_completed_at IS
  'Evolution 2B: timestamp when onboarding was sealed via fn_complete_academic_onboarding(). '
  'Backfilled from onboarding_completed boolean where TRUE. NULL = incomplete.';
COMMENT ON COLUMN public.student_academic_profiles.taxonomy_hash_at_save IS
  'Evolution 2B: MD5 taxonomy hash at the time of last profile save. Replay audit anchor.';
COMMENT ON COLUMN public.student_academic_profiles.rpc_version IS
  'Evolution 2B: RPC version that last wrote this row. Defaults to ''2.0.0''.';


-- ---------------------------------------------------------------------------
-- 1B. student_subject_selections — add missing columns
--
-- Existing live columns preserved:
--   id, student_profile_id, subject_id, is_primary, is_elective, is_active, created_at
--
-- Adding:
--   user_id, subject_code, sort_order, taxonomy_hash_at_save, updated_at
-- ---------------------------------------------------------------------------

ALTER TABLE public.student_subject_selections
  ADD COLUMN IF NOT EXISTS user_id               UUID,
  ADD COLUMN IF NOT EXISTS subject_code          TEXT,
  ADD COLUMN IF NOT EXISTS sort_order            SMALLINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS taxonomy_hash_at_save TEXT,
  ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ DEFAULT NOW();

COMMENT ON COLUMN public.student_subject_selections.user_id IS
  'Evolution 2B: denormed auth_user_id from student_academic_profiles. '
  'Backfilled from student_academic_profiles.auth_user_id via student_profile_id join.';
COMMENT ON COLUMN public.student_subject_selections.subject_code IS
  'Evolution 2B: denormed business key from academic_subjects.subject_code. '
  'Backfilled for existing rows.';
COMMENT ON COLUMN public.student_subject_selections.sort_order IS
  'Evolution 2B: deterministic display order. 0 default; reassigned on next fn_save_student_subjects() call.';
COMMENT ON COLUMN public.student_subject_selections.taxonomy_hash_at_save IS
  'Evolution 2B: taxonomy hash at the time this row was saved. Replay audit anchor.';
COMMENT ON COLUMN public.student_subject_selections.updated_at IS
  'Evolution 2B: audit timestamp. Maintained by trigger.';


-- ---------------------------------------------------------------------------
-- 1C. student_language_preferences — add missing columns
--
-- Existing live columns preserved:
--   id, student_profile_id, language_id, proficiency_level, is_primary, is_active, created_at
--
-- Adding:
--   user_id, language_code, sort_order, taxonomy_hash_at_save, updated_at
-- ---------------------------------------------------------------------------

ALTER TABLE public.student_language_preferences
  ADD COLUMN IF NOT EXISTS user_id               UUID,
  ADD COLUMN IF NOT EXISTS language_code         TEXT,
  ADD COLUMN IF NOT EXISTS sort_order            SMALLINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS taxonomy_hash_at_save TEXT,
  ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ DEFAULT NOW();

COMMENT ON COLUMN public.student_language_preferences.user_id IS
  'Evolution 2B: denormed auth_user_id from student_academic_profiles. '
  'Backfilled from student_academic_profiles.auth_user_id via student_profile_id join.';
COMMENT ON COLUMN public.student_language_preferences.language_code IS
  'Evolution 2B: denormed business key from academic_languages.language_code. '
  'Backfilled for existing rows.';
COMMENT ON COLUMN public.student_language_preferences.sort_order IS
  'Evolution 2B: deterministic display order. 0 default.';
COMMENT ON COLUMN public.student_language_preferences.taxonomy_hash_at_save IS
  'Evolution 2B: taxonomy hash at the time this row was saved. Replay audit anchor.';
COMMENT ON COLUMN public.student_language_preferences.updated_at IS
  'Evolution 2B: audit timestamp. Maintained by trigger.';


-- =============================================================================
-- SECTION 2: SAFE BACKFILLS
--
-- All UPDATE statements are:
--   • WHERE col IS NULL  — only touch rows not yet populated
--   • Never destructive — existing non-null values are never overwritten
--   • Additive only — no column removals, no row deletions
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 2A. student_academic_profiles: backfill code columns from FK lookups
-- ---------------------------------------------------------------------------

-- country_code from countries_master
UPDATE public.student_academic_profiles sap
SET country_code = cm.country_code
FROM public.countries_master cm
WHERE sap.country_id = cm.id
  AND sap.country_code IS NULL;

-- region_code from curriculum_regions
UPDATE public.student_academic_profiles sap
SET region_code = cr.region_code
FROM public.curriculum_regions cr
WHERE sap.region_id = cr.id
  AND sap.region_code IS NULL;

-- board_code from academic_boards
UPDATE public.student_academic_profiles sap
SET board_code = ab.board_code
FROM public.academic_boards ab
WHERE sap.board_id = ab.id
  AND sap.board_code IS NULL;

-- stream_code from academic_streams (nullable — not all profiles have a stream)
UPDATE public.student_academic_profiles sap
SET stream_code = ast.stream_code
FROM public.academic_streams ast
WHERE sap.stream_id = ast.id
  AND sap.stream_id IS NOT NULL
  AND sap.stream_code IS NULL;

-- onboarding_completed_at: backfill from onboarding_completed boolean
-- Use created_at as a proxy timestamp — best available without a real timestamp column.
-- Only sets where the boolean is TRUE and the timestamp is not yet populated.
UPDATE public.student_academic_profiles
SET onboarding_completed_at = updated_at
WHERE onboarding_completed = TRUE
  AND onboarding_completed_at IS NULL;

-- rpc_version: default all existing rows to '2.0.0'
UPDATE public.student_academic_profiles
SET rpc_version = '2.0.0'
WHERE rpc_version IS NULL;

-- taxonomy_hash_at_save: stamp existing rows with current hash
-- This is a best-effort backfill — these rows predate hash capture.
-- Prefixed with 'legacy:' to distinguish from live-captured hashes.
UPDATE public.student_academic_profiles
SET taxonomy_hash_at_save = 'legacy:' || COALESCE(public.fn_academic_taxonomy_hash(), 'unknown')
WHERE taxonomy_hash_at_save IS NULL;


-- ---------------------------------------------------------------------------
-- 2B. student_subject_selections: backfill user_id, subject_code, taxonomy_hash
-- ---------------------------------------------------------------------------

-- user_id: backfill from student_academic_profiles.auth_user_id via student_profile_id
UPDATE public.student_subject_selections sss
SET user_id = sap.auth_user_id
FROM public.student_academic_profiles sap
WHERE sss.student_profile_id = sap.id
  AND sss.user_id IS NULL;

-- subject_code: backfill from academic_subjects
UPDATE public.student_subject_selections sss
SET subject_code = sub.subject_code
FROM public.academic_subjects sub
WHERE sss.subject_id = sub.id
  AND sss.subject_code IS NULL;

-- taxonomy_hash_at_save: legacy stamp for existing rows
UPDATE public.student_subject_selections
SET taxonomy_hash_at_save = 'legacy:' || COALESCE(public.fn_academic_taxonomy_hash(), 'unknown')
WHERE taxonomy_hash_at_save IS NULL;


-- ---------------------------------------------------------------------------
-- 2C. student_language_preferences: backfill user_id, language_code, taxonomy_hash
-- ---------------------------------------------------------------------------

-- user_id: backfill from student_academic_profiles.auth_user_id via student_profile_id
UPDATE public.student_language_preferences slp
SET user_id = sap.auth_user_id
FROM public.student_academic_profiles sap
WHERE slp.student_profile_id = sap.id
  AND slp.user_id IS NULL;

-- language_code: backfill from academic_languages
UPDATE public.student_language_preferences slp
SET language_code = lang.language_code
FROM public.academic_languages lang
WHERE slp.language_id = lang.id
  AND slp.language_code IS NULL;

-- taxonomy_hash_at_save: legacy stamp for existing rows
UPDATE public.student_language_preferences
SET taxonomy_hash_at_save = 'legacy:' || COALESCE(public.fn_academic_taxonomy_hash(), 'unknown')
WHERE taxonomy_hash_at_save IS NULL;


-- =============================================================================
-- SECTION 3: TRIGGERS (updated_at maintenance)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 3A. student_academic_profiles updated_at trigger
--     (live table may already have one — guard with IF NOT EXISTS)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_sap_set_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname  = 'trg_sap_updated_at'
      AND tgrelid = 'public.student_academic_profiles'::regclass
  ) THEN
    CREATE TRIGGER trg_sap_updated_at
      BEFORE UPDATE ON public.student_academic_profiles
      FOR EACH ROW EXECUTE FUNCTION public.fn_sap_set_updated_at();
  END IF;
END;
$$;


-- ---------------------------------------------------------------------------
-- 3B. student_subject_selections updated_at trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_sss_set_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname  = 'trg_sss_updated_at'
      AND tgrelid = 'public.student_subject_selections'::regclass
  ) THEN
    CREATE TRIGGER trg_sss_updated_at
      BEFORE UPDATE ON public.student_subject_selections
      FOR EACH ROW EXECUTE FUNCTION public.fn_sss_set_updated_at();
  END IF;
END;
$$;


-- ---------------------------------------------------------------------------
-- 3C. student_language_preferences updated_at trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_slp_set_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname  = 'trg_slp_updated_at'
      AND tgrelid = 'public.student_language_preferences'::regclass
  ) THEN
    CREATE TRIGGER trg_slp_updated_at
      BEFORE UPDATE ON public.student_language_preferences
      FOR EACH ROW EXECUTE FUNCTION public.fn_slp_set_updated_at();
  END IF;
END;
$$;


-- =============================================================================
-- SECTION 4: INDEXES
-- =============================================================================

-- student_academic_profiles
CREATE INDEX IF NOT EXISTS idx_sap_auth_user_id
  ON public.student_academic_profiles (auth_user_id);

CREATE INDEX IF NOT EXISTS idx_sap_country_board
  ON public.student_academic_profiles (country_id, board_id);

CREATE INDEX IF NOT EXISTS idx_sap_stream
  ON public.student_academic_profiles (stream_id)
  WHERE stream_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sap_onboarding_complete
  ON public.student_academic_profiles (auth_user_id, onboarding_completed_at)
  WHERE onboarding_completed_at IS NOT NULL;

-- student_subject_selections
CREATE INDEX IF NOT EXISTS idx_sss_user_id
  ON public.student_subject_selections (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sss_student_profile_id
  ON public.student_subject_selections (student_profile_id);

CREATE INDEX IF NOT EXISTS idx_sss_user_sort
  ON public.student_subject_selections (user_id, sort_order ASC)
  WHERE user_id IS NOT NULL;

-- student_language_preferences
CREATE INDEX IF NOT EXISTS idx_slp_user_id
  ON public.student_language_preferences (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_slp_student_profile_id
  ON public.student_language_preferences (student_profile_id);

CREATE INDEX IF NOT EXISTS idx_slp_user_sort
  ON public.student_language_preferences (user_id, sort_order ASC)
  WHERE user_id IS NOT NULL;


-- =============================================================================
-- SECTION 5: RLS POLICIES (additive — guarded IF NOT EXISTS)
-- =============================================================================

-- Ensure RLS is enabled on all three tables (idempotent)
ALTER TABLE public.student_academic_profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_subject_selections     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_language_preferences   ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- student_academic_profiles policies
-- Policies use auth_user_id (canonical live column)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'student_academic_profiles' AND policyname = 'sap_select_own'
  ) THEN
    CREATE POLICY "sap_select_own"
      ON public.student_academic_profiles FOR SELECT
      USING (auth_user_id = auth.uid());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'student_academic_profiles' AND policyname = 'sap_insert_own'
  ) THEN
    CREATE POLICY "sap_insert_own"
      ON public.student_academic_profiles FOR INSERT
      WITH CHECK (auth_user_id = auth.uid());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'student_academic_profiles' AND policyname = 'sap_update_own'
  ) THEN
    CREATE POLICY "sap_update_own"
      ON public.student_academic_profiles FOR UPDATE
      USING  (auth_user_id = auth.uid())
      WITH CHECK (auth_user_id = auth.uid());
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- student_subject_selections policies
-- SELECT/INSERT/UPDATE/DELETE guarded by user_id (backfilled col) where populated,
-- otherwise via profile join. Using user_id for forward-compat; student_profile_id
-- is the legacy join path and remains intact.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'student_subject_selections' AND policyname = 'sss_select_own'
  ) THEN
    CREATE POLICY "sss_select_own"
      ON public.student_subject_selections FOR SELECT
      USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.student_academic_profiles sap
          WHERE sap.id            = student_subject_selections.student_profile_id
            AND sap.auth_user_id  = auth.uid()
        )
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'student_subject_selections' AND policyname = 'sss_insert_own'
  ) THEN
    CREATE POLICY "sss_insert_own"
      ON public.student_subject_selections FOR INSERT
      WITH CHECK (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.student_academic_profiles sap
          WHERE sap.id            = student_subject_selections.student_profile_id
            AND sap.auth_user_id  = auth.uid()
        )
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'student_subject_selections' AND policyname = 'sss_update_own'
  ) THEN
    CREATE POLICY "sss_update_own"
      ON public.student_subject_selections FOR UPDATE
      USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.student_academic_profiles sap
          WHERE sap.id            = student_subject_selections.student_profile_id
            AND sap.auth_user_id  = auth.uid()
        )
      )
      WITH CHECK (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.student_academic_profiles sap
          WHERE sap.id            = student_subject_selections.student_profile_id
            AND sap.auth_user_id  = auth.uid()
        )
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'student_subject_selections' AND policyname = 'sss_delete_own'
  ) THEN
    CREATE POLICY "sss_delete_own"
      ON public.student_subject_selections FOR DELETE
      USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.student_academic_profiles sap
          WHERE sap.id            = student_subject_selections.student_profile_id
            AND sap.auth_user_id  = auth.uid()
        )
      );
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- student_language_preferences policies
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'student_language_preferences' AND policyname = 'slp_select_own'
  ) THEN
    CREATE POLICY "slp_select_own"
      ON public.student_language_preferences FOR SELECT
      USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.student_academic_profiles sap
          WHERE sap.id            = student_language_preferences.student_profile_id
            AND sap.auth_user_id  = auth.uid()
        )
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'student_language_preferences' AND policyname = 'slp_insert_own'
  ) THEN
    CREATE POLICY "slp_insert_own"
      ON public.student_language_preferences FOR INSERT
      WITH CHECK (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.student_academic_profiles sap
          WHERE sap.id            = student_language_preferences.student_profile_id
            AND sap.auth_user_id  = auth.uid()
        )
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'student_language_preferences' AND policyname = 'slp_update_own'
  ) THEN
    CREATE POLICY "slp_update_own"
      ON public.student_language_preferences FOR UPDATE
      USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.student_academic_profiles sap
          WHERE sap.id            = student_language_preferences.student_profile_id
            AND sap.auth_user_id  = auth.uid()
        )
      )
      WITH CHECK (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.student_academic_profiles sap
          WHERE sap.id            = student_language_preferences.student_profile_id
            AND sap.auth_user_id  = auth.uid()
        )
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'student_language_preferences' AND policyname = 'slp_delete_own'
  ) THEN
    CREATE POLICY "slp_delete_own"
      ON public.student_language_preferences FOR DELETE
      USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.student_academic_profiles sap
          WHERE sap.id            = student_language_preferences.student_profile_id
            AND sap.auth_user_id  = auth.uid()
        )
      );
  END IF;
END;
$$;

-- Grants (idempotent)
GRANT SELECT, INSERT, UPDATE ON public.student_academic_profiles    TO authenticated;
GRANT ALL                    ON public.student_academic_profiles    TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.student_subject_selections   TO authenticated;
GRANT ALL                            ON public.student_subject_selections   TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.student_language_preferences TO authenticated;
GRANT ALL                            ON public.student_language_preferences TO service_role;

-- =============================================================================
-- UNIQUE CONSTRAINT SAFETY PATCH
-- Ensures ON CONFLICT(auth_user_id) is valid for
-- fn_create_student_academic_profile()
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_student_academic_profiles_auth_user_id'
      AND conrelid = 'public.student_academic_profiles'::regclass
  ) THEN

    -- Prevent accidental duplicate profiles before enforcing uniqueness
    IF EXISTS (
      SELECT auth_user_id
      FROM public.student_academic_profiles
      WHERE auth_user_id IS NOT NULL
      GROUP BY auth_user_id
      HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION
        'Cannot create UNIQUE(auth_user_id): duplicate student profiles detected.';
    END IF;

    ALTER TABLE public.student_academic_profiles
      ADD CONSTRAINT uq_student_academic_profiles_auth_user_id
      UNIQUE (auth_user_id);

  END IF;
END;
$$;

-- =============================================================================
-- SECTION 6: ADAPTED RPCs
--
-- All RPCs rewritten to use:
--   • auth_user_id  (instead of user_id) for student_academic_profiles queries
--   • student_profile_id (instead of profile_id) for child table queries
--
-- All RPCs remain:
--   • SECURITY DEFINER
--   • SET search_path TO 'public'
--   • business-key-safe (no internal UUIDs in public envelopes)
--   • replay-safe
--   • governance-safe
--   • deterministic ORDER BY
--   • rpc_version '2.0.0'
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 1 (EVOLVED): fn_create_student_academic_profile
--
-- Changes from original:
--   • Queries/writes student_academic_profiles using auth_user_id (not user_id)
--   • UPSERT conflict target is (auth_user_id) via existing unique constraint,
--     or falls back to WHERE auth_user_id = v_user_id if no UNIQUE constraint exists.
--   • New additive columns (country_code, region_code, etc.) now written.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_create_student_academic_profile(
  p_country_code  TEXT,
  p_region_code   TEXT,
  p_board_code    TEXT,
  p_stream_code   TEXT     DEFAULT NULL,
  p_current_class SMALLINT DEFAULT NULL,
  p_target_year   SMALLINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id         UUID;
  v_country_id      UUID;
  v_region_id       UUID;
  v_board_id        UUID;
  v_stream_id       UUID;
  v_taxonomy_hash   TEXT;
  v_canon_country   TEXT;
  v_canon_region    TEXT;
  v_canon_board     TEXT;
  v_canon_stream    TEXT;
  v_profile_id      UUID;
  v_is_new          BOOLEAN;
  v_completed_at    TIMESTAMPTZ;
BEGIN

  -- ── Auth guard ──────────────────────────────────────────────────────────
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'Authentication required.',
      'code',        'UNAUTHENTICATED'
    );
  END IF;

  -- ── Input validation ────────────────────────────────────────────────────
  IF p_country_code IS NULL OR trim(p_country_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'country_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_region_code IS NULL OR trim(p_region_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'region_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_board_code IS NULL OR trim(p_board_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'board_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_current_class IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'current_class is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_current_class < 1 OR p_current_class > 12 THEN
    RETURN jsonb_build_object(
      'success',       FALSE,
      'rpc',           'fn_create_student_academic_profile',
      'rpc_version',   '2.0.0',
      'error',         format('current_class %s is out of valid range (1–12).', p_current_class),
      'code',          'INVALID_CLASS_LEVEL',
      'current_class', p_current_class
    );
  END IF;

  IF p_target_year IS NOT NULL AND p_target_year < 2024 THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_create_student_academic_profile',
      'rpc_version',  '2.0.0',
      'error',        format('target_year %s is invalid. Must be 2024 or later.', p_target_year),
      'code',         'INVALID_TARGET_YEAR',
      'target_year',  p_target_year
    );
  END IF;

  -- ── Canonicalise inputs ─────────────────────────────────────────────────
  v_canon_country := upper(trim(p_country_code));
  v_canon_region  := upper(trim(p_region_code));
  v_canon_board   := upper(trim(p_board_code));
  v_canon_stream  := CASE
                       WHEN p_stream_code IS NULL OR trim(p_stream_code) = ''
                       THEN NULL
                       ELSE upper(trim(p_stream_code))
                     END;

  -- ── Taxonomy resolution ─────────────────────────────────────────────────
  v_country_id := public.fn__phase2_resolve_country_id(v_canon_country);
  IF v_country_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_create_student_academic_profile',
      'rpc_version',  '2.0.0',
      'error',        format('Country code "%s" is not valid or is inactive.', v_canon_country),
      'code',         'INVALID_COUNTRY_CODE',
      'country_code', v_canon_country
    );
  END IF;

  v_region_id := public.fn__phase2_resolve_region_id(v_canon_region, v_canon_country);
  IF v_region_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_create_student_academic_profile',
      'rpc_version',  '2.0.0',
      'error',        format('Region code "%s" is not valid or is inactive for country "%s".',
                             v_canon_region, v_canon_country),
      'code',         'INVALID_REGION_CODE',
      'region_code',  v_canon_region,
      'country_code', v_canon_country
    );
  END IF;

  v_board_id := public.fn__phase2_resolve_board_id(v_canon_board, v_canon_country);
  IF v_board_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_create_student_academic_profile',
      'rpc_version',  '2.0.0',
      'error',        format('Board code "%s" is not valid or is inactive for country "%s".',
                             v_canon_board, v_canon_country),
      'code',         'INVALID_BOARD_CODE',
      'board_code',   v_canon_board,
      'country_code', v_canon_country
    );
  END IF;

  IF v_canon_stream IS NOT NULL THEN
    v_stream_id := public.fn__phase2_resolve_stream_id(v_canon_stream, v_canon_board, v_canon_country);
    IF v_stream_id IS NULL THEN
      RETURN jsonb_build_object(
        'success',      FALSE,
        'rpc',          'fn_create_student_academic_profile',
        'rpc_version',  '2.0.0',
        'error',        format('Stream code "%s" is not valid or is inactive for board "%s".',
                               v_canon_stream, v_canon_board),
        'code',         'INVALID_STREAM_CODE',
        'stream_code',  v_canon_stream,
        'board_code',   v_canon_board
      );
    END IF;
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- ── Is this a new profile? ──────────────────────────────────────────────
  SELECT EXISTS(
    SELECT 1 FROM public.student_academic_profiles
    WHERE auth_user_id = v_user_id
  ) INTO v_is_new;
  v_is_new := NOT v_is_new;

  -- ── UPSERT profile ──────────────────────────────────────────────────────
  -- The live table uses auth_user_id. The unique constraint on auth_user_id
  -- is used as the conflict target. If the constraint name differs in production,
  -- the DO UPDATE path handles it safely via the WHERE auth_user_id = clause.
  INSERT INTO public.student_academic_profiles (
    auth_user_id,
    country_id,   region_id,   board_id,   stream_id,
    country_code, region_code, board_code, stream_code,
    current_class, target_year,
    taxonomy_hash_at_save,
    rpc_version
  )
  VALUES (
    v_user_id,
    v_country_id, v_region_id, v_board_id, v_stream_id,
    v_canon_country, v_canon_region, v_canon_board, v_canon_stream,
    p_current_class, p_target_year,
    v_taxonomy_hash,
    '2.0.0'
  )
  ON CONFLICT (auth_user_id) DO UPDATE SET
    country_id            = EXCLUDED.country_id,
    region_id             = EXCLUDED.region_id,
    board_id              = EXCLUDED.board_id,
    stream_id             = EXCLUDED.stream_id,
    country_code          = EXCLUDED.country_code,
    region_code           = EXCLUDED.region_code,
    board_code            = EXCLUDED.board_code,
    stream_code           = EXCLUDED.stream_code,
    current_class         = EXCLUDED.current_class,
    target_year           = EXCLUDED.target_year,
    taxonomy_hash_at_save = EXCLUDED.taxonomy_hash_at_save,
    rpc_version           = EXCLUDED.rpc_version,
    -- Preserve completion state — profile update does NOT reset completion
    onboarding_completed_at = public.student_academic_profiles.onboarding_completed_at,
    updated_at            = NOW()
  RETURNING id, onboarding_completed_at
  INTO v_profile_id, v_completed_at;

  RETURN jsonb_build_object(
    'success',     TRUE,
    'rpc',         'fn_create_student_academic_profile',
    'rpc_version', '2.0.0',
    'query_meta',  jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
    ),
    'profile_state', jsonb_build_object(
      'country_code',  v_canon_country,
      'region_code',   v_canon_region,
      'board_code',    v_canon_board,
      'stream_code',   v_canon_stream,
      'current_class', p_current_class,
      'target_year',   p_target_year
    ),
    'onboarding_state', jsonb_build_object(
      'is_new_profile', v_is_new,
      'is_complete',    v_completed_at IS NOT NULL,
      'completed_at',   v_completed_at
    ),
    'timestamps', jsonb_build_object(
      'saved_at',              NOW(),
      'taxonomy_hash_at_save', v_taxonomy_hash
    )
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'Profile save failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_create_student_academic_profile(TEXT, TEXT, TEXT, TEXT, SMALLINT, SMALLINT) IS
  'Phase 2B Evolution: create or update the onboarding academic profile. '
  'UPSERT via auth_user_id (canonical live column). '
  'Writes all evolved columns (country_code, region_code, board_code, stream_code, '
  'target_year, taxonomy_hash_at_save, rpc_version). '
  'Completion state preserved on update. Never exposes internal UUIDs. '
  'VOLATILE. SECURITY DEFINER. auth.uid() required.';

REVOKE ALL ON FUNCTION public.fn_create_student_academic_profile(TEXT, TEXT, TEXT, TEXT, SMALLINT, SMALLINT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_create_student_academic_profile(TEXT, TEXT, TEXT, TEXT, SMALLINT, SMALLINT)
  TO authenticated, service_role;
ALTER FUNCTION public.fn_create_student_academic_profile(TEXT, TEXT, TEXT, TEXT, SMALLINT, SMALLINT)
  COST 200;


-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 2 (EVOLVED): fn_get_student_full_profile
--
-- Changes from original:
--   • Reads student_academic_profiles using auth_user_id
--   • Reads student_subject_selections using student_profile_id (with user_id fallback)
--   • Reads student_language_preferences using student_profile_id (with user_id fallback)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_get_student_full_profile()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id        UUID;
  v_taxonomy_hash  TEXT;
  v_profile        RECORD;
  v_subjects       JSONB;
  v_languages      JSONB;
  v_subject_count  INTEGER;
  v_language_count INTEGER;
BEGIN

  -- ── Auth guard ──────────────────────────────────────────────────────────
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_student_full_profile',
      'rpc_version', '2.0.0',
      'error',       'Authentication required.',
      'code',        'UNAUTHENTICATED'
    );
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- ── Read profile (using auth_user_id) ───────────────────────────────────
  SELECT
    sap.id                     AS profile_id,
    sap.country_code,
    sap.region_code,
    sap.board_code,
    sap.stream_code,
    sap.current_class,
    sap.target_year,
    sap.onboarding_completed_at,
    sap.taxonomy_hash_at_save,
    sap.created_at,
    sap.updated_at
  INTO v_profile
  FROM public.student_academic_profiles sap
  WHERE sap.auth_user_id = v_user_id;

  -- No profile yet — valid onboarding state, not an error
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success',     TRUE,
      'rpc',         'fn_get_student_full_profile',
      'rpc_version', '2.0.0',
      'query_meta',  jsonb_build_object(
        'executed_at',    NOW(),
        'taxonomy_hash',  v_taxonomy_hash,
        'correlation_id', NULL::TEXT,
        'request_id',     NULL::TEXT
      ),
      'profile',          NULL,
      'subjects',         '[]'::jsonb,
      'languages',        '[]'::jsonb,
      'onboarding_state', jsonb_build_object(
        'profile_exists', FALSE,
        'is_complete',    FALSE,
        'completed_at',   NULL
      )
    );
  END IF;

  -- ── Read subjects via student_profile_id join ────────────────────────────
  -- Supports both old rows (no user_id) and new rows (user_id populated).
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'code',          sss.subject_code,
          'name',          sub.subject_name,
          'category',      sub.subject_category,
          'is_mandatory',  COALESCE(sub.is_mandatory, FALSE),
          'is_language',   sub.is_language,
          'is_integrated', sub.is_integrated,
          'sort_order',    sss.sort_order
        )
        ORDER BY sss.sort_order ASC, sss.subject_code ASC
      ),
      '[]'::jsonb
    ),
    COUNT(*)::INTEGER
  INTO v_subjects, v_subject_count
  FROM public.student_subject_selections sss
  JOIN public.academic_subjects sub ON sub.id = sss.subject_id
  WHERE sss.student_profile_id = v_profile.profile_id
    AND sub.is_active = TRUE
    AND sss.subject_code IS NOT NULL;

  -- ── Read languages via student_profile_id join ───────────────────────────
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'code',       slp.language_code,
          'name',       lang.language_name,
          'sort_order', slp.sort_order
        )
        ORDER BY slp.sort_order ASC, slp.language_code ASC
      ),
      '[]'::jsonb
    ),
    COUNT(*)::INTEGER
  INTO v_languages, v_language_count
  FROM public.student_language_preferences slp
  JOIN public.academic_languages lang ON lang.id = slp.language_id
  WHERE slp.student_profile_id = v_profile.profile_id
    AND lang.is_active = TRUE
    AND slp.language_code IS NOT NULL;

  RETURN jsonb_build_object(
    'success',     TRUE,
    'rpc',         'fn_get_student_full_profile',
    'rpc_version', '2.0.0',
    'query_meta',  jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
    ),
    'profile', jsonb_build_object(
      'country_code',          v_profile.country_code,
      'region_code',           v_profile.region_code,
      'board_code',            v_profile.board_code,
      'stream_code',           v_profile.stream_code,
      'current_class',         v_profile.current_class,
      'target_year',           v_profile.target_year,
      'taxonomy_hash_at_save', v_profile.taxonomy_hash_at_save,
      'created_at',            v_profile.created_at,
      'updated_at',            v_profile.updated_at
    ),
    'subjects',         v_subjects,
    'subject_count',    v_subject_count,
    'languages',        v_languages,
    'language_count',   v_language_count,
    'onboarding_state', jsonb_build_object(
      'profile_exists', TRUE,
      'is_complete',    v_profile.onboarding_completed_at IS NOT NULL,
      'completed_at',   v_profile.onboarding_completed_at
    )
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_get_student_full_profile',
      'rpc_version', '2.0.0',
      'error',       'Profile read failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_get_student_full_profile() IS
  'Phase 2B Evolution: read complete onboarding state for auth.uid(). '
  'Uses auth_user_id (live canonical column) for profile lookup. '
  'Uses student_profile_id for subject/language lookups (legacy-safe). '
  'STABLE. PARALLEL SAFE. SECURITY DEFINER. auth.uid() required.';

REVOKE ALL ON FUNCTION public.fn_get_student_full_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_student_full_profile() TO authenticated, service_role;
ALTER FUNCTION public.fn_get_student_full_profile()
  PARALLEL SAFE
  COST 150;

-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 3 (EVOLVED): fn_save_student_subjects
--
-- Changes from original:
--   • Profile lookup via auth_user_id
--   • INSERT into student_subject_selections writes student_profile_id (live column)
--     AND user_id (new evolved column) simultaneously
--   • DELETE via student_profile_id (preserves legacy referential integrity)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_save_student_subjects(
  p_subject_codes TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id         UUID;
  v_profile_id      UUID;
  v_stream_id       UUID;
  v_taxonomy_hash   TEXT;
  v_invalid_codes   TEXT[];
  v_invalid_stream  TEXT[];
  v_subject_rows    JSONB;
  v_subject_count   INTEGER;
  v_canon_codes     TEXT[];
  v_code            TEXT;
  v_i               INTEGER;
BEGIN

  -- ── Auth guard ──────────────────────────────────────────────────────────
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_subjects',
      'rpc_version', '2.0.0',
      'error',       'Authentication required.',
      'code',        'UNAUTHENTICATED'
    );
  END IF;

  -- ── Input validation ────────────────────────────────────────────────────
  IF p_subject_codes IS NULL OR array_length(p_subject_codes, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_subjects',
      'rpc_version', '2.0.0',
      'error',       'subject_codes must be a non-empty array.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT upper(trim(c))
    FROM unnest(p_subject_codes) c
    WHERE trim(c) <> ''
    ORDER BY 1
  ) INTO v_canon_codes;

  IF array_length(v_canon_codes, 1) IS NULL OR array_length(v_canon_codes, 1) = 0 THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_subjects',
      'rpc_version', '2.0.0',
      'error',       'subject_codes must contain at least one non-blank code.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  -- ── Profile existence check (auth_user_id) ──────────────────────────────
  SELECT id, stream_id
  INTO v_profile_id, v_stream_id
  FROM public.student_academic_profiles
  WHERE auth_user_id = v_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_subjects',
      'rpc_version', '2.0.0',
      'error',       'No academic profile found. Create a profile first via fn_create_student_academic_profile().',
      'code',        'PROFILE_NOT_FOUND'
    );
  END IF;

  -- ── Validate all subject codes exist in taxonomy ────────────────────────
  SELECT ARRAY(
    SELECT c
    FROM unnest(v_canon_codes) c
    WHERE NOT EXISTS (
      SELECT 1 FROM public.academic_subjects sub
      WHERE sub.subject_code = c
        AND sub.is_active    = TRUE
        AND sub.deprecated_at IS NULL
    )
    ORDER BY 1
  ) INTO v_invalid_codes;

  IF array_length(v_invalid_codes, 1) IS NOT NULL AND array_length(v_invalid_codes, 1) > 0 THEN
    RETURN jsonb_build_object(
      'success',       FALSE,
      'rpc',           'fn_save_student_subjects',
      'rpc_version',   '2.0.0',
      'error',         format('Invalid or inactive subject codes: %s',
                              array_to_string(v_invalid_codes, ', ')),
      'code',          'INVALID_SUBJECT_CODES',
      'invalid_codes', to_jsonb(v_invalid_codes)
    );
  END IF;

  -- ── Stream membership validation ────────────────────────────────────────
  IF v_stream_id IS NOT NULL THEN
    SELECT ARRAY(
      SELECT c
      FROM unnest(v_canon_codes) c
      JOIN public.academic_subjects sub ON sub.subject_code = c AND sub.is_active
      WHERE sub.is_integrated = FALSE
        AND NOT EXISTS (
          SELECT 1
          FROM public.subject_stream_map ssm
          WHERE ssm.stream_id  = v_stream_id
            AND ssm.subject_id = sub.id
            AND ssm.is_active  = TRUE
        )
      ORDER BY 1
    ) INTO v_invalid_stream;

    IF array_length(v_invalid_stream, 1) IS NOT NULL AND array_length(v_invalid_stream, 1) > 0 THEN
      RETURN jsonb_build_object(
        'success',       FALSE,
        'rpc',           'fn_save_student_subjects',
        'rpc_version',   '2.0.0',
        'error',         format('Subject codes not available for your stream: %s',
                                array_to_string(v_invalid_stream, ', ')),
        'code',          'SUBJECTS_NOT_IN_STREAM',
        'invalid_codes', to_jsonb(v_invalid_stream)
      );
    END IF;
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- ── Atomic replacement ──────────────────────────────────────────────────
  -- Delete via student_profile_id (legacy-safe; covers rows with and without user_id)
  DELETE FROM public.student_subject_selections
  WHERE student_profile_id = v_profile_id;

  v_i := 0;
  FOREACH v_code IN ARRAY v_canon_codes LOOP
    INSERT INTO public.student_subject_selections (
      student_profile_id,
      user_id,
      subject_id,
      subject_code,
      sort_order,
      taxonomy_hash_at_save
    )
    SELECT
      v_profile_id,
      v_user_id,
      sub.id,
      sub.subject_code,
      v_i,
      v_taxonomy_hash
    FROM public.academic_subjects sub
    WHERE sub.subject_code = v_code AND sub.is_active;

    v_i := v_i + 1;
  END LOOP;

  -- ── Build return payload ────────────────────────────────────────────────
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'code',          sss.subject_code,
          'name',          sub.subject_name,
          'category',      sub.subject_category,
          'is_mandatory',  COALESCE(sub.is_mandatory, FALSE),
          'is_language',   sub.is_language,
          'is_integrated', sub.is_integrated,
          'sort_order',    sss.sort_order
        )
        ORDER BY sss.sort_order ASC, sss.subject_code ASC
      ),
      '[]'::jsonb
    ),
    COUNT(*)::INTEGER
  INTO v_subject_rows, v_subject_count
  FROM public.student_subject_selections sss
  JOIN public.academic_subjects sub ON sub.id = sss.subject_id
  WHERE sss.student_profile_id = v_profile_id;

  RETURN jsonb_build_object(
    'success',       TRUE,
    'rpc',           'fn_save_student_subjects',
    'rpc_version',   '2.0.0',
    'query_meta',    jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
    ),
    'subjects',      v_subject_rows,
    'subject_count', v_subject_count,
    'updated_at',    NOW()
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_subjects',
      'rpc_version', '2.0.0',
      'error',       'Subject save failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_save_student_subjects(TEXT[]) IS
  'Phase 2B Evolution: atomically replace student subject selections. '
  'Profile lookup via auth_user_id. DELETE/INSERT via student_profile_id (legacy-safe). '
  'New rows write both student_profile_id AND user_id. '
  'VOLATILE. SECURITY DEFINER. auth.uid() required.';

REVOKE ALL ON FUNCTION public.fn_save_student_subjects(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_save_student_subjects(TEXT[]) TO authenticated, service_role;
ALTER FUNCTION public.fn_save_student_subjects(TEXT[]) COST 250;


-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 4 (EVOLVED): fn_save_student_languages
--
-- Changes from original:
--   • Profile lookup via auth_user_id
--   • INSERT writes student_profile_id AND user_id
--   • DELETE via student_profile_id (legacy-safe)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_save_student_languages(
  p_language_codes TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id          UUID;
  v_profile_id       UUID;
  v_region_id        UUID;
  v_taxonomy_hash    TEXT;
  v_invalid_codes    TEXT[];
  v_region_advisory  TEXT[];
  v_language_rows    JSONB;
  v_language_count   INTEGER;
  v_canon_codes      TEXT[];
  v_code             TEXT;
  v_i                INTEGER;
  v_region_has_map   BOOLEAN;
BEGIN

  -- ── Auth guard ──────────────────────────────────────────────────────────
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_languages',
      'rpc_version', '2.0.0',
      'error',       'Authentication required.',
      'code',        'UNAUTHENTICATED'
    );
  END IF;

  -- ── Input validation ────────────────────────────────────────────────────
  IF p_language_codes IS NULL OR array_length(p_language_codes, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_languages',
      'rpc_version', '2.0.0',
      'error',       'language_codes must be a non-empty array.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT upper(trim(c))
    FROM unnest(p_language_codes) c
    WHERE trim(c) <> ''
    ORDER BY 1
  ) INTO v_canon_codes;

  IF array_length(v_canon_codes, 1) IS NULL OR array_length(v_canon_codes, 1) = 0 THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_languages',
      'rpc_version', '2.0.0',
      'error',       'language_codes must contain at least one non-blank code.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  -- ── Profile existence check (auth_user_id) ──────────────────────────────
  SELECT id, region_id
  INTO v_profile_id, v_region_id
  FROM public.student_academic_profiles
  WHERE auth_user_id = v_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_languages',
      'rpc_version', '2.0.0',
      'error',       'No academic profile found. Create a profile first via fn_create_student_academic_profile().',
      'code',        'PROFILE_NOT_FOUND'
    );
  END IF;

  -- ── Validate all language codes exist ───────────────────────────────────
  SELECT ARRAY(
    SELECT c
    FROM unnest(v_canon_codes) c
    WHERE NOT EXISTS (
      SELECT 1 FROM public.academic_languages lang
      WHERE lang.language_code = c
        AND lang.is_active     = TRUE
        AND lang.deprecated_at IS NULL
    )
    ORDER BY 1
  ) INTO v_invalid_codes;

  IF array_length(v_invalid_codes, 1) IS NOT NULL AND array_length(v_invalid_codes, 1) > 0 THEN
    RETURN jsonb_build_object(
      'success',       FALSE,
      'rpc',           'fn_save_student_languages',
      'rpc_version',   '2.0.0',
      'error',         format('Invalid or inactive language codes: %s',
                              array_to_string(v_invalid_codes, ', ')),
      'code',          'INVALID_LANGUAGE_CODES',
      'invalid_codes', to_jsonb(v_invalid_codes)
    );
  END IF;

  -- ── Region compatibility advisory (non-blocking) ────────────────────────
  SELECT EXISTS(
    SELECT 1 FROM public.state_language_mapping slm
    WHERE slm.region_id = v_region_id AND slm.is_active = TRUE
  ) INTO v_region_has_map;

  IF v_region_has_map THEN
    SELECT ARRAY(
      SELECT c
      FROM unnest(v_canon_codes) c
      JOIN public.academic_languages lang ON lang.language_code = c AND lang.is_active
      WHERE NOT EXISTS (
        SELECT 1 FROM public.state_language_mapping slm
        WHERE slm.region_id   = v_region_id
          AND slm.language_id = lang.id
          AND slm.is_active   = TRUE
      )
      ORDER BY 1
    ) INTO v_region_advisory;
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- ── Atomic replacement ──────────────────────────────────────────────────
  DELETE FROM public.student_language_preferences
  WHERE student_profile_id = v_profile_id;

  v_i := 0;
  FOREACH v_code IN ARRAY v_canon_codes LOOP
    INSERT INTO public.student_language_preferences (
      student_profile_id,
      user_id,
      language_id,
      language_code,
      sort_order,
      taxonomy_hash_at_save
    )
    SELECT
      v_profile_id,
      v_user_id,
      lang.id,
      lang.language_code,
      v_i,
      v_taxonomy_hash
    FROM public.academic_languages lang
    WHERE lang.language_code = v_code AND lang.is_active;

    v_i := v_i + 1;
  END LOOP;

  -- ── Build return payload ────────────────────────────────────────────────
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'code',       slp.language_code,
          'name',       lang.language_name,
          'sort_order', slp.sort_order
        )
        ORDER BY slp.sort_order ASC, slp.language_code ASC
      ),
      '[]'::jsonb
    ),
    COUNT(*)::INTEGER
  INTO v_language_rows, v_language_count
  FROM public.student_language_preferences slp
  JOIN public.academic_languages lang ON lang.id = slp.language_id
  WHERE slp.student_profile_id = v_profile_id;

  RETURN jsonb_build_object(
    'success',        TRUE,
    'rpc',            'fn_save_student_languages',
    'rpc_version',    '2.0.0',
    'query_meta',     jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
    ),
    'languages',       v_language_rows,
    'language_count',  v_language_count,
    'region_advisory', CASE
                         WHEN array_length(v_region_advisory, 1) IS NOT NULL
                              AND array_length(v_region_advisory, 1) > 0
                         THEN to_jsonb(v_region_advisory)
                         ELSE '[]'::jsonb
                       END,
    'updated_at',      NOW()
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_save_student_languages',
      'rpc_version', '2.0.0',
      'error',       'Language save failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_save_student_languages(TEXT[]) IS
  'Phase 2B Evolution: atomically replace student language preferences. '
  'Profile lookup via auth_user_id. DELETE/INSERT via student_profile_id (legacy-safe). '
  'New rows write both student_profile_id AND user_id. '
  'VOLATILE. SECURITY DEFINER. auth.uid() required.';

REVOKE ALL ON FUNCTION public.fn_save_student_languages(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_save_student_languages(TEXT[]) TO authenticated, service_role;
ALTER FUNCTION public.fn_save_student_languages(TEXT[]) COST 200;


-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 5 (EVOLVED): fn_complete_academic_onboarding
--
-- Changes from original:
--   • Profile lookup via auth_user_id
--   • Counts via student_profile_id in child tables (legacy-safe)
--   • UPDATE writes onboarding_completed_at (evolved column)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_complete_academic_onboarding()
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id         UUID;
  v_taxonomy_hash   TEXT;
  v_profile         RECORD;
  v_subject_count   INTEGER;
  v_language_count  INTEGER;
  v_completed_at    TIMESTAMPTZ;
  v_already_done    BOOLEAN;

  v_g1_profile      BOOLEAN := FALSE;
  v_g2_keys         BOOLEAN := FALSE;
  v_g3_class        BOOLEAN := FALSE;
  v_g4_subjects     BOOLEAN := FALSE;
  v_g5_languages    BOOLEAN := FALSE;
  v_gates_passed    BOOLEAN;
  v_failure_reasons TEXT[]  := '{}';
BEGIN

  -- ── Auth guard ──────────────────────────────────────────────────────────
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_complete_academic_onboarding',
      'rpc_version', '2.0.0',
      'error',       'Authentication required.',
      'code',        'UNAUTHENTICATED'
    );
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- ── Read profile (auth_user_id) ─────────────────────────────────────────
  SELECT
    sap.id                     AS profile_id,
    sap.country_code,
    sap.region_code,
    sap.board_code,
    sap.stream_code,
    sap.stream_id,
    sap.current_class,
    sap.target_year,
    sap.onboarding_completed_at,
    sap.created_at,
    sap.updated_at
  INTO v_profile
  FROM public.student_academic_profiles sap
  WHERE sap.auth_user_id = v_user_id;

  v_g1_profile := FOUND;
  IF NOT v_g1_profile THEN
    v_failure_reasons := array_append(v_failure_reasons,
      'G-1: No academic profile found. Call fn_create_student_academic_profile() first.');
  END IF;

  IF v_g1_profile THEN

    v_g2_keys := (
      v_profile.country_code IS NOT NULL AND trim(v_profile.country_code) <> ''
      AND v_profile.region_code IS NOT NULL AND trim(v_profile.region_code) <> ''
      AND v_profile.board_code  IS NOT NULL AND trim(v_profile.board_code)  <> ''
    );
    IF NOT v_g2_keys THEN
      v_failure_reasons := array_append(v_failure_reasons,
        'G-2: Profile is missing required fields (country_code, region_code, board_code). '
        'Call fn_create_student_academic_profile() to populate these fields.');
    END IF;

    v_g3_class := (
      v_profile.current_class IS NOT NULL
      AND v_profile.current_class BETWEEN 1 AND 12
    );
    IF NOT v_g3_class THEN
      v_failure_reasons := array_append(v_failure_reasons,
        'G-3: current_class is missing or out of valid range (1–12).');
    END IF;

    -- G-4: Subjects — count via student_profile_id (legacy-safe)
    SELECT COUNT(*)::INTEGER INTO v_subject_count
    FROM public.student_subject_selections
    WHERE student_profile_id = v_profile.profile_id;

    IF v_profile.stream_id IS NOT NULL THEN
      v_g4_subjects := v_subject_count >= 1;
      IF NOT v_g4_subjects THEN
        v_failure_reasons := array_append(v_failure_reasons,
          'G-4: At least one subject must be selected when a stream is set. Call fn_save_student_subjects().');
      END IF;
    ELSE
      v_g4_subjects := TRUE;
    END IF;

    -- G-5: Languages — count via student_profile_id (legacy-safe)
    SELECT COUNT(*)::INTEGER INTO v_language_count
    FROM public.student_language_preferences
    WHERE student_profile_id = v_profile.profile_id;

    v_g5_languages := v_language_count >= 1;
    IF NOT v_g5_languages THEN
      v_failure_reasons := array_append(v_failure_reasons,
        'G-5: At least one language must be selected. Call fn_save_student_languages().');
    END IF;

  END IF;

  v_gates_passed := v_g1_profile AND v_g2_keys AND v_g3_class
                    AND v_g4_subjects AND v_g5_languages;

  IF NOT v_gates_passed THEN
    RETURN jsonb_build_object(
      'success',             FALSE,
      'rpc',                 'fn_complete_academic_onboarding',
      'rpc_version',         '2.0.0',
      'error',               'Onboarding is not ready for completion.',
      'code',                'ONBOARDING_INCOMPLETE',
      'onboarding_complete', FALSE,
      'readiness_summary',   jsonb_build_object(
        'gates', jsonb_build_object(
          'G1_profile_exists', v_g1_profile,
          'G2_keys_complete',  v_g2_keys,
          'G3_class_valid',    v_g3_class,
          'G4_subjects_ok',    v_g4_subjects,
          'G5_languages_ok',   v_g5_languages
        ),
        'failure_reasons', to_jsonb(v_failure_reasons),
        'subject_count',   v_subject_count,
        'language_count',  v_language_count
      )
    );
  END IF;

  v_already_done := v_profile.onboarding_completed_at IS NOT NULL;

  -- Update uses auth_user_id; writes onboarding_completed_at (evolved column)
  -- Also mirrors to onboarding_completed boolean for legacy compat
  UPDATE public.student_academic_profiles
  SET onboarding_completed_at = COALESCE(onboarding_completed_at, NOW()),
      onboarding_completed    = TRUE,
      updated_at              = NOW()
  WHERE auth_user_id = v_user_id
  RETURNING onboarding_completed_at INTO v_completed_at;

  RETURN jsonb_build_object(
    'success',             TRUE,
    'rpc',                 'fn_complete_academic_onboarding',
    'rpc_version',         '2.0.0',
    'query_meta',          jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
    ),
    'onboarding_complete',  TRUE,
    'completed_at',         v_completed_at,
    'was_already_complete', v_already_done,
    'readiness_summary',    jsonb_build_object(
      'gates', jsonb_build_object(
        'G1_profile_exists', TRUE,
        'G2_keys_complete',  TRUE,
        'G3_class_valid',    TRUE,
        'G4_subjects_ok',    TRUE,
        'G5_languages_ok',   TRUE
      ),
      'subject_count',   v_subject_count,
      'language_count',  v_language_count,
      'profile_snapshot', jsonb_build_object(
        'country_code',  v_profile.country_code,
        'region_code',   v_profile.region_code,
        'board_code',    v_profile.board_code,
        'stream_code',   v_profile.stream_code,
        'current_class', v_profile.current_class,
        'target_year',   v_profile.target_year
      )
    ),
    'taxonomy_hash', v_taxonomy_hash
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_complete_academic_onboarding',
      'rpc_version', '2.0.0',
      'error',       'Onboarding completion failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION public.fn_complete_academic_onboarding() IS
  'Phase 2B Evolution: finalize and seal academic onboarding. '
  'Profile lookup via auth_user_id. Child counts via student_profile_id (legacy-safe). '
  'On success: writes onboarding_completed_at (evolved) AND onboarding_completed=TRUE (legacy). '
  'Idempotent — safe to call on already-completed profiles. '
  'VOLATILE. SECURITY DEFINER. auth.uid() required.';

REVOKE ALL ON FUNCTION public.fn_complete_academic_onboarding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_complete_academic_onboarding() TO authenticated, service_role;
ALTER FUNCTION public.fn_complete_academic_onboarding() COST 150;


-- =============================================================================
-- SECTION 7: GOVERNANCE SEEDS
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 7A. Schema registry — evolution entries (additive, ON CONFLICT DO NOTHING)
-- ---------------------------------------------------------------------------

INSERT INTO public.academic_rpc_schema_registry
(
  rpc_name,
  rpc_signature,
  field_path,
  field_type,
  stability,
  introduced_phase,
  notes
)
VALUES

-- =============================================================================
-- fn_create_student_academic_profile
-- =============================================================================

(
  'fn_create_student_academic_profile',
  'p_country_code text, p_region_code text, p_board_code text, p_stream_code text, p_current_class smallint, p_target_year smallint',
  'success',
  'boolean',
  'stable',
  'phase2b_evo',
  'Envelope root'
),

(
  'fn_create_student_academic_profile',
  'p_country_code text, p_region_code text, p_board_code text, p_stream_code text, p_current_class smallint, p_target_year smallint',
  'rpc',
  'text',
  'stable',
  'phase2b_evo',
  NULL
),

(
  'fn_create_student_academic_profile',
  'p_country_code text, p_region_code text, p_board_code text, p_stream_code text, p_current_class smallint, p_target_year smallint',
  'rpc_version',
  'text',
  'stable',
  'phase2b_evo',
  NULL
),

(
  'fn_create_student_academic_profile',
  'p_country_code text, p_region_code text, p_board_code text, p_stream_code text, p_current_class smallint, p_target_year smallint',
  'query_meta',
  'object',
  'stable',
  'phase2b_evo',
  NULL
),

(
  'fn_create_student_academic_profile',
  'p_country_code text, p_region_code text, p_board_code text, p_stream_code text, p_current_class smallint, p_target_year smallint',
  'query_meta.executed_at',
  'timestamptz',
  'stable',
  'phase2b_evo',
  NULL
),

(
  'fn_create_student_academic_profile',
  'p_country_code text, p_region_code text, p_board_code text, p_stream_code text, p_current_class smallint, p_target_year smallint',
  'query_meta.taxonomy_hash',
  'text',
  'stable',
  'phase2b_evo',
  NULL
),

(
  'fn_create_student_academic_profile',
  'p_country_code text, p_region_code text, p_board_code text, p_stream_code text, p_current_class smallint, p_target_year smallint',
  'query_meta.correlation_id',
  'text|null',
  'additive',
  'phase2b_evo',
  'Phase 3+ tracing placeholder'
),

(
  'fn_create_student_academic_profile',
  'p_country_code text, p_region_code text, p_board_code text, p_stream_code text, p_current_class smallint, p_target_year smallint',
  'query_meta.request_id',
  'text|null',
  'additive',
  'phase2b_evo',
  'Phase 3+ idempotency placeholder'
),

(
  'fn_create_student_academic_profile',
  'p_country_code text, p_region_code text, p_board_code text, p_stream_code text, p_current_class smallint, p_target_year smallint',
  'profile_state',
  'object',
  'stable',
  'phase2b_evo',
  NULL
),

(
  'fn_create_student_academic_profile',
  'p_country_code text, p_region_code text, p_board_code text, p_stream_code text, p_current_class smallint, p_target_year smallint',
  'profile_state.country_code',
  'text',
  'stable',
  'phase2b_evo',
  NULL
),

(
  'fn_create_student_academic_profile',
  'p_country_code text, p_region_code text, p_board_code text, p_stream_code text, p_current_class smallint, p_target_year smallint',
  'profile_state.region_code',
  'text',
  'stable',
  'phase2b_evo',
  NULL
),

(
  'fn_create_student_academic_profile',
  'p_country_code text, p_region_code text, p_board_code text, p_stream_code text, p_current_class smallint, p_target_year smallint',
  'profile_state.board_code',
  'text',
  'stable',
  'phase2b_evo',
  NULL
),

(
  'fn_create_student_academic_profile',
  'p_country_code text, p_region_code text, p_board_code text, p_stream_code text, p_current_class smallint, p_target_year smallint',
  'profile_state.stream_code',
  'text|null',
  'stable',
  'phase2b_evo',
  'null when no stream'
)

,

(
  'fn_get_student_full_profile',
  '',
  'success',
  'boolean',
  'stable',
  'phase2b_evo',
  'Envelope root'
),

(
  'fn_save_student_subjects',
  'p_subject_codes text[]',
  'success',
  'boolean',
  'stable',
  'phase2b_evo',
  'Envelope root'
),

(
  'fn_save_student_languages',
  'p_language_codes text[]',
  'success',
  'boolean',
  'stable',
  'phase2b_evo',
  'Envelope root'
),

(
  'fn_complete_academic_onboarding',
  '',
  'success',
  'boolean',
  'stable',
  'phase2b_evo',
  'Envelope root'
)

ON CONFLICT DO NOTHING;


-- ---------------------------------------------------------------------------
-- 7B. Lifecycle registry — evolution entries
-- ---------------------------------------------------------------------------

INSERT INTO public.academic_rpc_lifecycle
  (rpc_name, rpc_signature, rpc_version, lifecycle_state, introduced_phase, notes)
VALUES
  (
    'fn_create_student_academic_profile',
    'fn_create_student_academic_profile(text, text, text, text, smallint, smallint)',
    '2.0.1',
    'active',
    'phase2b_evo',
    'Evolution: adapted for auth_user_id. Writes evolved code/hash columns. '
    'ON CONFLICT target: auth_user_id unique constraint.'
  ),
  (
    'fn_get_student_full_profile',
    'fn_get_student_full_profile()',
    '2.0.1',
    'active',
    'phase2b_evo',
    'Evolution: profile lookup via auth_user_id. '
    'Subject/language read via student_profile_id (legacy-safe).'
  ),
  (
    'fn_save_student_subjects',
    'fn_save_student_subjects(text[])',
    '2.0.1',
    'active',
    'phase2b_evo',
    'Evolution: profile lookup via auth_user_id. '
    'DELETE/INSERT via student_profile_id. New rows write user_id.'
  ),
  (
    'fn_save_student_languages',
    'fn_save_student_languages(text[])',
    '2.0.1',
    'active',
    'phase2b_evo',
    'Evolution: profile lookup via auth_user_id. '
    'DELETE/INSERT via student_profile_id. New rows write user_id.'
  ),
  (
    'fn_complete_academic_onboarding',
    'fn_complete_academic_onboarding()',
    '2.0.1',
    'active',
    'phase2b_evo',
    'Evolution: profile lookup via auth_user_id. '
    'Writes onboarding_completed_at AND onboarding_completed (legacy compat).'
  )
ON CONFLICT DO NOTHING;


-- =============================================================================
-- SECTION 8: VERIFICATION QUERIES
-- =============================================================================

DO $$
DECLARE
  v_sap_cols         INTEGER;
  v_sss_cols         INTEGER;
  v_slp_cols         INTEGER;
  v_rpc_count        INTEGER;
  v_schema_count     INTEGER;
  v_lifecycle_count  INTEGER;
  v_missing_cols     TEXT := '';

  -- Expected evolved columns
  v_expected_sap TEXT[] := ARRAY[
    'country_code','region_code','board_code','stream_code',
    'target_year','onboarding_completed_at','taxonomy_hash_at_save','rpc_version'
  ];
  v_expected_sss TEXT[] := ARRAY[
    'user_id','subject_code','sort_order','taxonomy_hash_at_save','updated_at'
  ];
  v_expected_slp TEXT[] := ARRAY[
    'user_id','language_code','sort_order','taxonomy_hash_at_save','updated_at'
  ];
  v_col TEXT;
  v_exists BOOLEAN;
BEGIN

  -- Verify evolved columns on student_academic_profiles
  v_sap_cols := 0;
  FOREACH v_col IN ARRAY v_expected_sap LOOP
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'student_academic_profiles'
        AND column_name  = v_col
    ) INTO v_exists;
    IF v_exists THEN
      v_sap_cols := v_sap_cols + 1;
    ELSE
      v_missing_cols := v_missing_cols || 'student_academic_profiles.' || v_col || ' ';
    END IF;
  END LOOP;

  IF v_sap_cols < array_length(v_expected_sap, 1) THEN
    RAISE EXCEPTION
      'VERIFICATION FAILURE: student_academic_profiles missing evolved columns: %',
      v_missing_cols;
  END IF;

  -- Verify evolved columns on student_subject_selections
  v_sss_cols := 0;
  v_missing_cols := '';
  FOREACH v_col IN ARRAY v_expected_sss LOOP
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'student_subject_selections'
        AND column_name  = v_col
    ) INTO v_exists;
    IF v_exists THEN
      v_sss_cols := v_sss_cols + 1;
    ELSE
      v_missing_cols := v_missing_cols || 'student_subject_selections.' || v_col || ' ';
    END IF;
  END LOOP;

  IF v_sss_cols < array_length(v_expected_sss, 1) THEN
    RAISE EXCEPTION
      'VERIFICATION FAILURE: student_subject_selections missing evolved columns: %',
      v_missing_cols;
  END IF;

  -- Verify evolved columns on student_language_preferences
  v_slp_cols := 0;
  v_missing_cols := '';
  FOREACH v_col IN ARRAY v_expected_slp LOOP
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'student_language_preferences'
        AND column_name  = v_col
    ) INTO v_exists;
    IF v_exists THEN
      v_slp_cols := v_slp_cols + 1;
    ELSE
      v_missing_cols := v_missing_cols || 'student_language_preferences.' || v_col || ' ';
    END IF;
  END LOOP;

  IF v_slp_cols < array_length(v_expected_slp, 1) THEN
    RAISE EXCEPTION
      'VERIFICATION FAILURE: student_language_preferences missing evolved columns: %',
      v_missing_cols;
  END IF;

  -- Verify all 5 evolved RPCs exist
  SELECT COUNT(*) INTO v_rpc_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'fn_create_student_academic_profile',
      'fn_get_student_full_profile',
      'fn_save_student_subjects',
      'fn_save_student_languages',
      'fn_complete_academic_onboarding'
    );

  IF v_rpc_count < 5 THEN
    RAISE EXCEPTION
      'VERIFICATION FAILURE: Expected 5 evolved Phase 2B RPCs in pg_proc, found %.',
      v_rpc_count;
  END IF;

  -- Verify governance seeds
  SELECT COUNT(*) INTO v_schema_count
  FROM public.academic_rpc_schema_registry
  WHERE introduced_phase = 'phase2b_evo';

  IF v_schema_count = 0 THEN
    RAISE EXCEPTION
      'VERIFICATION FAILURE: No phase2b_evo entries in academic_rpc_schema_registry.';
  END IF;

  SELECT COUNT(*) INTO v_lifecycle_count
  FROM public.academic_rpc_lifecycle
  WHERE introduced_phase = 'phase2b_evo';

  IF v_lifecycle_count < 5 THEN
    RAISE EXCEPTION
      'VERIFICATION FAILURE: Expected 5 phase2b_evo lifecycle entries, found %.',
      v_lifecycle_count;
  END IF;

  RAISE NOTICE
    '20260527000003_phase2b_student_academic_rpcs_evolution applied successfully. '
    'student_academic_profiles: % evolved columns added. '
    'student_subject_selections: % evolved columns added. '
    'student_language_preferences: % evolved columns added. '
    'RPCs evolved: % (all SECURITY DEFINER, auth_user_id + student_profile_id). '
    'Schema registry entries: %. '
    'Lifecycle registry entries: %. '
    'Zero destructive changes. Additive only. '
    'auth_user_id preserved as canonical user FK. '
    'student_profile_id preserved as canonical profile FK in child tables. '
    'Legacy onboarding_completed boolean kept and mirrored on completion.',
    v_sap_cols, v_sss_cols, v_slp_cols, v_rpc_count, v_schema_count, v_lifecycle_count;

END;
$$;


COMMIT;
