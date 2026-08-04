-- WP-ADMIN-02C — Enterprise Admin Step-Up Authentication (Google Authenticator TOTP)
-- Additive only. Does not modify any existing table. Reuses admin_logs (via
-- adminAuditLogger.js) for audit trail — no new audit table introduced.

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_mfa_secrets — one row per admin who has enrolled (or is enrolling)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."admin_mfa_secrets" (
    "uid"                text PRIMARY KEY,
    "encrypted_secret"   text NOT NULL,
    "iv"                 text NOT NULL,
    "auth_tag"           text NOT NULL,
    "activated"          boolean NOT NULL DEFAULT false,
    "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
    "activated_at"       timestamp with time zone,
    "last_verified_at"   timestamp with time zone,
    "failed_attempts"    integer NOT NULL DEFAULT 0,
    "locked_until"       timestamp with time zone,
    "updated_at"         timestamp with time zone NOT NULL DEFAULT now()
);

COMMENT ON TABLE "public"."admin_mfa_secrets" IS
    'WP-ADMIN-02C: RFC-6238 TOTP secret per admin, AES-256-GCM encrypted at rest via utils/adminCrypto.js. Never stores or returns the plaintext secret after enrollment completes.';

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_mfa_recovery_codes — single-use recovery codes, hashed (never plaintext)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."admin_mfa_recovery_codes" (
    "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "uid"         text NOT NULL REFERENCES "public"."admin_mfa_secrets"("uid") ON DELETE CASCADE,
    "code_hash"   text NOT NULL,
    "used_at"     timestamp with time zone,
    "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_mfa_recovery_codes_uid
    ON "public"."admin_mfa_recovery_codes" ("uid");

COMMENT ON TABLE "public"."admin_mfa_recovery_codes" IS
    'WP-ADMIN-02C: SHA-256 hashed single-use recovery codes. Regenerating revokes all previous unused codes for that uid.';

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_elevated_sessions — the step-up session, independent of the primary
-- Supabase auth session per the WP's "must be independent" requirement.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."admin_elevated_sessions" (
    "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "uid"               text NOT NULL,
    "session_token"     text NOT NULL UNIQUE,
    "verified_at"       timestamp with time zone NOT NULL DEFAULT now(),
    "expires_at"        timestamp with time zone NOT NULL,
    "last_activity_at"  timestamp with time zone NOT NULL DEFAULT now(),
    "revoked_at"        timestamp with time zone,
    "created_via"       text NOT NULL DEFAULT 'totp' -- 'totp' | 'recovery_code'
);

CREATE INDEX IF NOT EXISTS idx_admin_elevated_sessions_uid
    ON "public"."admin_elevated_sessions" ("uid");
CREATE INDEX IF NOT EXISTS idx_admin_elevated_sessions_token
    ON "public"."admin_elevated_sessions" ("session_token");

COMMENT ON TABLE "public"."admin_elevated_sessions" IS
    'WP-ADMIN-02C: step-up (elevated) admin session, separate from the Supabase auth session. 30-minute inactivity timeout enforced in mfa.service.js, not by the DB.';
