-- =============================================================================
-- Career Intelligence Data Model Migration Completion Program (CIDM)
-- Migration: 20260723000001_retire_career_paths.sql
-- Work Package: WP-CI-04 — Legacy Schema Retirement Implementation
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------------------------------------------------------
-- `public.career_paths` is the legacy career-transition table superseded by
-- `public.career_role_transitions` (the governed model, keyed on
-- career_roles.role_id text slugs) back in WP-CI-01/WP-CI-02.
--
-- WP-CI-03 (readiness audit) confirmed:
--   - Zero runtime reads of career_paths (CareerGraph / career-opportunity
--     engine both read career_role_transitions exclusively).
--   - Zero views, functions, triggers, RPCs, or materialized views in any
--     migration after the 000 baseline reference career_paths.
--   - Zero test references.
--   - The only repository dependency was the manual CLI importer
--     (src/data-import/excelImporter.js, `careerPaths` sheet), which wrote
--     from_role_id/to_role_id/years_to_next — columns that do not exist on
--     career_paths (whose real columns are from_role/to_role/avg_years/
--     demand_score/required_skills) — so that import path was already
--     non-functional against the live schema. It has been retired in
--     WP-CI-04 (see excelImporter.js) rather than repaired/retargeted,
--     since there is no repository-evidenced mapping from this importer's
--     UUID-keyed `roles` table to career_role_transitions' text-slug
--     `career_roles.role_id` keyspace.
--   - `pi_career_paths` (Platform Intelligence) and `role_transitions`
--     (CHI v2) are separate, unrelated tables and are NOT touched by this
--     migration.
--
-- PRODUCTION DATA — READ BEFORE APPLYING
--   Repository evidence (schema backups taken pre- and post-WP-DB-005) show
--   the table's definition unchanged over time, but static repository
--   inspection cannot determine current row count. Run the verification
--   queries in supabase/scripts/verify_career_paths_data.sql against the
--   live database BEFORE applying this migration. If any rows are present,
--   export them first (see that script for the recommended backup command).
--   Do not apply this migration to production until that check has been
--   run and, if needed, a backup has been taken.
--
-- WHAT THIS MIGRATION DOES
--   Drops `public.career_paths` (CASCADE also removes its constraints,
--   indexes, and RLS policy grants; there are no dependent views/functions/
--   triggers to worry about per the WP-CI-03 audit, so CASCADE is a safety
--   net here, not an indication of hidden dependents).
--
-- WHAT THIS MIGRATION DOES NOT DO
--   - Does not touch `pi_career_paths` or `role_transitions`.
--   - Does not touch `career_role_transitions` or `career_roles`.
--   - Does not alter any runtime API or response contract.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.career_paths;

COMMIT;
