-- =============================================================================
-- MIGRATION: 20260824120000_wp_admin_intel_06_provider_registry.sql
-- PURPOSE:   WP-ADMIN-INTEL-06 — storage for admin-registered AI provider
--            configuration ("Add Provider" from the Intelligence
--            Administration UI), so a MASTER_ADMIN can register a new
--            provider without a frontend/backend code change.
--
-- SCOPE:     Non-secret provider configuration ONLY — provider_key,
--            display_name, adapter_type, api_endpoint, default_model,
--            credential_type, enabled, priority_position, metadata. The
--            actual API credential is NEVER stored in this table; it is
--            written exclusively to the existing AES-256-GCM Secrets
--            Manager (public.admin_secrets) via
--            intelligenceProviders.secrets.config.js, exactly the same
--            separation WP-ADMIN-INTEL-03/04 already draw between secret
--            and non-secret Intelligence data. This table stores at most a
--            non-secret *reference* (the canonical secret name) implicitly
--            via provider_key — never a value, ciphertext, IV, or tag.
--
--            The five built-in providers (gemini, grok, mistral, openai,
--            anthropic) remain entirely code/env/Secrets-Manager managed
--            via aiProviderManager.PROVIDER_ENV_KEYS and
--            intelligenceSecrets.config.js — they are NOT rows in this
--            table and provider_key here is constrained to never collide
--            with one of them, so an admin can never "re-add" or shadow a
--            built-in provider through this flow.
--
--            Registering a row here does NOT make a provider executable.
--            Runtime execution requires a matching entry in
--            aiProviderManager.PROVIDER_REGISTRY (a real adapter module),
--            which only ships via a code deploy. The service layer reports
--            this honestly per-row (`runtimeSupported`) rather than this
--            migration trying to encode adapter availability in SQL.
--
-- SAFE:      Additive only. New table, no changes to existing tables.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."intelligence_provider_registry" (
    "id"                "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_key"      "text" NOT NULL,
    "display_name"      "text" NOT NULL,
    -- Which existing adapter protocol this provider claims compatibility
    -- with. Purely informational/forward-looking until a matching
    -- aiProviderManager.PROVIDER_REGISTRY entry exists in code — see
    -- intelligenceProviders.definitions.js's KNOWN_ADAPTER_TYPES, which
    -- this CHECK must be extended in lockstep with.
    "adapter_type"      "text" NOT NULL,
    "api_endpoint"      "text",
    "default_model"     "text",
    "credential_type"   "text" DEFAULT 'api_key' NOT NULL,
    "enabled"           boolean DEFAULT true NOT NULL,
    "priority_position" integer,
    "metadata"          jsonb DEFAULT '{}'::jsonb NOT NULL,
    "created_by"        "text",
    "updated_by"        "text",
    "created_at"        timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"        timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "intelligence_provider_registry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "intelligence_provider_registry_key_unique" UNIQUE ("provider_key"),
    -- Server-controlled key format: lowercase, starts with a letter, ASCII
    -- letters/digits/underscore only. Mirrors
    -- intelligenceProviders.definitions.js's PROVIDER_KEY_REGEX — the app
    -- layer is the primary validator; this is the DB-level backstop.
    CONSTRAINT "intelligence_provider_registry_key_format" CHECK (
        "provider_key" ~ '^[a-z][a-z0-9_]{1,39}$'
    ),
    -- A custom provider can never shadow a built-in, code-managed provider.
    CONSTRAINT "intelligence_provider_registry_no_builtin_shadow" CHECK (
        "provider_key" NOT IN ('gemini', 'grok', 'mistral', 'openai', 'anthropic')
    ),
    CONSTRAINT "intelligence_provider_registry_adapter_type_allowlist" CHECK (
        "adapter_type" IN ('openai', 'anthropic', 'gemini', 'mistral', 'grok')
    ),
    CONSTRAINT "intelligence_provider_registry_credential_type_allowlist" CHECK (
        "credential_type" IN ('api_key')
    )
);

ALTER TABLE "public"."intelligence_provider_registry" OWNER TO "postgres";

CREATE INDEX IF NOT EXISTS "intelligence_provider_registry_priority_idx"
  ON "public"."intelligence_provider_registry" ("priority_position");

-- Same lockdown pattern as public.admin_secrets / public.intelligence_config_overrides:
-- backend only ever uses the service_role client (src/config/supabase.js) —
-- no anon or authenticated grants are needed, and RLS is forced so a
-- policy gap can never expose this table.
REVOKE ALL ON TABLE "public"."intelligence_provider_registry" FROM anon;
REVOKE ALL ON TABLE "public"."intelligence_provider_registry" FROM authenticated;

ALTER TABLE "public"."intelligence_provider_registry" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."intelligence_provider_registry" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "intelligence_provider_registry_service_role" ON "public"."intelligence_provider_registry";

CREATE POLICY "intelligence_provider_registry_service_role"
  ON "public"."intelligence_provider_registry"
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;
