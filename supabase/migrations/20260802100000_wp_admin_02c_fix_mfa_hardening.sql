-- WP-ADMIN-02C-FIX — Enterprise Admin MFA Production Hardening Migration
--
-- Forward-only. Does NOT modify, rename, or touch
--   20260802010000_wp_admin_02c_mfa_totp_schema.sql
-- which remains applied and untouched. All statements below are additive
-- and, where the object type allows it, idempotent (safe to re-run).
--
-- Scope: admin_mfa_secrets, admin_mfa_recovery_codes,
-- admin_elevated_sessions only. No changes to authentication,
-- authorization, or the MFA workflow itself.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Data Integrity — additive CHECK constraints
-- ═════════════════════════════════════════════════════════════════════════
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so each is wrapped in a
-- guard against pg_constraint to make re-running this file a no-op rather
-- than an error.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_admin_mfa_secrets_failed_attempts_nonneg'
    ) THEN
        ALTER TABLE "public"."admin_mfa_secrets"
            ADD CONSTRAINT "chk_admin_mfa_secrets_failed_attempts_nonneg"
                CHECK ("failed_attempts" >= 0);
    END IF;
END $$;

COMMENT ON CONSTRAINT "chk_admin_mfa_secrets_failed_attempts_nonneg"
    ON "public"."admin_mfa_secrets" IS
    'WP-ADMIN-02C-FIX: failed_attempts is a counter, never meaningfully negative.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_admin_elevated_sessions_created_via'
    ) THEN
        ALTER TABLE "public"."admin_elevated_sessions"
            ADD CONSTRAINT "chk_admin_elevated_sessions_created_via"
                CHECK ("created_via" IN ('totp', 'recovery_code'));
    END IF;
END $$;

COMMENT ON CONSTRAINT "chk_admin_elevated_sessions_created_via"
    ON "public"."admin_elevated_sessions" IS
    'WP-ADMIN-02C-FIX: mirrors the only two literals mfa.service.js ever writes (createElevatedSession callers).';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_admin_elevated_sessions_expiry_after_verify'
    ) THEN
        ALTER TABLE "public"."admin_elevated_sessions"
            ADD CONSTRAINT "chk_admin_elevated_sessions_expiry_after_verify"
                CHECK ("expires_at" > "verified_at");
    END IF;
END $$;

COMMENT ON CONSTRAINT "chk_admin_elevated_sessions_expiry_after_verify"
    ON "public"."admin_elevated_sessions" IS
    'WP-ADMIN-02C-FIX: an elevated session cannot expire before it was verified.';

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Recovery Code Integrity — scoped uniqueness
-- ═════════════════════════════════════════════════════════════════════════
-- Scoped to (uid, code_hash), matching useRecoveryCode()'s own query shape
-- (`.eq('uid', uid).eq('code_hash', hash).maybeSingle()`), which already
-- assumes at most one match. Not a global UNIQUE on code_hash alone —
-- that would be a stricter, unrequested guarantee across unrelated admins.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_admin_mfa_recovery_codes_uid_hash'
    ) THEN
        ALTER TABLE "public"."admin_mfa_recovery_codes"
            ADD CONSTRAINT "uq_admin_mfa_recovery_codes_uid_hash"
                UNIQUE ("uid", "code_hash");
    END IF;
END $$;

COMMENT ON CONSTRAINT "uq_admin_mfa_recovery_codes_uid_hash"
    ON "public"."admin_mfa_recovery_codes" IS
    'WP-ADMIN-02C-FIX: enforces at the DB level the single-match assumption useRecoveryCode() already makes in application code.';

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Automatic Timestamp Maintenance — reuse existing trigger function
-- ═════════════════════════════════════════════════════════════════════════
-- public.trigger_set_updated_at() already exists (000_initial_schema.sql)
-- and is already reused by set_admin_principals_updated_at and others.
-- No new trigger function is created here — only the missing trigger on
-- admin_mfa_secrets. CREATE OR REPLACE TRIGGER is itself idempotent.
--
-- Note: admin_mfa_secrets.updated_at is currently set by hand inside
-- verifyEnrollment() but NOT inside challenge() in mfa.service.js — this
-- trigger closes that drift gap going forward without requiring an
-- application code change.

CREATE OR REPLACE TRIGGER "set_admin_mfa_secrets_updated_at"
    BEFORE UPDATE ON "public"."admin_mfa_secrets"
    FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();

-- admin_mfa_recovery_codes and admin_elevated_sessions have no
-- updated_at column (append/mark-once tables), so no trigger applies.

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Elevated Session Cleanup — reuse existing pg_cron infrastructure
-- ═════════════════════════════════════════════════════════════════════════
-- pg_cron is already enabled in this project
-- (migrations/20260410162714_remote_schema.sql). No new worker is
-- introduced. Retention: rows are purged 24h after becoming expired or
-- revoked — the durable audit trail is admin_logs, not this table, so a
-- short forensic window here is sufficient.

