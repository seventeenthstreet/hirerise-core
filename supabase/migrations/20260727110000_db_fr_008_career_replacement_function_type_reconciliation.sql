-- =============================================================================
-- DB-FR-008 — Career Replacement Function Type Reconciliation
-- =============================================================================
--
-- Scope: public.replace_career_predictions(), public.replace_career_simulations(),
--        public.replace_education_roi() only.
--
-- Root cause (identical for all three — one underlying issue, not three
-- independent bugs; see report §3):
--   000_initial_schema.sql defines TWO overloads of each function name:
--     (p_student_id text, p_rows jsonb)  — matches the canonical schema
--     (p_student_id uuid, p_rows jsonb)  — does NOT match the canonical schema
--   lmi_career_predictions.student_id, edu_career_simulations.student_id, and
--   edu_education_roi.student_id are, and per migration history have always
--   been, TEXT — never UUID (confirmed identical across 000_initial_schema.sql,
--   migrations_original_backup, pre_wp_db_005_schema.sql, and
--   post_wp_db_005_schema.sql — no drift, this was never correct).
--   Each uuid-typed overload's body runs `... WHERE student_id = p_student_id`,
--   i.e. text = uuid, which PostgreSQL has no operator for (SQLSTATE 42883).
--   This reproduces exactly, for all three functions, in a scratch Postgres 16
--   instance during this work package (see report §8).
--
-- This is the same defect shape DB-FR-003 already certified a fix for
-- (public.claim_job: uuid-typed p_job_id vs. automation_jobs.id text) and
-- the same resolution is applied here: CREATE OR REPLACE FUNCTION cannot
-- change a parameter's type, so the broken uuid-typed overload of each
-- function is DROPped explicitly, and the correct text-typed overload —
-- already present, already schema-correct, already the one every
-- application caller's plain-string studentId value matches — is left
-- exactly as-is and additionally certified with a COMMENT ON FUNCTION.
--
-- Sole application caller: core/src/modules/education-intelligence/orchestrator/
-- education.orchestrator.js calls all three via supabase.rpc(fn, { p_student_id:
-- studentId, p_rows: rows }), where studentId is always a plain JS string
-- traced back to route/service parameters — never a typed UUID object. This
-- migration removes the ambiguous uuid overload and leaves that call path
-- fully intact against the remaining text overload.
--
-- No table, column, RLS policy, or application code is touched. No new
-- capability is introduced. Behavior of the surviving text overload is
-- byte-for-byte unchanged from 000_initial_schema.sql.
--
-- Replay-safety: DROP FUNCTION IF EXISTS is idempotent; COMMENT ON is
-- idempotent (overwrite). Safe to re-run.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. replace_career_predictions — drop broken uuid overload
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS "public"."replace_career_predictions"("p_student_id" "uuid", "p_rows" "jsonb");

COMMENT ON FUNCTION "public"."replace_career_predictions"("p_student_id" "text", "p_rows" "jsonb") IS
'DB-FR-008: certified as the sole surviving overload. lmi_career_predictions.student_id is, and always '
'has been, text — this overload''s parameter type already matched the canonical schema and required no '
'change. A second, uuid-typed overload existed alongside it since 000_initial_schema.sql and was broken '
'(text = uuid has no operator, SQLSTATE 42883); it has been dropped by this migration (same defect shape, '
'same resolution, as DB-FR-003''s public.claim_job fix). Sole caller: education.orchestrator.js '
'atomicReplace(''replace_career_predictions'', studentId, careerRows), where studentId is always a plain '
'string — this overload''s signature and behavior are unchanged.';

-- -----------------------------------------------------------------------------
-- 2. replace_career_simulations — drop broken uuid overload
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS "public"."replace_career_simulations"("p_student_id" "uuid", "p_rows" "jsonb");

COMMENT ON FUNCTION "public"."replace_career_simulations"("p_student_id" "text", "p_rows" "jsonb") IS
'DB-FR-008: certified as the sole surviving overload. edu_career_simulations.student_id is, and always '
'has been, text — this overload''s parameter type already matched the canonical schema and required no '
'change. A second, uuid-typed overload existed alongside it since 000_initial_schema.sql and was broken '
'(text = uuid has no operator, SQLSTATE 42883); it has been dropped by this migration (same defect shape, '
'same resolution, as DB-FR-003''s public.claim_job fix). Sole caller: education.orchestrator.js '
'atomicReplace(''replace_career_simulations'', studentId, simulationRows), where studentId is always a '
'plain string — this overload''s signature and behavior are unchanged.';

-- -----------------------------------------------------------------------------
-- 3. replace_education_roi — drop broken uuid overload
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS "public"."replace_education_roi"("p_student_id" "uuid", "p_rows" "jsonb");

COMMENT ON FUNCTION "public"."replace_education_roi"("p_student_id" "text", "p_rows" "jsonb") IS
'DB-FR-008: certified as the sole surviving overload. edu_education_roi.student_id is, and always has '
'been, text — this overload''s parameter type already matched the canonical schema and required no '
'change. A second, uuid-typed overload existed alongside it since 000_initial_schema.sql and was broken '
'(text = uuid has no operator, SQLSTATE 42883); it has been dropped by this migration (same defect shape, '
'same resolution, as DB-FR-003''s public.claim_job fix). Sole caller: education.orchestrator.js '
'atomicReplace(''replace_education_roi'', studentId, roiRows), where studentId is always a plain string — '
'this overload''s signature and behavior are unchanged.';

COMMIT;
