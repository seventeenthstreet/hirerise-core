-- =============================================================================
-- Wave 3 Phase 2: Slow RPC Hotspot Review
-- File: 20260411013000_rpc_hotspot_fixes.sql
-- Safe: CREATE OR REPLACE only
-- Backward compatible: signatures + return schemas unchanged
-- =============================================================================

-- ---------------------------------------------------------------------------
-- FIX 1: get_latest_chi_score
-- Partition pruning + latest row push-down
-- ---------------------------------------------------------------------------

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
PARALLEL SAFE
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
      AND cs.last_updated <= now()
    ORDER BY cs.last_updated DESC
    LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- FIX 2: get_chi_trend_history
-- MV fast-path + bounded raw scan fallback
-- ---------------------------------------------------------------------------

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
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $$
DECLARE
    v_since timestamptz := now() - make_interval(days => p_lookback_days);
    v_bucket text := lower(trim(p_bucket));
BEGIN
    -- Normalize unsupported buckets safely
    IF v_bucket NOT IN ('day', 'week', 'month') THEN
        v_bucket := 'day';
    END IF;

    -- Fast-path for weekly rollups
    IF v_bucket = 'week' AND p_lookback_days <= 365 THEN
        RETURN QUERY
        SELECT
            mv.week_bucket AS bucket,
            mv.avg_score,
            mv.min_score,
            mv.max_score,
            mv.samples
        FROM public.chi_weekly_rollups_mv mv
        WHERE mv.user_id = p_user_id
          AND mv.week_bucket >= date_trunc('week', v_since)
          AND mv.week_bucket <= date_trunc('week', now())
        ORDER BY mv.week_bucket ASC;

        IF FOUND THEN
            RETURN;
        END IF;
    END IF;

    -- Raw fallback path
    RETURN QUERY
    SELECT
        date_trunc(v_bucket, cs.last_updated) AS bucket,
        ROUND(AVG(cs.chi_score), 2)          AS avg_score,
        ROUND(MIN(cs.chi_score), 2)          AS min_score,
        ROUND(MAX(cs.chi_score), 2)          AS max_score,
        COUNT(*)::bigint                     AS samples
    FROM public.chi_scores cs
    WHERE cs.user_id = p_user_id
      AND cs.last_updated >= v_since
      AND cs.last_updated <= now()
    GROUP BY 1
    ORDER BY 1 ASC;
END;
$$;

-- =============================================================================
-- POST-DEPLOY EXPLAIN VALIDATION
-- =============================================================================
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT * FROM public.get_chi_trend_history('test-user', 45, 'week');
-- Expect: Index Scan using idx_chi_weekly_rollups_user_week

-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT * FROM public.get_chi_trend_history('test-user', 14, 'day');
-- Expect: Index Scan using idx_chi_scores_user_updated