-- =============================================================================
-- WP-ADMIN-COMP-AW-03C — Adaptive Weight role_id Corrective Migration
-- =============================================================================
--
-- Implements the AW-03B approved architectural decision (Option B):
--   adaptive_weights.role_id is a structurally retained, functionally inert
--   legacy column with respect to the certified Adaptive Weight domain
--   model. The canonical identity is (role_family, experience_bucket,
--   industry_tag). No certified RPC — get_adaptive_weights(),
--   record_adaptive_outcome(), apply_adaptive_override(),
--   release_adaptive_override() — reads, writes, or derives role_id, and no
--   deterministic role_family -> role_id mapping exists to populate it.
--
-- This migration performs exactly one schema change: it drops the NOT NULL
-- constraint on adaptive_weights.role_id, which is the sole blocker of the
-- first-time INSERT branches of record_adaptive_outcome() and
-- apply_adaptive_override() for a genuinely new segment.
--
-- This migration does NOT:
--   - modify get_adaptive_weights(), record_adaptive_outcome(),
--     apply_adaptive_override(), or release_adaptive_override();
--   - modify role_family, experience_bucket, or industry_tag;
--   - drop the role_id column;
--   - drop the legacy adaptive_weights_role_id_experience_bucket_key
--     unique constraint;
--   - add a default to role_id;
--   - backfill or otherwise modify any existing row;
--   - change RLS, RLS policies, or any RPC grant/SECURITY INVOKER-DEFINER
--     status.
--
-- =============================================================================

BEGIN;

ALTER TABLE "public"."adaptive_weights"
    ALTER COLUMN "role_id" DROP NOT NULL;

COMMENT ON COLUMN "public"."adaptive_weights"."role_id" IS
    'Legacy specific-role identifier from the original (role_id, experience_bucket)
     segmentation key. Superseded as the operative identity by
     (role_family, experience_bucket, industry_tag) (DB-FR-005A/DB-FR-005B).
     No certified RPC or application code populates this column; it is retained,
     nullable, for rows created prior to the composite-key model.';

COMMIT;

-- =============================================================================
-- POST-DEPLOYMENT VERIFICATION
-- =============================================================================
-- Schema-only checks. Does not mutate adaptive_weights data.

-- A. role_id is now nullable.
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'adaptive_weights'
  AND column_name = 'role_id';
-- expect 1 row: role_id | YES

-- B. The legacy unique constraint remains, unchanged.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.adaptive_weights'::regclass
  AND conname = 'adaptive_weights_role_id_experience_bucket_key';
-- expect 1 row: UNIQUE (role_id, experience_bucket), unchanged

-- C. The canonical unique constraint remains, unchanged.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.adaptive_weights'::regclass
  AND conname = 'adaptive_weights_role_family_experience_bucket_industry_tag_key';
-- expect 1 row: UNIQUE (role_family, experience_bucket, industry_tag), unchanged

-- D. Certified RPCs are untouched by this migration (name/arg check only —
--    this migration contains no statement that alters any of them).
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
      'get_adaptive_weights', 'record_adaptive_outcome',
      'apply_adaptive_override', 'release_adaptive_override'
  )
ORDER BY p.proname;
-- expect 4 rows, unchanged from 000_initial_schema.sql /
-- 20260823060000_wp_admin_comp_aw_03_adaptive_override_rpcs.sql

-- E. RLS remains enabled on the table (unchanged by this migration).
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'adaptive_weights';
-- expect rls_enabled = true

-- F. Existing row count preserved (row-count-neutral by construction —
--    ALTER COLUMN ... DROP NOT NULL and COMMENT ON COLUMN never insert,
--    update, or delete rows).
SELECT count(*) AS row_count FROM public.adaptive_weights;
