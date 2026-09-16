-- =============================================================================
-- Validation: Phase 3B.6E.3 — Career Area Governed Vocabulary Implementation
-- Run after: 20260904010000_phase3b6e3_career_area_governed_vocabulary.sql
--
-- Ad hoc verification queries an operator can run post-deployment. The
-- migration itself already enforces the row-count assertion in-transaction
-- (Step 4 — POST-SEED ASSERTION block) — this file is for manual
-- spot-checks and the exact remote verification queries required by the
-- Phase 3B.6E.3 spec §20, not a required deployment step in itself.
--
-- Run these against the remote database (e.g. via `supabase db execute` or
-- the SQL editor) after `supabase db push` has applied the migration.
--
-- READ-ONLY: every statement below is a SELECT / inspection query. No
-- INSERT, UPDATE, DELETE, ALTER, CREATE, DROP, or TRUNCATE is included
-- anywhere in this file. Safe to run against production.
-- =============================================================================

-- 1. Full row detail: expect exactly 8 rows, one per approved canonical_key,
--    each with the matching approved display label.
SELECT
    canonical_key,
    name,
    normalized_name,
    status,
    soft_deleted,
    created_by_admin_id,
    updated_by_admin_id
FROM public.cms_career_domains
ORDER BY canonical_key;
-- Expected: 8 rows —
--   business             | Business             | business
--   creative_industries  | Creative Industries  | creative industries
--   education            | Education            | education
--   engineering          | Engineering          | engineering
--   health_sciences      | Health Sciences      | health sciences
--   natural_sciences     | Natural Sciences     | natural sciences
--   social_sciences      | Social Sciences      | social sciences
--   technology           | Technology           | technology
-- All rows: status = 'active', soft_deleted = false,
-- created_by_admin_id = updated_by_admin_id = 'system'.

-- 2. Row count.
SELECT COUNT(*) AS total_row_count
FROM public.cms_career_domains;
-- Expected: 8

-- 3. No duplicate canonical keys.
SELECT canonical_key, COUNT(*)
FROM public.cms_career_domains
GROUP BY canonical_key
HAVING COUNT(*) > 1;
-- Expected: 0 rows

