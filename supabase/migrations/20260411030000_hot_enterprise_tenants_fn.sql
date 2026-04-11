-- =============================================================================
-- Add get_hot_enterprise_tenants function
-- Used by lifecycle worker deploy warmup to prewarm benchmark cache
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_hot_enterprise_tenants()
RETURNS TABLE (tenant_id text)
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT DISTINCT cs.user_id AS tenant_id
    FROM public.chi_scores cs
    WHERE cs.last_updated >= now() - interval '7 days'
    ORDER BY tenant_id
    LIMIT 50;
$$;
