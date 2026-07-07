-- =============================================================================
-- Wave 3 Phase 4: Cohort Percentile Query Optimization
-- File: 20260411020000_percentile_optimization.sql
-- Safe: new functions only
-- =============================================================================

-- ---------------------------------------------------------------------------
-- FUNCTION 1: get_chi_percentile
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_chi_percentile(
    p_user_id text,
    p_role_id text DEFAULT NULL,
    p_weeks integer DEFAULT 4
)
RETURNS TABLE (
    user_id text,
    role_id text,
    avg_score numeric,
    percentile numeric,
    cohort_size bigint,
    week_bucket timestamptz
)
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    WITH recent_week AS (
        SELECT MAX(mv.week_bucket) AS wk
        FROM public.chi_weekly_rollups_mv mv
        WHERE mv.user_id = p_user_id
          AND (p_role_id IS NULL OR mv.role_id = p_role_id)
          AND mv.week_bucket >= date_trunc('week', now() - make_interval(days => p_weeks * 7))
    ),
    cohort AS (
        SELECT
            mv.user_id,
            mv.role_id,
            mv.avg_score,
            mv.week_bucket,
            COUNT(*) OVER ()::bigint AS cohort_size,
            ROUND(
                PERCENT_RANK() OVER (
                    PARTITION BY mv.week_bucket, mv.role_id
                    ORDER BY mv.avg_score ASC
                )::numeric,
                4
            ) AS percentile
        FROM public.chi_weekly_rollups_mv mv
        CROSS JOIN recent_week rw
        WHERE rw.wk IS NOT NULL
          AND mv.week_bucket = rw.wk
          AND (p_role_id IS NULL OR mv.role_id = p_role_id)
    )
    SELECT
        c.user_id,
        c.role_id,
        ROUND(c.avg_score, 2) AS avg_score,
        c.percentile,
        c.cohort_size,
        c.week_bucket
    FROM cohort c
    WHERE c.user_id = p_user_id
    LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- FUNCTION 2: get_chi_percentile_band
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_chi_percentile_band(
    p_user_id text,
    p_role_id text DEFAULT NULL
)
RETURNS TABLE (
    user_avg_score numeric,
    p25 numeric,
    p50 numeric,
    p75 numeric,
    p90 numeric,
    band text,
    cohort_size bigint,
    week_bucket timestamptz
)
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    WITH latest_week AS (
        SELECT MAX(week_bucket) AS wk
        FROM public.chi_weekly_rollups_mv
        WHERE (p_role_id IS NULL OR role_id = p_role_id)
    ),
    cohort_stats AS (
        SELECT
            mv.week_bucket,
            COUNT(*)::bigint AS cohort_size,
            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY mv.avg_score) AS p25,
            PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY mv.avg_score) AS p50,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mv.avg_score) AS p75,
            PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY mv.avg_score) AS p90
        FROM public.chi_weekly_rollups_mv mv
        CROSS JOIN latest_week lw
        WHERE lw.wk IS NOT NULL
          AND mv.week_bucket = lw.wk
          AND (p_role_id IS NULL OR mv.role_id = p_role_id)
        GROUP BY mv.week_bucket
    ),
    user_score AS (
        SELECT
            ROUND(mv.avg_score, 2) AS avg_score,
            mv.week_bucket
        FROM public.chi_weekly_rollups_mv mv
        CROSS JOIN latest_week lw
        WHERE lw.wk IS NOT NULL
          AND mv.user_id = p_user_id
          AND mv.week_bucket = lw.wk
          AND (p_role_id IS NULL OR mv.role_id = p_role_id)
        ORDER BY mv.week_bucket DESC
        LIMIT 1
    )
    SELECT
        us.avg_score AS user_avg_score,
        ROUND(cs.p25::numeric, 2) AS p25,
        ROUND(cs.p50::numeric, 2) AS p50,
        ROUND(cs.p75::numeric, 2) AS p75,
        ROUND(cs.p90::numeric, 2) AS p90,
        CASE
            WHEN us.avg_score >= cs.p90 THEN 'top_10'
            WHEN us.avg_score >= cs.p75 THEN 'top_25'
            WHEN us.avg_score >= cs.p50 THEN 'median'
            ELSE 'below_median'
        END AS band,
        cs.cohort_size,
        cs.week_bucket
    FROM user_score us
    CROSS JOIN cohort_stats cs;
$$;