-- 3a. [NEW] Deterministic PASS/FAIL summary — exact Career Area state.
--     Single-row assertion covering every condition in the Phase 3B.6E.3
--     required-improvement list: exact row count, exact key set (no
--     missing/no unexpected keys), no duplicates, no soft-deleted governed
--     rows, and the required status/soft_deleted/actor attributes on all
--     eight rows. Any FAIL sub-check also lists the offending
--     canonical_key(s) so a failure is diagnosable without re-running
--     ad hoc queries.
WITH expected_keys(canonical_key) AS (
  VALUES
    ('technology'), ('engineering'), ('natural_sciences'), ('business'),
    ('creative_industries'), ('social_sciences'), ('health_sciences'), ('education')
),
active_rows AS (
  SELECT *
  FROM public.cms_career_domains
  WHERE soft_deleted = false
),
missing_keys AS (
  SELECT e.canonical_key
  FROM expected_keys e
  LEFT JOIN active_rows a ON a.canonical_key = e.canonical_key
  WHERE a.canonical_key IS NULL
),
unexpected_keys AS (
  SELECT a.canonical_key
  FROM active_rows a
  LEFT JOIN expected_keys e ON e.canonical_key = a.canonical_key
  WHERE e.canonical_key IS NULL
),
duplicate_keys AS (
  SELECT canonical_key
  FROM public.cms_career_domains
  GROUP BY canonical_key
  HAVING COUNT(*) > 1
),
soft_deleted_governed AS (
  SELECT ccd.canonical_key
  FROM public.cms_career_domains ccd
  JOIN expected_keys e ON e.canonical_key = ccd.canonical_key
  WHERE ccd.soft_deleted = true
),
attribute_mismatches AS (
  SELECT a.canonical_key
  FROM active_rows a
  JOIN expected_keys e ON e.canonical_key = a.canonical_key
  WHERE a.status IS DISTINCT FROM 'active'
     OR a.soft_deleted IS DISTINCT FROM false
     OR a.created_by_admin_id IS DISTINCT FROM 'system'
     OR a.updated_by_admin_id IS DISTINCT FROM 'system'
)
SELECT
  (SELECT COUNT(*) FROM active_rows
    WHERE canonical_key IN (SELECT canonical_key FROM expected_keys)) AS approved_active_row_count,
  CASE WHEN (SELECT COUNT(*) FROM missing_keys) = 0 THEN 'PASS' ELSE 'FAIL' END AS no_missing_keys_check,
  (SELECT COALESCE(string_agg(canonical_key, ', ' ORDER BY canonical_key), '') FROM missing_keys) AS missing_keys,
  CASE WHEN (SELECT COUNT(*) FROM unexpected_keys) = 0 THEN 'PASS' ELSE 'FAIL' END AS no_unexpected_keys_check,
  (SELECT COALESCE(string_agg(canonical_key, ', ' ORDER BY canonical_key), '') FROM unexpected_keys) AS unexpected_keys,
  CASE WHEN (SELECT COUNT(*) FROM duplicate_keys) = 0 THEN 'PASS' ELSE 'FAIL' END AS no_duplicate_keys_check,
  (SELECT COALESCE(string_agg(canonical_key, ', ' ORDER BY canonical_key), '') FROM duplicate_keys) AS duplicate_keys,
  CASE WHEN (SELECT COUNT(*) FROM soft_deleted_governed) = 0 THEN 'PASS' ELSE 'FAIL' END AS no_soft_deleted_governed_check,
  (SELECT COALESCE(string_agg(canonical_key, ', ' ORDER BY canonical_key), '') FROM soft_deleted_governed) AS soft_deleted_governed_keys,
  CASE WHEN (SELECT COUNT(*) FROM attribute_mismatches) = 0 THEN 'PASS' ELSE 'FAIL' END AS status_soft_deleted_actor_check,
  (SELECT COALESCE(string_agg(canonical_key, ', ' ORDER BY canonical_key), '') FROM attribute_mismatches) AS attribute_mismatch_keys,
  CASE WHEN
        (SELECT COUNT(*) FROM active_rows WHERE canonical_key IN (SELECT canonical_key FROM expected_keys)) = 8
    AND (SELECT COUNT(*) FROM missing_keys) = 0
    AND (SELECT COUNT(*) FROM unexpected_keys) = 0
    AND (SELECT COUNT(*) FROM duplicate_keys) = 0
    AND (SELECT COUNT(*) FROM soft_deleted_governed) = 0
    AND (SELECT COUNT(*) FROM attribute_mismatches) = 0
  THEN 'PASS' ELSE 'FAIL' END AS overall_career_area_state_check;
-- Expected: overall_career_area_state_check = 'PASS'; approved_active_row_count = 8;
-- every *_check column = 'PASS'; every detail column empty ('').
-- A FAIL in any single sub-check flips overall_career_area_state_check to
-- 'FAIL' and names the offending canonical_key(s) in the adjacent column.

