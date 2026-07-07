-- =============================================================================
-- Wave 3 Phase 3: Partition Pruning Validation
-- File: 20260411014500_partition_pruning.sql
-- Safe: MV rebuild + helper function
-- Backward compatible: no RPC signature changes
-- =============================================================================

-- ---------------------------------------------------------------------------
-- FIX 1: Rebuild chi_weekly_rollups_mv with pruning-safe bounds
-- Drop dependent MVs first, they are recreated in later migrations
-- ---------------------------------------------------------------------------

DROP MATERIALIZED VIEW IF EXISTS public.chi_cohort_benchmark_mv;
DROP MATERIALIZED VIEW IF EXISTS public.chi_weekly_rollups_mv;

CREATE MATERIALIZED VIEW public.chi_weekly_rollups_mv AS
SELECT
    date_trunc('week', cs.last_updated) AS week_bucket,
    cs.user_id,
    cs.role_id,
    COUNT(*)::bigint                    AS samples,
    ROUND(AVG(cs.chi_score), 2)        AS avg_score,
    ROUND(MIN(cs.chi_score), 2)        AS min_score,
    ROUND(MAX(cs.chi_score), 2)        AS max_score,
    MAX(cs.last_updated)               AS latest_point_at
FROM public.chi_scores cs
WHERE cs.last_updated >= now() - interval '365 days'
  AND cs.last_updated < now() + interval '1 day'
GROUP BY 1, 2, 3
WITH DATA;

-- Required for future concurrent refreshes (Phase 5)
CREATE UNIQUE INDEX IF NOT EXISTS idx_chi_weekly_rollups_mv_pk
    ON public.chi_weekly_rollups_mv (week_bucket, user_id, role_id);

-- Existing Phase 1 drift-safe index
CREATE INDEX IF NOT EXISTS idx_chi_weekly_rollups_mv_user_week
    ON public.chi_weekly_rollups_mv (user_id, week_bucket DESC);

-- Required for benchmark MV source scans
CREATE INDEX IF NOT EXISTS idx_chi_weekly_rollups_mv_week_role
    ON public.chi_weekly_rollups_mv (week_bucket, role_id);

-- ---------------------------------------------------------------------------
-- FIX 2: ai_observability_logs bounded helper
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_recent_observability_logs(
    p_user_id uuid,
    p_lookback_days integer DEFAULT 90,
    p_limit integer DEFAULT 100
)
RETURNS SETOF public.ai_observability_logs
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT *
    FROM public.ai_observability_logs
    WHERE user_id = p_user_id
      AND created_at >= now() - make_interval(days => p_lookback_days)
      AND created_at <= now()
    ORDER BY created_at DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 1000);
$$;

-- =============================================================================
-- POST-DEPLOY VALIDATION
-- =============================================================================
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT * FROM public.get_recent_observability_logs(
--   '00000000-0000-0000-0000-000000000000'::uuid,
--   90,
--   100
-- );
-- Expect: only recent ai_observability_logs partitions accessed