-- =============================================================================
-- HireRise Curriculum Architecture — PHASE 2 / P2.2
-- Migration: 20260913050000_p2_2_subject_group_members_is_mandatory.sql
--
-- Purely additive. Does NOT modify, in any way:
--   20260912000000_g5_add_science_academic_subject.sql
--   20260913010000_p1_curriculum_taxonomy_sentinel_enum.sql
--   20260913020000_p1_curriculum_schema_foundation.sql
--   20260913030000_p1_correction_ncert_vocab_and_draft_rls.sql
--   20260913040000_p1_curriculum_version_audit_log_trigger.sql
--
-- DISCREPANCY BEING RESOLVED:
-- The architecture lock governing this work specifies
-- subject_group_members as (group_id, subject_id, is_mandatory). The
-- table as actually deployed by 20260913020000 (Section G) is
-- (group_id, subject_id, created_at) — no is_mandatory column.
--
-- This was investigated before writing this migration, not assumed:
--   1. Searched every deployed migration for `is_mandatory` history. It
--      has only ever existed on subject_stream_map (Phase 1A,
--      20260526000001) — used for a subject directly assigned to a
--      stream/pathway ("core" vs "elective" in that direct-assignment
--      sense). 20260727120000_db_fr_009_... is a prior, unrelated bug
--      fix that had to correct several RPCs which wrongly assumed
--      is_mandatory existed on academic_subjects — it never has, on any
--      table other than subject_stream_map, until now.
--   2. Searched documents/*.md for a prior written architecture-lock
--      artifact for this feature — none exists in this repository; the
--      lock is the instruction text governing this work, not a repo file.
--   3. Considered whether this is a deliberate Phase 1 design decision
--      rather than an omission: 20260913020000's own Section G comment
--      explicitly documents subject_group_members as a deliberately
--      minimal "pure membership join table" and explains why other
--      candidate columns (curriculum_version_id, soft-delete) were left
--      out — but is_mandatory is not among the columns that comment
--      discusses omitting, and nothing in that migration's commentary
--      argues against a per-member mandatory flag. Its absence reads as
--      an oversight relative to the lock, not a reasoned rejection of it.
--   4. Considered whether a per-member mandatory flag is even coherent
--      for a "choose min_select-to-max_select of N" group
--      (subject_group_map): it is — an "anchor" member that must always
--      be included regardless of the counting logic, alongside other
--      members that still compete for the remaining selection slots
--      (e.g. "English is compulsory; also choose 1 of these 2 electives"
--      modelled as one group with one is_mandatory=TRUE member and two
--      is_mandatory=FALSE members). This is a distinct concept from
--      subject_stream_map.is_mandatory, which applies to a subject
--      assigned directly to a stream/pathway, outside any group
--      entirely — the two do not conflict or duplicate one another.
--
-- CONCLUSION: genuine deployed-schema omission relative to the
-- architecture lock. Corrected here with the smallest possible additive
-- change — one nullable-with-default column, no data migration (no
-- subject_group_members rows exist yet in any environment this migration
-- has been run against), no change to any constraint, trigger, RLS
-- policy, or grant already governing this table.
-- =============================================================================

BEGIN;

ALTER TABLE public.subject_group_members
  ADD COLUMN IF NOT EXISTS is_mandatory BOOLEAN DEFAULT FALSE NOT NULL;

COMMENT ON COLUMN public.subject_group_members.is_mandatory IS
  'TRUE = this subject is an always-included ("anchor") member of the '
  'group, regardless of subject_group_map.min_select/max_select counting '
  '— it does not compete for a selection slot the way other members do. '
  'FALSE (default) = an ordinary elective member subject to the group''s '
  'min/max selection rule. Distinct from subject_stream_map.is_mandatory, '
  'which describes a subject assigned directly to a stream/pathway '
  'outside any subject_group_map group entirely; the two flags never '
  'apply to the same row and do not need to agree with one another.';

COMMIT;
