-- =============================================================================
-- HireRise · Phase 2A.1 · Sprint 1A Recovery
-- Migration : H1.1 — signal_category_hierarchy Initial Seed
-- File      : migration_H1_01_signal_category_hierarchy_seed.sql
-- Author    : Principal Database Architect
-- Date      : 2026-06-07
-- =============================================================================
--
-- Purpose:
--   Seeds the initial v1 taxonomy hierarchy into signal_category_hierarchy.
--   Establishes 1 domain root node ('signals') and 7 category nodes derived
--   from verified intelligence_signal_registry distribution.
--
-- Dependencies (must be deployed before this migration):
--   migration_1A_01_enums.sql          — signal_category_hierarchy_level_enum
--   migration_1A_02_core_tables.sql    — signal_category_hierarchy table + constraints
--   G4D functions                      — consumers of this seed data
--
-- Verified pre-conditions:
--   signal_category_hierarchy          — 0 rows (empty, confirmed)
--   UNIQUE (category_key, taxonomy_version) — confirmed present
--   'v1'::public.taxonomy_version_enum — confirmed valid
--   signal_category_hierarchy_level_enum — contains domain, category, subcategory
--   relrowsecurity                     — false (RLS disabled, no policy required)
--
-- Design decisions:
--   Root node key : 'signals' (neutral structural anchor — not a registry domain)
--   Domain level  : NOT modeled as hierarchy parents. Registry primary_domain
--                   values (academic, activity, cognitive, cross_domain) exhibit
--                   many-to-many category membership incompatible with the
--                   single parent_category_key tree model. Domain structure
--                   is deferred to H2 pending schema extension or ontology input.
--   Subcategories : NOT seeded. No registry evidence for subcategory distinctions.
--                   Deferred to H2 pending domain team input.
--   description   : NULL for all rows. Content requires product/domain team input.
--
-- Idempotency:
--   ON CONFLICT (category_key, taxonomy_version) DO NOTHING
--   Safe to re-run. Existing rows are not modified.
--
-- Rollback:
--   See migration_H1_01_signal_category_hierarchy_seed_ROLLBACK.sql
--
-- Post-deployment:
--   Run validation package migration_H1_01_VALIDATION.sql
-- =============================================================================

BEGIN;

-- ── PREAMBLE: Pre-insert assertion block ─────────────────────────────────────
-- Validates runtime pre-conditions before any INSERT executes.
-- Any failure raises EXCEPTION and rolls back the transaction.

DO $$
DECLARE
    v_count         integer;
