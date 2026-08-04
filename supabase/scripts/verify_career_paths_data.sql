-- =============================================================================
-- WP-CI-04 — Production Data Verification for public.career_paths
-- =============================================================================
-- Run this against the LIVE database BEFORE applying
-- 20260723000001_retire_career_paths.sql. Repository/static-file
-- inspection cannot determine current row count — this must be run live.
--
-- Step 1 — row count
-- -----------------------------------------------------------------------------
SELECT COUNT(*) AS total_rows
FROM public.career_paths;

-- Step 2 — sample rows (skip if total_rows = 0)
-- -----------------------------------------------------------------------------
SELECT id, from_role, to_role, avg_years, demand_score, created_at, required_skills
FROM public.career_paths
ORDER BY created_at DESC NULLS LAST
LIMIT 20;

-- Step 3 — IF total_rows > 0: export before dropping
-- -----------------------------------------------------------------------------
-- Option A — CSV export via psql \copy (run from psql, not as a plain query):
--   \copy (SELECT * FROM public.career_paths) TO 'career_paths_backup.csv' WITH (FORMAT csv, HEADER true)
--
-- Option B — table-scoped pg_dump (run from a shell, not psql):
--   pg_dump "$DATABASE_URL" --table=public.career_paths --data-only \
--     --format=custom --file=career_paths_backup.dump
--
-- Either export should be stored somewhere durable (e.g. the same location
-- used for other schema backups in this repo, core/backups/) before the
-- forward migration is applied. If Step 1 returns 0, no export is required
-- and the forward migration can proceed directly.
-- =============================================================================
