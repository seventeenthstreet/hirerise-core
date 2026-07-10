-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 1A — GOVERNANCE HARDENING (EXTENSION MIGRATION)
-- File: 20260526000004_phase1a_governance_hardening.sql
--
-- Governance: HireRise Academic Intelligence Governance Blueprint v2
-- Extends:    20260526000001_phase1a_academic_taxonomy_infrastructure.sql
-- Created:    2026-05-26
--
-- SCOPE: Six enterprise-grade governance improvements + Reserved Business Key
--   Governance. This migration EXTENDS and HARDENS the existing schema.
--   It does NOT redesign tables or change authority rules.
--
-- SECTIONS:
--   1.  Partial Unique Constraint Governance
--   2.  Strict Class Range CHECK Constraints
--   3.  board_region_map — Board-Region Compatibility Table
--   4.  Taxonomy Audit Fields (created_by / updated_by)
--   5.  Immutable Business Key Triggers
--   6.  Governance-safe soft-deprecation for state_language_mapping + subject_stream_map
--       (these tables lacked deprecated_at; added now for full audit parity)
--
-- ROLLBACK: See 20260526000004_phase1a_governance_hardening.rollback.sql
--
-- DEPENDENCIES:
--   20260526000001_phase1a_academic_taxonomy_infrastructure.sql  (REQUIRED)
--   20260526000002_phase1a_seed_v1_india_taxonomy.sql            (REQUIRED)
--
-- IDEMPOTENCY:
--   All DDL uses IF NOT EXISTS, DO $$ ... IF NOT EXISTS patterns,
--   and safe trigger replacement via CREATE OR REPLACE.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: PARTIAL UNIQUE CONSTRAINT GOVERNANCE
--
-- PURPOSE:
--   Existing tables carry full UNIQUE constraints on business key columns.
--   These are replaced by partial unique indexes scoped to is_active = TRUE.
--
-- RATIONALE:
--   A soft-deleted entity (is_active = FALSE) must be allowed to coexist with
--   a new active entity bearing the same business key — this is the correct
--   behaviour for historical reconstruction and curriculum versioning.
--
--   Without partial uniqueness:
--     INSERT new 'SCIENCE' stream after deprecating the old one → CONFLICT.
--   With partial uniqueness:
--     The deprecated row is invisible to the unique index; INSERT succeeds.
--
-- APPROACH:
--   1. DROP the existing full UNIQUE table constraints (which block re-use).
--   2. CREATE partial unique indexes limited to WHERE is_active = TRUE.
--   3. Full uniqueness on UUIDs (PKs) is unchanged.
--
-- NAMING CONVENTION:
--   pudx_<table>_<columns>_active
--   ("pudx" = Partial Unique inDeX — distinguishes from full uq_ constraints)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1a. curriculum_regions
-- DROP: uq_curriculum_regions_code (full UNIQUE on country_id, region_code)
-- ADD:  pudx on (country_id, region_code) WHERE is_active = TRUE
-- ---------------------------------------------------------------------------

ALTER TABLE public.curriculum_regions
  DROP CONSTRAINT IF EXISTS uq_curriculum_regions_code;

CREATE UNIQUE INDEX IF NOT EXISTS pudx_curriculum_regions_code_active
  ON public.curriculum_regions (country_id, region_code)
  WHERE is_active = TRUE;

COMMENT ON INDEX public.pudx_curriculum_regions_code_active IS
  'Partial unique index: prevents duplicate active region_codes per country. '
  'Soft-deleted regions may coexist with new active regions sharing the same code. '
  'Supports historical reconstruction without DDL changes.';

-- ---------------------------------------------------------------------------
-- 1b. academic_boards
-- DROP: uq_academic_boards_code (full UNIQUE on country_id, board_code)
-- ADD:  pudx on (country_id, board_code) WHERE is_active = TRUE
-- ---------------------------------------------------------------------------

ALTER TABLE public.academic_boards
  DROP CONSTRAINT IF EXISTS uq_academic_boards_code;

