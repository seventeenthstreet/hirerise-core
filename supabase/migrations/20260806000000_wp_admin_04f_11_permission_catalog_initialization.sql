-- =============================================================================
-- HireRise · Enterprise Permission Management
-- Migration : WP-ADMIN-04F-11 — Enterprise Permission Catalog Initialization
-- File      : 20260806000000_wp_admin_04f_11_permission_catalog_initialization.sql
-- Date      : 2026-08-06
-- =============================================================================
--
-- Purpose:
--   Seeds the Initial Enterprise Permission Catalog into public.permissions
--   (WP-ADMIN-04F-02), exactly as approved by the WP-ADMIN-04F Repository
--   Audit and Permission Catalog Scope Verification:
--     administration:view, administration:create, administration:delete.
--
--   This migration performs catalog initialization ONLY. It does not
--   modify the permissions table's schema, the Registry, Governance,
--   Evaluation, Assignment, Middleware, APIs, UI, or RolePermissionResolver.
--
-- Dependencies (must be deployed before this migration):
--   20260804120000_wp_admin_04f_02_permission_repository_schema.sql
--     — public.permissions table + UNIQUE(name) constraint
--
-- Catalog provenance (historical, not a live sync target):
--   The three rows below were generated from
--   src/domain/permission/permission.catalog.js (INITIAL_PERMISSION_CATALOG)
--   at authoring time, via the certified domain factory createPermission()
--   (src/domain/permission/permission.model.js) and the certified
--   vocabulary (src/domain/permission/permission.constants.js). That
--   provenance is recorded here for traceability only.
--
--   IMMUTABLE HISTORICAL ARTIFACT: once deployed, this migration is a
--   permanent record of the Enterprise Permission Catalog as approved
--   under WP-ADMIN-04F-11 and must not be edited — not even to keep it
--   "in sync" with a permission.catalog.js that has since changed. Like
--   every other applied migration in this repository, its job is to
--   reproduce a specific historical state, not to track a moving target.
--   permission.catalog.js is free to evolve after this point (new
--   Permissions, renamed categories, etc.) without this file changing.
--
--   Any future evolution of the Permission Catalog — adding, retiring,
--   or recategorizing a Permission — must be introduced through a NEW
--   forward migration (with its own rollback), never by modifying the
--   INSERT statement below.
--
-- Idempotency:
--   ON CONFLICT (name) DO NOTHING — safe to re-run, including after
--   `supabase db reset`. Existing rows (and any operator-modified
--   category/status/description) are never overwritten by this migration.
--
-- Rollback:
--   supabase/rollback/20260806000000_wp_admin_04f_11_permission_catalog_initialization_rollback.sql
--
-- Post-deployment:
--   supabase/validation/wp_admin_04f_11_permission_catalog_validation.sql
-- =============================================================================

BEGIN;

-- ── PREAMBLE: Pre-insert assertion block ────────────────────────────────────
-- Confirms the schema this migration depends on (WP-ADMIN-04F-02's
-- public.permissions table) is actually present and shaped as expected,
-- before any INSERT runs. Any RAISE EXCEPTION here aborts the whole
-- migration transaction (see BEGIN above) — nothing is partially applied.

DO $$
DECLARE
    v_count integer;
