-- =============================================================================
-- Rollback for: 20260526100000_phase2b_student_academic_rpcs_original_RECONSTRUCTED.sql
--
-- SAFETY WARNING — READ BEFORE EXECUTING
--   - This DROPs student_language_preferences, student_subject_selections,
--     and student_academic_profiles entirely, including any evolution-added
--     columns from 20260527000003 and any production data in these tables.
--   - Do NOT run this if 20260527000003_phase2b_student_academic_rpcs_evolution.sql
--     has already been applied on top of it and the tables contain live rows —
--     confirm with the data/backend owner first. Per WP-ARCH-01A2 these tables
--     are confirmed LIVE IN PRODUCTION and are read via Supabase RPC directly
--     from front/src/api/academicOnboardingApi.ts.
--   - Child tables are dropped before the parent to satisfy FK dependencies.
--   - This rollback does not touch student_education_profiles, taxonomy
--     tables (countries_master, academic_boards, etc.), or any other table —
--     those are out of scope for this migration and this rollback.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.student_language_preferences;
DROP TABLE IF EXISTS public.student_subject_selections;
DROP TABLE IF EXISTS public.student_academic_profiles;

COMMIT;
