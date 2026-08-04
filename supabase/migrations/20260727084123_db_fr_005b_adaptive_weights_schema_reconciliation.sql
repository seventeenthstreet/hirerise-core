-- =============================================================================
-- DB-FR-005B — Adaptive Weights Schema Reconciliation
-- =============================================================================
--
-- Certified architecture (DB-FR-005A):
--   public.get_adaptive_weights() and public.record_adaptive_outcome() are the
--   canonical adaptive-learning implementation. public.adaptive_weights is
--   reconciled TO the model those functions already require:
--     role_family, experience_bucket, industry_tag,
--     manual_override, freeze_learning, confidence_score
--
--   This migration adds only what the certified functions need. It does not
--   touch the functions, application code, repositories, services, routes,
--   or controllers.
--
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1-2. New key/dimension columns: role_family, industry_tag
-- -----------------------------------------------------------------------------
-- Added as nullable text. There is no reliable source to backfill these from
-- for existing rows: role_family is a distinct business concept from role_id
-- (role_id identifies a specific role; role_family is a category grouping —
-- see DB-FR-005A domain model analysis), so role_id cannot be mechanically
-- copied into role_family without risking incorrect data. industry_tag has no
-- prior representation on this table at all.
--
-- Runtime behaviour of legacy rows:
--   - Existing rows are preserved as-is; nothing is deleted or overwritten.
--   - Existing rows will have NULL role_family and NULL industry_tag. Because
--     get_adaptive_weights()/record_adaptive_outcome() key their lookups on
--     equality (role_family = p_role_family AND ... AND industry_tag =
--     p_industry_tag), a NULL on either side of that comparison never
--     evaluates to true in SQL. Legacy rows therefore simply will not be
--     matched or returned by adaptive lookups until those two columns are
--     populated for them — this does not raise an error, and it does not
--     corrupt or block new rows; it just means legacy rows are inert with
--     respect to the adaptive-learning key until backfilled.
--   - Populating role_family/industry_tag for legacy rows is intentionally
--     out of scope for this migration. It requires a business decision about
--     how to map historical role_id values to the correct role_family /
--     industry_tag, which is a data-backfill exercise, not a schema
--     reconciliation, and is deferred to a future, separate work package.

ALTER TABLE "public"."adaptive_weights"
    ADD COLUMN IF NOT EXISTS "role_family" "text";

ALTER TABLE "public"."adaptive_weights"
    ADD COLUMN IF NOT EXISTS "industry_tag" "text";

COMMENT ON COLUMN "public"."adaptive_weights"."role_family" IS
    'Role family / category grouping used as part of the adaptive-learning key by get_adaptive_weights()/record_adaptive_outcome() (DB-FR-005B). Distinct from role_id, which identifies a specific role and is retained unchanged for its original purpose. NULL on pre-existing rows until a separate backfill effort populates them; such rows are simply not matched by adaptive lookups in the interim (no error).';

COMMENT ON COLUMN "public"."adaptive_weights"."industry_tag" IS
    'Industry dimension of the adaptive-learning key used by get_adaptive_weights()/record_adaptive_outcome() (DB-FR-005B). No prior column existed for this on adaptive_weights; NULL on pre-existing rows until a separate backfill effort populates them; such rows are simply not matched by adaptive lookups in the interim (no error).';

-- -----------------------------------------------------------------------------
-- 3-4. Governance columns: manual_override, freeze_learning
-- -----------------------------------------------------------------------------
-- Added NOT NULL DEFAULT FALSE. This is a fast, metadata-only operation in
-- PostgreSQL 11+ for a constant default, and it backfills every existing row
-- to the safe, inert value (no override active, learning not frozen) —
-- exactly the behavior get_adaptive_weights()/record_adaptive_outcome()
-- already assume for a normal, non-overridden record.

ALTER TABLE "public"."adaptive_weights"
    ADD COLUMN IF NOT EXISTS "manual_override" boolean NOT NULL DEFAULT false;

ALTER TABLE "public"."adaptive_weights"
    ADD COLUMN IF NOT EXISTS "freeze_learning" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "public"."adaptive_weights"."manual_override" IS
    'Governance flag consumed by get_adaptive_weights()/record_adaptive_outcome() (DB-FR-005B). Defaults to false so existing and new rows behave as normal (non-overridden) adaptive records unless explicitly set.';

