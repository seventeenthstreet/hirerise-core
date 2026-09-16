-- =============================================================================
-- HireRise Curriculum Architecture — PHASE 1: AUDIT TRAIL CORRECTION
-- Migration: 20260913040000_p1_curriculum_version_audit_log_trigger.sql
--
-- Purely additive. Does NOT modify, in any way:
--   20260912000000_g5_add_science_academic_subject.sql
--   20260913010000_p1_curriculum_taxonomy_sentinel_enum.sql
--   20260913020000_p1_curriculum_schema_foundation.sql
--   20260913030000_p1_correction_ncert_vocab_and_draft_rls.sql
-- Does NOT change fn_curriculum_version_lifecycle_guard() or its semantics.
--
-- PROBLEM:
--   curriculum_version_audit_log exists (20260913020000, Section B) but
--   nothing writes to it. fn_curriculum_version_lifecycle_guard() correctly
--   enforces the lifecycle and immutability rules but was never responsible
--   for, and does not perform, audit logging.
--
-- FIX:
--   A separate AFTER trigger + function on curriculum_versions that records
--   exactly three lifecycle events:
--     - creation             (NULL   -> draft)
--     - publication           (draft -> published)
--     - archival                (published -> archived)
--   Ordinary updates that do not change `status` (e.g. editing `notes` in
--   isolation) are NOT audited. Each audit row carries NEW.notes, so any
--   notes present on the row at the moment of creation/publication/
--   archival are preserved alongside that lifecycle event.
--
-- WHY A SEPARATE AFTER TRIGGER RATHER THAN EDITING THE GUARD:
--   fn_curriculum_version_lifecycle_guard() is a BEFORE trigger. Postgres
--   only fires AFTER triggers once the row-level operation — including any
--   BEFORE trigger on it — has succeeded without raising. That gives this
--   AFTER trigger two properties for free, without touching the guard's
--   logic at all:
--     1. An invalid transition, or a rejected structural mutation on a
--        published/archived row, raises inside the BEFORE guard and aborts
--        the statement — this AFTER trigger simply never runs, so no audit
--        row is ever written for something that didn't actually happen.
--     2. By the time this trigger sees a row, the guard has already decided
--        the transition is legal. This trigger only *observes and records*;
--        it never validates, authorizes, or blocks anything itself.
--   This keeps the two concerns (lifecycle enforcement vs. audit recording)
--   fully decoupled.
--
-- WHY EXPLICIT CONDITIONS INSTEAD OF RELYING ON GUARD EXHAUSTIVENESS:
--   The previous draft used a CASE keyed only on NEW.status, implicitly
--   trusting that the guard would never let anything else reach this
--   trigger. This revision does not lean on that assumption: the audit
--   writer itself explicitly checks for exactly
--     (OLD.status = 'draft' AND NEW.status = 'published')
--   and
--     (OLD.status = 'published' AND NEW.status = 'archived')
--   on UPDATE, and (NEW.status = 'draft') on INSERT for the creation event.
--   Any UPDATE where status does not change falls through and writes
--   nothing. This is still purely observational — it adds no new
--   validation or authorization of its own, and does not change what the
--   guard permits or rejects. It only narrows what THIS trigger chooses to
--   record, independent of whatever the guard's own transition table looks
--   like today or in the future.
--
-- ACTOR IDENTITY:
--   curriculum_versions is writable only by service_role
--   (curriculum_versions_service_role_full, 20260913020000). A service-role
--   database session does not carry an authenticated end-user JWT, so there
--   is no established, safe DB-trigger mechanism to attribute the
--   operation to a specific end user. actor_id is left NULL. Attributing
--   *who* requested a transition remains an application-layer concern for
--   a later (Admin) phase, not this one.
--
-- SCOPE:
--   Not a generic audit framework. This trigger exists only for
--   curriculum_versions -> curriculum_version_audit_log, and only for the
--   three events above. DELETE is intentionally not audited: only draft
--   rows can ever be deleted (the guard blocks DELETE on
--   published/archived), and deletion is not one of the three events this
--   migration is scoped to capture.
--
-- PRIVILEGES:
--   No new GRANTs, no SECURITY DEFINER, no new public write access. The
--   function runs with the privileges of the invoking role (service_role),
--   which already holds GRANT ALL on curriculum_version_audit_log and
--   already satisfies curriculum_version_audit_log_service_role_full's
--   WITH CHECK (TRUE).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_curriculum_version_audit_writer()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'draft' THEN
      INSERT INTO public.curriculum_version_audit_log
        (curriculum_version_id, actor_id, from_status, to_status, action, notes)
      VALUES
        (NEW.id, NULL, NULL, 'draft', 'created', NEW.notes);
    END IF;
    -- Any other NEW.status on INSERT is already rejected by the BEFORE
    -- lifecycle guard before this trigger can run, so there is nothing
    -- else to handle here — this trigger simply does not fire for it.
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.status = 'draft' AND NEW.status = 'published' THEN
    INSERT INTO public.curriculum_version_audit_log
      (curriculum_version_id, actor_id, from_status, to_status, action, notes)
    VALUES
      (NEW.id, NULL, 'draft', 'published', 'published', NEW.notes);

  ELSIF OLD.status = 'published' AND NEW.status = 'archived' THEN
    INSERT INTO public.curriculum_version_audit_log
      (curriculum_version_id, actor_id, from_status, to_status, action, notes)
    VALUES
      (NEW.id, NULL, 'published', 'archived', 'archived', NEW.notes);

  END IF;
  -- Any other case — status unchanged (e.g. a notes-only edit, on a draft
  -- or on a locked row), or any status pairing other than the two above —
  -- is deliberately not audited here. Transitions other than the two
  -- above cannot reach this point at all: the BEFORE lifecycle guard
  -- already rejects them and aborts the statement first.

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_curriculum_version_audit_writer() IS
  'Writes curriculum_version_audit_log rows for curriculum_versions '
  'lifecycle events only: creation (NULL->draft), publication '
  '(draft->published), archival (published->archived), each carrying '
  'NEW.notes. Explicitly matches only these event shapes rather than '
  'assuming the lifecycle guard''s transition table is exhaustive. Fires '
  'AFTER trg_curriculum_versions_lifecycle_guard and therefore only ever '
  'observes transitions that already passed validation — it never '
  'authorizes or blocks anything itself. Non-status-changing updates '
  '(e.g. notes-only edits) are not audited. actor_id is left NULL: see '
  'migration 20260913040000 header for why.';

CREATE OR REPLACE TRIGGER trg_curriculum_version_audit_writer
  AFTER INSERT OR UPDATE ON public.curriculum_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_curriculum_version_audit_writer();

COMMENT ON TRIGGER trg_curriculum_version_audit_writer ON public.curriculum_versions IS
  'Records the three lifecycle events (create/publish/archive), with '
  'notes, into curriculum_version_audit_log. Purely observational — runs '
  'AFTER the lifecycle guard and never influences whether an operation '
  'succeeds.';

COMMIT;