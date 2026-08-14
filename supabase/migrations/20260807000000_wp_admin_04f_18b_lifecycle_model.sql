-- =============================================================================
-- HireRise · Enterprise Authorization Program
-- Migration : WP-ADMIN-04F-18B — Enterprise Administrator Lifecycle Model
-- File      : 20260807000000_wp_admin_04f_18b_lifecycle_model.sql
-- Date      : 2026-08-07
-- =============================================================================
--
-- Purpose:
--   Extends public.admin_principals with an explicit lifecycle `status`
--   column (active | suspended | revoked | expired) and the supporting
--   metadata columns needed to record suspend/reactivate transitions and
--   an optional expiry timestamp.
--
--   This is the SMALLEST forward-compatible evolution of the existing
--   table. It does not touch admin_principals_pkey, role, granted_at/by,
--   verified_at, last_action_at, or any other certified column, and it
--   does not modify any other table (permissions, role_permissions,
--   admin_logs, admin_secrets, etc).
--
-- Backward compatibility:
--   `is_active` is preserved as a generated/synchronized column so that
--   every existing query that filters on `is_active = true`
--   (adminPrincipal.repository.js#listActive, requireAdmin.middleware.js)
--   continues to behave exactly as before: is_active is true if and only
--   if status = 'active'.
--
--   Existing rows are backfilled deterministically from their current
--   is_active/revoked_at values so no row silently changes verification
--   behaviour on deploy.
--
-- Does NOT modify: Authentication, JWT issuance, Authorization/Permission
-- Registry, Assignment Engine, Administrator identity, or the shape of
-- any column already present on admin_principals.
-- =============================================================================

BEGIN;

-- ── 1. Lifecycle status enum (as a CHECK constraint, matching the existing
--       convention used by admin_principals_role_check rather than a
--       Postgres ENUM type, so this migration stays a pure ALTER TABLE) ──
ALTER TABLE "public"."admin_principals"
  ADD COLUMN IF NOT EXISTS "status" "text";

-- ── 2. Lifecycle transition metadata ──────────────────────────────────────
ALTER TABLE "public"."admin_principals"
  ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "suspended_by" "text",
  ADD COLUMN IF NOT EXISTS "suspension_reason" "text",
  ADD COLUMN IF NOT EXISTS "reactivated_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "reactivated_by" "text",
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;

-- ── 3. Backfill existing rows into the new state machine ─────────────────
--     revoked_at already set        -> revoked
--     is_active = false, no revoke  -> revoked (only prior "inactive" state)
--     otherwise                     -> active
UPDATE "public"."admin_principals"
SET "status" = CASE
  WHEN "revoked_at" IS NOT NULL THEN 'revoked'
  WHEN "is_active" = false THEN 'revoked'
  ELSE 'active'
END
WHERE "status" IS NULL;

ALTER TABLE "public"."admin_principals"
  ALTER COLUMN "status" SET DEFAULT 'active',
  ALTER COLUMN "status" SET NOT NULL;

ALTER TABLE "public"."admin_principals"
  DROP CONSTRAINT IF EXISTS "admin_principals_status_check";

ALTER TABLE "public"."admin_principals"
  ADD CONSTRAINT "admin_principals_status_check"
  CHECK ("status" = ANY (ARRAY['active'::"text", 'suspended'::"text", 'revoked'::"text", 'expired'::"text"]));

-- ── 4. Keep is_active synchronized with status for backward compatibility ─
CREATE OR REPLACE FUNCTION "public"."admin_principals_sync_is_active"()
RETURNS TRIGGER AS $$
BEGIN
  NEW.is_active := (NEW.status = 'active');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "admin_principals_sync_is_active_trg" ON "public"."admin_principals";

CREATE TRIGGER "admin_principals_sync_is_active_trg"
  BEFORE INSERT OR UPDATE OF "status" ON "public"."admin_principals"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."admin_principals_sync_is_active"();

-- Re-run once to normalize is_active for the rows backfilled in step 3
-- (the trigger only fires on INSERT/UPDATE going forward).
UPDATE "public"."admin_principals"
SET "is_active" = ("status" = 'active');

-- ── 5. Index for lifecycle-state queries (listByStatus, expiry sweeps) ───
CREATE INDEX IF NOT EXISTS "admin_principals_status_idx"
  ON "public"."admin_principals" ("status");

CREATE INDEX IF NOT EXISTS "admin_principals_expires_at_idx"
  ON "public"."admin_principals" ("expires_at")
  WHERE "expires_at" IS NOT NULL;

COMMIT;

-- =============================================================================
-- Rollback (manual):
--   BEGIN;
--   DROP TRIGGER IF EXISTS admin_principals_sync_is_active_trg ON public.admin_principals;
--   DROP FUNCTION IF EXISTS public.admin_principals_sync_is_active();
--   DROP INDEX IF EXISTS public.admin_principals_status_idx;
--   DROP INDEX IF EXISTS public.admin_principals_expires_at_idx;
--   ALTER TABLE public.admin_principals
--     DROP COLUMN IF EXISTS status,
--     DROP COLUMN IF EXISTS suspended_at,
--     DROP COLUMN IF EXISTS suspended_by,
--     DROP COLUMN IF EXISTS suspension_reason,
--     DROP COLUMN IF EXISTS reactivated_at,
--     DROP COLUMN IF EXISTS reactivated_by,
--     DROP COLUMN IF EXISTS expires_at;
--   COMMIT;
-- =============================================================================
