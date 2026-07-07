CREATE OR REPLACE FUNCTION public.get_latest_chi_score(
    p_user_id text,
    p_lookback_days integer DEFAULT 90
)
RETURNS TABLE (
    id text,
    user_id text,
    role_id text,
    chi_score numeric,
    last_updated timestamptz
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        cs.id,
        cs.user_id,
        cs.role_id,
        cs.chi_score,
        cs.last_updated
    FROM public.chi_scores cs
    WHERE cs.user_id = p_user_id
      AND cs.last_updated >= now() - make_interval(days => p_lookback_days)
    ORDER BY cs.last_updated DESC
    LIMIT 1;
$$;