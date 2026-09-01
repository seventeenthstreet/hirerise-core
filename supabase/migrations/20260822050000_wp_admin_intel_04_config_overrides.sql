-- =============================================================================
-- MIGRATION: 20260822050000_wp_admin_intel_04_config_overrides.sql
-- PURPOSE:   WP-ADMIN-INTEL-04 — minimal storage for ordinary, non-secret
--            Intelligence configuration admin overrides.
--
-- SCOPE:     This is NOT a generic key/value settings table. `key` is
--            constrained at the database level (CHECK) to the exact set of
--            settings the backend's server-controlled definitions registry
--            (src/modules/intelligenceConfig/intelligenceConfig.definitions.js)
--            currently supports. Adding a new administrable setting requires
--            both a registry entry AND a migration extending this CHECK —
--            an admin (or a compromised admin session) can never write an
--            arbitrary key, only override one of the explicitly enumerated,
--            already-audited settings.
--
--            Values are stored as plain text (never secrets — provider
--            credentials remain exclusively in public.admin_secrets via the
--            existing WP-ADMIN-INTEL-03 Secrets Manager / gateway). No
--            encryption columns are needed here, mirroring the distinction
--            drawn in WP-ADMIN-INTEL-01 between secrets and ordinary
--            configuration.
--
-- SAFE:      Additive only. New table, no changes to existing tables.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."intelligence_config_overrides" (
    "id"         "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key"        "text" NOT NULL,
    "value"      "text" NOT NULL,
    "updated_by" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "intelligence_config_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "intelligence_config_overrides_key_unique" UNIQUE ("key"),
    -- Server-controlled allowlist. Extend only alongside a corresponding
    -- entry in intelligenceConfig.definitions.js (see module doc comment).
    CONSTRAINT "intelligence_config_overrides_key_allowlist" CHECK (
        "key" IN ('AI_PROVIDER_PRIORITY')
    )
);

ALTER TABLE "public"."intelligence_config_overrides" OWNER TO "postgres";

-- Same lockdown pattern as public.admin_secrets / public.admin_principals
-- (see 20260410000000_phase1_db_security.sql): backend only ever uses the
-- service_role client (src/config/supabase.js) — no anon or authenticated
-- grants are needed, and RLS is forced so a policy gap can never expose
-- this table.
REVOKE ALL ON TABLE "public"."intelligence_config_overrides" FROM anon;
REVOKE ALL ON TABLE "public"."intelligence_config_overrides" FROM authenticated;

ALTER TABLE "public"."intelligence_config_overrides" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."intelligence_config_overrides" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "intelligence_config_overrides_service_role" ON "public"."intelligence_config_overrides";

CREATE POLICY "intelligence_config_overrides_service_role"
  ON "public"."intelligence_config_overrides"
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;
