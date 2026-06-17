-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback: 20260616000001_a10_governance_schema_foundation_rollback.sql
-- A10 Phase 6A — WS-1 — WP-DB-001 — Governance Schema Foundation (ROLLBACK)
--
-- SAFE ONLY IF: no table created by WP-DB-002 through WP-DB-009 yet exists in
-- the governance or audit schemas. If any such table exists, roll back those
-- migrations first, in reverse order, before running this rollback.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TYPE IF EXISTS governance.actor_role_enum;
DROP TYPE IF EXISTS governance.lineage_state_enum;
DROP TYPE IF EXISTS audit.audit_event_category_enum;
DROP TYPE IF EXISTS governance.governance_status_enum;

DROP SCHEMA IF EXISTS audit CASCADE;
DROP SCHEMA IF EXISTS governance CASCADE;