BEGIN
    -- Assert: public.permissions table exists
    SELECT COUNT(*) INTO v_count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'permissions';
    IF v_count = 0 THEN
        RAISE EXCEPTION 'WP-ADMIN-04F-11 PREAMBLE FAILED: public.permissions table not found. '
            '20260804120000_wp_admin_04f_02_permission_repository_schema.sql must be deployed first.';
    END IF;

    -- Assert: required columns present
    SELECT COUNT(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'permissions'
      AND column_name  IN ('id', 'name', 'resource', 'action', 'category', 'status', 'created_at', 'updated_at');
    IF v_count < 8 THEN
        RAISE EXCEPTION 'WP-ADMIN-04F-11 PREAMBLE FAILED: public.permissions is missing one or '
            'more required columns. Expected 8, found %.', v_count;
    END IF;

    -- Assert: a UNIQUE constraint covering (name) exists on public.permissions.
    -- This is the conflict target the INSERT below relies on: without it,
    -- `ON CONFLICT (name) DO NOTHING` has nothing to match against and
    -- Postgres will reject the statement outright (re-running this
    -- migration would fail loudly, not silently insert duplicates) — but
    -- checking for it here surfaces that as a clear, actionable error at
    -- the PREAMBLE stage rather than an opaque Postgres error mid-INSERT.
    SELECT COUNT(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname  = 'public'
      AND cl.relname = 'permissions'
      AND c.contype  = 'u'
      AND pg_get_constraintdef(c.oid) LIKE '%(name)%';
    IF v_count = 0 THEN
        RAISE EXCEPTION 'WP-ADMIN-04F-11 PREAMBLE FAILED: UNIQUE constraint on permissions(name) '
            'not found. ON CONFLICT (name) requires this constraint.';
    END IF;

    RAISE NOTICE 'WP-ADMIN-04F-11 PREAMBLE PASSED: all pre-conditions satisfied.';
END;
$$;

-- ── INSERT: Initial Enterprise Permission Catalog ───────────────────────────
-- The 3 rows approved under WP-ADMIN-04F-11 (see "Catalog provenance"
-- above). `ON CONFLICT (name) DO NOTHING` makes this safe to re-run —
-- including after `supabase db reset` — without ever duplicating or
-- overwriting a row that's already there.

INSERT INTO "public"."permissions" (
    "id",
    "name",
    "resource",
    "action",
    "category",
    "status",
    "description",
    "created_at",
    "updated_at"
)
VALUES
    (gen_random_uuid(), 'administration:view',   'administration', 'view',   'administration', 'published', NULL, now(), now()),
    (gen_random_uuid(), 'administration:create', 'administration', 'create', 'administration', 'published', NULL, now(), now()),
    (gen_random_uuid(), 'administration:delete', 'administration', 'delete', 'administration', 'published', NULL, now(), now())
ON CONFLICT (name) DO NOTHING;

-- ── POST-INSERT ASSERTIONS: Validate within transaction before COMMIT ──────
-- Confirms the INSERT actually produced the intended end state before the
-- transaction commits. This guards against the ON CONFLICT no-op masking
-- a problem — e.g. a same-named row already present with a *different*
-- resource/category/status than this catalog expects, which
-- `DO NOTHING` would otherwise leave in place unnoticed.

DO $$
DECLARE
    v_catalog_count  integer;
    v_missing_names  text[];
    v_name           text;
    v_expected_names text[] := ARRAY['administration:view', 'administration:create', 'administration:delete'];
BEGIN
    -- VAL-04F11-01: all 3 expected identities exist and match the
    -- catalog's intended shape (resource, category, status) — not just
    -- that a row with that name exists.
    SELECT COUNT(*) INTO v_catalog_count
    FROM public.permissions
    WHERE name IN (SELECT unnest(v_expected_names))
      AND resource = 'administration'
      AND category = 'administration'
      AND status   = 'published';

    IF v_catalog_count <> 3 THEN
        RAISE EXCEPTION 'WP-ADMIN-04F-11 POST-ASSERTION FAILED [VAL-04F11-01]: '
            'Expected exactly 3 rows matching the Initial Permission Catalog '
            '(resource=administration, category=administration, status=published), found %.',
            v_catalog_count;
    END IF;

    -- VAL-04F11-02: no expected identity is missing or accidentally
    -- duplicated — each name maps to exactly one row.
    FOREACH v_name IN ARRAY v_expected_names
    LOOP
        SELECT COUNT(*) INTO v_catalog_count
        FROM public.permissions
        WHERE name = v_name;

        IF v_catalog_count <> 1 THEN
            v_missing_names := array_append(v_missing_names, v_name || ' (found ' || v_catalog_count || ')');
        END IF;
    END LOOP;

    IF v_missing_names IS NOT NULL AND array_length(v_missing_names, 1) > 0 THEN
        RAISE EXCEPTION 'WP-ADMIN-04F-11 POST-ASSERTION FAILED [VAL-04F11-02]: '
            'Identity count mismatch for: %.', array_to_string(v_missing_names, ', ');
    END IF;

    RAISE NOTICE 'WP-ADMIN-04F-11 POST-ASSERTIONS PASSED: all 3 catalog Permissions present, published, correctly categorized.';
END;
$$;

COMMIT;

-- =============================================================================
-- End of 20260806000000_wp_admin_04f_11_permission_catalog_initialization.sql
-- =============================================================================