BEGIN
    -- Assert: signal_category_hierarchy table exists
    SELECT COUNT(*) INTO v_count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'signal_category_hierarchy';
    IF v_count = 0 THEN
        RAISE EXCEPTION 'H1.1 PREAMBLE FAILED: signal_category_hierarchy table not found. '
            'migration_1A_02_core_tables.sql must be deployed before H1.1.';
    END IF;

    -- Assert: required columns present (10-column schema per DB-06)
    SELECT COUNT(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'signal_category_hierarchy'
      AND column_name  IN (
          'id', 'category_key', 'display_name', 'level',
          'parent_category_key', 'description', 'taxonomy_version',
          'is_active', 'created_at', 'updated_at'
      );
    IF v_count < 10 THEN
        RAISE EXCEPTION 'H1.1 PREAMBLE FAILED: signal_category_hierarchy is missing one or '
            'more required columns. Expected 10, found %. '
            'Verify migration_1A_02_core_tables.sql deployment.', v_count;
    END IF;

    -- Assert: UNIQUE constraint on (category_key, taxonomy_version) exists
    SELECT COUNT(*) INTO v_count
    FROM pg_constraint
    WHERE conrelid  = 'public.signal_category_hierarchy'::regclass
      AND contype   = 'u'
      AND conkey    = ARRAY(
          SELECT a.attnum
          FROM pg_attribute a
          WHERE a.attrelid = 'public.signal_category_hierarchy'::regclass
            AND a.attname  IN ('category_key', 'taxonomy_version')
          ORDER BY a.attnum
      );
    -- Note: if constraint column order differs from attnum order, fall back to
    -- name-based check
    IF v_count = 0 THEN
        SELECT COUNT(*) INTO v_count
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
                WHERE n.nspname  = 'public'
          AND cl.relname = 'signal_category_hierarchy'
          AND c.contype  = 'u'
          AND (
              pg_get_constraintdef(c.oid) LIKE '%category_key%taxonomy_version%'
              OR
              pg_get_constraintdef(c.oid) LIKE '%taxonomy_version%category_key%'
          );

        IF v_count = 0 THEN
            RAISE EXCEPTION 'H1.1 PREAMBLE FAILED: UNIQUE constraint on '
                '(category_key, taxonomy_version) not found. '
                'ON CONFLICT clause requires this constraint. '
                'Verify migration_1A_02_core_tables.sql deployment.';
        END IF;
    END IF;

    -- Assert: 'domain' is a valid enum value
    BEGIN
        PERFORM 'domain'::signal_category_hierarchy_level_enum;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'H1.1 PREAMBLE FAILED: ''domain'' is not a valid value of '
            'signal_category_hierarchy_level_enum.';
    END;

    -- Assert: 'category' is a valid enum value
    BEGIN
        PERFORM 'category'::signal_category_hierarchy_level_enum;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'H1.1 PREAMBLE FAILED: ''category'' is not a valid value of '
            'signal_category_hierarchy_level_enum.';
    END;

    -- Assert: 'v1' is a valid taxonomy_version_enum value
    BEGIN
        PERFORM 'v1'::public.taxonomy_version_enum;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'H1.1 PREAMBLE FAILED: ''v1'' is not a valid value of '
            'public.taxonomy_version_enum. '
            'Enum must be extended before H1.1 can be deployed.';
    END;

    RAISE NOTICE 'H1.1 PREAMBLE PASSED: all pre-conditions satisfied.';
END;
$$;


-- ── INSERT: Domain root node ──────────────────────────────────────────────────

INSERT INTO public.signal_category_hierarchy (
    id,
    category_key,
    display_name,
    level,
    parent_category_key,
    description,
    taxonomy_version,
    is_active,
    created_at,
    updated_at
)
VALUES (
    gen_random_uuid(),
    'signals',
    'Signals',
    'domain'::signal_category_hierarchy_level_enum,
    NULL,
    NULL,
    'v1',
    true,
    now(),
    now()
)
ON CONFLICT (category_key, taxonomy_version) DO NOTHING;


-- ── INSERT: Category nodes (parent = 'signals') ───────────────────────────────

INSERT INTO public.signal_category_hierarchy (
    id,
    category_key,
    display_name,
    level,
    parent_category_key,
    description,
    taxonomy_version,
    is_active,
    created_at,
    updated_at
)
VALUES
    (
        gen_random_uuid(),
        'reasoning',
        'Reasoning',
        'category'::signal_category_hierarchy_level_enum,
        'signals',
        NULL,
        'v1',
        true,
        now(),
        now()
    ),
    (
        gen_random_uuid(),
        'creative',
        'Creative',
        'category'::signal_category_hierarchy_level_enum,
        'signals',
        NULL,
        'v1',
        true,
        now(),
        now()
    ),
    (
        gen_random_uuid(),
        'social',
        'Social',
        'category'::signal_category_hierarchy_level_enum,
        'signals',
        NULL,
        'v1',
        true,
        now(),
        now()
    ),
    (
        gen_random_uuid(),
        'technical',
        'Technical',
        'category'::signal_category_hierarchy_level_enum,
        'signals',
        NULL,
        'v1',
        true,
        now(),
        now()
    ),
    (
        gen_random_uuid(),
        'cognitive_style',
        'Cognitive Style',
        'category'::signal_category_hierarchy_level_enum,
        'signals',
        NULL,
        'v1',
        true,
        now(),
        now()
    ),
    (
        gen_random_uuid(),
        'subject_affinity',
        'Subject Affinity',
        'category'::signal_category_hierarchy_level_enum,
        'signals',
        NULL,
        'v1',
        true,
        now(),
        now()
    ),
    (
        gen_random_uuid(),
        'behavioral',
        'Behavioral',
        'category'::signal_category_hierarchy_level_enum,
        'signals',
        NULL,
        'v1',
        true,
        now(),
        now()
    )
ON CONFLICT (category_key, taxonomy_version) DO NOTHING;


-- ── POST-INSERT ASSERTIONS: Validate within transaction before COMMIT ─────────

DO $$
DECLARE
    v_total_count       integer;
    v_active_count      integer;
    v_domain_count      integer;
    v_category_count    integer;
    v_root_exists       integer;
    v_missing_keys      text[];
    v_valt2_exists      boolean;
    v_expected_keys     text[] := ARRAY[
        'reasoning', 'creative', 'social', 'technical',
        'cognitive_style', 'subject_affinity', 'behavioral'
    ];
    v_key               text;
    v_key_count         integer;
BEGIN
    -- VAL-H1-01: Total row count for v1
    SELECT COUNT(*) INTO v_total_count
    FROM public.signal_category_hierarchy
    WHERE taxonomy_version = 'v1';

    IF v_total_count <> 8 THEN
        RAISE EXCEPTION 'H1.1 POST-ASSERTION FAILED [VAL-H1-01]: '
            'Expected exactly 8 rows for taxonomy_version=v1, found %.'
            'One or more INSERTs were silently skipped — '
            'check for pre-existing conflicting rows.', v_total_count;
    END IF;

    -- VAL-H1-02: All v1 rows are active
    SELECT COUNT(*) INTO v_active_count
    FROM public.signal_category_hierarchy
    WHERE taxonomy_version = 'v1'
      AND is_active = true;

    IF v_active_count <> 8 THEN
        RAISE EXCEPTION 'H1.1 POST-ASSERTION FAILED [VAL-H1-02]: '
            'Expected exactly 8 active rows (is_active = true) for taxonomy_version=v1, found %.', 
            v_active_count;
    END IF;

    -- VAL-H1-03: Root domain node exists
    SELECT COUNT(*) INTO v_root_exists
    FROM public.signal_category_hierarchy
    WHERE category_key          = 'signals'
      AND taxonomy_version      = 'v1'
      AND level::text           = 'domain'
      AND parent_category_key   IS NULL
      AND is_active             = true;

    IF v_root_exists <> 1 THEN
        RAISE EXCEPTION 'H1.1 POST-ASSERTION FAILED [VAL-H1-03]: '
            'Root domain node (category_key=''signals'', level=''domain'', '
            'parent_category_key IS NULL) not found or duplicated. '
            'Found % matching rows.', v_root_exists;
    END IF;

    -- VAL-H1-04: Exactly 7 category nodes parented to 'signals'
    SELECT COUNT(*) INTO v_category_count
    FROM public.signal_category_hierarchy
    WHERE taxonomy_version      = 'v1'
      AND level::text           = 'category'
      AND parent_category_key   = 'signals'
      AND is_active             = true;

    IF v_category_count <> 7 THEN
        RAISE EXCEPTION 'H1.1 POST-ASSERTION FAILED [VAL-H1-04]: '
            'Expected exactly 7 category nodes with parent_category_key=''signals'', '
            'found %.', v_category_count;
    END IF;

    -- VAL-H1-05: All 7 expected category keys present
    FOREACH v_key IN ARRAY v_expected_keys
    LOOP
        SELECT COUNT(*) INTO v_key_count
        FROM public.signal_category_hierarchy
        WHERE category_key     = v_key
          AND taxonomy_version = 'v1'
          AND is_active        = true;

        IF v_key_count = 0 THEN
            v_missing_keys := array_append(v_missing_keys, v_key);
        END IF;
    END LOOP;

    IF v_missing_keys IS NOT NULL AND array_length(v_missing_keys, 1) > 0 THEN
        RAISE EXCEPTION 'H1.1 POST-ASSERTION FAILED [VAL-H1-05]: '
            'Missing expected category keys: %. '
            'All 7 registry-derived categories must be present.', 
            array_to_string(v_missing_keys, ', ');
    END IF;

    -- VAL-H1-06: VAL-T2 gate query — mirrors exact fn_validate_signal_keys check
    SELECT EXISTS (
    SELECT 1
    FROM public.signal_category_hierarchy
    WHERE taxonomy_version = 'v1'
      AND is_active = true
)
INTO v_valt2_exists;

    IF NOT v_valt2_exists THEN
        RAISE EXCEPTION 'H1.1 POST-ASSERTION FAILED [VAL-H1-06]: '
            'VAL-T2 gate query returned no rows. '
            'fn_validate_signal_keys will still return INVALID_TAXONOMY_VERSION.';
    END IF;

    RAISE NOTICE 'H1.1 POST-ASSERTIONS PASSED: % total rows, % active, '
        'root node confirmed, all 7 category keys present, VAL-T2 gate cleared.',
        v_total_count, v_active_count;
END;
$$;


COMMIT;

-- =============================================================================
-- End of migration_H1_01_signal_category_hierarchy_seed.sql
-- =============================================================================