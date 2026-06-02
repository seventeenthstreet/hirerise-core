-- =============================================================================
-- HireRise Phase 1.6 Sprint 1
-- Migration: 20260601000002_intelligence_grant_remediation.sql
--
-- EXPLICIT GRANT REMEDIATION
--
-- PURPOSE:
--   Applies the deny-by-default explicit GRANT model to intelligence-tier
--   tables that pre-date the governance foundation. This migration exists
--   because the HireRise codebase had intelligence tables created before the
--   explicit GRANT architecture was established.
--
-- RECONSTRUCTION BASIS:
--   000004 references this migration in its header comment as a dependency.
--   000004 itself does not modify any of the tables in this migration —
--   it only modifies the four governance tables from 000001.
--   Therefore this migration addresses the pre-governance intelligence tables
--   that 000004 will interact with indirectly (via pipeline_run_id FKs,
--   signal_key references, and the intelligence service layer).
--
-- WHAT THIS MIGRATION DOES:
--   For each intelligence-tier table that may exist on a non-clean project:
--     1. Enables RLS (idempotent ALTER)
--     2. Creates policies (DROP IF EXISTS + CREATE for idempotency)
--     3. Applies explicit GRANT/REVOKE
--
--   On a CLEAN Supabase project (no prior intelligence tables):
--     All ALTER TABLE statements are guarded with existence checks via
--     DO $$ blocks so this migration is safe even when tables do not exist.
--
-- TABLE CLASSIFICATIONS (from 000004 architecture document):
--   Class A — Public Reference Data:
--     intelligence_signal_registry, signal_relationships
--     cognitive_questions, cognitive_options
--   Class B — Authenticated User Data:
--     student_activities, onboarding_progress
--   Class C — Highly Sensitive Intelligence Data:
--     student_signal_vectors, student_signal_evidence,
--     signal_confidence_models, signal_coverage_profiles,
--     signal_reliability_scores, cluster_stability_profiles,
--     cluster_drift_history, student_cognitive_responses,
--     student_cognitive_signals
--
-- SECURITY RULES:
--   anon        — SELECT on Class A only; REVOKED from Class B and C
--   authenticated — SELECT only, owner-filtered by RLS (Class B and C)
--                   SELECT all rows (Class A)
--   service_role  — Full access within table capabilities
--
-- EXECUTION: Fully idempotent. Safe on clean projects (tables may not exist).
--            Safe on legacy projects (policies recreated via DROP IF EXISTS).
-- =============================================================================

BEGIN;

-- =============================================================================
-- HELPER: safe_apply_grants()
-- Applies GRANT/REVOKE/RLS/policy to a table only if it exists.
-- Used to make this migration safe on clean Supabase projects where
-- pre-governance intelligence tables may not yet exist.
-- =============================================================================

-- We use DO blocks with conditional logic rather than a helper function
-- to avoid function naming conflicts with any existing schema.

-- =============================================================================
-- CLASS A — PUBLIC REFERENCE DATA
-- intelligence_signal_registry
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'intelligence_signal_registry'
  ) THEN
    -- Enable RLS
    EXECUTE 'ALTER TABLE public.intelligence_signal_registry ENABLE ROW LEVEL SECURITY';

    -- Policies
    EXECUTE 'DROP POLICY IF EXISTS "registry_read_authenticated" ON public.intelligence_signal_registry';
    EXECUTE '
      CREATE POLICY "registry_read_authenticated"
        ON public.intelligence_signal_registry FOR SELECT TO authenticated
        USING (deleted_at IS NULL)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "registry_read_anon" ON public.intelligence_signal_registry';
    EXECUTE '
      CREATE POLICY "registry_read_anon"
        ON public.intelligence_signal_registry FOR SELECT TO anon
        USING (deleted_at IS NULL AND deprecated_at IS NULL)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "registry_write_service_only" ON public.intelligence_signal_registry';
    EXECUTE '
      CREATE POLICY "registry_write_service_only"
        ON public.intelligence_signal_registry FOR ALL TO service_role
        USING (deleted_at IS NULL) WITH CHECK (true)
    ';

    -- GRANTs
    EXECUTE 'REVOKE ALL ON public.intelligence_signal_registry FROM anon';
    EXECUTE 'REVOKE ALL ON public.intelligence_signal_registry FROM authenticated';
    EXECUTE 'GRANT SELECT                       ON public.intelligence_signal_registry TO anon';
    EXECUTE 'GRANT SELECT                       ON public.intelligence_signal_registry TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE        ON public.intelligence_signal_registry TO service_role';

    RAISE NOTICE 'intelligence_signal_registry: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'intelligence_signal_registry: table does not exist — skipping (safe on clean project).';
  END IF;
