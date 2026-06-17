-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback: 20260616000002_a10_governance_role_model_rollback.sql
-- A10 Phase 6A — WS-1 — WP-DB-002 — Governance Role Model (ROLLBACK)
--
-- PURPOSE:
--   Reverses 20260616000002_a10_governance_role_model.sql in full.
--   Drops governance.governance_roles (including its four seed rows,
--   all constraints, and its auto-created indexes) and drops
--   governance.governance_role_name_enum.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠  ROLLBACK SAFETY PRECONDITION — READ BEFORE EXECUTING
-- ─────────────────────────────────────────────────────────────────────────────
--
-- This rollback is SAFE only if no PrincipalRoleGrant row (WP-DB-003) yet
-- references any row in governance.governance_roles.
--
-- Once WP-DB-003 has been applied and any PrincipalRoleGrant record has been
-- inserted, governance.governance_roles is referenced by a live foreign key.
-- Executing this rollback in that state will result in a FK violation error
-- (or, if CASCADE were in effect, unintended data loss in PrincipalRoleGrant).
--
-- MANDATORY ROLLBACK ORDER when WP-DB-003 has been applied:
--   1. Roll back WP-DB-003 first:
--        20260616000003_a10_core_governance_entities_rollback.sql
--        (or the applicable WP-DB-003 rollback file)
--   2. Then run this rollback.
--
-- Per Phase 4 §11.3's DB-3 rollback note: "Drop GovernanceRole,
-- PrincipalRoleGrant. Revoke role_grant_svc identity. Low [risk] before any
-- role grants are made." The low-risk window closes the moment WP-DB-003 is
-- applied and any row is inserted into PrincipalRoleGrant.
--
-- Additional downstream consumers that must be rolled back before this file
-- if they have been applied:
--   WP-DB-005  (GovernanceEvent / Transition Matrix — indirect dependency)
--   WP-DB-007  (Review/Audit Reporting Views — read dependency on role_name)
--   WP-DB-010  (Security Grant Layer — GRANT matrix references this table)
--   WP-DB-011  (RLS Security Layer — if RLS was applied to this table)
--
-- The governance schema namespace itself (WP-DB-001) is NOT dropped by this
-- rollback. The governance schema remains in place after this file executes.
-- To remove the schema, run WP-DB-001's rollback after all WP-DB-002 through
-- WP-DB-013 migrations have been individually rolled back.
-- ─────────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: Drop the governance_roles table
-- Drops the table and implicitly removes:
--   • All four seed rows
--   • governance_roles_pkey (PRIMARY KEY constraint + auto-index on id)
--   • governance_roles_role_name_uq (UNIQUE constraint + auto-index on role_name)
--   • governance_roles_description_ck (CHECK constraint)
-- IF NOT EXISTS guard makes this statement a no-op if the table does not exist.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS governance.governance_roles;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: Drop the entity-specific enum type
-- governance.governance_role_name_enum was created by this package's migration
-- and is used only by governance.governance_roles.role_name. The table drop
-- in Step 1 removes the column dependency; the type can therefore be dropped
-- cleanly here.
-- IF EXISTS guard makes this statement a no-op if the type does not exist.
--
-- NOTE: governance.actor_role_enum (WP-DB-001) is a DISTINCT type and is NOT
-- dropped by this rollback. It was created by WP-DB-001 and is removed only
-- by WP-DB-001's rollback file.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TYPE IF EXISTS governance.governance_role_name_enum;


-- ─────────────────────────────────────────────────────────────────────────────
-- A09 PROTECTION NOTE
-- This rollback does not reference signal_lineage, signal_registry_audit_log,
-- or fn_get_signal_lineage_summary() in any statement above. No GRANT/REVOKE
-- statements are issued. No RLS policy is created or dropped.
-- A09 Classification: No Impact — confirmed.
-- ─────────────────────────────────────────────────────────────────────────────
