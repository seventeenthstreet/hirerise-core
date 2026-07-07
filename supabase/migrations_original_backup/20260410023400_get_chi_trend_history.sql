CREATE OR REPLACE FUNCTION public.get_chi_trend_history(
    p_user_id text,
    p_lookback_days integer DEFAULT 45,
    p_bucket text DEFAULT 'day'
)
RETURNS TABLE (
    bucket timestamptz,
    avg_score numeric,
    min_score numeric,
    max_score numeric,
    samples bigint
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        date_trunc(p_bucket, cs.last_updated) AS bucket,
        ROUND(AVG(cs.chi_score), 2) AS avg_score,
        ROUND(MIN(cs.chi_score), 2) AS min_score,
        ROUND(MAX(cs.chi_score), 2) AS max_score,
        COUNT(*) AS samples
    FROM public.chi_scores cs
    WHERE cs.user_id = p_user_id
      AND cs.last_updated >= now() - (p_lookback_days || ' days')::interval
    GROUP BY 1
    ORDER BY 1 ASC;
$$;