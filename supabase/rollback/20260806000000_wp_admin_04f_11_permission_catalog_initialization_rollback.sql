-- =============================================================================
-- Migration: 20260806000000_wp_admin_04f_11_permission_catalog_initialization_rollback.sql
-- Work Package: WP-ADMIN-04F-11 — Enterprise Permission Catalog Initialization
--
-- Reverses 20260806000000_wp_admin_04f_11_permission_catalog_initialization.sql
-- by deleting exactly the three catalog rows it inserted, identified by
-- their Stable Permission Identity. Does not drop or alter
-- public.permissions itself (owned by WP-ADMIN-04F-02) — only removes the
-- catalog data this migration is responsible for.
--
-- SCOPE — read before running in an environment with more than one
-- Permission Catalog migration applied:
--   - This rollback removes ONLY the three `administration:*` identities
--     WP-ADMIN-04F-11 introduced: administration:view, administration:create,
--     administration:delete.
--   - Later migrations may add further Permissions under the same
--     `administration` resource (e.g. administration:update,
--     administration:publish). Those rows are NOT touched by this
--     rollback — deliberately. This script only ever undoes the specific
--     INSERT WP-ADMIN-04F-11 performed; it has no knowledge of, and no
--     business reverting, catalog entries introduced by other work
--     packages. Rolling those back is that later migration's own
--     rollback's job.
--
-- SAFETY WARNING — READ BEFORE EXECUTING
--   - This targets rows by `name` only. If any of these three Permissions
--     have since been assigned to a Role or a user via the Permission
--     Assignment Service, those assignment records reference a
--     now-missing Permission — check
--     src/domain/permission/assignment/ for dependents before running
--     this in an environment with real assignments.
--   - Do NOT run this rollback as a routine operation — it exists only to
--     recover from an unexpected issue immediately after the forward
--     migration is applied.
-- =============================================================================

BEGIN;

DELETE FROM "public"."permissions"
WHERE "name" IN ('administration:view', 'administration:create', 'administration:delete');

COMMIT;

-- =============================================================================
-- End of 20260806000000_wp_admin_04f_11_permission_catalog_initialization_rollback.sql
-- =============================================================================
