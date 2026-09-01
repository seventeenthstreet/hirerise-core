-- WP-ADMIN-04F-20 — Permission Assignment Persistence (Blocker 3C)
--
-- Persistence table backing src/domain/permission/assignment/repository/
-- permission.assignment.repository.supabase.js. Additive only. Does not
-- modify any existing table, trigger, or policy.
--
-- SCOPE NOTE, mirroring 20260804120000_wp_admin_04f_02_permission_repository_schema.sql's
-- own precedent: this migration introduces storage for the Assignment
-- entity (WP-ADMIN-04F-06) only. It intentionally does NOT encode:
--   - a role-based CHECK constraint on `principal_id` eligibility — Blocker
--     3B's Option A (frozen product decision) makes every valid enterprise
--     user (`user`/`contributor`/`admin`/`super_admin`/`MASTER_ADMIN`)
--     equally eligible; that eligibility is a domain/application concern
--     (permission.assignment.validation.js), never a schema constraint;
--   - enum CHECK constraints on `resource`/`action` — same governed-
--     vocabulary reasoning as the `permissions` table above;
--   - any write path to, or dependency on, `public.admin_principals` —
--     Assignment and Administrator lifecycle are frozen as separate
--     systems (see permission.assignment.model.js's header); this table
--     has no column, trigger, or FK referencing admin_principals;
--   - history/audit — already durably persisted in the existing,
--     certified `admin_logs` table via logAdminAction() (WP-ADMIN-05B).
--     This table represents CURRENT STATE only.

-- ─────────────────────────────────────────────────────────────────────────
-- permission_assignments — one row per explicit Permission Assignment.
-- Canonical identity, matching permission.assignment.model.js exactly:
--   permission_identity = `${resource}:${action}`
--   assignment_identity  = `${principal_id}::${permission_identity}`
-- `assignment_identity` is the natural conflict target / duplicate-
-- prevention key — one canonical row per (principal_id, permission_identity),
-- enforced by the database (not solely application logic), so that two
-- backend instances racing an identical grant cannot both succeed.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."permission_assignments" (
    "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "principal_id"        uuid NOT NULL,
    "resource"            text NOT NULL,
    "action"              text NOT NULL,
    "permission_identity" text NOT NULL,
    "assignment_identity" text NOT NULL,
    "assigned_at"         timestamp with time zone NOT NULL DEFAULT now(),
    "created_at"          timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "public"."permission_assignments" OWNER TO "postgres";

-- FOREIGN KEY POLICY (Blocker 3C §2): principal_id references
-- public.users(id) — confirmed equal in value to the Supabase Auth user
-- id (adminUsers.repository.js: RLS policy "auth.uid() = id" ON
-- public.users, 000_initial_schema.sql). ON DELETE RESTRICT, not
-- CASCADE: public.users has no soft-delete column and no admin-exposed
-- hard-delete path today (confirmed against adminUsers.repository.js and
-- the full 000_initial_schema.sql table definition), so there is no
-- established precedent for what should happen to an Assignment if a
-- user row were ever deleted. RESTRICT fails loudly if that path is
-- introduced later, forcing an explicit decision then, rather than
-- silently destroying Assignment rows now via an assumed CASCADE.
ALTER TABLE ONLY "public"."permission_assignments"
    ADD CONSTRAINT "permission_assignments_principal_id_fkey"
    FOREIGN KEY ("principal_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT;

-- Duplicate prevention (Blocker 3C §7): the actual multi-instance-safe
-- guarantee. permission.assignment.repository.supabase.js's create()
-- relies on THIS constraint (via a Postgres unique-violation on insert),
-- not solely on an application-level pre-check, to enforce "one
-- principal + one permission = one explicit Assignment" even under
-- concurrent requests across multiple backend instances.
ALTER TABLE ONLY "public"."permission_assignments"
    ADD CONSTRAINT "permission_assignments_identity_key" UNIQUE ("assignment_identity");

COMMENT ON TABLE "public"."permission_assignments" IS
    'WP-ADMIN-04F-20 (Blocker 3C): durable persistence for explicit Permission Assignments (WP-ADMIN-04F-06). Current state only — history lives in admin_logs. Never referenced by or referencing admin_principals. See src/domain/permission/assignment/repository/permission.assignment.repository.supabase.js.';

-- Indexes (Blocker 3C §8) — justified by the repository's two actual
-- non-identity lookup patterns:
--   findByPrincipal(principalId)        -> idx_permission_assignments_principal
--   findByPermission(permissionIdentity) -> idx_permission_assignments_permission
-- The canonical single-row lookup (find/create/delete by assignment_identity)
-- is already covered by the UNIQUE constraint above, which Postgres backs
-- with its own index — no separate index on assignment_identity is added.
-- No index is added on (resource, action) individually: no repository
-- method filters on either column alone, only on the combined
-- permission_identity.
CREATE INDEX IF NOT EXISTS "idx_permission_assignments_principal"
    ON "public"."permission_assignments" USING "btree" ("principal_id");
CREATE INDEX IF NOT EXISTS "idx_permission_assignments_permission"
    ON "public"."permission_assignments" USING "btree" ("permission_identity");

-- RLS: enabled with no policies — same posture as `permissions`
-- (20260804120000_wp_admin_04f_02_permission_repository_schema.sql) and
-- admin_mfa_* (20260802010000_wp_admin_02c_mfa_totp_schema.sql). This
-- table has no direct client; it is reached only through the backend's
-- service-role Supabase client (src/config/supabase.js), which bypasses
-- RLS. The existing Permission Admin API
-- (src/modules/admin/permissions/routes/permissionAdmin.routes.js,
-- gated by requireAdmin + requirePermission(administration:*)) remains
-- the sole access path. No anon/authenticated grant is added.
ALTER TABLE "public"."permission_assignments" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."permission_assignments" TO "service_role";

-- Rollback note: no historical migration is modified by this file, and no
-- rollback script is added here — matching the precedent already set by
-- the most recent Permission/Admin migrations (e.g. 20260824010000_wp_admin_imp_07_master_admin_bootstrap.sql,
-- 20260824120000_wp_admin_intel_06_provider_registry.sql), which also
-- ship without a paired supabase/rollback/ file. If a rollback is ever
-- required: `DROP TABLE IF EXISTS "public"."permission_assignments";`
-- (safe — this table has no dependents; nothing else references it).