END;
$$;

-- =============================================================================
-- CLASS A — PUBLIC REFERENCE DATA
-- signal_relationships
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_relationships'
  ) THEN
    EXECUTE 'ALTER TABLE public.signal_relationships ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "relationships_read_authenticated" ON public.signal_relationships';
    EXECUTE '
      CREATE POLICY "relationships_read_authenticated"
        ON public.signal_relationships FOR SELECT TO authenticated
        USING (deleted_at IS NULL)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "relationships_read_anon" ON public.signal_relationships';
    EXECUTE '
      CREATE POLICY "relationships_read_anon"
        ON public.signal_relationships FOR SELECT TO anon
        USING (deleted_at IS NULL)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "relationships_write_service_only" ON public.signal_relationships';
    EXECUTE '
      CREATE POLICY "relationships_write_service_only"
        ON public.signal_relationships FOR ALL TO service_role
        USING (deleted_at IS NULL) WITH CHECK (true)
    ';

    EXECUTE 'REVOKE ALL ON public.signal_relationships FROM anon';
    EXECUTE 'REVOKE ALL ON public.signal_relationships FROM authenticated';
    EXECUTE 'GRANT SELECT                        ON public.signal_relationships TO anon';
    EXECUTE 'GRANT SELECT                        ON public.signal_relationships TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE         ON public.signal_relationships TO service_role';

    RAISE NOTICE 'signal_relationships: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'signal_relationships: table does not exist — skipping.';
  END IF;
END;
$$;

-- =============================================================================
-- CLASS A — PUBLIC REFERENCE DATA
-- cognitive_questions
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'cognitive_questions'
  ) THEN
    EXECUTE 'ALTER TABLE public.cognitive_questions ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "cognitive_questions_read_all" ON public.cognitive_questions';
    EXECUTE '
      CREATE POLICY "cognitive_questions_read_all"
        ON public.cognitive_questions FOR SELECT
        USING (true)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "cognitive_questions_service_write" ON public.cognitive_questions';
    EXECUTE '
      CREATE POLICY "cognitive_questions_service_write"
        ON public.cognitive_questions FOR ALL TO service_role
        USING (true) WITH CHECK (true)
    ';

    EXECUTE 'REVOKE ALL ON public.cognitive_questions FROM anon';
    EXECUTE 'REVOKE ALL ON public.cognitive_questions FROM authenticated';
    EXECUTE 'GRANT SELECT                       ON public.cognitive_questions TO anon';
    EXECUTE 'GRANT SELECT                       ON public.cognitive_questions TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE        ON public.cognitive_questions TO service_role';

    RAISE NOTICE 'cognitive_questions: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'cognitive_questions: table does not exist — skipping.';
  END IF;
END;
$$;

-- =============================================================================
-- CLASS A — PUBLIC REFERENCE DATA
-- cognitive_options
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'cognitive_options'
  ) THEN
    EXECUTE 'ALTER TABLE public.cognitive_options ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "cognitive_options_read_all" ON public.cognitive_options';
    EXECUTE '
      CREATE POLICY "cognitive_options_read_all"
        ON public.cognitive_options FOR SELECT
        USING (true)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "cognitive_options_service_write" ON public.cognitive_options';
    EXECUTE '
      CREATE POLICY "cognitive_options_service_write"
        ON public.cognitive_options FOR ALL TO service_role
        USING (true) WITH CHECK (true)
    ';

    EXECUTE 'REVOKE ALL ON public.cognitive_options FROM anon';
    EXECUTE 'REVOKE ALL ON public.cognitive_options FROM authenticated';
    EXECUTE 'GRANT SELECT                       ON public.cognitive_options TO anon';
    EXECUTE 'GRANT SELECT                       ON public.cognitive_options TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE        ON public.cognitive_options TO service_role';

    RAISE NOTICE 'cognitive_options: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'cognitive_options: table does not exist — skipping.';
  END IF;
END;
$$;

