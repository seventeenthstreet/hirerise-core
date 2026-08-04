-- =============================================================================
-- DB-FR-004 — Orphaned Function Reconciliation
-- =============================================================================
--
-- Root cause (certified):
--   public.check_and_increment_ai_usage(uuid, integer, timestamptz, timestamptz)
--   is an orphaned duplicate of the AI-usage-metering feature, left behind
--   after the project standardized on increment_ai_usage(text, text). It
--   references user_profiles.monthly_ai_usage_count and
--   user_profiles.ai_usage_reset_date, columns that have never existed on
--   that table in any schema snapshot in this repository — this is not
--   schema drift; the function has never matched the schema. It also takes
--   p_user_id as uuid while user_profiles.id is text, a second, independent
--   mismatch. It has zero callers anywhere in the repository (no RPC
--   invocation, no trigger, no view, no policy, no scheduled job), confirmed
--   independently by the repository's own function inventory, which flags it
--   as ORPHANED.
--
--   AI usage metering is already correctly implemented in production by
--   increment_ai_usage(user_id text, user_tier text), called from
--   aiUsage.service.js, operating on "userProfiles" ("monthlyAiUsageCount",
--   "aiUsageResetDate"). That function is untouched by this migration.
--
-- Fix:
--   Drop the orphaned function. No repair, no redesign — it serves no
--   production purpose and repairing it would only recreate a duplicate,
--   competing implementation.
--
-- Certified signature being removed:
--   public.check_and_increment_ai_usage(
--     p_user_id    uuid,
--     p_limit      integer,
--     p_now        timestamp with time zone,
--     p_next_reset timestamp with time zone
--   )
--
-- Note on DROP FUNCTION vs DROP FUNCTION IF EXISTS:
--   This migration intentionally uses a bare DROP FUNCTION rather than
--   DROP FUNCTION IF EXISTS. The certified investigation asserts, as fact,
--   that this exact orphaned signature exists in the target schema. If that
--   precondition does not hold at apply time (wrong environment, drift,
--   already applied), that is itself a signal worth surfacing loudly rather
--   than swallowing silently. A pre-flight existence check below raises a
--   clear, migration-specific diagnostic before the DROP is attempted, so a
--   missing function produces an actionable error instead of a bare
--   PostgreSQL "does not exist" failure.
--
-- Ownership/grants:
--   No separate cleanup is required. PostgreSQL automatically revokes all
--   privileges on a function and drops its ownership record when the
--   function itself is dropped; no orphaned grants remain.
--
-- =============================================================================

BEGIN;

-- Pre-flight: confirm the certified orphaned signature exists before
-- attempting the drop, and fail with a clear message if it does not.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'check_and_increment_ai_usage'
          AND pg_catalog.pg_get_function_identity_arguments(p.oid)
              = 'p_user_id uuid, p_limit integer, p_now timestamp with time zone, p_next_reset timestamp with time zone'
    ) THEN
        RAISE EXCEPTION
            'DB-FR-004 precondition failed: public.check_and_increment_ai_usage(uuid, integer, timestamptz, timestamptz) not found. Certified reconciliation assumes this exact orphaned signature exists; refusing to proceed silently.';
    END IF;
END;
$$;

DROP FUNCTION "public"."check_and_increment_ai_usage"(
    "uuid",
    integer,
    timestamp with time zone,
    timestamp with time zone
);

COMMIT;
