-- =============================================================================
-- Migration: 20260616000006_a10_audit_store.sql
-- Work Package: WP-DB-006 — Audit Store Foundation
-- Specification: WP-DB-006-SPEC-01 Revision 1 (IMPLEMENTATION READY)
-- Workstream: WS-1 — Database
-- Programme: HireRise A10 Phase 6A
--
-- Requires (must already be deployed):
--   20260616000001_a10_governance_schema_foundation.sql  (WP-DB-001)
--     -> provides the `audit` schema
--
-- Note on dependency guard scope: WP-DB-006-SPEC-01 Revision 1, Section J.2,
-- specifies a single dependency guard for this migration: assert that the
-- `audit` schema exists. No other WP-DB-001 through WP-DB-005 object is
-- read, referenced, or required by any DDL or DML statement below. (An
-- earlier draft of this specification listed a longer guard list, including
-- a `governance.governance_config` table; that table does not exist in any
-- reference implementation produced so far and is not part of the Revision 1
-- authoritative guard scope. No FK or other hard reference to it, or to any
-- other governance-schema object, exists anywhere in this migration.)
--
-- A09 Classification: NO IMPACT
--   - No reference to signal_lineage
--   - No reference to signal_registry_audit_log
--   - No reference to fn_get_signal_lineage_summary()
--   - No modification of any previously delivered object
--   - No FK from audit.audit_records to any table, in any schema
--
-- Idempotency: Safe to re-run. CREATE TYPE uses DO $$ ... EXCEPTION WHEN
--   duplicate_object THEN NULL guards (WP-DB-001 convention). CREATE TABLE
--   and CREATE INDEX use IF NOT EXISTS. The genesis INSERT uses
--   ON CONFLICT (id) DO NOTHING. Re-running against an already-migrated
--   schema produces zero errors, zero duplicate objects, and zero new rows.
--
-- Out of scope: triggers, functions, procedures, views, GRANT/REVOKE, RLS
--   policies, sequence number generation by database SEQUENCE object
--   (sequence_number is supplied by audit_write_svc at the application
--   layer; Phase 4 §6.3).
-- =============================================================================


-- =============================================================================
-- BLOCK 1: DEPENDENCY GUARD
-- Spec ref: WP-DB-006-SPEC-01 Revision 1, Section J.2 (Migration Structure, step 2)
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'audit'
  ) THEN
    RAISE EXCEPTION 'WP-DB-006 dependency guard FAILED: schema "audit" does not exist. '
      'Ensure WP-DB-001 (Governance Schema Foundation) has been applied before running WP-DB-006.';
  END IF;
END $$;


