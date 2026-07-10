-- =============================================================================
-- WP-0002 — Task T-102: Enable RLS on the sim_sources table family
-- Migration: 20260710000001_wp_0002_t102_sim_sources_rls.sql
--
-- Reviewed under WP-0002 Task T-102 Engineering Peer Review (see
-- wp0002_t102_engineering_review.md). This revision adds a documentation-
-- only validation section (Section 4) and clarifies the rollback comment.
-- No behavioral SQL was changed from the original implementation; see the
-- review document for the full list of items considered and rejected
-- (explicit service_role privileges, FORCE ROW LEVEL SECURITY, policy
-- COMMENT statements, structured metadata header).
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------------------------------------------------------
-- The WP-0002 Enterprise Security Baseline Report identified that
-- sim_sources, sim_source_health_snapshots, sim_source_relationships, and
-- sim_source_audit_log (introduced in
-- 20260706000001_wp_p2_01_sim_enterprise_foundation.sql) were created
-- without ENABLE ROW LEVEL SECURITY and without any CREATE POLICY
-- statement. Because this project's bootstrap migration grants
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated
-- at the schema level, the absence of RLS on these four tables meant Postgres
-- default grants — not application logic — were the only thing standing
-- between an anon/authenticated PostgREST caller and full read/write access.
--
-- ACCESS MODEL — established from repository evidence, not assumed:
--   - source.routes.js is mounted at /api/v1/admin/source-intelligence
--     behind `authenticate` + `requireAdmin` (core/src/server.js line ~4555,
--     confirmed against
--     core/src/modules/source-intelligence/routes/source.routes.js, whose
--     own file header states: "SIM is an internal enterprise-governance
--     system, not student/employer facing, so admin-only is the correct
--     default.")
--   - Every repository in src/modules/source-intelligence/repositories/
--     extends BaseRepository and reads `supabase` from
--     core/src/config/supabase.js, which is constructed with
--     SUPABASE_SERVICE_ROLE_KEY (never the anon key) — so the application
--     never needs `anon` or `authenticated` grants on these tables to
--     function; every legitimate access path already goes through the
--     service-role client.
--   - No CREATE POLICY, RPC GRANT, or SECURITY DEFINER function referencing
--     any of these four tables was found anywhere in the migration history
--     (verified by full-text search of the concatenated migration set).
--
-- CONCLUSION: these are internal, backend-service-only tables. This
-- migration enables RLS and grants access to `service_role` only, and
-- explicitly revokes the inherited default grants from `anon` and
-- `authenticated` so the tables no longer rely on default-privilege
-- inheritance for their security posture.
--
-- SCOPE DISCIPLINE (per WP-0002 Engineering Execution Plan, Task T-102):
--   - This migration touches ONLY the four tables listed above.
--   - No other table, function, or grant identified elsewhere in the
--     Gap Register (G2-G9) is modified here. Those remain out of scope for
--     this task and are tracked separately (T-103, T-104, T-301, T-401, ...).
--   - No schema/column change, no data change, no backend code change is
--     included in this migration — see the accompanying implementation
--     report for backend-code review findings (none required).
--
-- ROLLBACK: see the commented rollback block at the end of this file.
-- EXECUTION: idempotent — safe to run multiple times (IF EXISTS / OR
--            REPLACE-equivalent guards throughout).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Enable Row Level Security
--
-- FORCE ROW LEVEL SECURITY was reviewed and intentionally NOT added: it
-- only changes behavior for the table owner, and only when that owner
-- lacks BYPASSRLS/superuser status. Migrations in this project run as a
-- superuser role, and the only role with any policy here (service_role)
-- carries BYPASSRLS independent of RLS/FORCE RLS configuration. Adding
-- FORCE RLS would therefore change no actual access outcome while
-- implying a protection that isn't in effect.
-- -----------------------------------------------------------------------------

ALTER TABLE "public"."sim_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sim_source_health_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sim_source_relationships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sim_source_audit_log" ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 2. Explicit least-privilege policies
--
-- Naming and shape follow this project's existing service-role-only
-- convention (see e.g. "emp_employer_users_service_role_full_access" in
-- 000_initial_schema.sql): a single permissive policy scoped TO
-- "service_role" per table. No policy is added for "anon" or
-- "authenticated" because no repository evidence supports either role
-- needing direct table access — all application access is mediated by the
-- backend's service-role Supabase client, and the SIM route surface is
-- admin-only at the API layer regardless.
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "sim_sources_service_role_full_access" ON "public"."sim_sources";
CREATE POLICY "sim_sources_service_role_full_access"
  ON "public"."sim_sources"
  TO "service_role"
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "sim_source_health_snapshots_service_role_full_access" ON "public"."sim_source_health_snapshots";
CREATE POLICY "sim_source_health_snapshots_service_role_full_access"
  ON "public"."sim_source_health_snapshots"
  TO "service_role"
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "sim_source_relationships_service_role_full_access" ON "public"."sim_source_relationships";
CREATE POLICY "sim_source_relationships_service_role_full_access"
  ON "public"."sim_source_relationships"
  TO "service_role"
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "sim_source_audit_log_service_role_full_access" ON "public"."sim_source_audit_log";
CREATE POLICY "sim_source_audit_log_service_role_full_access"
  ON "public"."sim_source_audit_log"
  TO "service_role"
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 3. Remove reliance on default grants
--
-- RLS + a service_role-only policy already blocks anon/authenticated at the
-- row level, but the underlying table-level GRANT ALL ... TO anon,
-- authenticated (inherited from this schema's
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated)
-- still nominally exists. Revoking it here is defense-in-depth: it removes
-- the table from the set of objects whose safety depends on RLS never being
-- accidentally disabled later, and makes the intended access model
-- self-documenting from the grants alone.
--
-- service_role's GRANT ALL is retained as-is (reviewed, not narrowed):
-- service_role already bypasses RLS via BYPASSRLS regardless of granted
-- privileges, so narrowing to an explicit CRUD list would not reduce risk,
-- while it could silently break an undiscovered maintenance/admin path
-- run under the same credential. The anon/authenticated revocation below
-- is where the actual privilege narrowing does the work.
-- -----------------------------------------------------------------------------

REVOKE ALL ON TABLE "public"."sim_sources" FROM "anon", "authenticated";
REVOKE ALL ON TABLE "public"."sim_source_health_snapshots" FROM "anon", "authenticated";
REVOKE ALL ON TABLE "public"."sim_source_relationships" FROM "anon", "authenticated";
REVOKE ALL ON TABLE "public"."sim_source_audit_log" FROM "anon", "authenticated";

-- service_role retains full access explicitly (belt-and-suspenders; service_role
-- already bypasses RLS and typically has these privileges via default grants,
-- but this makes the intended grant state explicit rather than implicit).
GRANT ALL ON TABLE "public"."sim_sources" TO "service_role";
GRANT ALL ON TABLE "public"."sim_source_health_snapshots" TO "service_role";
GRANT ALL ON TABLE "public"."sim_source_relationships" TO "service_role";
GRANT ALL ON TABLE "public"."sim_source_audit_log" TO "service_role";

COMMIT;

-- =============================================================================
-- 4. DEPLOYMENT VALIDATION (documentation only — comments, not executed)
--
-- Run these manually after deploying to staging to confirm the intended
-- access model is actually in effect. None of this section executes as
-- part of the migration.
-- =============================================================================

-- 4a. Confirm RLS is enabled (and FORCE is intentionally OFF) on all four tables:
--
-- SELECT relname, relrowsecurity, relforcerowsecurity
-- FROM pg_class
-- WHERE relname IN (
--   'sim_sources',
--   'sim_source_health_snapshots',
--   'sim_source_relationships',
--   'sim_source_audit_log'
-- );
-- -- Expect: relrowsecurity = true, relforcerowsecurity = false for all rows.

-- 4b. Confirm exactly one service_role-only policy exists per table:
--
-- SELECT tablename, policyname, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE tablename IN (
--   'sim_sources',
--   'sim_source_health_snapshots',
--   'sim_source_relationships',
--   'sim_source_audit_log'
-- );
-- -- Expect: 4 rows, one per table, roles = {service_role}.

-- 4c. Confirm anon/authenticated have no residual table-level grants:
--
-- SELECT table_name, grantee, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_schema = 'public'
--   AND table_name IN (
--     'sim_sources',
--     'sim_source_health_snapshots',
--     'sim_source_relationships',
--     'sim_source_audit_log'
--   )
--   AND grantee IN ('anon', 'authenticated');
-- -- Expect: 0 rows.

-- 4d. Confirm service_role retains full grants:
--
-- SELECT table_name, grantee, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_schema = 'public'
--   AND table_name IN (
--     'sim_sources',
--     'sim_source_health_snapshots',
--     'sim_source_relationships',
--     'sim_source_audit_log'
--   )
--   AND grantee = 'service_role'
-- ORDER BY table_name, privilege_type;
-- -- Expect: all standard privilege types present for service_role on all
-- -- four tables.

-- =============================================================================
-- ROLLBACK (manual — run only if this migration must be reverted)
--
-- Note: this restores the *effective* privilege state anon/authenticated
-- had before this migration (full access), not the original *mechanism*
-- that produced it. The original access came from this schema's
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated,
-- which applies automatically to newly created tables. Running this
-- rollback grants the same effective privileges directly on these four
-- existing tables; it does not re-link them to the default-privilege
-- mechanism, so a *future* rollback-of-a-rollback would need to REVOKE
-- these same explicit grants again rather than relying on the schema
-- default to have "remembered" anything about these tables.
-- =============================================================================
-- BEGIN;
--
-- GRANT ALL ON TABLE "public"."sim_sources" TO "anon", "authenticated";
-- GRANT ALL ON TABLE "public"."sim_source_health_snapshots" TO "anon", "authenticated";
-- GRANT ALL ON TABLE "public"."sim_source_relationships" TO "anon", "authenticated";
-- GRANT ALL ON TABLE "public"."sim_source_audit_log" TO "anon", "authenticated";
--
-- DROP POLICY IF EXISTS "sim_sources_service_role_full_access" ON "public"."sim_sources";
-- DROP POLICY IF EXISTS "sim_source_health_snapshots_service_role_full_access" ON "public"."sim_source_health_snapshots";
-- DROP POLICY IF EXISTS "sim_source_relationships_service_role_full_access" ON "public"."sim_source_relationships";
-- DROP POLICY IF EXISTS "sim_source_audit_log_service_role_full_access" ON "public"."sim_source_audit_log";
--
-- ALTER TABLE "public"."sim_sources" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "public"."sim_source_health_snapshots" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "public"."sim_source_relationships" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "public"."sim_source_audit_log" DISABLE ROW LEVEL SECURITY;
--
-- COMMIT;
-- =============================================================================