COMMENT ON COLUMN "public"."adaptive_weights"."freeze_learning" IS
    'Governance flag consumed by get_adaptive_weights()/record_adaptive_outcome() (DB-FR-005B) to pause adaptive updates. Defaults to false so learning proceeds normally unless explicitly frozen.';

-- -----------------------------------------------------------------------------
-- 5. Reconcile confidence -> confidence_score
-- -----------------------------------------------------------------------------
-- Decision: RENAME the existing column rather than add a new one and migrate
-- values.
--
-- Rationale: a rename is the safer option here specifically because nothing
-- else references the old name. Repository investigation (DB-FR-005/005A/005B)
-- explicitly checked the following and found no reference to
-- adaptive_weights.confidence outside the table's own column definition:
--   - SQL functions: no function in the schema (including
--     get_adaptive_weights() and record_adaptive_outcome() themselves, which
--     already read/write "confidence_score", never "confidence") selects,
--     filters, or assigns adaptive_weights.confidence.
--   - Views: no view definition in the schema references adaptive_weights at
--     all.
--   - Triggers: no trigger is defined on adaptive_weights.
--   - RLS policies: adaptive_weights has row-level security enabled but no
--     policies are defined on it, so there is no policy expression to check
--     against this column.
--   - Application repository/service code: a full-repository search for
--     "adaptive_weights" and "confidence" across the codebase surfaces only
--     the table name constant and the RPC function names; no repository,
--     service, or controller code selects a "confidence" field from this
--     table by name.
--   - Prior migrations: adaptive_weights has been created and left otherwise
--     unmodified since 000_initial_schema.sql; no earlier migration
--     references its confidence column.
--
-- With no other consumer of the old name, RENAME COLUMN is a metadata-only
-- operation: it preserves every existing value and every existing row's
-- identity exactly, with no data copy, no dual-write window, and no
-- follow-up cleanup migration required later to drop a duplicate column.
-- Introducing a second column and backfilling would only be the safer choice
-- if some other object still depended on the "confidence" name continuing to
-- exist, which the above evidence shows is not the case here.
--
-- Guarded (replay-safe) rename:
--   Plain RENAME COLUMN has no "IF EXISTS"-style guard in PostgreSQL, so a
--   second execution of this statement against a database where it already
--   succeeded would fail with "column confidence does not exist" — for
--   example if a deployment is interrupted after this statement committed
--   but before a later statement in the same migration run, and the
--   deployment tool re-runs the migration file as part of recovery. The
--   check below inspects information_schema.columns for both preconditions
--   (confidence present AND confidence_score absent) and performs the
--   rename only when both hold, exactly reproducing the certified rename
--   strategy — no duplicate column is created and no data is copied,
--   because when confidence_score already exists (rename already applied)
--   the block is simply a no-op.
--
--   This remains forward-only: the guard only ever moves the schema from
--   "not yet renamed" to "renamed" (or leaves it at "renamed" if already
--   there). It never reverses the rename or recreates the old column, so it
--   does not introduce a rollback path or any backward state transition.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'adaptive_weights'
          AND column_name = 'confidence'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'adaptive_weights'
          AND column_name = 'confidence_score'
    ) THEN
        ALTER TABLE "public"."adaptive_weights"
            RENAME COLUMN "confidence" TO "confidence_score";
    END IF;
END;
$$;

COMMENT ON COLUMN "public"."adaptive_weights"."confidence_score" IS
    'Renamed from confidence (DB-FR-005B) to match the column name required by get_adaptive_weights()/record_adaptive_outcome(). Renamed rather than duplicated: repository investigation found no other SQL function, view, trigger, RLS policy, application code, or prior migration referencing the prior "confidence" name, so the rename is a lossless, metadata-only change with no other consumer to break.';