-- 3b. [NEW] Canonical key / display name / normalized_name reconciliation.
--     Verifies the exact approved mapping in the Phase 3B.6E.3 spec table.
--     Returns 0 rows when every row matches exactly. Returns one row per
--     mismatch: a MISSING_ROW (approved key not found), NAME_MISMATCH,
--     NORMALIZED_NAME_MISMATCH, or an UNEXPECTED_CANONICAL_KEY (a row in
--     the table whose canonical_key is not one of the 8 approved keys).
WITH expected(canonical_key, name, normalized_name) AS (
  VALUES
    ('technology',          'Technology',          'technology'),
    ('engineering',         'Engineering',          'engineering'),
    ('natural_sciences',    'Natural Sciences',     'natural sciences'),
    ('business',            'Business',             'business'),
    ('creative_industries', 'Creative Industries',  'creative industries'),
    ('social_sciences',     'Social Sciences',      'social sciences'),
    ('health_sciences',     'Health Sciences',      'health sciences'),
    ('education',           'Education',            'education')
)
SELECT
  e.canonical_key   AS expected_canonical_key,
  e.name            AS expected_name,
  e.normalized_name AS expected_normalized_name,
  a.canonical_key   AS actual_canonical_key,
  a.name            AS actual_name,
  a.normalized_name AS actual_normalized_name,
  CASE
    WHEN a.canonical_key IS NULL THEN 'MISSING_ROW'
    WHEN a.name IS DISTINCT FROM e.name THEN 'NAME_MISMATCH'
    WHEN a.normalized_name IS DISTINCT FROM e.normalized_name THEN 'NORMALIZED_NAME_MISMATCH'
    ELSE 'OK'
  END AS mismatch_reason
FROM expected e
LEFT JOIN public.cms_career_domains a
  ON a.canonical_key = e.canonical_key
WHERE a.canonical_key IS NULL
   OR a.name IS DISTINCT FROM e.name
   OR a.normalized_name IS DISTINCT FROM e.normalized_name

UNION ALL

SELECT
  NULL, NULL, NULL,
  a.canonical_key, a.name, a.normalized_name,
  'UNEXPECTED_CANONICAL_KEY'
FROM public.cms_career_domains a
LEFT JOIN expected e ON e.canonical_key = a.canonical_key
WHERE e.canonical_key IS NULL;
-- Expected: 0 rows.

-- 4. canonical_key is NOT NULL and uniquely constrained (schema check).
SELECT
    a.attname AS column_name,
    a.attnotnull AS not_null,
    EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = 'public.cms_career_domains'::regclass
        AND c.contype = 'u'
        AND a.attnum = ANY (c.conkey)
    ) AS has_unique_constraint
FROM pg_attribute a
WHERE a.attrelid = 'public.cms_career_domains'::regclass
  AND a.attname = 'canonical_key'
  AND a.attnum > 0
  AND NOT a.attisdropped;
-- Expected: not_null = true, has_unique_constraint = true

-- 5. Existing normalized_name constraints are untouched (still present,
--    not duplicated).
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'public.cms_career_domains'::regclass
  AND conname IN (
    'cms_career_domains_normalized_name_key',
    'cms_career_domains_pkey',
    'cms_career_domains_canonical_key_key',
    'chk_cms_career_domains_canonical_key_allowlist'
  )
ORDER BY conname;
SELECT indexname
FROM pg_indexes
WHERE tablename = 'cms_career_domains'
  AND indexname = 'idx_domains_normalized_name';
-- Expected: cms_career_domains_normalized_name_key (u), cms_career_domains_pkey (p),
-- cms_career_domains_canonical_key_key (u), chk_cms_career_domains_canonical_key_allowlist (c)
-- all present exactly once; idx_domains_normalized_name still present.

-- 5a. [NEW] Explicit, deterministic schema/governance-object verification.
--     One PASS/FAIL row per object named in the Phase 3B.6E.3 spec, each
--     proven directly from PostgreSQL catalog metadata (information_schema /
--     pg_catalog) rather than inferred from query 5's raw listing.
SELECT 'canonical_key column exists' AS check_name,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cms_career_domains'
      AND column_name = 'canonical_key'
  ) THEN 'PASS' ELSE 'FAIL' END AS result