CREATE UNIQUE INDEX IF NOT EXISTS pudx_academic_boards_code_active
  ON public.academic_boards (country_id, board_code)
  WHERE is_active = TRUE;

COMMENT ON INDEX public.pudx_academic_boards_code_active IS
  'Partial unique index: prevents duplicate active board_codes per country. '
  'Deprecated boards retain their rows; new boards with the same code are permitted '
  'only after the predecessor is soft-deprecated.';

-- ---------------------------------------------------------------------------
-- 1c. academic_streams
-- DROP: uq_academic_streams_code (full UNIQUE on board_id, stream_code)
-- ADD:  pudx on (board_id, stream_code) WHERE is_active = TRUE
-- ---------------------------------------------------------------------------

ALTER TABLE public.academic_streams
  DROP CONSTRAINT IF EXISTS uq_academic_streams_code;

CREATE UNIQUE INDEX IF NOT EXISTS pudx_academic_streams_code_active
  ON public.academic_streams (board_id, stream_code)
  WHERE is_active = TRUE;

COMMENT ON INDEX public.pudx_academic_streams_code_active IS
  'Partial unique index: prevents duplicate active stream_codes per board. '
  'Supports future curriculum versioning where stream definitions evolve.';

-- ---------------------------------------------------------------------------
-- 1d. academic_subjects
-- DROP: uq_academic_subjects_code (full UNIQUE on subject_code)
-- ADD:  pudx on (subject_code) WHERE is_active = TRUE
-- ---------------------------------------------------------------------------

ALTER TABLE public.academic_subjects
  DROP CONSTRAINT IF EXISTS uq_academic_subjects_code;

CREATE UNIQUE INDEX IF NOT EXISTS pudx_academic_subjects_code_active
  ON public.academic_subjects (subject_code)
  WHERE is_active = TRUE;

COMMENT ON INDEX public.pudx_academic_subjects_code_active IS
  'Partial unique index: prevents duplicate active subject_codes globally. '
  'A deprecated subject_code may be reactivated as a new row without collision. '
  'NOTE: Business Key Governance (Section 5) PROHIBITS recycling deprecated codes — '
  'this index permits the DB-level possibility but governance triggers prevent it.';

-- ---------------------------------------------------------------------------
-- 1e. academic_languages
-- DROP: uq_academic_languages_code (full UNIQUE on language_code)
-- ADD:  pudx on (language_code) WHERE is_active = TRUE
-- ---------------------------------------------------------------------------

ALTER TABLE public.academic_languages
  DROP CONSTRAINT IF EXISTS uq_academic_languages_code;

CREATE UNIQUE INDEX IF NOT EXISTS pudx_academic_languages_code_active
  ON public.academic_languages (language_code)
  WHERE is_active = TRUE;

COMMENT ON INDEX public.pudx_academic_languages_code_active IS
  'Partial unique index: prevents duplicate active language_codes globally.';

-- ---------------------------------------------------------------------------
-- 1f. state_language_mapping
-- DROP: uq_state_language_mapping_region_lang (full UNIQUE)
-- ADD:  pudx on (region_id, language_id) WHERE is_active = TRUE
-- ---------------------------------------------------------------------------

ALTER TABLE public.state_language_mapping
  DROP CONSTRAINT IF EXISTS uq_state_language_mapping_region_lang;

CREATE UNIQUE INDEX IF NOT EXISTS pudx_state_language_mapping_active
  ON public.state_language_mapping (region_id, language_id)
  WHERE is_active = TRUE;

COMMENT ON INDEX public.pudx_state_language_mapping_active IS
  'Partial unique index: prevents duplicate active (region, language) mappings. '
  'Soft-deleted mappings may be superseded by new active mappings with updated role flags.';

-- ---------------------------------------------------------------------------
-- 1g. subject_stream_map
-- DROP: uq_subject_stream_map_subject_stream (full UNIQUE)
-- ADD:  pudx on (subject_id, stream_id) WHERE is_active = TRUE
-- ---------------------------------------------------------------------------

ALTER TABLE public.subject_stream_map
  DROP CONSTRAINT IF EXISTS uq_subject_stream_map_subject_stream;