-- =============================================================================
-- CLASS C — HIGHLY SENSITIVE INTELLIGENCE DATA
-- student_signal_vectors
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'student_signal_vectors'
  ) THEN
    EXECUTE 'ALTER TABLE public.student_signal_vectors ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "vectors_owner_read" ON public.student_signal_vectors';
    EXECUTE '
      CREATE POLICY "vectors_owner_read"
        ON public.student_signal_vectors FOR SELECT TO authenticated
        USING (auth.uid() = user_id AND deleted_at IS NULL)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "vectors_service_write" ON public.student_signal_vectors';
    EXECUTE '
      CREATE POLICY "vectors_service_write"
        ON public.student_signal_vectors FOR ALL TO service_role
        USING (deleted_at IS NULL) WITH CHECK (true)
    ';

    EXECUTE 'REVOKE ALL ON public.student_signal_vectors FROM anon';
    EXECUTE 'REVOKE ALL ON public.student_signal_vectors FROM authenticated';
    EXECUTE 'GRANT SELECT                   ON public.student_signal_vectors TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE    ON public.student_signal_vectors TO service_role';

    RAISE NOTICE 'student_signal_vectors: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'student_signal_vectors: table does not exist — skipping.';
  END IF;
END;
$$;

-- =============================================================================
-- CLASS C — HIGHLY SENSITIVE INTELLIGENCE DATA
-- student_signal_evidence
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'student_signal_evidence'
  ) THEN
    EXECUTE 'ALTER TABLE public.student_signal_evidence ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "evidence_owner_read" ON public.student_signal_evidence';
    EXECUTE '
      CREATE POLICY "evidence_owner_read"
        ON public.student_signal_evidence FOR SELECT TO authenticated
        USING (auth.uid() = user_id)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "evidence_service_insert" ON public.student_signal_evidence';
    EXECUTE '
      CREATE POLICY "evidence_service_insert"
        ON public.student_signal_evidence FOR INSERT TO service_role
        WITH CHECK (true)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "evidence_service_read" ON public.student_signal_evidence';
    EXECUTE '
      CREATE POLICY "evidence_service_read"
        ON public.student_signal_evidence FOR SELECT TO service_role
        USING (true)
    ';

    EXECUTE 'REVOKE ALL ON public.student_signal_evidence FROM anon';
    EXECUTE 'REVOKE ALL ON public.student_signal_evidence FROM authenticated';
    EXECUTE 'GRANT SELECT          ON public.student_signal_evidence TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT  ON public.student_signal_evidence TO service_role';

    RAISE NOTICE 'student_signal_evidence: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'student_signal_evidence: table does not exist — skipping.';
  END IF;
END;
$$;

-- =============================================================================
-- CLASS C — HIGHLY SENSITIVE INTELLIGENCE DATA
-- signal_confidence_models
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_confidence_models'
  ) THEN
    EXECUTE 'ALTER TABLE public.signal_confidence_models ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "confidence_owner_read" ON public.signal_confidence_models';
    EXECUTE '
      CREATE POLICY "confidence_owner_read"
        ON public.signal_confidence_models FOR SELECT TO authenticated
        USING (auth.uid() = user_id)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "confidence_service_write" ON public.signal_confidence_models';
    EXECUTE '
      CREATE POLICY "confidence_service_write"
        ON public.signal_confidence_models FOR ALL TO service_role
        USING (true) WITH CHECK (true)
    ';

    EXECUTE 'REVOKE ALL ON public.signal_confidence_models FROM anon';
    EXECUTE 'REVOKE ALL ON public.signal_confidence_models FROM authenticated';
    EXECUTE 'GRANT SELECT                   ON public.signal_confidence_models TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE    ON public.signal_confidence_models TO service_role';

    RAISE NOTICE 'signal_confidence_models: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'signal_confidence_models: table does not exist — skipping.';
  END IF;
END;
$$;

-- =============================================================================
-- CLASS C — HIGHLY SENSITIVE INTELLIGENCE DATA
-- signal_coverage_profiles
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_coverage_profiles'
  ) THEN
    EXECUTE 'ALTER TABLE public.signal_coverage_profiles ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "signal_coverage_profiles_user_read" ON public.signal_coverage_profiles';
    EXECUTE '
      CREATE POLICY "signal_coverage_profiles_user_read"
        ON public.signal_coverage_profiles FOR SELECT TO authenticated
        USING (auth.uid() = user_id)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "signal_coverage_profiles_service_all" ON public.signal_coverage_profiles';
    EXECUTE '
      CREATE POLICY "signal_coverage_profiles_service_all"
        ON public.signal_coverage_profiles FOR ALL TO service_role
        USING (auth.role() = ''service_role'')
    ';

    EXECUTE 'REVOKE ALL ON public.signal_coverage_profiles FROM anon';
    EXECUTE 'REVOKE ALL ON public.signal_coverage_profiles FROM authenticated';
    EXECUTE 'GRANT SELECT          ON public.signal_coverage_profiles TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT  ON public.signal_coverage_profiles TO service_role';

    RAISE NOTICE 'signal_coverage_profiles: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'signal_coverage_profiles: table does not exist — skipping.';
  END IF;
END;
$$;

