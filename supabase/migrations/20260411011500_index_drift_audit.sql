-- =============================================================================
-- Wave 3 Phase 1: Missing Index Drift Audit
-- File: 20260411_001_index_drift_audit.sql
-- Safe: all CREATE INDEX IF NOT EXISTS — zero table locks
-- Idempotent: IF NOT EXISTS guards every statement
-- Backward compatible: no schema or RPC contract changes
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. chi_scores — primary hot path (partitioned table, no CONCURRENTLY)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_chi_scores_user_updated
    ON public.chi_scores (user_id, last_updated DESC);

CREATE INDEX IF NOT EXISTS idx_chi_scores_user_score
    ON public.chi_scores (user_id, chi_score DESC);

CREATE INDEX IF NOT EXISTS idx_chi_scores_role_updated
    ON public.chi_scores (role_id, last_updated DESC);

-- ---------------------------------------------------------------------------
-- 2. resumes (skipped if table does not exist)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'resumes') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_resumes_user_completed_scored') THEN
            CREATE INDEX idx_resumes_user_completed_scored
                ON public.resumes (user_id, scored_at DESC)
                WHERE soft_deleted = false AND ats_score > 0;
        END IF;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. job_match_analyses (skipped if table does not exist)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'job_match_analyses') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_job_match_analyses_user_analyzed') THEN
            CREATE INDEX idx_job_match_analyses_user_analyzed
                ON public.job_match_analyses (user_id, analyzed_at DESC);
        END IF;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. onboarding_progress (skipped if table does not exist)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'onboarding_progress') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_onboarding_progress_user_id') THEN
            CREATE INDEX idx_onboarding_progress_user_id
                ON public.onboarding_progress (user_id)
                WHERE soft_deleted IS NOT TRUE;
        END IF;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. user_profiles (skipped if table does not exist)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_profiles') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_user_profiles_user_soft') THEN
            CREATE INDEX idx_user_profiles_user_soft
                ON public.user_profiles (user_id, soft_deleted)
                WHERE soft_deleted IS NOT TRUE;
        END IF;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. chi_weekly_rollups_mv
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_chi_weekly_rollups_week_user
    ON public.chi_weekly_rollups_mv (week_bucket, user_id);

CREATE INDEX IF NOT EXISTS idx_chi_weekly_rollups_user_week
    ON public.chi_weekly_rollups_mv (user_id, week_bucket DESC);

-- ---------------------------------------------------------------------------
-- 7. role_skills
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'role_skills' AND column_name = 'skill_name') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_role_skills_role_covering') THEN
            EXECUTE 'CREATE INDEX idx_role_skills_role_covering ON public.role_skills (role_id, importance_weight DESC) INCLUDE (skill_id, skill_name)';
        END IF;
    ELSE
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_role_skills_role_covering') THEN
            EXECUTE 'CREATE INDEX idx_role_skills_role_covering ON public.role_skills (role_id, importance_weight DESC) INCLUDE (skill_id)';
        END IF;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. role_transitions
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_role_transitions_from_covering
    ON public.role_transitions (from_role_id)
    INCLUDE (to_role_id, years_required);

-- ---------------------------------------------------------------------------
-- 9. usage_logs
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_usage_logs_created_feature
    ON public.usage_logs (created_at, feature, user_id, tier);