-- =============================================================================
-- Migration: 20260723000001_retire_career_paths_rollback.sql
-- Work Package: WP-CI-04 — Legacy Schema Retirement Implementation
--
-- Reverses 20260723000001_retire_career_paths.sql by recreating
-- `public.career_paths` with the exact structure it had in
-- 000_initial_schema.sql (columns, primary key, unique constraint, RLS
-- enablement, and default grants).
--
-- SAFETY WARNING — READ BEFORE EXECUTING
--   - This recreates the TABLE STRUCTURE ONLY. It does NOT restore data.
--   - If the pre-drop production data verification (see
--     supabase/scripts/verify_career_paths_data.sql) found existing rows,
--     they were exported before the forward migration ran. To restore
--     data after running this rollback, reload that export, e.g.:
--       COPY public.career_paths (id, from_role, to_role, avg_years,
--         demand_score, created_at, required_skills)
--       FROM '<path-to-exported-backup>.csv' WITH (FORMAT csv, HEADER true);
--     or, if a full pg_dump table backup was taken instead:
--       pg_restore --data-only --table=career_paths <backup-file>
--   - Do NOT run this rollback as a routine operation — it exists only to
--     recover from an unexpected issue immediately after the forward
--     migration is applied. Once `career_role_transitions` has become the
--     sole system of record and any excelImporter.js consumers have been
--     updated, re-introducing career_paths reopens the exact dual-schema
--     ambiguity WP-CI-01/02/03/04 exist to close.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."career_paths" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_role" "text" NOT NULL,
    "to_role" "text" NOT NULL,
    "avg_years" integer DEFAULT 2,
    "demand_score" integer DEFAULT 50,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "required_skills" "jsonb" DEFAULT '[]'::"jsonb"
);

ALTER TABLE "public"."career_paths" OWNER TO "postgres";

ALTER TABLE ONLY "public"."career_paths"
    ADD CONSTRAINT "career_paths_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."career_paths"
    ADD CONSTRAINT "career_paths_from_role_to_role_key" UNIQUE ("from_role", "to_role");

ALTER TABLE "public"."career_paths" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."career_paths" TO "anon";
GRANT ALL ON TABLE "public"."career_paths" TO "authenticated";
GRANT ALL ON TABLE "public"."career_paths" TO "service_role";

COMMIT;
