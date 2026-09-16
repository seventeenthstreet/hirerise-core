-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260904010000_phase3b6e3_career_area_governed_vocabulary.sql
-- Phase 3B.6E.3 — Career Area Governed Vocabulary Implementation
-- (Family #1 Student-Native Intelligence Layer)
--
-- Implements the product decision closed across Phase 3B.6D → 3B.6D.5 and the
-- pre-flight closed across Phase 3B.6E.1 → 3B.6E.2A:
--
--   public.cms_career_domains becomes the governed Career Area vocabulary
--   owner, carrying a new, stable, governance-restricted `canonical_key`
--   machine identity alongside the existing `name` (display identity) and
--   `normalized_name` (existing search/uniqueness helper — semantics
--   UNCHANGED by this migration).
--
-- APPROVED VOCABULARY (closed, exactly 8 — do not add/remove/rename here):
--   technology, engineering, natural_sciences, business,
--   creative_industries, social_sciences, health_sciences, education
--
-- PRE-FLIGHT CONFIRMED REMOTE STATE (Phase 3B.6E.2A):
--   public.cms_career_domains had 0 rows. No existing-row migration,
--   rename, merge, or reconciliation is required. This migration is
--   additive only.
--
-- SEED ATTRIBUTION CONVENTION:
--   created_by_admin_id / updated_by_admin_id are `text NOT NULL` with no
--   FK constraint (verified against 000_initial_schema.sql). The repository
--   has an existing, documented, project-wide convention for exactly this
--   situation — a text-typed actor/audit column populated by a migration
--   rather than a human admin: the literal value 'system'. This is used as
--   a DEFAULT across multiple existing tables (e.g.
--   20260706000001_wp_p2_01_sim_enterprise_foundation.sql:
--   created_by/updated_by/actor_id DEFAULT 'system') and is explicitly
--   documented in 20260531000002_migration_1a_02_core_tables.sql
--   (signal_registry_audit_log.performed_by comment: "Identity of
--   responsible actor. Service account, admin user ID, or 'system'.").
--   'system' represents migration/governance ownership, is stable, does
--   not depend on any particular administrator remaining active, and is
--   used consistently for both created_by_admin_id and updated_by_admin_id
--   on the eight seeded rows below. No human Admin ID is hard-coded.
--
-- GOVERNANCE MODEL (I-C — Governance-Restricted Key):
--   canonical_key is fixed by this migration. Ordinary Admin CRUD
--   (adminCmsCareerDomains.module.js) does not read or accept a
--   canonical_key field from request payloads, and is hardened in the same
--   phase (application layer) to explicitly reject any attempt to supply
--   one, per Section 4 of the Phase 3B.6E.3 spec. No new database trigger
--   is introduced — application-layer write protection plus this CHECK
--   constraint is the approved, narrower mechanism.
--
-- SAFETY GUARD:
--   Because this migration cannot re-verify the live remote state at the
--   moment it is written (see accompanying implementation report), a
--   runtime guard (Step 0 below) re-checks the assumption that no
--   unexpected pre-existing Career Area data exists before altering
--   anything. If the table is no longer empty and contains rows outside
--   the approved 8-domain vocabulary, the migration raises an exception
--   and the whole transaction rolls back rather than silently proceeding
--   — satisfying the Phase 3B.6E.3 STOP CONDITION for "remote state has
--   changed since pre-flight" at apply time, not just at authoring time.
--
-- WHAT THIS MIGRATION DOES NOT DO:
--   - does not change normalized_name semantics or its normalization
--     convention;
--   - does not remove or duplicate the existing normalized_name unique
--     constraint / partial unique index;
--   - does not rewrite, reweight, or otherwise touch the 34 existing
--     signal_ontology_edges rows (target_type = 'career_area') — their
--     target_key values already match the 8 canonical keys exactly
--     (verified by inspection; also verified by the regression test suite
--     added alongside this migration);
--   - does not touch intelligence_recommendations, Aspiration, RLS
--     policies, or any legacy career system.
--
-- IDEMPOTENCY:
--   Column/constraint changes use IF NOT EXISTS / DROP ... IF EXISTS so
--   the DDL is safe to re-run. The seed INSERT uses
--   ON CONFLICT (normalized_name) DO UPDATE ... WHERE canonical_key IS NULL
--   so re-running this file after a partial success only ever backfills a
--   NULL canonical_key — it never overwrites an admin-edited name/
--   description, and never re-assigns a canonical_key that is already set.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Step 0: Safety guard — re-verify the empty/expected-only assumption ────
-- Only meaningful on first run (before canonical_key exists). Once
-- canonical_key exists, later steps are themselves idempotent/self-guarding.
DO $$
DECLARE
  v_existing_count   integer;
  v_unexpected_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'cms_career_domains'
      AND column_name  = 'canonical_key'
  ) THEN
    SELECT count(*) INTO v_existing_count
    FROM public.cms_career_domains;

    IF v_existing_count > 0 THEN
      SELECT count(*) INTO v_unexpected_count
      FROM public.cms_career_domains
      WHERE normalized_name NOT IN (
        'technology', 'engineering', 'natural sciences', 'business',
        'creative industries', 'social sciences', 'health sciences', 'education'
      );

      IF v_unexpected_count > 0 THEN
        RAISE EXCEPTION
          'PHASE 3B.6E.3 STOP CONDITION: public.cms_career_domains contains % row(s) that do not match the approved 8-domain vocabulary by normalized_name. Phase 3B.6E.2A pre-flight confirmed the table empty — remote state has changed since pre-flight. Aborting migration without writing. Investigate and re-run the pre-flight checkpoint before re-attempting this migration.',
          v_unexpected_count;
      END IF;
    END IF;
  END IF;
END $$;

-- ── Step 1: Add canonical_key as nullable ───────────────────────────────────
ALTER TABLE public.cms_career_domains
  ADD COLUMN IF NOT EXISTS canonical_key text;

COMMENT ON COLUMN public.cms_career_domains.canonical_key IS
  'Stable machine identity for the governed Career Area vocabulary (Phase '
  '3B.6E.3). Governance-restricted (I-C model): fixed by migration, not '
  'ordinary-Admin-editable. Exactly 8 approved values. Never regenerated '
  'from name; independent of normalized_name. A retired key must never be '
  'reused for a different meaning — deprecate/replace via a new governed '
  'migration instead.';

-- ── Step 2: Add exact eight-key validation (allows NULL pre-backfill) ──────
ALTER TABLE public.cms_career_domains
  DROP CONSTRAINT IF EXISTS chk_cms_career_domains_canonical_key_allowlist;

ALTER TABLE public.cms_career_domains
  ADD CONSTRAINT chk_cms_career_domains_canonical_key_allowlist
  CHECK (
    canonical_key IS NULL OR canonical_key IN (
      'technology',
      'engineering',
      'natural_sciences',
      'business',
      'creative_industries',
      'social_sciences',
      'health_sciences',
      'education'
    )
  );

-- ── Step 3: Populate the eight governed rows ────────────────────────────────
-- normalized_name is generated using the existing platform convention
-- (trim + lowercase — see adminCmsCareerDomains.module.js#normalizeName).
-- Space-preserving: NOT converted to an underscore slug. canonical_key is
-- the only underscore-slug identity introduced by this phase.
INSERT INTO public.cms_career_domains (
  name,
  normalized_name,
  canonical_key,
  description,
  status,
  created_by_admin_id,
  updated_by_admin_id,
  source_agency,
  soft_deleted
)
VALUES
  ('Technology',          'technology',          'technology',          '', 'active', 'system', 'system', NULL, false),
  ('Engineering',         'engineering',          'engineering',         '', 'active', 'system', 'system', NULL, false),
  ('Natural Sciences',    'natural sciences',     'natural_sciences',    '', 'active', 'system', 'system', NULL, false),
  ('Business',            'business',             'business',            '', 'active', 'system', 'system', NULL, false),
  ('Creative Industries', 'creative industries',  'creative_industries', '', 'active', 'system', 'system', NULL, false),
  ('Social Sciences',     'social sciences',      'social_sciences',     '', 'active', 'system', 'system', NULL, false),
  ('Health Sciences',     'health sciences',      'health_sciences',     '', 'active', 'system', 'system', NULL, false),
  ('Education',           'education',            'education',           '', 'active', 'system', 'system', NULL, false)
ON CONFLICT (normalized_name)
DO UPDATE SET
  canonical_key = EXCLUDED.canonical_key
WHERE public.cms_career_domains.canonical_key IS NULL;

-- ── Step 4: Verify the resulting set before tightening constraints ─────────
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.cms_career_domains
  WHERE soft_deleted = false
    AND canonical_key IN (
      'technology', 'engineering', 'natural_sciences', 'business',
      'creative_industries', 'social_sciences', 'health_sciences', 'education'
    );

  IF v_count <> 8 THEN
    RAISE EXCEPTION
      'PHASE 3B.6E.3: expected exactly 8 active governed Career Area rows with an approved canonical_key after seeding, found %. Aborting before tightening canonical_key to NOT NULL / UNIQUE.',
      v_count;
  END IF;
END $$;

-- ── Step 5: Set canonical_key NOT NULL ──────────────────────────────────────
ALTER TABLE public.cms_career_domains
  ALTER COLUMN canonical_key SET NOT NULL;

-- ── Step 6: Add canonical_key uniqueness (independent of normalized_name) ──
ALTER TABLE public.cms_career_domains
  DROP CONSTRAINT IF EXISTS cms_career_domains_canonical_key_key;

ALTER TABLE public.cms_career_domains
  ADD CONSTRAINT cms_career_domains_canonical_key_key UNIQUE (canonical_key);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback (manual):
--   BEGIN;
--   ALTER TABLE public.cms_career_domains DROP CONSTRAINT IF EXISTS cms_career_domains_canonical_key_key;
--   ALTER TABLE public.cms_career_domains ALTER COLUMN canonical_key DROP NOT NULL;
--   ALTER TABLE public.cms_career_domains DROP CONSTRAINT IF EXISTS chk_cms_career_domains_canonical_key_allowlist;
--   DELETE FROM public.cms_career_domains WHERE canonical_key IN (
--     'technology','engineering','natural_sciences','business',
--     'creative_industries','social_sciences','health_sciences','education'
--   ) AND created_by_admin_id = 'system' AND updated_by_admin_id = 'system';
--   ALTER TABLE public.cms_career_domains DROP COLUMN IF EXISTS canonical_key;
--   COMMIT;
--   -- Note: the DELETE above is scoped to created_by_admin_id = 'system' so it
--   -- will not remove any row an Admin has since edited (updated_by_admin_id
--   -- would then differ). Review before running in case of legitimate Admin
--   -- edits to these rows post-seed.
-- ─────────────────────────────────────────────────────────────────────────────
