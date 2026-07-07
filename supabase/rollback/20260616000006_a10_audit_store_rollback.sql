-- =============================================================================
-- Migration: 20260616000006_a10_audit_store_rollback.sql
-- Work Package: WP-DB-006 — Audit Store Foundation (ROLLBACK)
-- Specification: WP-DB-006-SPEC-01 Revision 1, Section J.3 / Decision 5
-- Workstream: WS-1 — Database
-- Programme: HireRise A10 Phase 6A
--
-- SAFETY WARNING — READ BEFORE EXECUTING (Spec ref: Section M.3 of the draft
-- WP-DB-006-SPEC-01, carried forward as binding guidance under Revision 1
-- Section J.3):
--   - Do NOT execute this rollback if WP-DB-007 (Legacy Governance Entities)
--     or any later work package has been applied. Those packages depend on
--     the Audit Store's presence; roll them back first.
--   - Do NOT execute this rollback after A10 go-live, once active governance
--     traffic is generating AuditRecords. Post-go-live rollback of the
--     Audit Store is prohibited under all circumstances.
--   - Do NOT execute this rollback after the DB-2 validation gate has been
--     formally passed and cleared for go-live.
--   This rollback is intended for pre-go-live development and validation
--   cycles only.
--
-- No explicit DELETE of the genesis row is issued. DROP TABLE removes all
-- rows (including the genesis record) automatically (Decision 5). This
-- differs from an earlier draft of this specification, which included an
-- explicit DELETE step; that step was removed in Revision 1 because it is
-- redundant with DROP TABLE and risks a partial-rollback failure if the
-- genesis row's constraint state is ever unexpected.
--
-- Rollback order (strict):
--   1. Drop the four explicit indexes.
--   2. Drop audit.audit_records (table drop also removes the PK-backing
--      index and the audit_records_sequence_number_uq-backing index).
--   3. Drop audit.audit_entity_type_enum.
--   4. Drop audit.audit_event_type_enum.
--   5. Preservation verification (advisory notices only).
--
-- Objects this rollback must NOT touch, and does not touch:
--   audit schema; audit.audit_event_category_enum (WP-DB-001); the
--   governance schema and every governance.* object created by
--   WP-DB-001 through WP-DB-005; public.signal_lineage (A09).
-- =============================================================================


-- =============================================================================
-- STEP 1: DROP INDEXES
-- =============================================================================

DROP INDEX IF EXISTS audit.audit_records_actor_idx;
DROP INDEX IF EXISTS audit.audit_records_lineage_idx;
DROP INDEX IF EXISTS audit.audit_records_entity_idx;
DROP INDEX IF EXISTS audit.audit_records_event_timestamp_idx;


-- =============================================================================
-- STEP 2: DROP TABLE
-- Removes all rows (including the genesis record), the PK constraint/index,
-- and the audit_records_sequence_number_uq constraint/index automatically.
-- No CASCADE — this table has no dependents (no FK from any other table
-- references audit.audit_records).
-- =============================================================================

DROP TABLE IF EXISTS audit.audit_records;


-- =============================================================================
-- STEP 3 & 4: DROP ENUMS
-- =============================================================================

DROP TYPE IF EXISTS audit.audit_entity_type_enum;
DROP TYPE IF EXISTS audit.audit_event_type_enum;


-- =============================================================================
-- STEP 5: PRESERVATION VERIFICATION (advisory)
-- Confirms WP-DB-006 objects are gone and nothing outside its boundary was
-- touched. Raises a NOTICE either way; does not abort the rollback.
-- =============================================================================

DO $$
DECLARE
  v_audit_schema_exists boolean;
  v_category_enum_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'audit'
  ) INTO v_audit_schema_exists;

  SELECT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'audit' AND t.typname = 'audit_event_category_enum'
  ) INTO v_category_enum_exists;

  IF NOT v_audit_schema_exists THEN
    RAISE WARNING 'WP-DB-006 rollback preservation check: "audit" schema is missing. '
      'This is unexpected — WP-DB-006 rollback must not remove the schema itself (owned by WP-DB-001).';
  ELSE
    RAISE NOTICE 'WP-DB-006 rollback preservation check: "audit" schema is intact, as expected.';
  END IF;

  IF NOT v_category_enum_exists THEN
    RAISE WARNING 'WP-DB-006 rollback preservation check: "audit.audit_event_category_enum" is missing. '
      'This WP-DB-001 object must not have been affected by this rollback.';
  ELSE
    RAISE NOTICE 'WP-DB-006 rollback preservation check: "audit.audit_event_category_enum" (WP-DB-001) is intact, as expected.';
  END IF;
END $$;

-- =============================================================================
-- END OF ROLLBACK 20260616000006_a10_audit_store_rollback.sql
-- =============================================================================