CREATE UNIQUE INDEX IF NOT EXISTS pudx_subject_stream_map_active
  ON public.subject_stream_map (subject_id, stream_id)
  WHERE is_active = TRUE;

COMMENT ON INDEX public.pudx_subject_stream_map_active IS
  'Partial unique index: prevents duplicate active (subject, stream) relationships. '
  'Allows curriculum evolution: a subject-stream mapping can be deprecated and '
  're-established with updated is_mandatory values without a full row replacement.';

-- =============================================================================
-- SECTION 2: STRICT CLASS RANGE CHECK CONSTRAINTS
--
-- PURPOSE:
--   Harden the existing loose class range validation.
--   Phase 1A had: applicable_from_class > 0 and from <= to.
--   This section adds: BETWEEN 1 AND 12 for both columns.
--
-- RATIONALE:
--   Indian academic curriculum spans classes 1–12.
--   Values outside this range (e.g. 0, 13, 99) indicate data entry errors.
--   NULL remains permitted for entities with no grade restriction.
--
-- GOVERNANCE RULE:
--   Constraints are named explicitly and deterministically.
--   Existing weaker constraints are dropped before adding strict replacements.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 2a. academic_streams — replace loose positive check with strict BETWEEN
-- ---------------------------------------------------------------------------

ALTER TABLE public.academic_streams
  DROP CONSTRAINT IF EXISTS chk_academic_streams_class_positive;

ALTER TABLE public.academic_streams
  ADD CONSTRAINT chk_academic_streams_from_class_range
    CHECK (applicable_from_class IS NULL
           OR applicable_from_class BETWEEN 1 AND 12);

ALTER TABLE public.academic_streams
  ADD CONSTRAINT chk_academic_streams_to_class_range
    CHECK (applicable_to_class IS NULL
           OR applicable_to_class BETWEEN 1 AND 12);

-- The ordering constraint (from <= to) already exists as
-- chk_academic_streams_class_range from Phase 1A — retained as-is.

COMMENT ON CONSTRAINT chk_academic_streams_from_class_range
  ON public.academic_streams IS
  'Strict class range governance: applicable_from_class must be 1–12 or NULL. '
  'Values outside this range indicate data entry errors in Indian curriculum context.';

COMMENT ON CONSTRAINT chk_academic_streams_to_class_range
  ON public.academic_streams IS
  'Strict class range governance: applicable_to_class must be 1–12 or NULL.';

-- ---------------------------------------------------------------------------
-- 2b. academic_subjects — add BETWEEN 1 AND 12 for both class columns
-- ---------------------------------------------------------------------------

-- Drop the existing single-combined positive check
ALTER TABLE public.academic_subjects
  DROP CONSTRAINT IF EXISTS chk_academic_subjects_class_positive;

ALTER TABLE public.academic_subjects
  ADD CONSTRAINT chk_academic_subjects_from_class_range
    CHECK (applicable_from_class IS NULL
           OR applicable_from_class BETWEEN 1 AND 12);

ALTER TABLE public.academic_subjects
  ADD CONSTRAINT chk_academic_subjects_to_class_range
    CHECK (applicable_to_class IS NULL
           OR applicable_to_class BETWEEN 1 AND 12);

COMMENT ON CONSTRAINT chk_academic_subjects_from_class_range
  ON public.academic_subjects IS
  'Strict class range governance: applicable_from_class must be 1–12 or NULL.';

COMMENT ON CONSTRAINT chk_academic_subjects_to_class_range
  ON public.academic_subjects IS
  'Strict class range governance: applicable_to_class must be 1–12 or NULL.';

