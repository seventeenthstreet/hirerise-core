-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260616000003_a10_core_governance_entities.sql
-- A10 Phase 6A — WS-1 — WP-DB-003 — Core Governance Entities
--
-- DESIGN PRINCIPLES:
--   • Additive only — creates two new entity-specific enum types and four new
--     tables in the existing governance schema (created by WP-DB-001). No
--     existing object is read, altered, or referenced
--     (A09 Classification: No Impact).
--   • Idempotent — table DDL uses CREATE TABLE IF NOT EXISTS; enum DDL uses
--     the DO $$ ... duplicate_object guard established by WP-DB-001; index
--     DDL uses CREATE INDEX/UNIQUE INDEX IF NOT EXISTS.
--   • No triggers, functions, stored procedures, GRANT statements, RLS
--     policies, or workflow automation are created by this migration — all
--     are explicitly out of scope per the WP-DB-003 Implementation
--     Specification's Objective/Constraints section.
--   • Deferred foreign key — review_assignments.lineage_version_id,
--     approval_decisions.lineage_version_id, and
--     revocation_records.lineage_version_id are created as plain
--     uuid NOT NULL columns with NO foreign key constraint, because their
--     target table (governance.lineage_versions) does not exist yet — it is
--     created by WP-DB-004 (Versioning Architecture), which has not yet run.
--     This is the explicit Soft Dependency documented in Section 2 §3 of the
--     WS-1 work packages and resolved per WP-DB-003 Implementation
--     Specification Section 5 (Deferred Foreign Key Design). WP-DB-004 is
--     responsible for adding the three corresponding FOREIGN KEY constraints
--     via ALTER TABLE once governance.lineage_versions exists — see that
--     section for the exact resolution procedure. This migration does NOT
--     need WP-DB-004 to have run first; it is fully self-contained.
--   • Enum reuse, not duplication — RevocationRecord.initiating_role and
--     co_authoriser_role reuse governance.actor_role_enum (WP-DB-001) rather
--     than introducing a third actor-role-like enum, restricted to its
--     GOVERNANCE_ADMIN and APPROVER values by an explicit CHECK constraint.
--     See WP-DB-003 Implementation Specification, Source Document
--     Reconciliation Note item 3.
--
-- DEPENDENCY:
--   Requires: 20260616000001_a10_governance_schema_foundation.sql (WP-DB-001)
--     — provides the governance schema namespace and governance.actor_role_enum.
--   Requires: 20260616000002_a10_governance_role_model.sql (WP-DB-002)
--     — provides governance.governance_roles, the FK target for
--     principal_role_grants.role_id.
--   Both are hard dependencies, both CLOSED, per the A10 Execution Tracker.
--
-- SOURCE AUTHORITY:
--   WP-DB-003 Implementation Specification (APPROVED) — Sections 2–13.
--   This file is the sole reference implementation for that specification;
--   no design decision is made here that is not already documented there.
--
-- LOCATION: core/src/migration/
-- ─────────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: governance.review_recommendation_enum
-- Entity-specific catalogue for ReviewAssignment.review_recommendation
-- (Phase 4 §3.4; WP-DB-001 Specification §5.5 confirms this enum is owned by
-- WP-DB-003, not foundational/shared).
--
-- CONTRACT: Never remove or rename values. Append only, and only via a
-- formally reviewed amendment to the WP-DB-003 Implementation Specification.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE governance.review_recommendation_enum AS ENUM (
    'APPROVE_RECOMMENDED',
    'REJECT_RECOMMENDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: governance.approval_decision_enum
-- Entity-specific catalogue for ApprovalDecision.decision
-- (Phase 4 §3.5; WP-DB-001 Specification §5.5 confirms this enum is owned by
-- WP-DB-003, not foundational/shared).
--
-- CONTRACT: Never remove or rename values. Append only, and only via a
-- formally reviewed amendment to the WP-DB-003 Implementation Specification.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE governance.approval_decision_enum AS ENUM (
    'APPROVED',
    'REJECTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: governance.review_assignments
-- Records the assignment of a Reviewer to a LineageVersion (Phase 4 §2.4/§3.4)
--
-- OWNERSHIP:
--   Write (INSERT/UPDATE): governance_workflow_svc exclusively — applied by
--   WP-DB-010. Read (SELECT): governance_workflow_svc, dashboard_svc — applied
--   by WP-DB-010. No GRANT statements are issued by this package.
--
-- lineage_version_id: DEFERRED FK — see migration header note above and
-- WP-DB-003 Implementation Specification Section 5.
--
-- LIFECYCLE RULES (WP-DB-003 Spec §6):
--   • At most one active (review_completed_at IS NULL) row per
--     lineage_version_id — enforced below by a partial unique index.
--   • Immutable after review_completed_at is set (application-enforced; no
--     trigger is created by this package).
--   • Never physically deleted.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS governance.review_assignments (
  id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
  lineage_version_id   uuid        NOT NULL,
  reviewer_id          text        NOT NULL,
  assigned_at          timestamptz NOT NULL DEFAULT now(),
  assigned_by          text        NOT NULL,
  review_completed_at  timestamptz NULL,
  review_recommendation governance.review_recommendation_enum NULL,
  review_notes         text        NULL,
  sla_due_at           timestamptz NOT NULL,
  is_sla_breached      boolean     NOT NULL DEFAULT false,

  CONSTRAINT review_assignments_pkey
    PRIMARY KEY (id),

  CONSTRAINT review_assignments_reviewer_id_ck
    CHECK (length(btrim(reviewer_id)) > 0),

  CONSTRAINT review_assignments_assigned_by_ck
    CHECK (length(btrim(assigned_by)) > 0),

  CONSTRAINT review_assignments_sla_due_after_assigned_ck
    CHECK (sla_due_at >= assigned_at),

  CONSTRAINT review_assignments_completed_after_assigned_ck
    CHECK (review_completed_at IS NULL OR review_completed_at >= assigned_at)
);

-- Partial unique index — Phase 4 §8.2: "One active ReviewAssignment per version."
CREATE UNIQUE INDEX IF NOT EXISTS review_assignments_active_per_version_uq
  ON governance.review_assignments (lineage_version_id)
  WHERE review_completed_at IS NULL;

-- Lookup / future FK-support index for lineage_version_id.
CREATE INDEX IF NOT EXISTS idx_review_assignments_lineage_version_id
  ON governance.review_assignments (lineage_version_id);

-- Phase 4 §9.1: "Reviewer's active queue."
CREATE INDEX IF NOT EXISTS idx_review_assignments_reviewer_active
  ON governance.review_assignments (reviewer_id)
  WHERE review_completed_at IS NULL;

-- Phase 4 §9.1: "SLA monitoring."
CREATE INDEX IF NOT EXISTS idx_review_assignments_sla_monitoring
  ON governance.review_assignments (sla_due_at)
  WHERE is_sla_breached = false AND review_completed_at IS NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: governance.approval_decisions
-- Records the final approve/reject decision on a reviewed LineageVersion
-- (Phase 4 §2.5/§3.5)
--
-- OWNERSHIP:
--   Write (INSERT only — write-once, DENIED ALL on UPDATE/DELETE per Phase 4
--   §10.2): governance_workflow_svc exclusively — applied by WP-DB-010.
--   Read (SELECT): governance_workflow_svc, dashboard_svc — applied by
--   WP-DB-010. No GRANT statements are issued by this package.
--
-- lineage_version_id: DEFERRED FK — see migration header note above and
-- WP-DB-003 Implementation Specification Section 5.
-- review_assignment_id: FULLY RESOLVABLE FK — governance.review_assignments
-- is created earlier in this same migration.
--
-- LIFECYCLE RULES (WP-DB-003 Spec §7):
--   • Written once per ReviewAssignment. Never updated. Never deleted.
--   • At most one decision per lineage_version_id — enforced below by a
--     UNIQUE constraint.
--   • Rejection rationale is mandatory and non-empty — enforced below by a
--     CHECK constraint (Phase 4 §3.5.1/§8.1).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS governance.approval_decisions (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  lineage_version_id    uuid        NOT NULL,
  review_assignment_id  uuid        NOT NULL,
  approver_id           text        NOT NULL,
  decision              governance.approval_decision_enum NOT NULL,
  rationale             text        NULL,
  decided_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT approval_decisions_pkey
    PRIMARY KEY (id),

  CONSTRAINT approval_decisions_review_assignment_id_fkey
    FOREIGN KEY (review_assignment_id)
    REFERENCES governance.review_assignments (id)
    ON DELETE NO ACTION ON UPDATE NO ACTION,

  CONSTRAINT approval_decisions_lineage_version_id_uq
    UNIQUE (lineage_version_id),

  CONSTRAINT approval_decisions_approver_id_ck
    CHECK (length(btrim(approver_id)) > 0),

  CONSTRAINT approval_decisions_rejection_rationale_ck
    CHECK (
      decision <> 'REJECTED'
      OR (rationale IS NOT NULL AND length(btrim(rationale)) > 0)
    )
);

-- FK-support index — PostgreSQL does not auto-index the referencing side of a FK.
CREATE INDEX IF NOT EXISTS idx_approval_decisions_review_assignment_id
  ON governance.approval_decisions (review_assignment_id);

-- Phase 4 §9.2: "Approval and rejection rate KPIs."
CREATE INDEX IF NOT EXISTS idx_approval_decisions_decided_at_decision
  ON governance.approval_decisions (decided_at, decision);

-- Phase 4 §9.5: "Approver throughput metrics."
CREATE INDEX IF NOT EXISTS idx_approval_decisions_approver_throughput
  ON governance.approval_decisions (approver_id, decided_at);


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: governance.revocation_records
-- Records exceptional, dual-control revocation of an Approved LineageVersion
-- (Phase 4 §2.6/§3.6)
--
-- OWNERSHIP:
--   Write (INSERT/UPDATE — co-authorisation fields only, per Phase 4 §10.2):
--   governance_workflow_svc exclusively — applied by WP-DB-010.
--   Read (SELECT): Governance Admin, Governance Auditor only (Phase 4 §2.6) —
--   applied by WP-DB-010/WP-DB-011. No GRANT statements are issued by this
--   package.
--
-- lineage_version_id: DEFERRED FK — see migration header note above and
-- WP-DB-003 Implementation Specification Section 5. The application-layer
-- rule that the referenced LineageVersion must be in current_state =
-- APPROVED is a WS-3 responsibility, not database-enforced here.
--
-- initiating_role / co_authoriser_role: reuse governance.actor_role_enum
-- (WP-DB-001), restricted to GOVERNANCE_ADMIN/APPROVER by CHECK constraints
-- below — see Reconciliation Note item 3 in the WP-DB-003 specification.
--
-- LIFECYCLE RULES (WP-DB-003 Spec §8):
--   • Dual-control: co_authoriser_id, when populated, must differ from
--     initiating_principal. Completion requires co-authorisation.
--   • Rationale mandatory and non-empty.
--   • Immutable after revocation_completed_at is set (application-enforced;
--     no trigger is created by this package).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS governance.revocation_records (
  id                       uuid        NOT NULL DEFAULT gen_random_uuid(),
  lineage_version_id       uuid        NOT NULL,
  initiating_principal     text        NOT NULL,
  initiating_role          governance.actor_role_enum NOT NULL,
  revocation_rationale     text        NOT NULL,
  initiated_at             timestamptz NOT NULL DEFAULT now(),
  co_authoriser_id         text        NULL,
  co_authoriser_role       governance.actor_role_enum NULL,
  co_authorised_at         timestamptz NULL,
  revocation_completed_at  timestamptz NULL,
  sla_due_at               timestamptz NOT NULL,

  CONSTRAINT revocation_records_pkey
    PRIMARY KEY (id),

  CONSTRAINT revocation_records_rationale_ck
    CHECK (length(btrim(revocation_rationale)) > 0),

  CONSTRAINT revocation_records_initiating_principal_ck
    CHECK (length(btrim(initiating_principal)) > 0),

  CONSTRAINT revocation_records_initiating_role_ck
    CHECK (initiating_role IN ('GOVERNANCE_ADMIN', 'APPROVER')),

  CONSTRAINT revocation_records_co_authoriser_role_ck
    CHECK (co_authoriser_role IS NULL OR co_authoriser_role IN ('GOVERNANCE_ADMIN', 'APPROVER')),

  CONSTRAINT revocation_records_distinct_principals_ck
    CHECK (co_authoriser_id IS NULL OR co_authoriser_id <> initiating_principal),

  CONSTRAINT revocation_records_co_authorisation_consistency_ck
    CHECK (
      (co_authoriser_id IS NULL AND co_authoriser_role IS NULL AND co_authorised_at IS NULL)
      OR
      (co_authoriser_id IS NOT NULL AND co_authoriser_role IS NOT NULL AND co_authorised_at IS NOT NULL)
    ),

  CONSTRAINT revocation_records_completion_requires_co_auth_ck
    CHECK (revocation_completed_at IS NULL OR co_authorised_at IS NOT NULL)
);

-- Lookup / future FK-support index for lineage_version_id.
CREATE INDEX IF NOT EXISTS idx_revocation_records_lineage_version_id
  ON governance.revocation_records (lineage_version_id);

-- Phase 4 §9.1: "Pending revocations awaiting co-authorisation — exception queue feed."
CREATE INDEX IF NOT EXISTS idx_revocation_records_pending_co_authorisation
  ON governance.revocation_records (co_authoriser_id, initiated_at)
  WHERE co_authoriser_id IS NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: governance.principal_role_grants
-- Records the granting (and optional revocation/expiry) of a GovernanceRole
-- to a principal (Phase 4 §2.8/§3.8)
--
-- OWNERSHIP:
--   Write (INSERT/UPDATE — revocation fields only, per Phase 4 §10.2):
--   role_grant_svc exclusively — applied by WP-DB-010. Read (SELECT):
--   governance_workflow_svc (role resolution), dashboard_svc — applied by
--   WP-DB-010. No GRANT statements are issued by this package.
--
-- role_id: FULLY RESOLVABLE FK — governance.governance_roles was created and
-- seeded by WP-DB-002 (CLOSED).
--
-- LIFECYCLE RULES (WP-DB-003 Spec §9):
--   • Never physically deleted — logically revoked via revoked_at/revoked_by.
--   • No stored "active" column — active status is derived at query time:
--     revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()).
--   • A principal regaining a role after revocation produces a new row.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS governance.principal_role_grants (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  principal_id       text        NOT NULL,
  role_id            uuid        NOT NULL,
  granted_by         text        NOT NULL,
  granted_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NULL,
  revoked_by         text        NULL,
  revoked_at         timestamptz NULL,
  revocation_reason  text        NULL,

  CONSTRAINT principal_role_grants_pkey
    PRIMARY KEY (id),

  CONSTRAINT principal_role_grants_role_id_fkey
    FOREIGN KEY (role_id)
    REFERENCES governance.governance_roles (id)
    ON DELETE NO ACTION ON UPDATE NO ACTION,

  CONSTRAINT principal_role_grants_principal_id_ck
    CHECK (length(btrim(principal_id)) > 0),

  CONSTRAINT principal_role_grants_granted_by_ck
    CHECK (length(btrim(granted_by)) > 0),

  CONSTRAINT principal_role_grants_revocation_consistency_ck
    CHECK (
      (revoked_at IS NULL AND revoked_by IS NULL)
      OR
      (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
    ),

  CONSTRAINT principal_role_grants_expiry_after_grant_ck
    CHECK (expires_at IS NULL OR expires_at > granted_at)
);

-- FK-support index for role_id.
CREATE INDEX IF NOT EXISTS idx_principal_role_grants_role_id
  ON governance.principal_role_grants (role_id);

-- Phase 4 §9.5: "Active role holder enumeration."
CREATE INDEX IF NOT EXISTS idx_principal_role_grants_active
  ON governance.principal_role_grants (principal_id, role_id)
  WHERE revoked_at IS NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- A09 PROTECTION NOTE
-- This migration does not reference signal_lineage, signal_registry_audit_log,
-- or fn_get_signal_lineage_summary() in any statement above. No GRANT/REVOKE
-- statements are issued. No RLS policy is created. No CREATE FUNCTION,
-- CREATE TRIGGER, or stored procedure is present. No statement outside the
-- governance schema is issued, and the only cross-table reference within the
-- governance schema is to governance.governance_roles (WP-DB-002, already
-- CLOSED) and governance.actor_role_enum (WP-DB-001, already CLOSED).
-- See WP-DB-003 Implementation Specification Section 14 for the full A09
-- Protection Analysis.
-- A09 Classification: No Impact — confirmed.
-- ─────────────────────────────────────────────────────────────────────────────