-- -----------------------------------------------------------------------------
-- 6. Reconcile uniqueness (replay-safe)
-- -----------------------------------------------------------------------------
-- Add the new unique constraint the certified functions' key model requires:
-- (role_family, experience_bucket, industry_tag). The existing
-- adaptive_weights_role_id_experience_bucket_key constraint on
-- (role_id, experience_bucket) is left in place unchanged: role_id is being
-- retained (see below) and dropping its constraint is not required for the
-- certified functions to work, so removing it would be scope beyond the
-- minimum forward reconciliation.
--
-- No data migration is needed for this constraint to be added safely:
-- PostgreSQL unique constraints treat NULL as distinct from every other
-- value (including other NULLs), so existing rows -- which will have NULL
-- role_family and NULL industry_tag until backfilled by a future process --
-- cannot violate this constraint against each other or against new rows.
--
-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS form, so this is made
-- replay-safe by checking pg_constraint for the constraint name before
-- creating it. If the constraint already exists (e.g. this migration is
-- re-run in a recovery scenario), this is a no-op; otherwise the constraint
-- is created exactly as specified, unchanged from the certified definition.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public'
          AND c.conname = 'adaptive_weights_role_family_experience_bucket_industry_tag_key'
          AND c.conrelid = 'public.adaptive_weights'::regclass
    ) THEN
        ALTER TABLE "public"."adaptive_weights"
            ADD CONSTRAINT "adaptive_weights_role_family_experience_bucket_industry_tag_key"
            UNIQUE ("role_family", "experience_bucket", "industry_tag");
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- role_id — retained, unchanged
-- -----------------------------------------------------------------------------
-- role_id is NOT dropped, renamed, or reinterpreted. It is a distinct concept
-- from role_family (a specific role identifier vs. a role category grouping;
-- see DB-FR-005A domain model analysis) and remains available for any
-- consumer that still keys on it, including the pre-existing
-- adaptive_weights_role_id_experience_bucket_key unique constraint, which is
-- also left in place.

COMMIT;

-- =============================================================================
-- POST-DEPLOYMENT VERIFICATION
-- =============================================================================
-- Schema-only checks. Does not modify or invoke get_adaptive_weights() or
-- record_adaptive_outcome(); confirms the schema they depend on is correct.

-- A + B. New columns exist, including the renamed confidence_score, with the
--        expected types/nullability/defaults.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'adaptive_weights'
  AND column_name IN (
      'role_family', 'industry_tag', 'manual_override',
      'freeze_learning', 'confidence_score'
  )
ORDER BY column_name;
-- expect 5 rows; manual_override/freeze_learning: is_nullable = 'NO',
-- column_default = 'false'; role_family/industry_tag/confidence_score present.

-- Confirm the old "confidence" name is gone (renamed, not duplicated).
SELECT count(*) AS old_column_still_present
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'adaptive_weights'
  AND column_name = 'confidence';
-- expect 0

-- C. Unique constraint exists with the certified definition.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.adaptive_weights'::regclass
  AND conname = 'adaptive_weights_role_family_experience_bucket_industry_tag_key';
-- expect 1 row: UNIQUE (role_family, experience_bucket, industry_tag)

-- D. role_id remains present, unchanged, with its original constraint intact.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'adaptive_weights'
  AND column_name = 'role_id';
-- expect 1 row: role_id | text | NO

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.adaptive_weights'::regclass
  AND conname = 'adaptive_weights_role_id_experience_bucket_key';
-- expect 1 row: UNIQUE (role_id, experience_bucket), unchanged

-- E. Existing row count preserved.
--    A schema migration cannot independently prove that row count was
--    preserved -- this query only reports the count as it stands *after*
--    migration; it has no "before" value to compare against on its own.
--    None of the statements in this migration delete or insert rows (only
--    ADD COLUMN, RENAME COLUMN, and ADD CONSTRAINT are used, all of which
--    are row-count-neutral by construction), so no row loss is expected,
--    but confirming that requires an external baseline. Deployment
--    procedure should capture:
--        SELECT count(*) FROM public.adaptive_weights;
--    immediately BEFORE running this migration, and compare it against the
--    post-migration count below; the two values must match exactly.
SELECT count(*) AS row_count FROM public.adaptive_weights;

-- F. Schema satisfies every column referenced by get_adaptive_weights() and
--    record_adaptive_outcome() — a zero-row SELECT exercises column
--    existence/type resolution without touching data or invoking either
--    function.
SELECT
    role_family, experience_bucket, industry_tag,
    manual_override, freeze_learning,
    skills, experience, education, projects,
    confidence_score, performance_score
FROM public.adaptive_weights
LIMIT 0;
-- expect: succeeds with no error
