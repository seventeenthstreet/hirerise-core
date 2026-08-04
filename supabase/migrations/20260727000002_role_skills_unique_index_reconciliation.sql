-- =============================================================================
-- HireRise Core Database Function Reconciliation (DB-FR)
-- Migration: 20260727000002_role_skills_unique_index_reconciliation.sql
-- Work Package: DB-FR-002 — role_skills Unique Index Reconciliation
--
-- LINT ERROR ADDRESSED
--   supabase db lint (public schema):
--     function:  public.bulk_import_graph
--     message:   there is no unique or exclusion constraint matching the
--                ON CONFLICT specification
--     sqlState:  42P10
--
-- CERTIFIED ROOT CAUSE
--   All three independent write paths that populate role_skills —
--   public.bulk_import_graph (role_skills branch), graphImport.service.js,
--   and adminImport.service.js — model the table's business key as
--   (role_id, skill_id). None of them inserts, updates, validates, imports,
--   or maps skill_type. The only code that reads skill_type
--   (skillGraph.repository.js / SkillGraph.js) is tolerant of its absence
--   and does not depend on multiple rows existing for the same
--   (role_id, skill_id) pair.
--
--   Production verification:
--     - skill_type distribution: required = 117, preferred = 0.
--     - No (role_id, skill_id) pair has more than one row.
--
--   The existing three-column unique index
--   idx_role_skills_unique_typed (role_id, skill_id, skill_type) is
--   obsolete relative to the implemented product model — the function is
--   not the defect, the schema is.
--
-- WHAT THIS MIGRATION DOES
--   Drops the obsolete three-column unique index and replaces it with a
--   two-column unique index on (role_id, skill_id), matching the business
--   key already enforced by every write path. This gives
--   bulk_import_graph's existing `ON CONFLICT (role_id, skill_id)` clause
--   a matching constraint to resolve against.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   - Does not modify public.bulk_import_graph or any other function.
--   - Does not touch any other index, column, trigger, foreign key, RLS
--     policy, or grant on role_skills — all are left exactly as they are.
--   - Does not touch any other table.
--   - Does not address any other lint error.
-- =============================================================================

BEGIN;

-- Prerequisite validation: fail immediately if duplicate (role_id, skill_id)
-- pairs exist. Production evidence at certification time showed zero such
-- duplicates, but this guards the migration against that fact having changed
-- since certification. Runs before any schema change; if it raises, the
-- transaction aborts and idx_role_skills_unique_typed is left untouched.
DO $$
DECLARE
    v_duplicate_count integer;
BEGIN
    SELECT count(*) INTO v_duplicate_count
    FROM (
        SELECT role_id, skill_id
        FROM public.role_skills
        GROUP BY role_id, skill_id
        HAVING count(*) > 1
    ) dupes;

    IF v_duplicate_count > 0 THEN
        RAISE EXCEPTION
            'DB-FR-002 aborted: % duplicate (role_id, skill_id) pair(s) found in public.role_skills — a two-column UNIQUE index cannot be created until these are resolved',
            v_duplicate_count;
    END IF;
END;
$$;

-- Step 1: Drop the obsolete three-column unique index.
-- idx_role_skills_unique_typed was created as a standalone unique index
-- (CREATE UNIQUE INDEX), not as a table constraint, so it is removed with
-- DROP INDEX rather than ALTER TABLE ... DROP CONSTRAINT.
DROP INDEX IF EXISTS "public"."idx_role_skills_unique_typed";

-- Step 2: Create the replacement two-column unique index matching the
-- business key enforced by every write path (bulk_import_graph,
-- graphImport.service.js, adminImport.service.js).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_role_skills_unique_role_skill"
    ON "public"."role_skills" USING "btree" ("role_id", "skill_id");

COMMIT;