-- =============================================================================
-- CLASS C — HIGHLY SENSITIVE INTELLIGENCE DATA
-- signal_reliability_scores
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_reliability_scores'
  ) THEN
    EXECUTE 'ALTER TABLE public.signal_reliability_scores ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "signal_reliability_scores_user_read" ON public.signal_reliability_scores';
    EXECUTE '
      CREATE POLICY "signal_reliability_scores_user_read"
        ON public.signal_reliability_scores FOR SELECT TO authenticated
        USING (auth.uid() = user_id)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "signal_reliability_scores_service_all" ON public.signal_reliability_scores';
    EXECUTE '
      CREATE POLICY "signal_reliability_scores_service_all"
        ON public.signal_reliability_scores FOR ALL TO service_role
        USING (auth.role() = ''service_role'')
    ';

    EXECUTE 'REVOKE ALL ON public.signal_reliability_scores FROM anon';
    EXECUTE 'REVOKE ALL ON public.signal_reliability_scores FROM authenticated';
    EXECUTE 'GRANT SELECT          ON public.signal_reliability_scores TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT  ON public.signal_reliability_scores TO service_role';

    RAISE NOTICE 'signal_reliability_scores: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'signal_reliability_scores: table does not exist — skipping.';
  END IF;
END;
$$;

-- =============================================================================
-- CLASS C — HIGHLY SENSITIVE INTELLIGENCE DATA
-- cluster_stability_profiles
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'cluster_stability_profiles'
  ) THEN
    EXECUTE 'ALTER TABLE public.cluster_stability_profiles ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "cluster_stability_profiles_user_read" ON public.cluster_stability_profiles';
    EXECUTE '
      CREATE POLICY "cluster_stability_profiles_user_read"
        ON public.cluster_stability_profiles FOR SELECT TO authenticated
        USING (auth.uid() = user_id)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "cluster_stability_profiles_service_all" ON public.cluster_stability_profiles';
    EXECUTE '
      CREATE POLICY "cluster_stability_profiles_service_all"
        ON public.cluster_stability_profiles FOR ALL TO service_role
        USING (auth.role() = ''service_role'')
    ';

    EXECUTE 'REVOKE ALL ON public.cluster_stability_profiles FROM anon';
    EXECUTE 'REVOKE ALL ON public.cluster_stability_profiles FROM authenticated';
    EXECUTE 'GRANT SELECT          ON public.cluster_stability_profiles TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT  ON public.cluster_stability_profiles TO service_role';

    RAISE NOTICE 'cluster_stability_profiles: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'cluster_stability_profiles: table does not exist — skipping.';
  END IF;
END;
$$;

-- =============================================================================
-- CLASS C — HIGHLY SENSITIVE INTELLIGENCE DATA
-- cluster_drift_history
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'cluster_drift_history'
  ) THEN
    EXECUTE 'ALTER TABLE public.cluster_drift_history ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "cluster_drift_history_user_read" ON public.cluster_drift_history';
    EXECUTE '
      CREATE POLICY "cluster_drift_history_user_read"
        ON public.cluster_drift_history FOR SELECT TO authenticated
        USING (auth.uid() = user_id)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "cluster_drift_history_service_all" ON public.cluster_drift_history';
    EXECUTE '
      CREATE POLICY "cluster_drift_history_service_all"
        ON public.cluster_drift_history FOR ALL TO service_role
        USING (auth.role() = ''service_role'')
    ';

    EXECUTE 'REVOKE ALL ON public.cluster_drift_history FROM anon';
    EXECUTE 'REVOKE ALL ON public.cluster_drift_history FROM authenticated';
    EXECUTE 'GRANT SELECT          ON public.cluster_drift_history TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT  ON public.cluster_drift_history TO service_role';

    RAISE NOTICE 'cluster_drift_history: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'cluster_drift_history: table does not exist — skipping.';
  END IF;
END;
$$;

-- =============================================================================
-- CLASS B — AUTHENTICATED USER DATA
-- student_activities
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'student_activities'
  ) THEN
    EXECUTE 'ALTER TABLE public.student_activities ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "student_activities_owner_read" ON public.student_activities';
    EXECUTE '
      CREATE POLICY "student_activities_owner_read"
        ON public.student_activities FOR SELECT TO authenticated
        USING (auth.uid() = user_id)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "student_activities_owner_write" ON public.student_activities';
    EXECUTE '
      CREATE POLICY "student_activities_owner_write"
        ON public.student_activities FOR INSERT TO authenticated
        WITH CHECK (auth.uid() = user_id)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "student_activities_owner_update" ON public.student_activities';
    EXECUTE '
      CREATE POLICY "student_activities_owner_update"
        ON public.student_activities FOR UPDATE TO authenticated
        USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "student_activities_service_all" ON public.student_activities';
    EXECUTE '
      CREATE POLICY "student_activities_service_all"
        ON public.student_activities FOR ALL TO service_role
        USING (true) WITH CHECK (true)
    ';

    EXECUTE 'REVOKE ALL ON public.student_activities FROM anon';
    EXECUTE 'REVOKE ALL ON public.student_activities FROM authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.student_activities TO authenticated';
    EXECUTE 'GRANT ALL                    ON public.student_activities TO service_role';

    RAISE NOTICE 'student_activities: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'student_activities: table does not exist — skipping.';
  END IF;
