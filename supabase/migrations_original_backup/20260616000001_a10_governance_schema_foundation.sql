-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260616000001_a10_governance_schema_foundation.sql
-- A10 Phase 6A — WS-1 — WP-DB-001 — Governance Schema Foundation
--
-- DESIGN PRINCIPLES:
--   • Additive only — creates two new, empty schema namespaces and four
--     foundational enum types. No existing object is read, altered, or
--     referenced (A09 Classification: No Impact).
--   • Idempotent — all DDL is safe to re-run (DO $$ ... duplicate_object
--     guards, IF NOT EXISTS on schemas).
--   • Foundational only — no tables, functions, grants, or RLS policies.
--     Entity tables are created by WP-DB-002 through WP-DB-009.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEMAS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS governance;
CREATE SCHEMA IF NOT EXISTS audit;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: governance.governance_status_enum
-- Generic governance status (Section 5.1)
-- CONTRACT: Never remove or rename values. Append only.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE governance.governance_status_enum AS ENUM (
    'ACTIVE',
    'INACTIVE',
    'SUPERSEDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: audit.audit_event_category_enum
-- Foundational audit event categories (Section 5.2)
-- CONTRACT: Never remove or rename values. Append only.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE audit.audit_event_category_enum AS ENUM (
    'ACCESS',
    'INTEGRITY_CHECK',
    'SYSTEM_EVENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: governance.lineage_state_enum
-- Shared lineage lifecycle states (Section 5.3)
-- Mirrors: Phase 4 §3.1 LineageVersion.current_state
-- CONTRACT: Never remove or rename values. Append only, in lockstep with the
-- GovernanceEvent valid-transition matrix (owned by WP-DB-005).
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE governance.lineage_state_enum AS ENUM (
    'APPROVED_LEGACY',
    'DRAFT',
    'PROPOSED',
    'UNDER_REVIEW',
    'APPROVED',
    'REJECTED',
    'DEPRECATED',
    'RETIRED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: governance.actor_role_enum
-- Shared governance actor roles (Section 5.4)
-- Mirrors: Phase 4 §3.2 GovernanceEvent.actor_role
-- CONTRACT: Never remove or rename values. Append only.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE governance.actor_role_enum AS ENUM (
    'CONTRIBUTOR',
    'REVIEWER',
    'APPROVER',
    'GOVERNANCE_ADMIN',
    'SYSTEM'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A09 PROTECTION NOTE
-- This migration does not reference signal_lineage, signal_registry_audit_log,
-- or fn_get_signal_lineage_summary() in any statement above. No GRANT/REVOKE
-- statements are issued. See WP-DB-001 specification Section 9 for the full
-- A09 Protection Analysis.
-- ─────────────────────────────────────────────────────────────────────────────
