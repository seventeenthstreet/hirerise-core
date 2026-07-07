-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 1A — ROLLBACK MIGRATION
-- File: 20260526000001_phase1a_academic_taxonomy_infrastructure.rollback.sql
--
-- PURPOSE: Safely reverse the Phase 1A migration.
--
-- SAFETY RULES:
--   1. Drop order is reverse of creation (FK dependencies respected)
--   2. All DROPs use IF EXISTS — idempotent rollback
--   3. Triggers dropped before tables to avoid orphan dependencies
--   4. This rollback MUST NOT be run if Phase 1B or later migrations
--      have introduced FK references to these tables.
--
-- PRE-ROLLBACK CHECKLIST:
--   □ No Phase 1B+ migrations have been applied
--   □ No student academic records reference these taxonomy tables
--   □ No onboarding sessions are in-flight
--   □ Downstream competency layers have been rolled back first
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- STEP 1: Drop governance triggers (prevent-delete triggers first)
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_governance_no_delete_subject_stream_map     ON public.subject_stream_map;
DROP TRIGGER IF EXISTS trg_governance_no_delete_state_language_mapping  ON public.state_language_mapping;
DROP TRIGGER IF EXISTS trg_governance_no_delete_academic_languages      ON public.academic_languages;
DROP TRIGGER IF EXISTS trg_governance_no_delete_academic_subjects       ON public.academic_subjects;
DROP TRIGGER IF EXISTS trg_governance_no_delete_academic_streams        ON public.academic_streams;
DROP TRIGGER IF EXISTS trg_governance_no_delete_academic_boards         ON public.academic_boards;
DROP TRIGGER IF EXISTS trg_governance_no_delete_curriculum_regions      ON public.curriculum_regions;
DROP TRIGGER IF EXISTS trg_governance_no_delete_countries_master        ON public.countries_master;

-- ---------------------------------------------------------------------------
-- STEP 2: Drop updated_at triggers
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_subject_stream_map_updated_at    ON public.subject_stream_map;
DROP TRIGGER IF EXISTS trg_state_language_mapping_updated_at ON public.state_language_mapping;
DROP TRIGGER IF EXISTS trg_academic_languages_updated_at     ON public.academic_languages;
DROP TRIGGER IF EXISTS trg_academic_subjects_updated_at      ON public.academic_subjects;
DROP TRIGGER IF EXISTS trg_academic_streams_updated_at       ON public.academic_streams;
DROP TRIGGER IF EXISTS trg_academic_boards_updated_at        ON public.academic_boards;
DROP TRIGGER IF EXISTS trg_curriculum_regions_updated_at     ON public.curriculum_regions;
DROP TRIGGER IF EXISTS trg_countries_master_updated_at       ON public.countries_master;

-- ---------------------------------------------------------------------------
-- STEP 3: Drop RLS policies
-- ---------------------------------------------------------------------------

-- subject_stream_map
DROP POLICY IF EXISTS "subject_stream_map_service_role_full" ON public.subject_stream_map;
DROP POLICY IF EXISTS "subject_stream_map_public_read"       ON public.subject_stream_map;

-- state_language_mapping
DROP POLICY IF EXISTS "state_language_mapping_service_role_full" ON public.state_language_mapping;
DROP POLICY IF EXISTS "state_language_mapping_public_read"       ON public.state_language_mapping;

-- academic_languages
DROP POLICY IF EXISTS "academic_languages_service_role_full" ON public.academic_languages;
DROP POLICY IF EXISTS "academic_languages_public_read"       ON public.academic_languages;

-- academic_subjects
DROP POLICY IF EXISTS "academic_subjects_service_role_full" ON public.academic_subjects;
DROP POLICY IF EXISTS "academic_subjects_public_read"       ON public.academic_subjects;

-- academic_streams
DROP POLICY IF EXISTS "academic_streams_service_role_full" ON public.academic_streams;
DROP POLICY IF EXISTS "academic_streams_public_read"       ON public.academic_streams;

-- academic_boards
DROP POLICY IF EXISTS "academic_boards_service_role_full" ON public.academic_boards;
DROP POLICY IF EXISTS "academic_boards_public_read"       ON public.academic_boards;

-- curriculum_regions
DROP POLICY IF EXISTS "curriculum_regions_service_role_full" ON public.curriculum_regions;
DROP POLICY IF EXISTS "curriculum_regions_public_read"       ON public.curriculum_regions;

-- countries_master
DROP POLICY IF EXISTS "countries_master_service_role_full" ON public.countries_master;
DROP POLICY IF EXISTS "countries_master_public_read"       ON public.countries_master;

-- ---------------------------------------------------------------------------
-- STEP 4: Drop tables — reverse dependency order
-- Relationship/mapping tables before master tables.
-- ---------------------------------------------------------------------------

-- Mapping tables first (depend on masters)
DROP TABLE IF EXISTS public.subject_stream_map      CASCADE;
DROP TABLE IF EXISTS public.state_language_mapping  CASCADE;

-- Mid-level taxonomy (depend on board/country)
DROP TABLE IF EXISTS public.academic_streams  CASCADE;

-- Master taxonomy (depended on by streams/mappings)
DROP TABLE IF EXISTS public.academic_subjects   CASCADE;
DROP TABLE IF EXISTS public.academic_languages  CASCADE;
DROP TABLE IF EXISTS public.academic_boards     CASCADE;
DROP TABLE IF EXISTS public.curriculum_regions  CASCADE;
DROP TABLE IF EXISTS public.countries_master    CASCADE;

-- ---------------------------------------------------------------------------
-- STEP 5: Drop functions
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.fn_academic_taxonomy_hash()           CASCADE;
DROP FUNCTION IF EXISTS public.fn_prevent_physical_delete_taxonomy()  CASCADE;

-- NOTE: Do NOT drop public.set_updated_at() — it is shared across the
-- entire HireRise schema and predates Phase 1A.

COMMIT;

-- =============================================================================
-- END OF ROLLBACK: 20260526000001_phase1a_academic_taxonomy_infrastructure.rollback.sql
-- =============================================================================