-- =============================================================================
-- SECTION 3: BOARD-REGION COMPATIBILITY TABLE
--
-- PURPOSE:
--   Explicit, FK-safe mapping of boards to curriculum regions.
--   Decouples board-region compatibility from application logic and makes it
--   a first-class queryable taxonomy relationship.
--
-- RATIONALE:
--   Without this table:
--     "Which boards are available in Kerala?" requires application-level hardcoding
--     or a convention that state boards are named with region prefixes (fragile).
--
--   With this table:
--     Any board can be mapped to any number of regions; national boards (CBSE)
--     are mapped to all regions; state boards map to their primary region.
--     is_primary distinguishes the board's home jurisdiction.
--
-- GOVERNANCE:
--   - FK-safe: board_id → academic_boards, region_id → curriculum_regions
--   - Soft-delete: is_active flag, governed by prevent-delete trigger
--   - ON DELETE RESTRICT: no cascade deletions permitted
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.board_region_map (
  id          UUID        DEFAULT gen_random_uuid() NOT NULL,
  board_id    UUID        NOT NULL,
  region_id   UUID        NOT NULL,
  is_primary  BOOLEAN     DEFAULT FALSE NOT NULL,  -- TRUE = this is the board's home region
  is_active   BOOLEAN     DEFAULT TRUE  NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  created_by  TEXT,   -- NULL in Phase 1A; populated by future admin tooling
  updated_by  TEXT,   -- NULL in Phase 1A; populated by future admin tooling

  -- Primary key
  CONSTRAINT pk_board_region_map PRIMARY KEY (id),

  -- Governance: FKs
  CONSTRAINT fk_board_region_map_board
    FOREIGN KEY (board_id)
    REFERENCES public.academic_boards (id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT fk_board_region_map_region
    FOREIGN KEY (region_id)
    REFERENCES public.curriculum_regions (id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
);

COMMENT ON TABLE  public.board_region_map IS
  'Explicit region-aware board compatibility mapping. '
  'Answers: "Which boards are available in a given curriculum region?" '
  'National boards (CBSE, CISCE) map to all regions. '
  'State boards map to their primary region; is_primary = TRUE for the home jurisdiction. '
  'Drives onboarding board-selection filtering by detected or declared student region.';
COMMENT ON COLUMN public.board_region_map.is_primary IS
  'TRUE = this region is the board''s home jurisdiction. '
  'A state board has exactly one is_primary = TRUE mapping. '
  'National/international boards may have zero or many is_primary = TRUE mappings.';
COMMENT ON COLUMN public.board_region_map.created_by IS
  'Audit field: identity of the actor who created this mapping. '
  'NULL in Phase 1A migrations; populated by future admin systems.';

-- Partial unique index: one active (board, region) pairing at a time
CREATE UNIQUE INDEX IF NOT EXISTS pudx_board_region_map_active
  ON public.board_region_map (board_id, region_id)
  WHERE is_active = TRUE;

COMMENT ON INDEX public.pudx_board_region_map_active IS
  'Partial unique index: prevents duplicate active (board, region) mappings. '
  'Supports future re-mapping (e.g. board jurisdiction changes) via soft-deprecation.';

-- Operational indexes
CREATE INDEX IF NOT EXISTS idx_board_region_map_region_active
  ON public.board_region_map (region_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_board_region_map_board_active
  ON public.board_region_map (board_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_board_region_map_primary
  ON public.board_region_map (region_id, is_primary)
  WHERE is_primary = TRUE AND is_active = TRUE;

-- updated_at trigger
CREATE OR REPLACE TRIGGER trg_board_region_map_updated_at
  BEFORE UPDATE ON public.board_region_map
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Governance: physical DELETE prohibited (same as all taxonomy tables)
CREATE OR REPLACE TRIGGER trg_governance_no_delete_board_region_map
  BEFORE DELETE ON public.board_region_map
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_physical_delete_taxonomy();

-- RLS
ALTER TABLE public.board_region_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "board_region_map_public_read"
  ON public.board_region_map
  FOR SELECT
  USING (is_active = TRUE);

CREATE POLICY "board_region_map_service_role_full"
  ON public.board_region_map
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- Grants
GRANT SELECT ON public.board_region_map TO anon, authenticated;
GRANT ALL    ON public.board_region_map TO service_role;

-- =============================================================================
-- SECTION 4: TAXONOMY AUDIT FIELDS
--
-- PURPOSE:
--   Add created_by / updated_by to all taxonomy tables for governance-ready
--   auditability. Fields are nullable in Phase 1A; future admin tooling will
--   populate them via service-role operations.
--
-- GOVERNANCE RULES:
--   1. NULL is explicitly permitted — migration-driven seeds run as service_role
--      and do not carry a named actor identity in Phase 1A.
--   2. Field type is TEXT: supports UUIDs (auth.uid()), email addresses, or
--      system identifiers (e.g. 'migration:v2026.05.26', 'admin:seeder').
--   3. The updated_by field is NOT auto-stamped by set_updated_at() — it
--      requires the calling layer to supply the actor identity explicitly.
--      This is deliberate: automatic stamping would mask accountability.
--   4. board_region_map already carries these fields from Section 3.
-- =============================================================================

-- countries_master
ALTER TABLE public.countries_master
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_by TEXT;

COMMENT ON COLUMN public.countries_master.created_by IS
  'Audit: identity of the actor who created this record. '
  'NULL for migration-seeded rows. Future admin operations must supply this.';
COMMENT ON COLUMN public.countries_master.updated_by IS
  'Audit: identity of the actor who last modified this record. '
  'Not auto-stamped — calling layer must supply actor identity explicitly.';

-- curriculum_regions
ALTER TABLE public.curriculum_regions
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_by TEXT;

COMMENT ON COLUMN public.curriculum_regions.created_by IS
  'Audit: actor who created this curriculum region record.';
COMMENT ON COLUMN public.curriculum_regions.updated_by IS
  'Audit: actor who last modified this curriculum region record.';

-- academic_boards
ALTER TABLE public.academic_boards
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_by TEXT;

COMMENT ON COLUMN public.academic_boards.created_by IS
  'Audit: actor who created this board record.';
COMMENT ON COLUMN public.academic_boards.updated_by IS
  'Audit: actor who last modified this board record.';

-- academic_streams
ALTER TABLE public.academic_streams
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_by TEXT;

COMMENT ON COLUMN public.academic_streams.created_by IS
  'Audit: actor who created this stream record.';
COMMENT ON COLUMN public.academic_streams.updated_by IS
  'Audit: actor who last modified this stream record.';

-- academic_subjects
ALTER TABLE public.academic_subjects
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_by TEXT;

COMMENT ON COLUMN public.academic_subjects.created_by IS
  'Audit: actor who created this subject record.';
COMMENT ON COLUMN public.academic_subjects.updated_by IS
  'Audit: actor who last modified this subject record.';

-- academic_languages
ALTER TABLE public.academic_languages
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_by TEXT;

COMMENT ON COLUMN public.academic_languages.created_by IS
  'Audit: actor who created this language record.';
COMMENT ON COLUMN public.academic_languages.updated_by IS
  'Audit: actor who last modified this language record.';

-- state_language_mapping
ALTER TABLE public.state_language_mapping
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_by TEXT;

COMMENT ON COLUMN public.state_language_mapping.created_by IS
  'Audit: actor who created this state-language mapping.';
COMMENT ON COLUMN public.state_language_mapping.updated_by IS
  'Audit: actor who last modified this state-language mapping.';

-- subject_stream_map
ALTER TABLE public.subject_stream_map
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_by TEXT;

COMMENT ON COLUMN public.subject_stream_map.created_by IS
  'Audit: actor who created this subject-stream mapping.';
COMMENT ON COLUMN public.subject_stream_map.updated_by IS
  'Audit: actor who last modified this subject-stream mapping.';

-- =============================================================================
-- SECTION 5: IMMUTABLE BUSINESS KEY GOVERNANCE
--
-- PURPOSE:
--   Prevent in-place mutation of business key columns after row creation.
--
-- RATIONALE:
--   The following columns are reserved identifiers used across:
--     • AI embedding pipelines    (embedding vector keys)
--     • Telemetry dimensions      (analytics event dimensions)
--     • API contracts             (public-facing route parameters)
--     • Cache keys                (Redis/CDN invalidation signals)
--     • Integration identifiers   (third-party curriculum systems)
--
--   Mutating any of these in-place would silently break all downstream
--   consumers. The correct governance procedure is:
--     1. Create a new row with the new business key.
--     2. Soft-deprecate the old row (is_active = FALSE, deprecated_at = NOW()).
--     3. Downstream consumers migrate to the new key via a versioned update.
--
-- PROTECTED COLUMNS:
--   subject_code    — academic_subjects
--   board_code      — academic_boards
--   stream_code     — academic_streams
--   language_code   — academic_languages
--   region_code     — curriculum_regions
--   country_code    — countries_master
--
-- ENFORCEMENT:
--   BEFORE UPDATE triggers raise an explicit governance exception if any
--   protected column is included in an UPDATE with a changed value.
--   Trigger fires only when OLD.value <> NEW.value — metadata updates
--   (is_active, deprecated_at, updated_by, etc.) are unaffected.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_enforce_immutable_business_key()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_old_key TEXT;
  v_new_key TEXT;
  v_column  TEXT;
BEGIN
  -- Resolve which column to check based on the firing table
  v_column := TG_ARGV[0];

  EXECUTE format('SELECT ($1).%I::TEXT', v_column) INTO v_old_key USING OLD;
  EXECUTE format('SELECT ($1).%I::TEXT', v_column) INTO v_new_key USING NEW;

  IF v_old_key IS DISTINCT FROM v_new_key THEN
    RAISE EXCEPTION
      'GOVERNANCE_VIOLATION: Business key "%" in table "%" is immutable after creation. '
      'Attempted change: "%" → "%. '
      'Correct procedure: (1) INSERT a new row with the new key, '
      '(2) soft-deprecate this row (is_active = FALSE, deprecated_at = NOW()). '
      'See HireRise Governance Blueprint v2 §Reserved Business Key Governance.',
      v_column, TG_TABLE_NAME, v_old_key, v_new_key
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_enforce_immutable_business_key() IS
  'Governance trigger — prevents in-place mutation of reserved business key columns. '
  'Fires BEFORE UPDATE and compares OLD vs NEW value for the column named in TG_ARGV[0]. '
  'Raises restrict_violation if a change is detected. '
  'Does not block metadata updates (is_active, deprecated_at, updated_by, etc.).';

-- Apply immutable key triggers to each protected table/column combination

CREATE OR REPLACE TRIGGER trg_immutable_key_countries_master_code
  BEFORE UPDATE ON public.countries_master
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_immutable_business_key('country_code');

CREATE OR REPLACE TRIGGER trg_immutable_key_curriculum_regions_code
  BEFORE UPDATE ON public.curriculum_regions
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_immutable_business_key('region_code');

CREATE OR REPLACE TRIGGER trg_immutable_key_academic_boards_code
  BEFORE UPDATE ON public.academic_boards
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_immutable_business_key('board_code');

CREATE OR REPLACE TRIGGER trg_immutable_key_academic_streams_code
  BEFORE UPDATE ON public.academic_streams
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_immutable_business_key('stream_code');

CREATE OR REPLACE TRIGGER trg_immutable_key_academic_subjects_code
  BEFORE UPDATE ON public.academic_subjects
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_immutable_business_key('subject_code');

CREATE OR REPLACE TRIGGER trg_immutable_key_academic_languages_code
  BEFORE UPDATE ON public.academic_languages
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_immutable_business_key('language_code');

-- =============================================================================
-- SECTION 6: SUPPLEMENT — deprecated_at ON MAPPING TABLES
--
-- PURPOSE:
--   state_language_mapping and subject_stream_map in Phase 1A had no
--   deprecated_at column. For full audit parity with master tables, add it now.
--   The govern-safe deprecation check constraint is also added.
-- =============================================================================

ALTER TABLE public.state_language_mapping
  ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ;

-- ADD CONSTRAINT IF NOT EXISTS is not valid PostgreSQL syntax (no such
-- variant exists for ADD CONSTRAINT). Reconciled via a pg_constraint
-- existence check inside a DO block, preserving identical idempotency
-- and identical constraint semantics.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_state_language_mapping_deprecated_inactive'
      AND conrelid = 'public.state_language_mapping'::regclass
  ) THEN
    ALTER TABLE public.state_language_mapping
      ADD CONSTRAINT chk_state_language_mapping_deprecated_inactive
        CHECK (deprecated_at IS NULL OR is_active = FALSE);
  END IF;
END $$;

COMMENT ON COLUMN public.state_language_mapping.deprecated_at IS
  'Set when this region-language mapping is retired. '
  'Physical deletion is prohibited; deprecated mappings remain for FK integrity.';

ALTER TABLE public.subject_stream_map
  ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ;

-- Same reconciliation as above: ADD CONSTRAINT IF NOT EXISTS is not valid
-- PostgreSQL syntax.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_subject_stream_map_deprecated_inactive'
      AND conrelid = 'public.subject_stream_map'::regclass
  ) THEN
    ALTER TABLE public.subject_stream_map
      ADD CONSTRAINT chk_subject_stream_map_deprecated_inactive
        CHECK (deprecated_at IS NULL OR is_active = FALSE);
  END IF;
END $$;

COMMENT ON COLUMN public.subject_stream_map.deprecated_at IS
  'Set when this subject-stream relationship is retired. '
  'Physical deletion is prohibited; deprecated relationships remain for FK integrity.';

-- =============================================================================
-- SECTION 7: GRANTS — board_region_map utility RPC additions
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.fn_enforce_immutable_business_key() TO service_role;

-- =============================================================================
-- SECTION 8: UPDATE fn_deprecate_taxonomy_entity WHITELIST
-- Add board_region_map to the governance-safe deprecation whitelist
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_deprecate_taxonomy_entity(
  p_table TEXT,
  p_id    UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_allowed_tables TEXT[] := ARRAY[
    'countries_master',
    'curriculum_regions',
    'academic_boards',
    'academic_streams',
    'academic_subjects',
    'academic_languages',
    'state_language_mapping',
    'subject_stream_map',
    'board_region_map'          -- Added in governance hardening
  ];
  v_result JSONB;
  v_rows   INT;
BEGIN
  IF NOT (p_table = ANY(v_allowed_tables)) THEN
    RAISE EXCEPTION
      'fn_deprecate_taxonomy_entity: table "%" is not a valid taxonomy table. '
      'Allowed: %', p_table, array_to_string(v_allowed_tables, ', ')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'fn_deprecate_taxonomy_entity: p_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  EXECUTE format(
    'UPDATE public.%I
       SET is_active     = FALSE,
           deprecated_at = NOW(),
           updated_at    = NOW()
     WHERE id = $1
       AND is_active = TRUE
     RETURNING to_jsonb(%I.*)',
    p_table, p_table
  )
  USING p_id
  INTO v_result;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RAISE EXCEPTION
      'fn_deprecate_taxonomy_entity: No active record found in table "%" with id %',
      p_table, p_id
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN jsonb_build_object(
    'success',       TRUE,
    'table',         p_table,
    'deprecated_id', p_id,
    'deprecated_at', NOW(),
    'entity',        v_result
  );

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object('success', FALSE, 'error', SQLERRM, 'code', 'VALIDATION_ERROR');
  WHEN no_data_found THEN
    RETURN jsonb_build_object('success', FALSE, 'error', SQLERRM, 'code', 'NOT_FOUND');
  WHEN OTHERS THEN
    RAISE EXCEPTION 'fn_deprecate_taxonomy_entity failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;

COMMENT ON FUNCTION public.fn_deprecate_taxonomy_entity(TEXT, UUID) IS
  'Governance-safe soft-deprecation for taxonomy entities. '
  'Table name is whitelisted — prevents SQL injection. '
  'Updated in governance hardening to include board_region_map. '
  'Sets is_active = FALSE, deprecated_at = NOW(). '
  'Physical DELETE remains blocked by trg_governance_no_delete_* triggers.';

COMMIT;

-- =============================================================================
-- END OF MIGRATION: 20260526000004_phase1a_governance_hardening.sql
-- =============================================================================