CREATE OR REPLACE FUNCTION "public"."fn_cleanup_admin_elevated_sessions"()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM "public"."admin_elevated_sessions"
    WHERE ("revoked_at" IS NOT NULL AND "revoked_at" < now() - interval '24 hours')
       OR ("expires_at" < now() - interval '24 hours');
END;
$$;

COMMENT ON FUNCTION "public"."fn_cleanup_admin_elevated_sessions"() IS
    'WP-ADMIN-02C-FIX: purges expired/revoked admin_elevated_sessions rows older than 24h. Invoked hourly via pg_cron job admin-elevated-sessions-cleanup.';

-- Idempotent schedule creation: skip if a job with this name already
-- exists, so re-running this migration does not create duplicate cron
-- jobs (cron.schedule() with a jobname that already exists would
-- otherwise register a second, redundant job rather than erroring).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM cron.job WHERE jobname = 'admin-elevated-sessions-cleanup'
    ) THEN
        PERFORM cron.schedule(
            'admin-elevated-sessions-cleanup',
            '17 * * * *', -- hourly, offset from the hour to avoid contention with other jobs
            $CRON$SELECT public.fn_cleanup_admin_elevated_sessions();$CRON$
        );
    END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. Row Level Security — production hardening
-- ═════════════════════════════════════════════════════════════════════════
-- CRITICAL: these three tables were created by WP-ADMIN-02C without RLS.
-- This project's `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
-- anon, authenticated` (000_initial_schema.sql) means every table is
-- fully readable/writable by those roles by default the moment it's
-- created. The 2026-04-10 phase1_db_security pass that force-enabled RLS
-- on comparable admin tables predates these three, so they were never
-- brought under it — meaning encrypted TOTP secrets, recovery-code
-- hashes, and live elevated-session tokens have been directly reachable
-- by any anon/authenticated Supabase client since WP-ADMIN-02C shipped.
-- ENABLE/FORCE ROW LEVEL SECURITY are themselves idempotent (re-running
-- is a no-op if already set).

ALTER TABLE "public"."admin_mfa_secrets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."admin_mfa_secrets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."admin_mfa_recovery_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."admin_mfa_recovery_codes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."admin_elevated_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."admin_elevated_sessions" FORCE ROW LEVEL SECURITY;

-- service_role-only policies, mirroring the existing
-- admin_principals_service_role pattern exactly (phase1_db_security.sql).
-- DROP IF EXISTS + CREATE makes this block idempotent.

DROP POLICY IF EXISTS "admin_mfa_secrets_service_role" ON "public"."admin_mfa_secrets";
CREATE POLICY "admin_mfa_secrets_service_role"
    ON "public"."admin_mfa_secrets"
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "admin_mfa_recovery_codes_service_role" ON "public"."admin_mfa_recovery_codes";
CREATE POLICY "admin_mfa_recovery_codes_service_role"
    ON "public"."admin_mfa_recovery_codes"
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "admin_elevated_sessions_service_role" ON "public"."admin_elevated_sessions";
CREATE POLICY "admin_elevated_sessions_service_role"
    ON "public"."admin_elevated_sessions"
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ═════════════════════════════════════════════════════════════════════════
-- 6. Privilege Hardening
-- ═════════════════════════════════════════════════════════════════════════
-- These tables inherited a blanket ALL grant to anon/authenticated purely
-- from ALTER DEFAULT PRIVILEGES at creation time — neither role has any
-- legitimate reason to touch them; every read/write goes through the
-- Express backend using SUPABASE_SERVICE_ROLE_KEY
-- (core/src/config/supabase.js). RLS above already blocks row access for
-- anon/authenticated with no policy granting them anything; the REVOKE
-- below removes the table-level grant too, defense-in-depth style.
-- REVOKE/GRANT are idempotent by nature (re-running changes nothing if
-- already applied).

REVOKE ALL ON TABLE "public"."admin_mfa_secrets" FROM "anon", "authenticated";
REVOKE ALL ON TABLE "public"."admin_mfa_recovery_codes" FROM "anon", "authenticated";
REVOKE ALL ON TABLE "public"."admin_elevated_sessions" FROM "anon", "authenticated";

GRANT ALL ON TABLE "public"."admin_mfa_secrets" TO "service_role";
GRANT ALL ON TABLE "public"."admin_mfa_recovery_codes" TO "service_role";
GRANT ALL ON TABLE "public"."admin_elevated_sessions" TO "service_role";