-- =============================================================================
-- BLOCK 2: ENUM — audit.audit_event_type_enum (16 values)
-- Spec ref: WP-DB-006-SPEC-01 Revision 1, Section C.3
-- Values declared in specification order: 13 governance lifecycle values
-- (mirroring governance.governance_event_type_enum, WP-DB-005) followed by
-- 3 audit category values (mirroring audit.audit_event_category_enum,
-- WP-DB-001). This is a new, independent enum — neither source enum is
-- read, altered, or extended by this migration.
-- CONTRACT: Never remove or rename values. Append only, via specification
-- amendment.
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE audit.audit_event_type_enum AS ENUM (
    'DRAFT_CREATED',
    'SUBMITTED',
    'WITHDRAWN',
    'REVIEW_ASSIGNED',
    'REVIEW_COMPLETED',
    'APPROVED',
    'REJECTED',
    'DEPRECATED',
    'RETIRED',
    'REVOKED',
    'LEGACY_CLASSIFIED',
    'LEGACY_ENROLLED',
    'CONFIG_CHANGED',
    'ACCESS',
    'INTEGRITY_CHECK',
    'SYSTEM_EVENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- =============================================================================
-- BLOCK 3: ENUM — audit.audit_entity_type_enum (9 values)
-- Spec ref: WP-DB-006-SPEC-01 Revision 1, Section C.4
-- Two values (LEGACY_CLASSIFICATION, LEGACY_ENROLLMENT) name tables that are
-- created later by WP-DB-007. This is intentional and safe: there is no FK
-- from audit.audit_records.entity_type to any governance table, so the enum
-- value may exist before its corresponding table does.
-- CONTRACT: Never remove or rename values. Append only, via specification
-- amendment.
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE audit.audit_entity_type_enum AS ENUM (
    'LINEAGE_VERSION',
    'GOVERNANCE_EVENT',
    'REVIEW_ASSIGNMENT',
    'APPROVAL_DECISION',
    'REVOCATION_RECORD',
    'PRINCIPAL_ROLE_GRANT',
    'GOVERNANCE_CONFIG',
    'LEGACY_CLASSIFICATION',
    'LEGACY_ENROLLMENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- =============================================================================
-- BLOCK 4: TABLE — audit.audit_records
-- Spec ref: WP-DB-006-SPEC-01 Revision 1, Section C.2 (columns), Section F
-- (check constraints), Section G (PK / unique constraint)
--
-- No foreign key constraints exist on this table (Revision 1 Section C.2;
-- draft spec Section F). entity_id, lineage_id, and entity_type are
-- logically — not structurally — coupled to other A10 entities. All
-- referential integrity for this table is enforced at the application layer
-- by audit_write_svc. This preserves audit-schema/governance-schema
-- isolation and avoids any constraint that could restrict writes to
-- signal_lineage (A09 protection).
--
-- sequence_number has no DEFAULT and is not backed by a database SEQUENCE
-- object: values are supplied by audit_write_svc (Phase 4 §6.3).
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit.audit_records (
  id                     UUID NOT NULL DEFAULT gen_random_uuid(),
  sequence_number        BIGINT NOT NULL,
  event_type             audit.audit_event_type_enum NOT NULL,
  entity_type            audit.audit_entity_type_enum NOT NULL,
  entity_id              UUID NOT NULL,
  lineage_id             TEXT NULL,
  actor_id               TEXT NOT NULL,
  actor_role             TEXT NOT NULL,
  event_timestamp        TIMESTAMPTZ NOT NULL,
  written_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  previous_hash          TEXT NOT NULL,
  record_hash            TEXT NOT NULL,
  payload                JSONB NOT NULL,
  integrity_verified_at  TIMESTAMPTZ NULL,

  CONSTRAINT audit_records_pkey
    PRIMARY KEY (id),

  CONSTRAINT audit_records_sequence_number_uq
    UNIQUE (sequence_number),

  CONSTRAINT audit_records_actor_id_ck
    CHECK (LENGTH(actor_id) >= 1),

  CONSTRAINT audit_records_actor_role_ck
    CHECK (LENGTH(actor_role) >= 1),

  CONSTRAINT audit_records_sequence_number_ck
    CHECK (sequence_number >= 1),

  CONSTRAINT audit_records_previous_hash_ck
    CHECK (LENGTH(previous_hash) = 64),

  CONSTRAINT audit_records_record_hash_ck
    CHECK (LENGTH(record_hash) = 64),

  CONSTRAINT audit_records_event_timestamp_ck
    CHECK (event_timestamp <= written_at)
);


-- =============================================================================
-- BLOCK 5: INDEXES (4 explicit indexes)
-- Spec ref: WP-DB-006-SPEC-01 Revision 1, Section I
-- The PK-backing index (id) and the audit_records_sequence_number_uq-backing
-- index (sequence_number) are created automatically by their respective
-- constraints above and are not duplicated here.
-- =============================================================================

CREATE INDEX IF NOT EXISTS audit_records_event_timestamp_idx
  ON audit.audit_records (event_timestamp DESC);

CREATE INDEX IF NOT EXISTS audit_records_entity_idx
  ON audit.audit_records (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS audit_records_lineage_idx
  ON audit.audit_records (lineage_id)
  WHERE lineage_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_records_actor_idx
  ON audit.audit_records (actor_id);


-- =============================================================================
-- BLOCK 6: GENESIS RECORD
-- Spec ref: WP-DB-006-SPEC-01 Revision 1, Section D
--
-- previous_hash = SHA-256("HireRise-A10-Audit-Genesis-v1"), UTF-8 encoded,
--   lowercase hex (Decision 6a). Independently verified against this
--   migration's documentation.
--
-- record_hash = SHA-256 of the canonical JSON serialization of all genesis
--   fields except record_hash itself: keys sorted alphabetically by Unicode
--   codepoint, no insignificant whitespace, nulls serialized as JSON null,
--   UTF-8 encoded (Decision 6b). The exact canonical JSON string and the
--   resulting hash are reproduced in Section D.2 of the Revision 1
--   specification and have been independently recomputed and confirmed to
--   match during preparation of this migration. This canonical form is
--   adopted as a temporary authoritative standard pending publication of
--   the audit_write_svc serialization specification (Assumption A-5); any
--   future amendment to that standard must not retroactively alter this
--   value (Assumption A-6).
-- =============================================================================

INSERT INTO audit.audit_records (
  id,
  sequence_number,
  event_type,
  entity_type,
  entity_id,
  lineage_id,
  actor_id,
  actor_role,
  event_timestamp,
  written_at,
  previous_hash,
  record_hash,
  payload,
  integrity_verified_at
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  1,
  'SYSTEM_EVENT',
  'LINEAGE_VERSION',
  '00000000-0000-0000-0000-000000000000',
  NULL,
  'SYSTEM',
  'SYSTEM',
  '2026-06-16 00:00:06+00',
  '2026-06-16 00:00:06+00',
  'a64303aacf630d252cdbe66179f155197cc0a70bc5b655ae04bc14d3cc9a4283',
  '6f7eb36151edc1d654ad72b8fd7ad2522a17a732aaa1379e0d75f4f94902ac18',
  '{"description": "HireRise A10 Audit Store genesis record. Marks the beginning of the append-only audit chain."}'::jsonb,
  NULL
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- END OF MIGRATION 20260616000006_a10_audit_store.sql
-- WP-DB-006 — Audit Store Foundation — complete.
-- =============================================================================
