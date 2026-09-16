-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260905010000_phase0_student_recommendation_results_foundation.sql
-- Phase 0 — Recommendation Result Schema Alignment & Foundation
-- (HireRise Student MVP — prerequisite hygiene pass, ahead of the
--  Recommendation Engine rewrite)
--
-- EVIDENCE:
--   `public.student_recommendation_results` is actively read/written by
--   application code (core/src/modules/student-onboarding/services/
--   recommendation-engine.js, core/src/routes/student-onboarding.routes.js),
--   but no tracked migration creates it — confirmed by grep across
--   core/supabase/migrations/*.sql. Its base shape below is confirmed
--   identically by two independent repository schema dumps
--   (core/backups/pre_wp_db_005_schema.sql, core/backups/post_wp_db_005_schema.sql).
--   No live database connection was available in this environment, so no
--   live verification is claimed. This migration does not claim to be
--   "safe against any existing schema" — it assumes the repository-derived
--   base shape below is the live shape, and does not attempt to detect or
--   reconcile an unknown/drifted live schema.
--
-- REPOSITORY-DERIVED BASE SHAPE (assumed present; not reconciled if it isn't):
--   id              uuid PK, default gen_random_uuid()
--   user_id         uuid NOT NULL, UNIQUE (student_recommendation_results_user_id_key),
--                   FK -> auth.users(id) ON DELETE CASCADE
--   result_json     jsonb NOT NULL
--   engine_version  text NOT NULL DEFAULT 'v1'
--   top_domain_id   text
--   top_stream      text CHECK (top_stream IN ('science','commerce','humanities'))
--   generated_at    timestamptz NOT NULL DEFAULT now()
--   updated_at      timestamptz NOT NULL DEFAULT now(), maintained by trigger
--                   set_updated_at_results -> public.update_updated_at_column()
--   indexes: idx_student_recommendation_results_top_domain (top_domain_id),
--            idx_student_recommendation_results_user_id (user_id)
--   RLS ENABLED, policies:
--     student_recommendation_results_self_access (authenticated, ALL,
--       USING/WITH CHECK user_id = auth.uid())
--     student_recommendation_results_service_role (service_role, ALL, true)
--   GRANT ALL ... TO anon/authenticated/service_role — generic Supabase
--     pattern also present on other tracked RLS-protected tables; RLS
--     still applies underneath it, so this is not treated as a defect
--     (Phase 0 brief §8) and is left untouched.
--
-- THIS MIGRATION ADDS (Phase 0 scope only):
--   status          text NOT NULL DEFAULT 'ready'
--                   CHECK IN ('not_started','pending','ready','failed')
--   error_detail    text, nullable
--   context_version text, nullable (DB: context_version / JS: contextVersion)
--
-- WHY status DEFAULTs to 'ready' (not 'not_started'/'pending'):
--   The only write path for this table today
--   (recommendation-engine.js#generateRecommendations) upserts a row ONLY
--   after a Recommendation has been successfully generated and validated.
--   No code path inserts a 'pending' or 'failed' row. Every existing row
--   therefore represents a valid, complete result, so 'ready' is the
--   correct backfill value (Phase 0 brief §7) AND the correct DEFAULT so
--   the unmodified insert path keeps working unchanged
--   (recommendation-engine.js is explicitly out of scope this pass —
--   Phase 0 brief §27). A later pass that wires explicit pending/failed
--   writes should set `status` on those paths directly.
--
-- WHY context_version is left NULL for existing rows:
--   No prior code recorded which canonical-context contract version (if
--   any) produced a historical result, so the value cannot be honestly
--   reconstructed. NULL is preserved rather than invented (Phase 0 brief §7).
--
-- SECURITY / RLS:
--   RLS was verified from repository schema evidence (see above). Live DB
--   verification was unavailable. This migration does NOT unconditionally
--   drop/recreate policies and does not touch RLS at all when the table
--   already exists. The only case in which this migration establishes RLS
--   is the fallback table-creation path below (Step 0), which applies only
--   if the table does not yet exist — and in that case it creates exactly
--   the policies shown in the repository-derived shape above, nothing more.
--
-- WHAT THIS MIGRATION DOES NOT DO:
--   - does not reconcile an unknown/drifted live schema — it assumes the
--     repository-derived base shape above; if the live table's shape
--     differs from that, this migration does not detect or repair it;
--   - does not drop or recreate RLS policies on an existing table;
--   - does not add Recommendation history (no new row-per-generation
--     table; existing one-row-per-user model + UNIQUE(user_id) preserved);
--   - does not add the `studentRecommendation` credit operation (cost not
--     yet approved — see Phase 0 implementation report);
--   - does not modify recommendation-engine.js or student-onboarding
--     routes (generation logic / frontend wiring are explicitly deferred).
--
-- REMAINING GAP: live database verification remains outstanding.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Step 0: Fallback base-table creation (only if the table is absent) ─────
-- This branch is NOT expected to run — repository evidence indicates the
-- table already exists live. It exists only so this migration fails
-- gracefully forward (by creating exactly the repository-verified shape)
-- rather than silently no-op'ing against a table Phase 1+ code assumes is
-- present, in the unlikely event the table is genuinely absent. It is
-- guarded so that nothing in this block executes, and no RLS/grants are
-- touched, when the table already exists.
DO $$
BEGIN
  IF to_regclass('public.student_recommendation_results') IS NULL THEN

    CREATE TABLE "public"."student_recommendation_results" (
        "id" uuid DEFAULT gen_random_uuid() NOT NULL,
        "user_id" uuid NOT NULL,
        "result_json" jsonb NOT NULL,
        "engine_version" text DEFAULT 'v1'::text NOT NULL,
        "top_domain_id" text,
        "top_stream" text,
        "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "student_recommendation_results_top_stream_check"
          CHECK (("top_stream" IS NULL) OR ("top_stream" = ANY (ARRAY['science'::text, 'commerce'::text, 'humanities'::text])))
    );

    ALTER TABLE ONLY "public"."student_recommendation_results"
      ADD CONSTRAINT "student_recommendation_results_pkey" PRIMARY KEY ("id");

    ALTER TABLE ONLY "public"."student_recommendation_results"
      ADD CONSTRAINT "student_recommendation_results_user_id_key" UNIQUE ("user_id");

    ALTER TABLE ONLY "public"."student_recommendation_results"
      ADD CONSTRAINT "student_recommendation_results_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

    CREATE INDEX "idx_student_recommendation_results_top_domain"
      ON "public"."student_recommendation_results" USING btree ("top_domain_id");

    CREATE INDEX "idx_student_recommendation_results_user_id"
      ON "public"."student_recommendation_results" USING btree ("user_id");

    CREATE OR REPLACE TRIGGER "set_updated_at_results"
      BEFORE UPDATE ON "public"."student_recommendation_results"
      FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();

    -- RLS is established here ONLY because this branch just created the
    -- table. This is not a general-purpose RLS reconciliation path and
    -- does not run, and touches nothing, when the table already exists.
    ALTER TABLE "public"."student_recommendation_results" ENABLE ROW LEVEL SECURITY;

    CREATE POLICY "student_recommendation_results_self_access"
      ON "public"."student_recommendation_results"
      TO "authenticated"
      USING (("user_id" = auth.uid()))
      WITH CHECK (("user_id" = auth.uid()));

    CREATE POLICY "student_recommendation_results_service_role"
      ON "public"."student_recommendation_results"
      TO "service_role"
      USING (true)
      WITH CHECK (true);

    GRANT ALL ON TABLE "public"."student_recommendation_results" TO "anon";
    GRANT ALL ON TABLE "public"."student_recommendation_results" TO "authenticated";
    GRANT ALL ON TABLE "public"."student_recommendation_results" TO "service_role";

  END IF;
  -- ELSE: table already exists. Per repository evidence its base columns,
  -- constraints, indexes, trigger, RLS, and policies are already in place.
  -- This migration does not reassert, replace, or otherwise touch any of
  -- them here — see header "SECURITY / RLS".
END $$;

-- ── Step 1: Add the Phase 0 authorized fields (additive only) ──────────────

ALTER TABLE "public"."student_recommendation_results"
  ADD COLUMN IF NOT EXISTS "status" text;

ALTER TABLE "public"."student_recommendation_results"
  ADD COLUMN IF NOT EXISTS "error_detail" text;

ALTER TABLE "public"."student_recommendation_results"
  ADD COLUMN IF NOT EXISTS "context_version" text;

-- ── Step 2: Backfill existing rows ──────────────────────────────────────────
-- Every existing row was written by the success-only upsert path, so it
-- represents a complete, valid result.
UPDATE "public"."student_recommendation_results"
  SET "status" = 'ready'
  WHERE "status" IS NULL;

-- error_detail stays NULL for these rows (no error occurred).
-- context_version stays NULL for these rows (cannot be honestly
-- reconstructed for historical data — see header note).

-- ── Step 3: Enforce the locked state machine + finalize defaults ───────────
-- (This constraint is introduced by this migration; dropping/recreating it
-- here is this migration managing its own artifact, not reasserting a
-- pre-existing base-schema constraint.)

ALTER TABLE "public"."student_recommendation_results"
  DROP CONSTRAINT IF EXISTS "chk_student_recommendation_results_status";

ALTER TABLE "public"."student_recommendation_results"
  ADD CONSTRAINT "chk_student_recommendation_results_status"
  CHECK ("status" IN ('not_started', 'pending', 'ready', 'failed'));

ALTER TABLE "public"."student_recommendation_results"
  ALTER COLUMN "status" SET DEFAULT 'ready';

ALTER TABLE "public"."student_recommendation_results"
  ALTER COLUMN "status" SET NOT NULL;

COMMENT ON COLUMN "public"."student_recommendation_results"."status" IS
  'Phase 0 (student-recommendation-context-v1). Locked MVP state machine: '
  'not_started | pending | ready | failed. DEFAULT ''ready'' matches the '
  'only current write path (success-only upsert in '
  'recommendation-engine.js#generateRecommendations). A later pass that '
  'wires explicit pending/failed writes should set this column on every '
  'insert/update rather than rely on the default.';

COMMENT ON COLUMN "public"."student_recommendation_results"."error_detail" IS
  'Phase 0. Safe, concise, student-facing-safe representation of the most '
  'recent generation failure, if any. Must never contain secrets, API '
  'keys, authorization headers, raw prompts, model payloads, or stack '
  'traces. NULL when status != ''failed''.';

COMMENT ON COLUMN "public"."student_recommendation_results"."context_version" IS
  'Phase 0 (DB: context_version / JS: contextVersion). Structure/contract '
  'version of the canonical Student context used to generate this result '
  '(e.g. ''student-recommendation-context-v1''). NULL for historical rows '
  'predating this column, and for any row where the generating context '
  'version cannot be honestly reconstructed. Not derived from timestamps; '
  'not incremented per student.';

COMMIT;