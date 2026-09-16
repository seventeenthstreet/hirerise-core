-- =============================================================================
-- HireRise Curriculum Architecture — PHASE 1: SCHEMA FOUNDATION
-- Migration: 20260913020000_p1_curriculum_schema_foundation.sql
--
-- Governance: HireRise Academic Intelligence Governance Blueprint v2
-- Depends on: 20260526000001_phase1a_academic_taxonomy_infrastructure.sql
--             20260522000001_student_academic_records.sql
--             20260913010000_p1_curriculum_taxonomy_sentinel_enum.sql
--
-- SCOPE: Database/schema foundation ONLY for the curriculum-versioning
-- architecture (curriculum_versions -> academic_streams -> curriculum_pathways
-- -> subject membership / subject groups). No APIs, no seed data, no UX.
--
-- DOES NOT TOUCH: 20260912000000_g5_add_science_academic_subject.sql
--
-- KNOWN, DELIBERATE DEVIATION FROM THE LITERAL SPEC TEXT (documented, not
-- silent — see Phase 1 completion report §G):
--   The architecture doc asks for academic_streams.curriculum_version_id and
--   subject_stream_map.curriculum_version_id to be NOT NULL. Both tables
--   already contain rows seeded by Phase 1A
--   (20260526000002_phase1a_seed_v1_india_taxonomy.sql) that predate the
--   concept of a curriculum version, and Phase 1 explicitly forbids seeding
--   curriculum_versions data to backfill them (see spec §24/§18: "do not
--   fabricate mappings"). Making the columns NOT NULL would therefore either
--   fail outright against existing rows or require fabricating curriculum
--   version rows — both prohibited. Both columns are added NULLABLE, exactly
--   the same additive-nullable-for-legacy-compatibility pattern the spec
--   itself mandates for student_academic_records (§15) and
--   student_academic_subjects (§16). curriculum_pathways.curriculum_version_id
--   and subject_group_map.curriculum_version_id ARE NOT NULL as specified,
--   because those are brand-new tables with zero legacy rows.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION A: curriculum_versions
-- First-class temporal/lifecycle anchor for a curriculum.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.curriculum_versions (
  id                  UUID        DEFAULT gen_random_uuid() NOT NULL,
  board_id            UUID        NOT NULL,
  region_id           UUID        NULL,
  version_label       TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'draft',
  effective_from      DATE        NOT NULL,
  effective_to        DATE        NULL,
  ncert_relationship  TEXT        NULL,
  published_at        TIMESTAMPTZ NULL,
  archived_at         TIMESTAMPTZ NULL,
  created_by          UUID        NULL,
  notes               TEXT        NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  CONSTRAINT pk_curriculum_versions PRIMARY KEY (id),

  CONSTRAINT fk_curriculum_versions_board
    FOREIGN KEY (board_id) REFERENCES public.academic_boards (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT fk_curriculum_versions_region
    FOREIGN KEY (region_id) REFERENCES public.curriculum_regions (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT fk_curriculum_versions_created_by
    FOREIGN KEY (created_by) REFERENCES auth.users (id)
    ON DELETE SET NULL,

  CONSTRAINT chk_curriculum_versions_label_nonempty
    CHECK (version_label <> ''),

  CONSTRAINT chk_curriculum_versions_status
    CHECK (status IN ('draft', 'published', 'archived')),

  -- Closed vocabulary for NCERT relationship. Extend via future migration
  -- if new relationship types are required; do not repurpose values.
  CONSTRAINT chk_curriculum_versions_ncert_relationship
    CHECK (
      ncert_relationship IS NULL
      OR ncert_relationship IN ('ncert_based', 'ncert_adapted', 'non_ncert')
    ),

  CONSTRAINT chk_curriculum_versions_effective_range
    CHECK (effective_to IS NULL OR effective_to > effective_from),

  -- Lifecycle timestamps must agree with status
  CONSTRAINT chk_curriculum_versions_published_at_consistency
    CHECK (
      (status = 'draft' AND published_at IS NULL)
      OR (status IN ('published', 'archived') AND published_at IS NOT NULL)
    ),

  CONSTRAINT chk_curriculum_versions_archived_at_consistency
    CHECK (
      (status <> 'archived' AND archived_at IS NULL)
      OR (status = 'archived' AND archived_at IS NOT NULL)
    )
);

COMMENT ON TABLE public.curriculum_versions IS
  'First-class temporal anchor for a curriculum. Every stream, pathway, '
  'subject membership, and student academic record is scoped to a specific '
  'curriculum_version so historical student references stay pinned to the '
  'curriculum that was authoritative when the record was created. '
  'Lifecycle: draft -> published -> archived. Published/archived rows are '
  'structurally immutable — see trg_curriculum_versions_lifecycle_guard.';
COMMENT ON COLUMN public.curriculum_versions.status IS
  'draft = editable, not yet in force. published = locked, structurally '
  'immutable, authoritative. archived = retired but retained for historical '
  'student references. draft -> published -> archived only; no other '
  'transition is permitted (enforced by trigger).';
COMMENT ON COLUMN public.curriculum_versions.ncert_relationship IS
  'How this curriculum version relates to the NCERT national framework: '
  'ncert_based | ncert_adapted | non_ncert. NULL = not yet classified.';

-- Version-scoped uniqueness. region_id is nullable (national boards have no
-- region), so NULL and non-NULL region_id need separate partial unique
-- indexes — a plain UNIQUE(board_id, region_id, version_label) would treat
-- every NULL region_id as distinct and fail to prevent duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_curriculum_versions_board_region_label
  ON public.curriculum_versions (board_id, region_id, version_label)
  WHERE region_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_curriculum_versions_board_label_no_region
  ON public.curriculum_versions (board_id, version_label)
  WHERE region_id IS NULL;

-- Composite uniqueness target for downstream composite FKs (academic_streams,
-- curriculum_pathways) that must prove they reference a version consistent
-- with their own curriculum_version_id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_curriculum_versions_id_self
  ON public.curriculum_versions (id, board_id);

-- Indexes for expected lookup paths
CREATE INDEX IF NOT EXISTS idx_curriculum_versions_board
  ON public.curriculum_versions (board_id);
CREATE INDEX IF NOT EXISTS idx_curriculum_versions_region
  ON public.curriculum_versions (region_id);
CREATE INDEX IF NOT EXISTS idx_curriculum_versions_status
  ON public.curriculum_versions (status);
CREATE INDEX IF NOT EXISTS idx_curriculum_versions_effective_range
  ON public.curriculum_versions (effective_from, effective_to);

CREATE OR REPLACE TRIGGER trg_curriculum_versions_updated_at
  BEFORE UPDATE ON public.curriculum_versions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Lifecycle + immutability guard.
-- draft -> published -> archived only. Published/archived rows may not have
-- their structural identity/effectivity fields changed. `notes` remains
-- freely editable at any status since it is harmless operational metadata,
-- not structural curriculum identity.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_curriculum_version_lifecycle_guard()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION
        'GOVERNANCE_VIOLATION: curriculum_versions must be created with status = draft. '
        'Publish it via a separate transition update.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('published', 'archived') THEN
      RAISE EXCEPTION
        'GOVERNANCE_VIOLATION: curriculum_versions row % has status % and cannot be '
        'physically deleted. Published/archived curriculum versions must remain '
        'available for historical student references.', OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW.status = OLD.status THEN
    -- No lifecycle transition. If the row is locked (published/archived),
    -- only `notes` and `updated_at` may change.
    IF OLD.status IN ('published', 'archived') THEN
      IF NEW.board_id             IS DISTINCT FROM OLD.board_id
         OR NEW.region_id         IS DISTINCT FROM OLD.region_id
         OR NEW.version_label     IS DISTINCT FROM OLD.version_label
         OR NEW.effective_from    IS DISTINCT FROM OLD.effective_from
         OR NEW.effective_to      IS DISTINCT FROM OLD.effective_to
         OR NEW.ncert_relationship IS DISTINCT FROM OLD.ncert_relationship
         OR NEW.published_at      IS DISTINCT FROM OLD.published_at
         OR NEW.archived_at       IS DISTINCT FROM OLD.archived_at
         OR NEW.created_by        IS DISTINCT FROM OLD.created_by
      THEN
        RAISE EXCEPTION
          'GOVERNANCE_VIOLATION: curriculum_versions row % is % and structurally '
          'immutable. Only notes may be edited once published.', OLD.id, OLD.status
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Status is changing: validate the transition.
  IF OLD.status = 'draft' AND NEW.status = 'published' THEN
    NEW.published_at := COALESCE(NEW.published_at, NOW());
    RETURN NEW;
  ELSIF OLD.status = 'published' AND NEW.status = 'archived' THEN
    -- Archiving a published version must not silently rewrite its identity.
    IF NEW.board_id             IS DISTINCT FROM OLD.board_id
       OR NEW.region_id         IS DISTINCT FROM OLD.region_id
       OR NEW.version_label     IS DISTINCT FROM OLD.version_label
       OR NEW.effective_from    IS DISTINCT FROM OLD.effective_from
       OR NEW.effective_to      IS DISTINCT FROM OLD.effective_to
       OR NEW.ncert_relationship IS DISTINCT FROM OLD.ncert_relationship
       OR NEW.published_at      IS DISTINCT FROM OLD.published_at
    THEN
      RAISE EXCEPTION
        'GOVERNANCE_VIOLATION: archiving curriculum_versions row % must not change '
        'structural fields.', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    NEW.archived_at := COALESCE(NEW.archived_at, NOW());
    RETURN NEW;
  ELSE
    RAISE EXCEPTION
      'GOVERNANCE_VIOLATION: invalid curriculum_versions status transition % -> % on row %. '
      'Only draft -> published and published -> archived are permitted.',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.fn_curriculum_version_lifecycle_guard() IS
  'Enforces the curriculum_versions lifecycle: rows are created as draft; '
  'draft -> published and published -> archived are the only legal '
  'transitions; published/archived rows are structurally immutable (notes '
  'excepted); published/archived rows cannot be physically deleted.';

CREATE OR REPLACE TRIGGER trg_curriculum_versions_lifecycle_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.curriculum_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_curriculum_version_lifecycle_guard();

-- RLS: public/authenticated read, service_role full access (backend-mediated
-- writes only) — matches the established Phase 1A taxonomy security model.
ALTER TABLE public.curriculum_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "curriculum_versions_public_read"
  ON public.curriculum_versions
  FOR SELECT
  USING (TRUE);

CREATE POLICY "curriculum_versions_service_role_full"
  ON public.curriculum_versions
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.curriculum_versions TO anon, authenticated;
GRANT ALL    ON public.curriculum_versions TO service_role;

-- =============================================================================
-- SECTION B: curriculum_version_audit_log
-- Narrow, append-only audit trail for curriculum_versions lifecycle
-- transitions only. Not a generic audit framework.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.curriculum_version_audit_log (
  id                     UUID        DEFAULT gen_random_uuid() NOT NULL,
  curriculum_version_id  UUID        NOT NULL,
  actor_id               UUID        NULL,
  from_status            TEXT        NULL,
  to_status              TEXT        NOT NULL,
  action                 TEXT        NOT NULL,
  notes                  TEXT        NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  CONSTRAINT pk_curriculum_version_audit_log PRIMARY KEY (id),

  CONSTRAINT fk_curriculum_version_audit_log_version
    FOREIGN KEY (curriculum_version_id) REFERENCES public.curriculum_versions (id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_curriculum_version_audit_log_actor
    FOREIGN KEY (actor_id) REFERENCES auth.users (id)
    ON DELETE SET NULL,

  CONSTRAINT chk_curriculum_version_audit_log_to_status
    CHECK (to_status IN ('draft', 'published', 'archived')),

  CONSTRAINT chk_curriculum_version_audit_log_from_status
    CHECK (from_status IS NULL OR from_status IN ('draft', 'published', 'archived')),

  CONSTRAINT chk_curriculum_version_audit_log_action_nonempty
    CHECK (action <> '')
);

COMMENT ON TABLE public.curriculum_version_audit_log IS
  'Narrow, append-only audit trail of curriculum_versions lifecycle '
  'transitions (draft -> published, published -> archived). Not a generic '
  'audit framework — scoped strictly to curriculum version lifecycle.';

CREATE INDEX IF NOT EXISTS idx_curriculum_version_audit_log_version
  ON public.curriculum_version_audit_log (curriculum_version_id, created_at);

-- Append-only: no UPDATE or DELETE, ever (same governance pattern as
-- governance_contract_versions).
CREATE OR REPLACE FUNCTION public.fn_prevent_curriculum_audit_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'GOVERNANCE_VIOLATION: curriculum_version_audit_log rows are immutable and '
    'append-only. UPDATE and DELETE are prohibited.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE TRIGGER trg_curriculum_version_audit_log_immutable
  BEFORE UPDATE OR DELETE ON public.curriculum_version_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_curriculum_audit_mutation();

ALTER TABLE public.curriculum_version_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "curriculum_version_audit_log_service_role_full"
  ON public.curriculum_version_audit_log
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- No anon/authenticated read: audit trail is an internal governance record,
-- not public curriculum data (consistent with signal_registry_audit_log's
-- "service_role only" access model).
GRANT ALL ON public.curriculum_version_audit_log TO service_role;

-- =============================================================================
-- SECTION C: academic_streams extension
-- Streams are reclassified as CLASSIFICATION scoped to a curriculum version.
-- NOTE: curriculum_version_id is NULLABLE — see file-header deviation note.
-- No parent_stream_id (explicitly rejected architecture). Concrete offerings
-- live in curriculum_pathways instead.
-- =============================================================================

ALTER TABLE public.academic_streams
  ADD COLUMN IF NOT EXISTS curriculum_version_id UUID NULL;

ALTER TABLE public.academic_streams
  DROP CONSTRAINT IF EXISTS fk_academic_streams_curriculum_version;

ALTER TABLE public.academic_streams
  ADD CONSTRAINT fk_academic_streams_curriculum_version
    FOREIGN KEY (curriculum_version_id) REFERENCES public.curriculum_versions (id)
    ON DELETE RESTRICT;

COMMENT ON COLUMN public.academic_streams.curriculum_version_id IS
  'Curriculum version this stream classification belongs to. NULL on legacy '
  'Phase 1A rows seeded before curriculum versioning existed (see Phase 1 '
  'completion report §G) — never backfilled or inferred. All streams '
  'created going forward must set this.';

-- Composite uniqueness target so curriculum_pathways / subject_stream_map can
-- enforce "my curriculum_version_id matches my parent stream's" via a
-- composite FK rather than application-layer validation alone.
CREATE UNIQUE INDEX IF NOT EXISTS uq_academic_streams_id_version
  ON public.academic_streams (id, curriculum_version_id);

-- Version-scoped uniqueness for streams that do carry a curriculum_version_id.
-- Legacy (NULL) rows are excluded and keep relying on the pre-existing
-- uq_academic_streams_code (board_id, stream_code) constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_academic_streams_version_code
  ON public.academic_streams (curriculum_version_id, stream_code)
  WHERE curriculum_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_academic_streams_curriculum_version
  ON public.academic_streams (curriculum_version_id);

-- =============================================================================
-- SECTION D: curriculum_pathways
-- Concrete curriculum offering underneath a stream (e.g. Science -> Bio-Maths).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.curriculum_pathways (
  id                     UUID        DEFAULT gen_random_uuid() NOT NULL,
  stream_id              UUID        NOT NULL,
  curriculum_version_id  UUID        NOT NULL,
  pathway_code           TEXT        NOT NULL,
  pathway_name           TEXT        NOT NULL,
  external_reference     TEXT        NULL,
  is_active              BOOLEAN     DEFAULT TRUE NOT NULL,
  deprecated_at          TIMESTAMPTZ NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at             TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  CONSTRAINT pk_curriculum_pathways PRIMARY KEY (id),

  CONSTRAINT fk_curriculum_pathways_curriculum_version
    FOREIGN KEY (curriculum_version_id) REFERENCES public.curriculum_versions (id)
    ON DELETE RESTRICT,

  -- Composite FK: the pathway's stream must belong to the SAME curriculum
  -- version the pathway itself declares. This is the "safest PostgreSQL
  -- constraint strategy" for pathway/stream/version integrity — a pathway
  -- physically cannot reference a stream from a different curriculum version.
  CONSTRAINT fk_curriculum_pathways_stream_version
    FOREIGN KEY (stream_id, curriculum_version_id)
    REFERENCES public.academic_streams (id, curriculum_version_id)
    ON DELETE RESTRICT,

  CONSTRAINT chk_curriculum_pathways_code_nonempty
    CHECK (pathway_code <> ''),
  CONSTRAINT chk_curriculum_pathways_name_nonempty
    CHECK (pathway_name <> ''),
  CONSTRAINT chk_curriculum_pathways_deprecated_inactive
    CHECK (deprecated_at IS NULL OR is_active = FALSE),

  CONSTRAINT uq_curriculum_pathways_version_code
    UNIQUE (curriculum_version_id, pathway_code)
);

COMMENT ON TABLE public.curriculum_pathways IS
  'Concrete curriculum offering/pathway underneath a stream classification, '
  'e.g. Science -> Bio-Maths, Science -> Computer Science. For individually '
  'selectable (CBSE-style) streams, no pathway rows need exist. '
  'stream_id + curriculum_version_id is enforced consistent via composite FK.';
COMMENT ON COLUMN public.curriculum_pathways.external_reference IS
  'Optional free-text reference to an external authority code (e.g. a '
  'state DHSE combination code). Not a business key.';

-- Composite uniqueness target for downstream consumers (subject_stream_map,
-- subject_group_map, student_academic_records) needing the same
-- pathway<->version consistency guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS uq_curriculum_pathways_id_version
  ON public.curriculum_pathways (id, curriculum_version_id);

CREATE INDEX IF NOT EXISTS idx_curriculum_pathways_curriculum_version
  ON public.curriculum_pathways (curriculum_version_id);
CREATE INDEX IF NOT EXISTS idx_curriculum_pathways_stream
  ON public.curriculum_pathways (stream_id);

CREATE OR REPLACE TRIGGER trg_curriculum_pathways_updated_at
  BEFORE UPDATE ON public.curriculum_pathways
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Soft-delete governance — same taxonomy pattern as academic_streams etc.
CREATE OR REPLACE TRIGGER trg_governance_no_delete_curriculum_pathways
  BEFORE DELETE ON public.curriculum_pathways
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_physical_delete_taxonomy();

ALTER TABLE public.curriculum_pathways ENABLE ROW LEVEL SECURITY;

CREATE POLICY "curriculum_pathways_public_read"
  ON public.curriculum_pathways
  FOR SELECT
  USING (is_active = TRUE);

CREATE POLICY "curriculum_pathways_service_role_full"
  ON public.curriculum_pathways
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.curriculum_pathways TO anon, authenticated;
GRANT ALL    ON public.curriculum_pathways TO service_role;

-- =============================================================================
-- SECTION E: subject_stream_map extension
-- Adds curriculum_version_id (NULLABLE — see deviation note) and pathway_id,
-- and relaxes stream_id to nullable so a row can be EITHER stream-scoped OR
-- pathway-scoped (never both, never neither).
-- =============================================================================

ALTER TABLE public.subject_stream_map
  ALTER COLUMN stream_id DROP NOT NULL;

ALTER TABLE public.subject_stream_map
  ADD COLUMN IF NOT EXISTS curriculum_version_id UUID NULL,
  ADD COLUMN IF NOT EXISTS pathway_id UUID NULL;

ALTER TABLE public.subject_stream_map
  DROP CONSTRAINT IF EXISTS fk_subject_stream_map_curriculum_version;
ALTER TABLE public.subject_stream_map
  ADD CONSTRAINT fk_subject_stream_map_curriculum_version
    FOREIGN KEY (curriculum_version_id) REFERENCES public.curriculum_versions (id)
    ON DELETE RESTRICT;

ALTER TABLE public.subject_stream_map
  DROP CONSTRAINT IF EXISTS fk_subject_stream_map_pathway;
ALTER TABLE public.subject_stream_map
  ADD CONSTRAINT fk_subject_stream_map_pathway
    FOREIGN KEY (pathway_id) REFERENCES public.curriculum_pathways (id)
    ON DELETE RESTRICT;

-- Composite FKs: whichever scope is populated must belong to the declared
-- curriculum_version_id. MATCH SIMPLE (Postgres default) means a FK with any
-- NULL column is not enforced, so legacy rows (curriculum_version_id NULL)
-- and single-scope rows are unaffected.
ALTER TABLE public.subject_stream_map
  DROP CONSTRAINT IF EXISTS fk_subject_stream_map_stream_version;
ALTER TABLE public.subject_stream_map
  ADD CONSTRAINT fk_subject_stream_map_stream_version
    FOREIGN KEY (stream_id, curriculum_version_id)
    REFERENCES public.academic_streams (id, curriculum_version_id)
    ON DELETE RESTRICT;

ALTER TABLE public.subject_stream_map
  DROP CONSTRAINT IF EXISTS fk_subject_stream_map_pathway_version;
ALTER TABLE public.subject_stream_map
  ADD CONSTRAINT fk_subject_stream_map_pathway_version
    FOREIGN KEY (pathway_id, curriculum_version_id)
    REFERENCES public.curriculum_pathways (id, curriculum_version_id)
    ON DELETE RESTRICT;

ALTER TABLE public.subject_stream_map
  DROP CONSTRAINT IF EXISTS chk_subject_stream_map_scope_xor;
ALTER TABLE public.subject_stream_map
  ADD CONSTRAINT chk_subject_stream_map_scope_xor
    CHECK (
      (stream_id IS NOT NULL AND pathway_id IS NULL)
      OR (stream_id IS NULL AND pathway_id IS NOT NULL)
    );

COMMENT ON COLUMN public.subject_stream_map.curriculum_version_id IS
  'Curriculum version this subject-membership row belongs to. NULL on legacy '
  'Phase 1A rows (see Phase 1 completion report §G) — never backfilled.';
COMMENT ON COLUMN public.subject_stream_map.pathway_id IS
  'Set for pathway-scoped subject membership (e.g. Biology under the Kerala '
  'Bio-Maths pathway). Exactly one of stream_id / pathway_id is set '
  '(chk_subject_stream_map_scope_xor).';

-- Duplicate-membership prevention for the new pathway scope. The original
-- uq_subject_stream_map_subject_stream (subject_id, stream_id) still covers
-- the stream scope; NULLs there are distinct per row so a parallel partial
-- unique index is required for the pathway scope.
CREATE UNIQUE INDEX IF NOT EXISTS uq_subject_stream_map_subject_pathway
  ON public.subject_stream_map (subject_id, pathway_id)
  WHERE pathway_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subject_stream_map_curriculum_version
  ON public.subject_stream_map (curriculum_version_id);
CREATE INDEX IF NOT EXISTS idx_subject_stream_map_pathway
  ON public.subject_stream_map (pathway_id);

-- =============================================================================
-- SECTION F: subject_group_map
-- "Choose N of M" subject group definitions, scoped to EITHER a stream OR a
-- pathway (never both). Not a generic rules engine.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.subject_group_map (
  id                     UUID        DEFAULT gen_random_uuid() NOT NULL,
  curriculum_version_id  UUID        NOT NULL,
  stream_id              UUID        NULL,
  pathway_id             UUID        NULL,
  group_code             TEXT        NOT NULL,
  group_label            TEXT        NOT NULL,
  min_select             INTEGER     NOT NULL,
  max_select             INTEGER     NOT NULL,
  is_active              BOOLEAN     DEFAULT TRUE NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at             TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  CONSTRAINT pk_subject_group_map PRIMARY KEY (id),

  CONSTRAINT fk_subject_group_map_curriculum_version
    FOREIGN KEY (curriculum_version_id) REFERENCES public.curriculum_versions (id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_subject_group_map_stream_version
    FOREIGN KEY (stream_id, curriculum_version_id)
    REFERENCES public.academic_streams (id, curriculum_version_id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_subject_group_map_pathway_version
    FOREIGN KEY (pathway_id, curriculum_version_id)
    REFERENCES public.curriculum_pathways (id, curriculum_version_id)
    ON DELETE RESTRICT,

  CONSTRAINT chk_subject_group_map_scope_xor
    CHECK (
      (stream_id IS NOT NULL AND pathway_id IS NULL)
      OR (stream_id IS NULL AND pathway_id IS NOT NULL)
    ),

  CONSTRAINT chk_subject_group_map_code_nonempty CHECK (group_code <> ''),
  CONSTRAINT chk_subject_group_map_label_nonempty CHECK (group_label <> ''),
  CONSTRAINT chk_subject_group_map_min_select_nonnegative CHECK (min_select >= 0),
  CONSTRAINT chk_subject_group_map_max_ge_min CHECK (max_select >= min_select)
  -- NOTE: an upper bound derived from actual group size (max_select <= member
  -- count) cannot be enforced here — members are inserted afterwards into
  -- subject_group_members. Per spec §12, that check is deferred to the
  -- backend publish validator in a later phase.
);

COMMENT ON TABLE public.subject_group_map IS
  '"Choose N of M" subject group definitions, scoped to EITHER a stream OR a '
  'pathway. E.g. a Kerala pathway group requiring 1-of-2 optional subjects. '
  'Not a generic rules engine — deliberately narrow to this one shape. '
  'Group-size upper-bound validation against subject_group_members is '
  'deferred to the Phase-2 publish validator.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_subject_group_map_version_stream_code
  ON public.subject_group_map (curriculum_version_id, stream_id, group_code)
  WHERE stream_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subject_group_map_version_pathway_code
  ON public.subject_group_map (curriculum_version_id, pathway_id, group_code)
  WHERE pathway_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subject_group_map_curriculum_version
  ON public.subject_group_map (curriculum_version_id);
CREATE INDEX IF NOT EXISTS idx_subject_group_map_stream
  ON public.subject_group_map (stream_id);
CREATE INDEX IF NOT EXISTS idx_subject_group_map_pathway
  ON public.subject_group_map (pathway_id);

CREATE OR REPLACE TRIGGER trg_subject_group_map_updated_at
  BEFORE UPDATE ON public.subject_group_map
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE TRIGGER trg_governance_no_delete_subject_group_map
  BEFORE DELETE ON public.subject_group_map
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_physical_delete_taxonomy();

ALTER TABLE public.subject_group_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subject_group_map_public_read"
  ON public.subject_group_map
  FOR SELECT
  USING (is_active = TRUE);

CREATE POLICY "subject_group_map_service_role_full"
  ON public.subject_group_map
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.subject_group_map TO anon, authenticated;
GRANT ALL    ON public.subject_group_map TO service_role;

-- =============================================================================
-- SECTION G: subject_group_members
-- Pure membership join table. No curriculum_version_id here — the group's
-- own curriculum_version_id (via group_id) is the single source of truth.
-- No soft-delete column exists in the spec for this table, so the taxonomy
-- no-physical-delete trigger is intentionally NOT applied here: group
-- membership must remain freely editable while its parent group is a draft.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.subject_group_members (
  group_id    UUID        NOT NULL,
  subject_id  UUID        NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  CONSTRAINT pk_subject_group_members PRIMARY KEY (group_id, subject_id),

  CONSTRAINT fk_subject_group_members_group
    FOREIGN KEY (group_id) REFERENCES public.subject_group_map (id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_subject_group_members_subject
    FOREIGN KEY (subject_id) REFERENCES public.academic_subjects (id)
    ON DELETE RESTRICT
);

COMMENT ON TABLE public.subject_group_members IS
  'Membership of academic_subjects within a subject_group_map "choose N of M" '
  'group. Composite PK (group_id, subject_id) prevents duplicate membership. '
  'The group''s own curriculum_version_id (via group_id) is authoritative — '
  'deliberately not duplicated here per spec §13. Semantic cross-scope '
  'validation (e.g. a member subject must actually be valid for the group''s '
  'stream/pathway) is deferred to the Phase-2 publish validator per spec §14.';

CREATE INDEX IF NOT EXISTS idx_subject_group_members_group
  ON public.subject_group_members (group_id);
CREATE INDEX IF NOT EXISTS idx_subject_group_members_subject
  ON public.subject_group_members (subject_id);

ALTER TABLE public.subject_group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subject_group_members_public_read"
  ON public.subject_group_members
  FOR SELECT
  USING (TRUE);

CREATE POLICY "subject_group_members_service_role_full"
  ON public.subject_group_members
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.subject_group_members TO anon, authenticated;
GRANT ALL    ON public.subject_group_members TO service_role;

-- =============================================================================
-- SECTION H: student_academic_records extension
-- Additive, nullable-only. No backfill. No inference from board_type='state'.
-- =============================================================================

ALTER TABLE public.student_academic_records
  ADD COLUMN IF NOT EXISTS board_id              UUID NULL,
  ADD COLUMN IF NOT EXISTS region_id             UUID NULL,
  ADD COLUMN IF NOT EXISTS curriculum_version_id UUID NULL,
  ADD COLUMN IF NOT EXISTS stream_id             UUID NULL,
  ADD COLUMN IF NOT EXISTS pathway_id            UUID NULL;

ALTER TABLE public.student_academic_records
  DROP CONSTRAINT IF EXISTS fk_student_academic_records_board;
ALTER TABLE public.student_academic_records
  ADD CONSTRAINT fk_student_academic_records_board
    FOREIGN KEY (board_id) REFERENCES public.academic_boards (id)
    ON DELETE RESTRICT;

ALTER TABLE public.student_academic_records
  DROP CONSTRAINT IF EXISTS fk_student_academic_records_region;
ALTER TABLE public.student_academic_records
  ADD CONSTRAINT fk_student_academic_records_region
    FOREIGN KEY (region_id) REFERENCES public.curriculum_regions (id)
    ON DELETE RESTRICT;

ALTER TABLE public.student_academic_records
  DROP CONSTRAINT IF EXISTS fk_student_academic_records_curriculum_version;
ALTER TABLE public.student_academic_records
  ADD CONSTRAINT fk_student_academic_records_curriculum_version
    FOREIGN KEY (curriculum_version_id) REFERENCES public.curriculum_versions (id)
    ON DELETE RESTRICT;

-- Composite consistency FKs: if stream_id/pathway_id AND curriculum_version_id
-- are both populated, they must agree (defense-in-depth on top of the app
-- layer). MATCH SIMPLE means a NULL on either side of a pair skips the check,
-- so partially-populated legacy-style rows are never blocked.
ALTER TABLE public.student_academic_records
  DROP CONSTRAINT IF EXISTS fk_student_academic_records_stream_version;
ALTER TABLE public.student_academic_records
  ADD CONSTRAINT fk_student_academic_records_stream_version
    FOREIGN KEY (stream_id, curriculum_version_id)
    REFERENCES public.academic_streams (id, curriculum_version_id)
    ON DELETE RESTRICT;

ALTER TABLE public.student_academic_records
  DROP CONSTRAINT IF EXISTS fk_student_academic_records_pathway_version;
ALTER TABLE public.student_academic_records
  ADD CONSTRAINT fk_student_academic_records_pathway_version
    FOREIGN KEY (pathway_id, curriculum_version_id)
    REFERENCES public.curriculum_pathways (id, curriculum_version_id)
    ON DELETE RESTRICT;

COMMENT ON COLUMN public.student_academic_records.board_id IS
  'Canonical academic_boards reference. NULL for all pre-existing rows and '
  'never backfilled — board_type=''state'' does not identify which state, so '
  'no inference is performed (see Phase 1 architecture spec §18).';
COMMENT ON COLUMN public.student_academic_records.curriculum_version_id IS
  'The exact curriculum version that was authoritative when this academic '
  'record was created. NULL for legacy rows; never backfilled.';

CREATE INDEX IF NOT EXISTS idx_student_academic_records_curriculum_version
  ON public.student_academic_records (curriculum_version_id);
CREATE INDEX IF NOT EXISTS idx_student_academic_records_board
  ON public.student_academic_records (board_id);
CREATE INDEX IF NOT EXISTS idx_student_academic_records_region
  ON public.student_academic_records (region_id);
CREATE INDEX IF NOT EXISTS idx_student_academic_records_stream
  ON public.student_academic_records (stream_id);
CREATE INDEX IF NOT EXISTS idx_student_academic_records_pathway
  ON public.student_academic_records (pathway_id);

-- =============================================================================
-- SECTION I: student_academic_subjects extension
-- Additive nullable subject_id FK. The legacy `subject` enum column is
-- untouched and remains NOT NULL; taxonomy-backed rows use the
-- 'taxonomy_backed' sentinel there (added in the companion enum migration)
-- and carry their real identity in subject_id.
-- =============================================================================

ALTER TABLE public.student_academic_subjects
  ADD COLUMN IF NOT EXISTS subject_id UUID NULL;

ALTER TABLE public.student_academic_subjects
  DROP CONSTRAINT IF EXISTS fk_student_academic_subjects_subject;
ALTER TABLE public.student_academic_subjects
  ADD CONSTRAINT fk_student_academic_subjects_subject
    FOREIGN KEY (subject_id) REFERENCES public.academic_subjects (id)
    ON DELETE RESTRICT;

COMMENT ON COLUMN public.student_academic_subjects.subject_id IS
  'Canonical academic_subjects reference for taxonomy-backed subject rows. '
  'NULL for legacy rows keyed purely by the `subject` enum. When set, the '
  '`subject` enum column should carry the ''taxonomy_backed'' sentinel value.';

CREATE INDEX IF NOT EXISTS idx_student_academic_subjects_subject_id
  ON public.student_academic_subjects (subject_id);

COMMIT;

-- =============================================================================
-- END OF MIGRATION: 20260913020000_p1_curriculum_schema_foundation.sql
-- =============================================================================
