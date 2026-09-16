-- ADG-CBSE-07 — Schema reconciliation: bring the migration chain in line
-- with the already-approved live schema state. Reconciles
-- chk_subject_group_map_scope_xor from strict XOR to "at most one of
-- stream_id/pathway_id", and adds the version-wide uniqueness index that
-- was approved and applied live but never captured in a migration.
--
-- Schema-only. No data is inserted, updated, or deleted.

BEGIN;

ALTER TABLE public.subject_group_map
  DROP CONSTRAINT chk_subject_group_map_scope_xor;

ALTER TABLE public.subject_group_map
  ADD CONSTRAINT chk_subject_group_map_scope_xor
  CHECK (
    NOT (
      stream_id IS NOT NULL
      AND pathway_id IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_subject_group_map_version_wide_code
  ON public.subject_group_map (curriculum_version_id, group_code)
  WHERE stream_id IS NULL
    AND pathway_id IS NULL;

COMMIT;
