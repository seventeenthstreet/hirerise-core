-- =============================================================================
-- Wave 3 Phase 5: Peer Benchmark Materialization Strategy
-- File: 20260411021500_peer_benchmark_mv.sql
-- Safe: new MV + helper functions
-- =============================================================================

DROP MATERIALIZED VIEW IF EXISTS public.chi_cohort_benchmark_mv;

CREATE MATERIALIZED VIEW public.chi_cohort_benchmark_mv AS
SELECT
    mv.week_bucket,
    mv.role_id,
    COUNT(DISTINCT mv.user_id)::bigint AS sample_size,
    ROUND(AVG(mv.avg_score), 2)        AS avg_score,
    ROUND(
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY mv.avg_score)::numeric,
        2
    ) AS median_score,
    ROUND(
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY mv.avg_score)::numeric,
        2
    ) AS p25_score,
    ROUND(
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mv.avg_score)::numeric,
        2
    ) AS p75_score,
    ROUND(
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY mv.avg_score)::numeric,
        2
    ) AS p90_score,
    ROUND(MIN(mv.avg_score), 2)        AS min_score,
    ROUND(MAX(mv.avg_score), 2)        AS max_score,
    MAX(mv.latest_point_at)            AS last_data_at
FROM public.chi_weekly_rollups_mv mv
WHERE mv.week_bucket >= date_trunc('week', now() - interval '52 weeks')
  AND mv.week_bucket < date_trunc('week', now() + interval '1 week')
GROUP BY mv.week_bucket, mv.role_id
HAVING COUNT(DISTINCT mv.user_id) >= 3
WITH DATA;

-- Required for concurrent refresh
CREATE UNIQUE INDEX IF NOT EXISTS idx_chi_benchmark_mv_pk
    ON public.chi_cohort_benchmark_mv (week_bucket, role_id);

CREATE INDEX IF NOT EXISTS idx_chi_benchmark_mv_role_week
    ON public.chi_cohort_benchmark_mv (role_id, week_bucket DESC);

CREATE INDEX IF NOT EXISTS idx_chi_benchmark_mv_week
    ON public.chi_cohort_benchmark_mv (week_bucket DESC)
    WHERE sample_size >= 10;

-- ---------------------------------------------------------------------------
-- FUNCTION: get_peer_benchmark
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_peer_benchmark(
    p_role_id text,
    p_weeks integer DEFAULT 4
)
RETURNS TABLE (
    week_bucket timestamptz,
    role_id text,
    sample_size bigint,
    avg_score numeric,
    median_score numeric,
    p25_score numeric,
    p75_score numeric,
    p90_score numeric
)
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT
        bm.week_bucket,
        bm.role_id,
        bm.sample_size,
        bm.avg_score,
        bm.median_score,
        bm.p25_score,
        bm.p75_score,
        bm.p90_score
    FROM public.chi_cohort_benchmark_mv bm
    WHERE bm.role_id = p_role_id
      AND bm.week_bucket >= date_trunc(
            'week',
            now() - make_interval(days => p_weeks * 7)
      )
    ORDER BY bm.week_bucket DESC
    LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- FUNCTION: refresh_chi_benchmark_mv
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refresh_chi_benchmark_mv()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.chi_cohort_benchmark_mv;

    RETURN jsonb_build_object(
        'success', true,
        'refreshed_at', now(),
        'view', 'chi_cohort_benchmark_mv'
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', SQLERRM,
        'sqlstate', SQLSTATE
    );
END;
$$;