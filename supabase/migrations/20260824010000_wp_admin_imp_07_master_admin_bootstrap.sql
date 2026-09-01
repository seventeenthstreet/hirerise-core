-- =============================================================================
-- MIGRATION: 20260824010000_wp_admin_imp_07_master_admin_bootstrap.sql
-- PURPOSE:   WP-ADMIN-IMP-07 — Master Admin Bootstrap Recovery.
--
-- SCOPE:     Adds exactly one database-level invariant:
--
--                at most one row in public.admin_principals may have
--                role = 'MASTER_ADMIN' AND status = 'active' at a time.
--
--            This is the concurrency guarantee required by WP-ADMIN-IMP-07
--            §8: application-level eligibility checks in
--            adminBootstrap.service.js#checkEligibility() are the fast,
--            common-case guard, but two bootstrap processes racing each
--            other could both pass that check before either writes. This
--            partial unique index is what actually prevents two
--            concurrently-bootstrapped MASTER_ADMIN rows from both landing
--            as 'active' — the loser's INSERT/UPDATE is rejected by
--            Postgres with a unique_violation (SQLSTATE 23505), which
--            adminBootstrap.service.js#bootstrapMasterAdmin() catches and
--            maps to the same safe BootstrapAlreadyCompletedError an
--            eligibility-check failure would produce.
--
--            A partial index (WHERE role = 'MASTER_ADMIN' AND
--            status = 'active') rather than a table-wide unique
--            constraint, because:
--              - ordinary ADMIN/super_admin principals are unaffected and
--                may exist in any number, active or otherwise;
--              - a MASTER_ADMIN that has been suspended/revoked/expired
--                must not block granting a new active MASTER_ADMIN (the
--                lifecycle model already supports exactly this transition
--                via grant()); the partial predicate excludes those rows
--                from the uniqueness check entirely.
--
-- SAFE:      Additive only. No changes to existing columns, constraints,
--            RLS policies, or any other table. Does NOT touch Adaptive
--            Weight (public.role_weight_overrides / adaptive_weight_*) or
--            any Intelligence Administration table.
--
-- DOES NOT:  weaken requireMasterAdmin, weaken RLS, introduce a new
--            authority source, or change any existing column semantics on
--            admin_principals.
-- =============================================================================

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS "admin_principals_single_active_master_admin_idx"
  ON "public"."admin_principals" ("role")
  WHERE "role" = 'MASTER_ADMIN' AND "status" = 'active';

COMMIT;

-- =============================================================================
-- Rollback (manual):
--   DROP INDEX IF EXISTS "public"."admin_principals_single_active_master_admin_idx";
-- =============================================================================
