-- =============================================================================
-- Validation: WP-ADMIN-04F-11 — Enterprise Permission Catalog Initialization
-- Run after: 20260806000000_wp_admin_04f_11_permission_catalog_initialization.sql
--
-- Ad hoc verification queries an operator can run post-deployment. The
-- migration itself already enforces these as in-transaction assertions
-- (see its POST-INSERT ASSERTIONS block) — this file is for manual
-- spot-checks, not a required deployment step.
--
-- Scope note: every query below filters on the 3 specific Permission
-- identities WP-ADMIN-04F-11 introduced (`name IN (...)`), not on
-- `resource = 'administration'`. The `administration` resource is
-- expected to grow over time as later migrations add further
-- administration Permissions — filtering by resource here would make
-- this WP's validation drift as those future rows appear, and could mask
-- a real problem (e.g. count no longer matching 3) behind unrelated
-- growth. Scoping to this migration's own identities keeps the script
-- verifying exactly what WP-ADMIN-04F-11 is responsible for, indefinitely.
-- =============================================================================

-- 1. Row count: expect exactly 3 catalog rows introduced by this migration.
SELECT count(*) AS catalog_row_count
FROM public.permissions
WHERE name IN ('administration:view', 'administration:create', 'administration:delete');

-- 2. Full row detail: expect resource=administration, category=administration,
--    status=published for all three, description NULL.
SELECT name, resource, action, category, status, description
FROM public.permissions
WHERE name IN ('administration:view', 'administration:create', 'administration:delete')
ORDER BY name;

-- 3. No accidental duplicates of this migration's own identities beyond
--    the 3 seeded — does not assert anything about other `administration`
--    Permissions a later migration may have added since.
SELECT count(*) AS wp_admin_04f_11_row_count
FROM public.permissions
WHERE name IN ('administration:view', 'administration:create', 'administration:delete');
-- Expected: 3

-- 4. Idempotency check: re-running the forward migration must not change
--    this count. (Run this query, re-apply the migration, run it again —
--    counts must match.)
