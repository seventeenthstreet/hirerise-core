-- =============================================================================
-- HireRise . Admin Job Sync
-- Migration : WP-ADMIN-COMP-06-R3 -- Jobs bulk-upsert ON CONFLICT target fix
-- File      : 20260811070000_wp_admin_comp_06_r3_jobs_upsert_conflict_target_fix.sql
-- Date      : 2026-08-11
-- =============================================================================
--
-- Purpose:
--   Every admin job sync (URL-triggered and CSV upload) has been failing
--   every record with:
--     "there is no unique or exclusion constraint matching the ON CONFLICT
--      specification"
--   raised from job.repository.js's bulkUpsert(), which calls Supabase's
--     .from('jobs').upsert(rows, { onConflict: 'external_id,source' })
--   -- i.e. INSERT ... ON CONFLICT (external_id, source) DO UPDATE ...
--
-- Root cause:
--   "jobs_external_source_uq" (000_initial_schema.sql) was created as a
--   PARTIAL unique index:
--     CREATE UNIQUE INDEX "jobs_external_source_uq" ON "public"."jobs"
--       USING "btree" ("external_id", "source")
--       WHERE ("external_id" IS NOT NULL);
--   Postgres can only use a partial unique index to satisfy an
--   ON CONFLICT (columns) inference clause if the INSERT statement
--   repeats the exact same WHERE predicate. PostgREST/Supabase's
--   .upsert({ onConflict }) option has no mechanism to express that
--   predicate -- it only ever emits a plain ON CONFLICT (external_id,
--   source) -- so it can never match a partial index. Reproduced locally
--   against this exact table/index definition; fix verified against the
--   same reproduction before writing this migration.
--
-- Fix:
--   Replace the partial unique index with a full (non-partial) UNIQUE
--   constraint on the same two columns, which ON CONFLICT (external_id,
--   source) inference matches directly.
--
-- Why this is safe / behavior-preserving for existing data:
--   Standard Postgres unique constraints already treat NULL as distinct
--   from NULL (two rows with external_id IS NULL never collide) -- which
--   is exactly the behavior the old "WHERE external_id IS NOT NULL"
--   partial predicate existed to express. Converting to a full UNIQUE
--   constraint on (external_id, source) therefore accepts precisely the
--   same set of rows as before; it cannot introduce a new constraint
--   violation on data that satisfied the old partial index, and it does
--   not change any application-visible dedup semantics. Verified locally:
--   multiple rows with external_id = NULL still coexist fine under the
--   new constraint.
--
-- Idempotency / safety guard (R3):
--   The guard does not trust the object name alone. It inspects the
--   actual catalog definition of whatever currently occupies the name
--   "jobs_external_source_uq" on public.jobs and only proceeds down a
--   path it can prove is safe:
--     1. A CONSTRAINT named jobs_external_source_uq already exists:
--          - If it is UNIQUE on exactly (external_id, source): no-op.
--          - Otherwise (wrong type, or UNIQUE on different columns):
--            RAISE EXCEPTION. Never silently accept or drop an unknown
--            constraint.
--     2. No such constraint, but an INDEX named jobs_external_source_uq
--        exists:
--          - If it is the expected legacy shape (UNIQUE, partial /
--            indpred IS NOT NULL): drop it, then create the correct
--            UNIQUE constraint.
--          - Otherwise (not unique, or unique but not partial -- i.e.
--            some other index we don't recognise): RAISE EXCEPTION.
--            Never silently drop an unrecognised index.
--     3. Neither a constraint nor an index by that name exists: create
--        the correct UNIQUE constraint directly.
--   A RAISE EXCEPTION path aborts the whole DO block atomically -- if
--   this migration errors out, the database is left exactly as it was
--   found (no partial DROP/ADD applied), so it is always safe to re-run
--   after investigating.
--
-- Preserves: no schema changes other than this single unique-object
-- correction; no data changes; no RLS changes; no application code
-- changes; existing NULL external_id semantics; idempotency; and
-- transaction safety (the DO block is one atomic statement).
-- =============================================================================

DO $$
DECLARE
  v_contype    "char";
  v_columns    text[];
  v_is_unique  boolean;
  v_is_partial boolean;
BEGIN
  -----------------------------------------------------------------------
  -- Step 1 -- does a real CONSTRAINT (not merely an index) named
  -- jobs_external_source_uq already exist on public.jobs?
  -----------------------------------------------------------------------
  SELECT c.contype
  INTO v_contype
  FROM pg_constraint c
  WHERE c.conname = 'jobs_external_source_uq'
    AND c.conrelid = '"public"."jobs"'::regclass;

  IF FOUND THEN
    IF v_contype <> 'u' THEN
      RAISE EXCEPTION
        'jobs_external_source_uq exists on public.jobs as a "%" constraint, not UNIQUE. Refusing to modify automatically -- resolve manually before re-running this migration.',
        v_contype;
    END IF;

    SELECT array_agg(a.attname ORDER BY k.ord)
    INTO v_columns
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.conname = 'jobs_external_source_uq'
      AND c.conrelid = '"public"."jobs"'::regclass;

    IF v_columns = ARRAY['external_id', 'source'] THEN
      -- Correct UNIQUE constraint already in place. Safe no-op.
      RETURN;
    ELSE
      RAISE EXCEPTION
        'jobs_external_source_uq exists as a UNIQUE constraint but on columns (%) instead of (external_id, source). Refusing to modify automatically -- resolve manually before re-running this migration.',
        array_to_string(v_columns, ', ');
    END IF;
  END IF;

  -----------------------------------------------------------------------
  -- Step 2 -- no constraint by that name. Is there an INDEX (not a table
  -- constraint) with that name, and is it the expected legacy shape (the
  -- old partial unique index this migration exists to replace)?
  -----------------------------------------------------------------------
  SELECT ix.indisunique,
         (ix.indpred IS NOT NULL)
  INTO v_is_unique, v_is_partial
  FROM pg_class t
  JOIN pg_index ix ON ix.indrelid = t.oid
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'jobs'
    AND i.relname = 'jobs_external_source_uq';

  IF FOUND THEN
    IF NOT (v_is_unique AND v_is_partial) THEN
      RAISE EXCEPTION
        'An index named jobs_external_source_uq exists on public.jobs but is not the expected legacy partial UNIQUE index (unique=%, partial=%). Refusing to drop it automatically -- resolve manually before re-running this migration.',
        v_is_unique, v_is_partial;
    END IF;

    DROP INDEX "public"."jobs_external_source_uq";
  END IF;

  -----------------------------------------------------------------------
  -- Step 3 -- neither the correct constraint nor a recognised legacy
  -- index remains in the way. Create the correct full UNIQUE constraint.
  -----------------------------------------------------------------------
  ALTER TABLE "public"."jobs"
    ADD CONSTRAINT "jobs_external_source_uq"
    UNIQUE ("external_id", "source");
END
$$;
