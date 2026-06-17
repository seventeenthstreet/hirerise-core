-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260616000002_a10_governance_role_model.sql
-- A10 Phase 6A — WS-1 — WP-DB-002 — Governance Role Model
--
-- DESIGN PRINCIPLES:
--   • Additive only — creates one new entity-specific enum type and one new
--     table in the existing governance schema (created by WP-DB-001). No
--     existing object is read, altered, or referenced
--     (A09 Classification: No Impact).
--   • Idempotent — table DDL uses CREATE TABLE IF NOT EXISTS; enum DDL uses
--     the DO $$ ... duplicate_object guard established by WP-DB-001.
--   • Seed-on-create — the four approved GovernanceRole records are inserted
--     in this same migration, guarded by ON CONFLICT DO NOTHING so re-running
--     the migration is a true no-op with zero duplicate rows produced.
--   • Catalogue is fixed — per Phase 4 §12.5, exactly four records must exist
--     post-migration. No application insert path for additional roles is
--     created by this package.
--
-- DEPENDENCY:
--   Requires: 20260616000001_a10_governance_schema_foundation.sql (WP-DB-001)
--   The governance schema namespace must already exist before this migration
--   is applied. Per WP-DB-001 Naming Convention Standard and Identifier
--   Strategy — both are inherited and applied without modification here.
--
-- LOCATION: core/src/migration/
-- ─────────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: governance.governance_role_name_enum
-- Entity-specific catalogue for GovernanceRole.role_name (Phase 4 §3.7)
--
-- DISTINCT FROM governance.actor_role_enum (WP-DB-001):
--   governance.actor_role_enum  — used by GovernanceEvent.actor_role (5 values:
--     CONTRIBUTOR, REVIEWER, APPROVER, GOVERNANCE_ADMIN, SYSTEM). Closed.
--   governance.governance_role_name_enum — used by GovernanceRole.role_name
--     (4 values: GOVERNANCE_ADMIN, REVIEWER, APPROVER, GOVERNANCE_AUDITOR).
--     Created here. These are separate, independently maintained catalogues.
--
-- Per WP-DB-001 Specification §5 inclusion rule: entity-specific enums scoped
-- to a single field within a single entity are the responsibility of that
-- entity's work package — this enum is therefore created here, not in WP-DB-001.
--
-- CONTRACT: Never remove or rename values without a formally reviewed amendment
-- to the WP-DB-002 Implementation Specification and a follow-on migration.
-- Any future fifth value also requires a corresponding governance.actor_role_enum
-- review (Technical Validation requirement, WP-DB-002 Spec §14).
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE governance.governance_role_name_enum AS ENUM (
    'GOVERNANCE_ADMIN',
    'REVIEWER',
    'APPROVER',
    'GOVERNANCE_AUDITOR'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: governance.governance_roles
-- The fixed, four-record governance actor role catalogue (Phase 4 §2.7/§3.7)
--
-- PURPOSE:
--   Single source of truth for governance actor roles used throughout the A10
--   governance platform. PrincipalRoleGrant (WP-DB-003) references this table
--   via FK on role_id. Security, service-layer, API, and frontend layers
--   consult this table for role-based access decisions and role-conditional
--   presentation.
--
-- OWNERSHIP:
--   Write (INSERT/UPDATE): config_admin_svc exclusively — applied by WP-DB-010.
--   Read (SELECT): all governance service roles — applied by WP-DB-010.
--   No GRANT statements are issued by this package.
--
-- CONSTRAINTS:
--   governance_roles_pkey          — PRIMARY KEY on id (uuid)
--   governance_roles_role_name_uq  — UNIQUE on role_name (enum + unique = dual
--                                    enforcement against catalogue drift)
--   governance_roles_description_ck — CHECK that description is non-empty
--                                    (btrim removes whitespace before length
--                                    check, preventing blank-string bypass)
--
-- LIFECYCLE RULES (per WP-DB-002 Spec §2):
--   • Rows are never hard-deleted. Deactivate via is_active = false.
--   • role_name values are immutable after creation.
--   • description may be updated administratively by config_admin_svc.
--   • A fifth role requires a formally reviewed amendment + new migration.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS governance.governance_roles (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  role_name   governance.governance_role_name_enum NOT NULL,
  description text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  is_active   boolean     NOT NULL DEFAULT true,

  CONSTRAINT governance_roles_pkey
    PRIMARY KEY (id),

  CONSTRAINT governance_roles_role_name_uq
    UNIQUE (role_name),

  CONSTRAINT governance_roles_description_ck
    CHECK (length(btrim(description)) > 0)
);


-- ─────────────────────────────────────────────────────────────────────────────
-- SEED DATA: the four approved GovernanceRole records (Phase 4 §2.7/§12.5)
--
-- Per Phase 4 §12.5: "The GovernanceRole table must contain exactly four
-- records." These are the only four records that may be created by this
-- package. ON CONFLICT DO NOTHING ensures idempotency on re-run — a second
-- application of this migration produces zero new rows and no error.
--
-- Descriptions source: WP-DB-002 Implementation Specification §5 Seed Data
-- Catalogue (verbatim role catalogue). Descriptions are documentation-bearing
-- fields consulted during security review and audit — they are authoritative
-- and must not be abbreviated.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO governance.governance_roles (role_name, description, is_active)
VALUES
  (
    'GOVERNANCE_ADMIN',
    'Highest-privilege governance role. Sole authority to issue and revoke ' ||
    'PrincipalRoleGrant records (via role_grant_svc invocation) and to ' ||
    'co-authorise RevocationRecord dual-control actions. Read access to all ' ||
    'governance and audit entities required for administrative oversight.',
    true
  ),
  (
    'REVIEWER',
    'Performs initial review of proposed governance lineage changes ' ||
    '(ReviewAssignment, WP-DB-003). Subject to SoD enforcement: a principal ' ||
    'holding an active REVIEWER grant for a given lineage record may not also ' ||
    'be its Contributor, and may not simultaneously hold an active APPROVER ' ||
    'grant in the same review cycle, per Phase 4 §12.5.',
    true
  ),
  (
    'APPROVER',
    'Issues the final ApprovalDecision (WP-DB-003) on a reviewed governance ' ||
    'change. Subject to the same SoD enforcement as REVIEWER. Rejection ' ||
    'decisions require a mandatory, non-null rationale per Phase 4 §3.x.',
    true
  ),
  (
    'GOVERNANCE_AUDITOR',
    'Read-only compliance and audit role. Per Phase 4 §2.6/§2.8, reads ' ||
    'RevocationRecord and PrincipalRoleGrant history for compliance review ' ||
    'but holds no write authority over any governance entity.',
    true
  )
ON CONFLICT (role_name) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- A09 PROTECTION NOTE
-- This migration does not reference signal_lineage, signal_registry_audit_log,
-- or fn_get_signal_lineage_summary() in any statement above. No GRANT/REVOKE
-- statements are issued. No RLS policy is created. No CREATE FUNCTION or
-- ALTER FUNCTION statement is present. See WP-DB-002 Implementation
-- Specification §9 for the full A09 Protection Analysis.
-- A09 Classification: No Impact — confirmed.
-- ─────────────────────────────────────────────────────────────────────────────
