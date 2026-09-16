-- =============================================================================
-- HireRise Curriculum Architecture — PHASE 1: CORRECTION PASS
-- Migration: 20260913030000_p1_correction_ncert_vocab_and_draft_rls.sql
--
-- Purely additive/corrective follow-up to 20260913020000. No curriculum data
-- has been seeded, so these corrections are safe to apply directly against
-- the just-created objects rather than via a data migration.
--
-- Fixes two deviations from the architecture lock found on review:
--   1. curriculum_versions.ncert_relationship used an invented vocabulary
--      (ncert_based / ncert_adapted / non_ncert) instead of the locked
--      evidence-metadata vocabulary.
--   2. Several "public read" RLS policies used USING (TRUE) / USING
--      (is_active = TRUE) with no regard to curriculum_versions.status,
--      which would expose DRAFT curriculum configuration to anon/
--      authenticated clients once real data exists.
--
-- Does NOT touch: 20260912000000_g5_add_science_academic_subject.sql
-- Does NOT modify or rewrite 20260913010000 / 20260913020000 in place.
-- Does NOT seed any curriculum data. Does NOT broaden the lifecycle model.
-- =============================================================================

BEGIN;

-- =============================================================================
-- PART 1 — NCERT relationship vocabulary correction
-- =============================================================================

ALTER TABLE public.curriculum_versions
  DROP CONSTRAINT IF EXISTS chk_curriculum_versions_ncert_relationship;

ALTER TABLE public.curriculum_versions
  ADD CONSTRAINT chk_curriculum_versions_ncert_relationship
    CHECK (
      ncert_relationship IS NULL
      OR ncert_relationship IN (
        'prescribed', 'adopted', 'adapted', 'aligned',
        'referenced', 'independent', 'mixed', 'unknown'
      )
    );

COMMENT ON COLUMN public.curriculum_versions.ncert_relationship IS
  'Evidence metadata describing how this curriculum version relates to the '
  'NCERT national framework: prescribed | adopted | adapted | aligned | '
  'referenced | independent | mixed | unknown. NULL = not yet classified. '
  'Metadata only — no business logic keys off this value.';

-- =============================================================================
-- PART 2 — Draft curriculum visibility
--
-- Pattern: a row is publicly readable only if it is not tied to a DRAFT
-- curriculum version. Legacy Phase 1A rows with curriculum_version_id NULL
-- are unaffected (NULL never matches a draft version, so they stay visible
-- exactly as before, gated only by their existing is_active flag).
-- service_role keeps full access via the untouched *_service_role_full
-- policies from 20260913020000 — nothing below touches those.
-- =============================================================================

-- --- curriculum_versions: readers see published/archived only -------------

DROP POLICY IF EXISTS "curriculum_versions_public_read" ON public.curriculum_versions;

CREATE POLICY "curriculum_versions_public_read"
  ON public.curriculum_versions
  FOR SELECT
  USING (status IN ('published', 'archived'));

-- --- academic_streams: hide streams scoped to a draft curriculum version --

DROP POLICY IF EXISTS "academic_streams_public_read" ON public.academic_streams;

CREATE POLICY "academic_streams_public_read"
  ON public.academic_streams
  FOR SELECT
  USING (
    is_active = TRUE
    AND (
      curriculum_version_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.curriculum_versions cv
        WHERE cv.id = academic_streams.curriculum_version_id
          AND cv.status IN ('published', 'archived')
      )
    )
  );

-- --- curriculum_pathways: always curriculum_version-scoped, NOT NULL ------

DROP POLICY IF EXISTS "curriculum_pathways_public_read" ON public.curriculum_pathways;

CREATE POLICY "curriculum_pathways_public_read"
  ON public.curriculum_pathways
  FOR SELECT
  USING (
    is_active = TRUE
    AND EXISTS (
      SELECT 1 FROM public.curriculum_versions cv
      WHERE cv.id = curriculum_pathways.curriculum_version_id
        AND cv.status IN ('published', 'archived')
    )
  );

-- --- subject_stream_map: curriculum_version_id nullable (legacy rows) -----

DROP POLICY IF EXISTS "subject_stream_map_public_read" ON public.subject_stream_map;

CREATE POLICY "subject_stream_map_public_read"
  ON public.subject_stream_map
  FOR SELECT
  USING (
    is_active = TRUE
    AND (
      curriculum_version_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.curriculum_versions cv
        WHERE cv.id = subject_stream_map.curriculum_version_id
          AND cv.status IN ('published', 'archived')
      )
    )
  );

-- --- subject_group_map: always curriculum_version-scoped, NOT NULL --------

DROP POLICY IF EXISTS "subject_group_map_public_read" ON public.subject_group_map;

CREATE POLICY "subject_group_map_public_read"
  ON public.subject_group_map
  FOR SELECT
  USING (
    is_active = TRUE
    AND EXISTS (
      SELECT 1 FROM public.curriculum_versions cv
      WHERE cv.id = subject_group_map.curriculum_version_id
        AND cv.status IN ('published', 'archived')
    )
  );

-- --- subject_group_members: no direct curriculum_version_id column; -------
-- --- must join through the parent group to reach the guard ----------------

DROP POLICY IF EXISTS "subject_group_members_public_read" ON public.subject_group_members;

CREATE POLICY "subject_group_members_public_read"
  ON public.subject_group_members
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.subject_group_map sgm
      JOIN public.curriculum_versions cv ON cv.id = sgm.curriculum_version_id
      WHERE sgm.id = subject_group_members.group_id
        AND sgm.is_active = TRUE
        AND cv.status IN ('published', 'archived')
    )
  );

COMMIT;
