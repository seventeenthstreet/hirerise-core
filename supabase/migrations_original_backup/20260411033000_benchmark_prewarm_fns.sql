CREATE OR REPLACE FUNCTION public.get_hot_benchmark_cohorts(
    p_tenant_id text DEFAULT NULL,
    p_limit integer DEFAULT 25
)
RETURNS TABLE ("scoreType" text, "cohortKey" text, "cohortValue" text)
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT
        'overall'  AS "scoreType",
        'role_id'  AS "cohortKey",
        bm.role_id AS "cohortValue"
    FROM public.chi_cohort_benchmark_mv bm
    WHERE bm.week_bucket >= date_trunc('week', now() - interval '4 weeks')
    GROUP BY bm.role_id
    ORDER BY MAX(bm.sample_size) DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;

CREATE OR REPLACE FUNCTION public.get_peer_benchmark_mv(
    p_tenant_id text DEFAULT NULL,
    p_score_type text DEFAULT 'overall',
    p_cohort_key text DEFAULT 'role_id',
    p_cohort_value text DEFAULT NULL,
    p_weeks integer DEFAULT 4
)
RETURNS TABLE (
    week_bucket timestamptz, role_id text, sample_size bigint,
    avg_score numeric, median_score numeric, p25_score numeric,
    p75_score numeric, p90_score numeric, min_score numeric,
    max_score numeric, last_data_at timestamptz
)
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT
        bm.week_bucket, bm.role_id, bm.sample_size, bm.avg_score,
        bm.median_score, bm.p25_score, bm.p75_score, bm.p90_score,
        bm.min_score, bm.max_score, bm.last_data_at
    FROM public.chi_cohort_benchmark_mv bm
    WHERE (p_cohort_value IS NULL OR bm.role_id = p_cohort_value)
      AND bm.week_bucket >= date_trunc('week', now() - make_interval(days => p_weeks * 7))
    ORDER BY bm.week_bucket DESC;
$$;
