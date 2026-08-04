# Retired data artifacts

## career-paths.csv

Orphaned seed data for the legacy `career_paths` table (dropped in
WP-CI-04, migration `20260723000001_retire_career_paths.sql`). No code
in this repository ever read this file — `excelImporter.js` only reads
`.xlsx` workbooks via ExcelJS, never CSV — so it had no active
consumer even before retirement.

Kept here (rather than deleted outright) purely as a historical
reference for the shape of the old `from_role,to_role,years_to_next,
role_family` seed data, in case it's ever useful when reviewing what
the legacy model looked like. It is not used by, and should not be
wired into, any current import path. Career transition data is now
owned by `career_role_transitions` / `career_roles`.
