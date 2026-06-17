-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback: 20260616000003_a10_core_governance_entities_rollback.sql
-- A10 Phase 6A — WS-1 — WP-DB-003 — Core Governance Entities (ROLLBACK)
--
-- PURPOSE:
--   Reverses 20260616000003_a10_core_governance_entities.sql in full.
--   Drops governance.principal_role_grants, governance.revocation_records,
--   governance.approval_decisions, and governance.review_assignments
--   (including all rows, constraints, and auto-created indexes), and drops
--   governance.approval_decision_enum and governance.review_recommendation_enum.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠  ROLLBACK SAFETY PRECONDITION — READ BEFORE EXECUTING
-- ─────────────────────────────────────────────────────────────────────────────
--
-- This rollback is SAFE only if no later package has added a live dependency
-- on any of these four tables. Specifically:
--
--   • WP-DB-004 (Versioning Architecture) — if WP-DB-004 has already applied
--     its deferred-FK resolution step (ALTER TABLE ... ADD CONSTRAINT
--     review_assignments_lineage_version_id_fkey / etc., per WP-DB-003
--     Implementation Specification Section 5), those three constraints live
--     ON these tables (review_assignments, approval_decisions,
--     revocation_records), referencing governance.lineage_versions. Dropping
--     these tables below automatically drops those constraints along with
--     them — this is SAFE for governance.lineage_versions itself (the FK
--     reference runs in the other direction), but means WP-DB-004's own
--     Technical Validation evidence for those three constraints will need to
--     be re-established if WP-DB-003 is later re-applied.
--   • WP-DB-005 (Governance Event Store) — if GovernanceEvent rows reference
--     ReviewAssignment.id, ApprovalDecision.id, or RevocationRecord.id (via
--     FK or otherwise), roll back WP-DB-005 first.
--   • WP-DB-007 (Queue Entity Layer) — if any view reads these tables, roll
--     back or drop those views first.
--   • WP-DB-010 (Security Grant Layer) — if GRANT statements have been issued
--     against these tables, those grants are dropped automatically with the
--     tables; no separate REVOKE step is required, but WP-DB-010's own
--     evidence should be reviewed if WP-DB-003 is later re-applied.
--   • WP-DB-011 (RLS Security Layer) — if RLS policies have been created on
--     these tables, they are dropped automatically with the tables.
--
-- MANDATORY ROLLBACK ORDER when any of the above have been applied:
--   1. Roll back WP-DB-011, then WP-DB-010, then WP-DB-007, then WP-DB-005
--      (in that order, for whichever of these have actually been applied).
--   2. Then run this rollback.
--   3. WP-DB-004 does not need to be rolled back first — its deferred-FK
--      constraints (if added) are removed automatically by this rollback,
--      and governance.lineage_versions itself is never touched by this file.
--
-- This rollback does NOT touch:
--   • governance.governance_roles or governance.governance_role_name_enum
--     (WP-DB-002) — principal_role_grants_role_id_fkey is dropped along with
--     governance.principal_role_grants below, but the referenced table
--     itself is untouched, exactly as WP-DB-002's own rollback file leaves
--     the governance schema (WP-DB-001) untouched.
--   • governance.actor_role_enum (WP-DB-001) — reused, not owned, by this
--     package (Reconciliation Note item 3); it is removed only by WP-DB-001's
--     rollback file.
--   • governance.lineage_versions (WP-DB-004) — never referenced by an
--     enforced FK in this package; see Section 5 of the WP-DB-003
--     Implementation Specification.
-- ─────────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: Drop governance.principal_role_grants
-- Drops the table and implicitly removes:
--   • All rows
--   • principal_role_grants_pkey (PRIMARY KEY + auto-index on id)
--   • principal_role_grants_role_id_fkey (FOREIGN KEY to governance.governance_roles)
--   • All CHECK constraints (principal_id, granted_by, revocation consistency,
--     expiry-after-grant)
--   • idx_principal_role_grants_role_id
--   • idx_principal_role_grants_active
-- governance.governance_roles (the FK target) is NOT dropped by this step.
-- IF EXISTS guard makes this statement a no-op if the table does not exist.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS governance.principal_role_grants;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: Drop governance.revocation_records
-- Drops the table and implicitly removes:
--   • All rows
--   • revocation_records_pkey (PRIMARY KEY + auto-index on id)
--   • All CHECK constraints (rationale, initiating_principal, initiating_role,
--     co_authoriser_role, distinct_principals, co_authorisation_consistency,
--     completion_requires_co_auth)
--   • idx_revocation_records_lineage_version_id
--   • idx_revocation_records_pending_co_authorisation
--   • Any deferred FK to governance.lineage_versions added by WP-DB-004, if
--     applied (see Safety Precondition above)
-- governance.actor_role_enum (reused for initiating_role/co_authoriser_role)
-- is NOT dropped by this step.
-- IF EXISTS guard makes this statement a no-op if the table does not exist.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS governance.revocation_records;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: Drop governance.approval_decisions
-- Drops the table and implicitly removes:
--   • All rows
--   • approval_decisions_pkey (PRIMARY KEY + auto-index on id)
--   • approval_decisions_review_assignment_id_fkey (FOREIGN KEY to
--     governance.review_assignments)
--   • approval_decisions_lineage_version_id_uq (UNIQUE constraint + auto-index)
--   • All CHECK constraints (approver_id, rejection_rationale)
--   • idx_approval_decisions_review_assignment_id
--   • idx_approval_decisions_decided_at_decision
--   • idx_approval_decisions_approver_throughput
--   • Any deferred FK to governance.lineage_versions added by WP-DB-004, if
--     applied (see Safety Precondition above)
-- governance.approval_decision_enum is NOT dropped by this step (Step 6).
-- IF EXISTS guard makes this statement a no-op if the table does not exist.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS governance.approval_decisions;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: Drop governance.review_assignments
-- Drops the table and implicitly removes:
--   • All rows
--   • review_assignments_pkey (PRIMARY KEY + auto-index on id)
--   • All CHECK constraints (reviewer_id, assigned_by, sla_due_after_assigned,
--     completed_after_assigned)
--   • review_assignments_active_per_version_uq (partial unique index)
--   • idx_review_assignments_lineage_version_id
--   • idx_review_assignments_reviewer_active
--   • idx_review_assignments_sla_monitoring
--   • Any deferred FK to governance.lineage_versions added by WP-DB-004, if
--     applied (see Safety Precondition above)
-- This table is dropped after approval_decisions (Step 3) because
-- approval_decisions held a FOREIGN KEY referencing it.
-- governance.review_recommendation_enum is NOT dropped by this step (Step 5).
-- IF EXISTS guard makes this statement a no-op if the table does not exist.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS governance.review_assignments;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 5: Drop the entity-specific enum types
-- Both types were created by this package's migration and are used only by
-- the tables dropped above. The table drops in Steps 1–4 remove the column
-- dependencies; the types can therefore be dropped cleanly here.
-- IF EXISTS guards make these statements no-ops if the types do not exist.
--
-- NOTE: governance.actor_role_enum (WP-DB-001) is a DISTINCT, reused type and
-- is NOT dropped by this rollback — see the Safety Precondition note above.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TYPE IF EXISTS governance.approval_decision_enum;
DROP TYPE IF EXISTS governance.review_recommendation_enum;


-- ─────────────────────────────────────────────────────────────────────────────
-- A09 PROTECTION NOTE
-- This rollback does not reference signal_lineage, signal_registry_audit_log,
-- or fn_get_signal_lineage_summary() in any statement above. No GRANT/REVOKE
-- statements are issued. No RLS policy is created or dropped. No CREATE
-- FUNCTION, ALTER FUNCTION, or DROP FUNCTION statement is present.
-- A09 Classification: No Impact — confirmed.
-- ─────────────────────────────────────────────────────────────────────────────
