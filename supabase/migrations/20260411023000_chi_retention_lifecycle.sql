-- =============================================================================
-- Wave 3 Phase 6: CHI Snapshot Lifecycle Retention Automation
-- File: 20260411023000_chi_retention_lifecycle.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- FUNCTION 1: ensure_chi_mv_fresh
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ensure_chi_mv_fresh(
    p_max_age_minutes integer DEFAULT 30
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_last_refresh timestamptz;
BEGIN
    SELECT MAX(latest_point_at)
    INTO v_last_refresh
    FROM public.chi_weekly_rollups_mv;

    IF v_last_refresh IS NULL
       OR v_last_refresh < now() - make_interval(mins => p_max_age_minutes)
    THEN
        REFRESH MATERIALIZED VIEW CONCURRENTLY public.chi_weekly_rollups_mv;
        REFRESH MATERIALIZED VIEW CONCURRENTLY public.chi_cohort_benchmark_mv;
    END IF;

    RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- FUNCTION 2: create_chi_score_partition
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_chi_score_partition(
    p_year integer DEFAULT EXTRACT(year FROM now())::integer,
    p_month integer DEFAULT EXTRACT(month FROM now())::integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_start timestamptz;
    v_end timestamptz;
    v_name text;
    v_already boolean := false;
BEGIN
    v_start := make_date(p_year, p_month, 1)::timestamptz;
    v_end := (v_start + interval '1 month')::timestamptz;
    v_name := 'chi_scores_' || to_char(v_start, 'YYYY_MM');

    SELECT EXISTS (
        SELECT 1
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename = v_name
    ) INTO v_already;

    IF NOT v_already THEN
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS public.%I
             PARTITION OF public.chi_scores
             FOR VALUES FROM (%L) TO (%L)',
            v_name,
            v_start,
            v_end
        );
    END IF;

    RETURN jsonb_build_object(
        'partition', v_name,
        'start', v_start,
        'end', v_end,
        'created', NOT v_already
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- FUNCTION 3: drop_stale_chi_partitions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.drop_stale_chi_partitions(
    p_retain_days integer DEFAULT 90,
    p_dry_run boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_cutoff timestamptz := now() - make_interval(days => p_retain_days);
    v_dropped text[] := '{}';
    v_skipped text[] := '{}';
    v_errors jsonb := '[]';
    v_partition record;
    v_mv_covers boolean;
    v_part_end timestamptz;
BEGIN
    PERFORM public.ensure_chi_mv_fresh(60);

    FOR v_partition IN
        SELECT c.relname AS partition_name
        FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'chi_scores'
          AND c.relkind = 'r'
        ORDER BY c.relname
    LOOP
        BEGIN
            IF v_partition.partition_name !~ '^chi_scores_\d{4}_\d{2}$' THEN
                v_skipped := array_append(
                    v_skipped,
                    v_partition.partition_name || ' (unexpected naming)'
                );
                CONTINUE;
            END IF;

            v_part_end := to_timestamp(
                substring(v_partition.partition_name FROM 'chi_scores_(\d{4}_\d{2})'),
                'YYYY_MM'
            ) + interval '1 month';

            IF v_part_end > v_cutoff THEN
                v_skipped := array_append(
                    v_skipped,
                    v_partition.partition_name || ' (within retention)'
                );
                CONTINUE;
            END IF;

            SELECT EXISTS (
                SELECT 1
                FROM public.chi_weekly_rollups_mv mv
                WHERE mv.week_bucket < v_part_end
                  AND mv.week_bucket >= v_part_end - interval '31 days'
                LIMIT 1
            ) INTO v_mv_covers;

            IF NOT v_mv_covers THEN
                v_skipped := array_append(
                    v_skipped,
                    v_partition.partition_name || ' (MV not covering)'
                );
                CONTINUE;
            END IF;

            IF p_dry_run THEN
                v_dropped := array_append(
                    v_dropped,
                    v_partition.partition_name || ' [DRY RUN]'
                );
            ELSE
                EXECUTE format(
                    'DROP TABLE IF EXISTS public.%I',
                    v_partition.partition_name
                );
                v_dropped := array_append(v_dropped, v_partition.partition_name);
            END IF;

        EXCEPTION WHEN OTHERS THEN
            v_errors := v_errors || jsonb_build_object(
                'partition', v_partition.partition_name,
                'error', SQLERRM
            );
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'dry_run', p_dry_run,
        'retain_days', p_retain_days,
        'cutoff', v_cutoff,
        'dropped', to_jsonb(v_dropped),
        'skipped', to_jsonb(v_skipped),
        'errors', v_errors,
        'executed_at', now()
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- FUNCTION 4: chi_lifecycle_run
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.chi_lifecycle_run(
    p_dry_run boolean DEFAULT true,
    p_retain_days integer DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_next_year integer := EXTRACT(year FROM now() + interval '1 month')::integer;
    v_next_month integer := EXTRACT(month FROM now() + interval '1 month')::integer;
    v_partition jsonb;
    v_drop_result jsonb;
BEGIN
    v_partition := public.create_chi_score_partition(v_next_year, v_next_month);

    REFRESH MATERIALIZED VIEW CONCURRENTLY public.chi_weekly_rollups_mv;
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.chi_cohort_benchmark_mv;

    v_drop_result := public.drop_stale_chi_partitions(
        p_retain_days,
        p_dry_run
    );

    RETURN jsonb_build_object(
        'success', true,
        'partition_result', v_partition,
        'drop_result', v_drop_result,
        'mv_refreshed_at', now()
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', SQLERRM,
        'sqlstate', SQLSTATE
    );
END;
$$;