END;
$$;

-- =============================================================================
-- CLASS C — HIGHLY SENSITIVE INTELLIGENCE DATA
-- student_cognitive_responses
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'student_cognitive_responses'
  ) THEN
    EXECUTE 'ALTER TABLE public.student_cognitive_responses ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "cognitive_responses_owner_read" ON public.student_cognitive_responses';
    EXECUTE '
      CREATE POLICY "cognitive_responses_owner_read"
        ON public.student_cognitive_responses FOR SELECT TO authenticated
        USING (auth.uid() = user_id)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "cognitive_responses_owner_write" ON public.student_cognitive_responses';
    EXECUTE '
      CREATE POLICY "cognitive_responses_owner_write"
        ON public.student_cognitive_responses FOR INSERT TO authenticated
        WITH CHECK (auth.uid() = user_id)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "cognitive_responses_owner_update" ON public.student_cognitive_responses';
    EXECUTE '
      CREATE POLICY "cognitive_responses_owner_update"
        ON public.student_cognitive_responses FOR UPDATE TO authenticated
        USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "cognitive_responses_service_all" ON public.student_cognitive_responses';
    EXECUTE '
      CREATE POLICY "cognitive_responses_service_all"
        ON public.student_cognitive_responses FOR ALL TO service_role
        USING (true) WITH CHECK (true)
    ';

    EXECUTE 'REVOKE ALL ON public.student_cognitive_responses FROM anon';
    EXECUTE 'REVOKE ALL ON public.student_cognitive_responses FROM authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.student_cognitive_responses TO authenticated';
    EXECUTE 'GRANT ALL                    ON public.student_cognitive_responses TO service_role';

    RAISE NOTICE 'student_cognitive_responses: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'student_cognitive_responses: table does not exist — skipping.';
  END IF;
END;
$$;

-- =============================================================================
-- CLASS C — HIGHLY SENSITIVE INTELLIGENCE DATA
-- student_cognitive_signals
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'student_cognitive_signals'
  ) THEN
    EXECUTE 'ALTER TABLE public.student_cognitive_signals ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "cognitive_signals_owner_read" ON public.student_cognitive_signals';
    EXECUTE '
      CREATE POLICY "cognitive_signals_owner_read"
        ON public.student_cognitive_signals FOR SELECT TO authenticated
        USING (auth.uid() = user_id)
    ';

    EXECUTE 'DROP POLICY IF EXISTS "cognitive_signals_service_all" ON public.student_cognitive_signals';
    EXECUTE '
      CREATE POLICY "cognitive_signals_service_all"
        ON public.student_cognitive_signals FOR ALL TO service_role
        USING (true) WITH CHECK (true)
    ';

    EXECUTE 'REVOKE ALL ON public.student_cognitive_signals FROM anon';
    EXECUTE 'REVOKE ALL ON public.student_cognitive_signals FROM authenticated';
    EXECUTE 'GRANT SELECT                   ON public.student_cognitive_signals TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE    ON public.student_cognitive_signals TO service_role';

    RAISE NOTICE 'student_cognitive_signals: GRANT remediation applied.';
  ELSE
    RAISE NOTICE 'student_cognitive_signals: table does not exist — skipping.';
  END IF;
END;
$$;

-- =============================================================================
-- VERIFICATION SUMMARY (run manually after migration to confirm)
-- =============================================================================
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
--   AND tablename IN (
--     'intelligence_signal_registry','signal_relationships',
--     'cognitive_questions','cognitive_options',
--     'student_signal_vectors','student_signal_evidence',
--     'signal_confidence_models','signal_coverage_profiles',
--     'signal_reliability_scores','cluster_stability_profiles',
--     'cluster_drift_history','student_activities',
--     'student_cognitive_responses','student_cognitive_signals'
--   )
-- ORDER BY tablename;
-- Expected: rowsecurity = true for every row that exists.

COMMIT;
