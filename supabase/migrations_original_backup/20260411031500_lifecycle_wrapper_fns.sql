CREATE OR REPLACE FUNCTION public.run_analytics_retention_lifecycle(
    p_tenant_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    RETURN public.chi_lifecycle_run(
        p_dry_run     => false,
        p_retain_days => 90
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_peer_benchmark_mv(
    p_tenant_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    RETURN public.refresh_chi_benchmark_mv();
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$$;
