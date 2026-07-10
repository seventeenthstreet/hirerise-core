CREATE MATERIALIZED VIEW IF NOT EXISTS public.chi_weekly_rollups_mv AS
SELECT
    date_trunc('week', cs.last_updated) AS week_bucket,
    cs.user_id,
    COUNT(*) AS samples,
    ROUND(AVG(cs.chi_score), 2) AS avg_score,
    ROUND(MIN(cs.chi_score), 2) AS min_score,
    ROUND(MAX(cs.chi_score), 2) AS max_score,
    MAX(cs.last_updated) AS latest_point_at
FROM public.chi_scores cs
WHERE cs.last_updated >= now() - interval '365 days'
GROUP BY 1, 2
WITH DATA;