UNION ALL
SELECT 'canonical_key is NOT NULL',
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.cms_career_domains'::regclass
      AND attname = 'canonical_key'
      AND attnotnull = true
      AND NOT attisdropped
  ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'cms_career_domains_canonical_key_key UNIQUE constraint present',
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cms_career_domains'::regclass
      AND conname = 'cms_career_domains_canonical_key_key'
      AND contype = 'u'
  ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'chk_cms_career_domains_canonical_key_allowlist CHECK constraint present',
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cms_career_domains'::regclass
      AND conname = 'chk_cms_career_domains_canonical_key_allowlist'
      AND contype = 'c'
  ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'cms_career_domains_normalized_name_key UNIQUE constraint present',
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cms_career_domains'::regclass
      AND conname = 'cms_career_domains_normalized_name_key'
      AND contype = 'u'
  ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'cms_career_domains_pkey PRIMARY KEY present',
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cms_career_domains'::regclass
      AND conname = 'cms_career_domains_pkey'
      AND contype = 'p'
  ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'idx_domains_normalized_name index present',
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'cms_career_domains'
      AND indexname = 'idx_domains_normalized_name'
  ) THEN 'PASS' ELSE 'FAIL' END;
-- Expected: result = 'PASS' for every row.

-- 5b. [NEW] Allowlist CHECK constraint content — proves the constraint body
--     itself contains exactly the 8 approved canonical keys (no more, no
--     fewer), read directly from pg_get_constraintdef rather than assumed.
WITH constraint_def AS (
  SELECT pg_get_constraintdef(oid) AS def
  FROM pg_constraint
  WHERE conrelid = 'public.cms_career_domains'::regclass
    AND conname = 'chk_cms_career_domains_canonical_key_allowlist'
    AND contype = 'c'
),
extracted_keys AS (
  SELECT (regexp_matches(def, '''([a-z_]+)''', 'g'))[1] AS canonical_key
  FROM constraint_def
),
expected_keys(canonical_key) AS (
  VALUES
    ('technology'), ('engineering'), ('natural_sciences'), ('business'),
    ('creative_industries'), ('social_sciences'), ('health_sciences'), ('education')
)
SELECT
  (SELECT COUNT(*) FROM constraint_def) AS constraint_found,
  (SELECT COUNT(*) FROM extracted_keys) AS keys_found_in_constraint,
  CASE
    WHEN (SELECT COUNT(*) FROM constraint_def) = 0 THEN 'FAIL_CONSTRAINT_NOT_FOUND'
    WHEN (SELECT array_agg(canonical_key ORDER BY canonical_key) FROM extracted_keys)
       = (SELECT array_agg(canonical_key ORDER BY canonical_key) FROM expected_keys)
      THEN 'PASS'
    ELSE 'FAIL_KEY_SET_MISMATCH'
  END AS allowlist_content_check;
-- Expected: constraint_found = 1, keys_found_in_constraint = 8,
-- allowlist_content_check = 'PASS'.

-- 6. Ontology reconciliation: every active signal→career-area ontology edge
--    target_key must resolve to an approved canonical_key. (Explicit
--    reconciliation query, per §14 — no FK introduced.)
SELECT DISTINCT soe.target_key
FROM public.signal_ontology_edges soe
WHERE soe.target_type = 'career_area'
  AND soe.deprecated_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.cms_career_domains ccd
    WHERE ccd.canonical_key = soe.target_key
      AND ccd.soft_deleted = false
  );
-- Expected: 0 rows (every active ontology career-area target already
-- resolves to a seeded canonical_key).

-- 7. Sanity count of active career-area ontology edges (informational —
--    documents current state, does not assert an exact count since future
--    phases may add more edges against the same 8 canonical keys).
SELECT COUNT(*) AS active_career_area_edge_count
FROM public.signal_ontology_edges
WHERE target_type = 'career_area'
  AND deprecated_at IS NULL;
-- Expected at time of this migration: 34 (per Phase 3B.6E.3 spec §14).
-- This count is informational only and is NOT asserted as a permanent
-- invariant — future phases may add further edges against the same 8
-- canonical keys.
-- =============================================================================