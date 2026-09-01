-- ─────────────────────────────────────────────────────────────────────────────
-- migration: 20260828030000_wp_admin_04g_02_editor_role.sql
--
-- WP-ADMIN-04G — Ordinary Role Synchronization / Editor role
--
-- PURPOSE:
--   Adds 'editor' as a valid value for public.users.role, alongside the
--   existing 'user', 'admin', 'super_admin', 'MASTER_ADMIN', 'contributor'
--   values already permitted by users_role_check (see
--   supabase/migrations/000_initial_schema.sql).
--
-- SCOPE (deliberately minimal — see WP-ADMIN-04G implementation prompt):
--   - Only public.users.role's CHECK constraint is touched.
--   - Does NOT modify admin_principals, any Administrator-lifecycle table,
--     Permission Registry, permission_assignments, or any RLS policy.
--   - Does NOT change the Administrator/MASTER_ADMIN capability boundary —
--     'editor' is an ordinary role only, enforced at the application layer
--     by adminUsers.repository.js's ASSIGNABLE_ROLES (which intentionally
--     excludes admin/super_admin/MASTER_ADMIN).
--
-- SAFE TO RUN:
--   Idempotent — DROP IF EXISTS + ADD constraint, following the same
--   pattern as 20260520000002_fix_current_step_constraint.sql. No data is
--   modified; every existing role value remains valid.
--
-- LOCAL ONLY — not pushed to remote/hosted Supabase as part of this task.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
    CHECK (role = ANY (ARRAY[
      'user'::text,
      'admin'::text,
      'super_admin'::text,
      'MASTER_ADMIN'::text,
      'contributor'::text,
      'editor'::text
    ]));

NOTIFY pgrst, 'reload schema';

COMMIT;
