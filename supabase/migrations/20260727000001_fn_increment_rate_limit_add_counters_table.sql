-- =============================================================================
-- HireRise Core Database Function Reconciliation (DB-FR)
-- Migration: 20260727000001_fn_increment_rate_limit_add_counters_table.sql
-- Work Package: DB-FR — Lint Error 1/N
--
-- LINT ERROR ADDRESSED
--   supabase db lint (public schema):
--     function:  public.increment_rate_limit
--     message:   relation "rate_limit_counters" does not exist
--     sqlState:  42P01
--
-- CLASSIFICATION (per HireRise_DB-FR_Function_Inventory.csv)
--   public.increment_rate_limit — ACTIVE
--   App evidence: core/api-service/src/middleware/rate-limit.middleware.js
--   (checkAndIncrement() calls supabaseAdmin.rpc('increment_rate_limit',
--   { p_id, p_limit, p_expires_at })). Since the object is ACTIVE, this is a
--   fix-in-place per the DB-FR workflow, not a retirement.
--
-- ROOT CAUSE
--   `increment_rate_limit(p_id text, p_limit integer, p_expires_at
--   timestamptz)` was defined in 000_initial_schema.sql, but its backing
--   table `rate_limit_counters` was never created in any migration
--   (confirmed absent from the full migration chain and from both schema
--   backups: pre_wp_db_005_schema.sql, post_wp_db_005_schema.sql). The
--   function body's `insert ... on conflict (id) do update` requires:
--     - id        text, unique/primary key (the ON CONFLICT target)
--     - count     integer (incremented and returned)
--     - expires_at timestamptz (passed through from p_expires_at)
--   matching exactly the three arguments the middleware already sends.
--
-- WHAT THIS MIGRATION DOES
--   Creates the missing `public.rate_limit_counters` table with the minimal
--   columns the existing function body requires, and applies the same
--   RLS/grant convention already used for the sibling internal counter
--   table `public.conversion_aggregates` (RLS enabled, service-role-only
--   policy, broad table grants — the function itself is SECURITY DEFINER,
--   so this does not change any caller-facing behavior).
--
-- WHAT THIS MIGRATION DOES NOT DO
--   - Does not modify `increment_rate_limit` itself (function body is
--     already correct against this table shape).
--   - Does not touch `conversion_aggregates` or any other counter table.
--   - Does not add indexes, TTL cleanup jobs, or other schema beyond what
--     the function body requires — no redesign.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."rate_limit_counters" (
    "id" "text" NOT NULL,
    "count" integer DEFAULT 0 NOT NULL,
    "expires_at" timestamp with time zone NOT NULL
);

ALTER TABLE "public"."rate_limit_counters" OWNER TO "postgres";

ALTER TABLE ONLY "public"."rate_limit_counters"
    ADD CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("id");

ALTER TABLE "public"."rate_limit_counters" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON "public"."rate_limit_counters"
    USING (("auth"."role"() = 'service_role'::"text"));

GRANT ALL ON TABLE "public"."rate_limit_counters" TO "anon";
GRANT ALL ON TABLE "public"."rate_limit_counters" TO "authenticated";
GRANT ALL ON TABLE "public"."rate_limit_counters" TO "service_role";

COMMIT;
