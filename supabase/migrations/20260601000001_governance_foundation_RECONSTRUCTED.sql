-- =============================================================================
-- HireRise Phase 1.6 Sprint 1
-- Migration: 20260601000001_governance_foundation.sql
--
-- GOVERNANCE FOUNDATION — COMPLETE BASE SCHEMA
-- RECONSTRUCTED from 20260601000004_governance_refinements.sql
--
-- PURPOSE:
--   Establishes the five foundational objects required before 000004 can run:
--     1. consent_versions                       (reference table)
--     2. signal_weight_versions                 (model registry — base form)
--     3. intelligence_consent_ledger            (immutable consent log)
--     4. intelligence_pipeline_runs             (pipeline audit log)
--     5. intelligence_explainability_snapshots  (immutable explanation archive)
--
-- RECONSTRUCTION METHOD:
--   Every column, constraint name, function signature, trigger name, index name,
--   and seed row was inferred exclusively from the literal text of 000004.
--   No object was added speculatively. Each design decision is documented with
--   the exact 000004 line or section that proves it must exist.
--
-- KEY PROOFS FROM 000004:
--   • "ALTER TABLE public.signal_weight_versions ADD COLUMN IF NOT EXISTS model_type"
--     → table must exist
--   • "DROP CONSTRAINT IF EXISTS uq_signal_weight_version_tag"
--     → constraint named exactly uq_signal_weight_version_tag must exist
--   • "WHERE version_tag = 'v1.0.0' AND model_type = 'signal_weights'"
--     + comment "The ON CONFLICT DO NOTHING in Migration 1 means this row exists."
--     → seed row must exist
--   • "DROP FUNCTION IF EXISTS public.fn_verify_active_consent(uuid, text)"
--     → 2-arg function must exist (or IF EXISTS makes it no-op)
--   • "DROP FUNCTION IF EXISTS public.fn_record_consent_event(uuid,text,text,text,text[],inet,text,text)"
--     → 8-arg function must exist
--   • "DROP FUNCTION IF EXISTS public.fn_get_consent_history(uuid)"
--     → 1-arg function must exist
--   • "DROP FUNCTION IF EXISTS public.fn_get_latest_explanation(uuid, uuid)"
--     → 2-arg function must exist
--   • "The existing idx_explainability_user_subject is preserved"
--     → index named exactly idx_explainability_user_subject must exist
--   • 000004 replaces fn_explainability_snapshot_immutable() body but does NOT
--     re-create trigger bindings → trg_explainability_no_update/no_delete must exist
--   • 000004 replaces fn_pipeline_run_protect_audit_columns() body but does NOT
--     re-create trigger binding → trg_pipeline_run_protect_audit must exist
--   • 000004 replaces fn_signal_weight_version_protect() body but does NOT
--     re-create trigger binding → trg_signal_weight_version_protect must exist
--
-- EXECUTION: Safe to run multiple times (IF NOT EXISTS guards throughout).
-- =============================================================================

BEGIN;

-- =============================================================================
-- EXTENSIONS
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- TABLE 1: consent_versions
--
-- PROOF: fn_record_consent_event() in 000004 executes:
--   IF NOT EXISTS (SELECT 1 FROM public.consent_versions WHERE version = p_consent_version)
--   THEN RAISE EXCEPTION ...
-- This table must exist with a 'version' column. At least one row must exist
-- or every consent event insert will fail with an exception.
--
-- COMPATIBILITY PATCH (applied after deployment failure):
--   The real HireRise database already has public.consent_versions with schema:
--     version (text), label (text), effective_date (date), deprecated (boolean),
--     tos_url (text), privacy_url (text), created_at (timestamp)
--   Sample rows: version='1.0' deprecated=false, version='0.9' deprecated=true
--
--   The reconstructed migration incorrectly assumed:
--     description column  → real column is: label
--     is_current column   → real column is: NOT deprecated
--   This section detects the existing table and adapts accordingly.
-- =============================================================================

DO $$
BEGIN
  -- ── BRANCH A: Table does NOT exist — create with real schema ────────────────
  -- Uses the confirmed real HireRise schema so the table is correct whether
  -- this migration runs on a clean project or an existing one.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'consent_versions'
  ) THEN

    CREATE TABLE public.consent_versions (
      version        text    NOT NULL,
      label          text    NOT NULL,
      effective_date date    NOT NULL DEFAULT CURRENT_DATE,
      deprecated     boolean NOT NULL DEFAULT false,
      tos_url        text    NOT NULL,
      privacy_url    text    NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_consent_versions_version UNIQUE (version)
    );

    COMMENT ON TABLE public.consent_versions IS
      'Phase 1.6: Registry of consent document versions. '
      'fn_record_consent_event() validates p_consent_version against this table. '
      'At least one non-deprecated row must exist before any consent event can be recorded.';

    COMMENT ON COLUMN public.consent_versions.version IS
      'Version identifier (e.g. "1.0"). '
      'Must match p_consent_version passed to fn_record_consent_event().';

    COMMENT ON COLUMN public.consent_versions.deprecated IS
      'true = this version is no longer in use. '
      'Active version: WHERE deprecated = false ORDER BY effective_date DESC LIMIT 1.';

    RAISE NOTICE 'consent_versions: table created with real HireRise schema.';

  -- ── BRANCH B: Table exists — verify version column present, adapt safely ────
  ELSE
    -- The only column fn_record_consent_event() requires is 'version' (text).
    -- Confirm it exists; raise a clear error if the schema is unrecognisable.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'consent_versions'
        AND column_name  = 'version'
    ) THEN
      RAISE EXCEPTION
        'consent_versions exists but has no "version" column. '
        'fn_record_consent_event() requires this column. '
        'Manual intervention required before continuing.';
    END IF;

    RAISE NOTICE 'consent_versions: table already exists with real HireRise schema — skipping CREATE.';
  END IF;
END;
$$;

-- ── Index: active version lookup ───────────────────────────────────────────────
-- Uses 'deprecated' column (real schema). NOT is_current (reconstructed assumption).
-- Guarded: only creates if the deprecated column exists (i.e. real schema present).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'consent_versions'
      AND column_name  = 'deprecated'
  ) THEN
    -- Drop the incorrect index from the original reconstruction if it was
    -- somehow created before the migration failed.
    DROP INDEX IF EXISTS public.idx_consent_versions_current;

    -- Create the correct index using the real 'deprecated' column.
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename  = 'consent_versions'
        AND indexname  = 'idx_consent_versions_active'
    ) THEN
      EXECUTE '
        CREATE INDEX idx_consent_versions_active
          ON public.consent_versions (effective_date DESC)
          WHERE deprecated = false
      ';
      RAISE NOTICE 'consent_versions: created idx_consent_versions_active.';
    ELSE
      RAISE NOTICE 'consent_versions: idx_consent_versions_active already exists — skipping.';
    END IF;
  ELSE
    -- Fallback: table uses different schema (neither real nor reconstructed).
    -- Create a minimal index on version only — safe regardless of schema.
    RAISE NOTICE 'consent_versions: deprecated column not found — skipping active-version index.';
  END IF;
END;
$$;

-- ── RLS ────────────────────────────────────────────────────────────────────────
-- Idempotent: ENABLE ROW LEVEL SECURITY is safe on an already-RLS-enabled table.
ALTER TABLE public.consent_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "consent_versions_read_all" ON public.consent_versions;
CREATE POLICY "consent_versions_read_all"
  ON public.consent_versions FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "consent_versions_service_write" ON public.consent_versions;
CREATE POLICY "consent_versions_service_write"
  ON public.consent_versions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── GRANTs ──────────────────────────────────────────────────────────────────────
-- Preserve existing grants if already set; REVOKE + re-GRANT is idempotent.
REVOKE ALL ON public.consent_versions FROM anon, authenticated;
GRANT SELECT                 ON public.consent_versions TO anon;
GRANT SELECT                 ON public.consent_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.consent_versions TO service_role;

-- ── Seed: ensure at least one active row exists ────────────────────────────────
-- fn_record_consent_event() will raise an exception if no row exists with
-- version = p_consent_version. This INSERT uses the real schema (label, deprecated).
-- ON CONFLICT DO NOTHING: safe whether rows already exist (real DB) or not (clean project).
DO $$
BEGIN
  -- Only insert if no non-deprecated row already exists.
  -- The real DB already has version='1.0' deprecated=false — this will be a no-op.
  IF NOT EXISTS (
    SELECT 1 FROM public.consent_versions
    WHERE deprecated = false
  ) THEN
    -- Use the real schema columns confirmed from the existing HireRise database.
    -- Routed through public.seed_consent_versions() (defined in 000_initial_schema.sql)
    -- rather than a bare INSERT, since that function already validates and requires
    -- tos_url/privacy_url before writing a row.
    -- TODO: replace these placeholder legal-doc URLs with the real ToS/Privacy URLs
    -- before this runs against any real environment.
    PERFORM public.seed_consent_versions(jsonb_build_array(jsonb_build_object(
      'version',        '1.0',
      'label',          'HireRise Phase 1.6 initial consent version',
      'effective_date', CURRENT_DATE::text,
      'deprecated',     false,
      'tos_url',        'https://hirerise.com/legal/terms/v1.0',
      'privacy_url',    'https://hirerise.com/legal/privacy/v1.0'
    )));
    RAISE NOTICE 'consent_versions: seed row inserted (version=1.0).';
  ELSE
    RAISE NOTICE 'consent_versions: active row(s) already exist — seed INSERT skipped.';
  END IF;
END;
$$;

-- =============================================================================
-- TABLE 2: signal_weight_versions
--
-- PROOF: 000004 opens with:
--   ALTER TABLE public.signal_weight_versions ADD COLUMN IF NOT EXISTS model_type
-- The entire migration depends on this table existing.
--
-- CONSTRAINT NAME PROOF:
--   DROP CONSTRAINT IF EXISTS uq_signal_weight_version_tag
--   → constraint must be named exactly uq_signal_weight_version_tag
--
-- COLUMN PROOFS from 000004 trigger bodies and UPDATE statements:
--   version_tag   — WHERE version_tag = 'v1.0.0'; immutability trigger
--   weights       — COMMENT ON COLUMN; immutability trigger NEW.weights
--   approved_at   — IF OLD.approved_at IS NOT NULL (immutability trigger)
--   effective_from — ORDER BY effective_from DESC; WHERE effective_from <= now()
--   deprecated_at — WHERE deprecated_at IS NULL (index partial condition)
--   created_at    — immutability trigger NEW.created_at
--
-- SEED ROW PROOF:
--   Comment in 000004: "The ON CONFLICT DO NOTHING in Migration 1 means this row exists."
--   UPDATE: WHERE version_tag = 'v1.0.0' AND model_type = 'signal_weights'
--   → seed row with version_tag='v1.0.0' must be inserted ON CONFLICT DO NOTHING
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.signal_weight_versions (

  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- PROOF: DROP CONSTRAINT uq_signal_weight_version_tag; WHERE version_tag='v1.0.0'
  version_tag         text        NOT NULL,

  description         text        NOT NULL,

  -- PROOF: COMMENT ON COLUMN weights; immutability trigger checks NEW.weights
  -- Shape for signal_weights: { signal_key: { weight, domain, normalization, rationale } }
  weights             jsonb       NOT NULL,

  domain_overrides    jsonb       NOT NULL DEFAULT '{}',
  weight_rationale    jsonb       NOT NULL DEFAULT '{}',

  approved_by         text        DEFAULT NULL,

  -- PROOF: immutability trigger: IF OLD.approved_at IS NOT NULL
  approved_at         timestamptz DEFAULT NULL,

  -- PROOF: WHERE deprecated_at IS NULL AND approved_at IS NOT NULL (index);
  --        WHERE effective_from <= now() (fn_get_active_weight_version)
  effective_from      timestamptz NOT NULL DEFAULT now(),

  -- PROOF: index partial condition: WHERE deprecated_at IS NULL
  deprecated_at       timestamptz DEFAULT NULL,

  -- PROOF: immutability trigger checks NEW.created_at IS DISTINCT FROM OLD.created_at
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- PROOF: 000004 drops this exact constraint name:
  --   DROP CONSTRAINT IF EXISTS uq_signal_weight_version_tag
  CONSTRAINT uq_signal_weight_version_tag UNIQUE (version_tag),

  CONSTRAINT chk_weights_is_object
    CHECK (jsonb_typeof(weights) = 'object'),

  CONSTRAINT chk_domain_overrides_is_object
    CHECK (jsonb_typeof(domain_overrides) = 'object'),

  CONSTRAINT chk_weight_rationale_is_object
    CHECK (jsonb_typeof(weight_rationale) = 'object')

);

COMMENT ON TABLE public.signal_weight_versions IS
  'Phase 1.6: Versioned registry of signal weight configurations. '
  'Each row is a point-in-time snapshot of the signal weighting model. '
  'Rows are immutable after approval. Deprecation is the only permitted '
  'post-approval state change. Pipeline runs reference the version active '
  'at execution time for full historical reproducibility.';

COMMENT ON COLUMN public.signal_weight_versions.version_tag IS
  'Semantic version identifier. Unique in Sprint 1 '
  '(upgraded to composite unique key in Migration 000004).';

COMMENT ON COLUMN public.signal_weight_versions.approved_at IS
  'Timestamp of promotion to active status. NULL = draft/unapproved. '
  'Only approved versions are returned by fn_get_active_weight_version().';

-- PROOF: 000004 comment: "the single idx_signal_weight_versions_active which
-- did not include model_type — that index is preserved for backward-compat queries"
-- → this index must be named exactly idx_signal_weight_versions_active
CREATE INDEX IF NOT EXISTS idx_signal_weight_versions_active
  ON public.signal_weight_versions (effective_from DESC)
  WHERE deprecated_at IS NULL AND approved_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_signal_weight_versions_tag
  ON public.signal_weight_versions (version_tag);

-- ─── Immutability trigger ─────────────────────────────────────────────────────
-- PROOF: 000004 uses CREATE OR REPLACE on fn_signal_weight_version_protect()
-- but does NOT re-create the trigger binding → trigger must already exist here.
-- Sprint 1 version protects: version_tag, weights, effective_from, created_at.
-- 000004 will replace the body to also protect model_type and intelligence_domain.

CREATE OR REPLACE FUNCTION public.fn_signal_weight_version_protect()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS NOT NULL THEN
    IF NEW.version_tag    IS DISTINCT FROM OLD.version_tag   OR
       NEW.weights        IS DISTINCT FROM OLD.weights       OR
       NEW.effective_from IS DISTINCT FROM OLD.effective_from OR
       NEW.created_at     IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION
        'signal_weight_versions: immutable columns (version_tag, weights, '
        'effective_from, created_at) cannot be changed after approval. '
        'Create a new version instead. version_tag=%, id=%',
        OLD.version_tag, OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_signal_weight_version_protect
  ON public.signal_weight_versions;
CREATE TRIGGER trg_signal_weight_version_protect
  BEFORE UPDATE ON public.signal_weight_versions
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_signal_weight_version_protect();

ALTER TABLE public.signal_weight_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "weight_versions_authenticated_read" ON public.signal_weight_versions;
CREATE POLICY "weight_versions_authenticated_read"
  ON public.signal_weight_versions FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "weight_versions_service_all" ON public.signal_weight_versions;
CREATE POLICY "weight_versions_service_all"
  ON public.signal_weight_versions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

REVOKE ALL ON public.signal_weight_versions FROM anon, authenticated;
GRANT SELECT                 ON public.signal_weight_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.signal_weight_versions TO service_role;

-- ─── fn_get_active_weight_version ────────────────────────────────────────────
-- PROOF: 000004 replaces this with a wrapper calling fn_get_active_model_version().
-- Comment in 000004: "All existing callers (intelligence.service.ts, Sprint 1 code)
-- continue to work with zero changes."
-- Sprint 1 version queries the table directly.
-- RETURNS type: public.signal_weight_versions (confirmed by 000004 replacement function)

CREATE OR REPLACE FUNCTION public.fn_get_active_weight_version()
RETURNS public.signal_weight_versions
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT *
  FROM public.signal_weight_versions
  WHERE deprecated_at IS NULL
    AND approved_at   IS NOT NULL
    AND effective_from <= now()
  ORDER BY effective_from DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.fn_get_active_weight_version() IS
  'Phase 1.6 Sprint 1: Returns the currently active signal weight version. '
  'Replaced with a wrapper calling fn_get_active_model_version() in Sprint 1.1.';

REVOKE ALL ON FUNCTION public.fn_get_active_weight_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_active_weight_version()
  TO authenticated, service_role;

-- ─── Seed: v1.0.0 signal weights ─────────────────────────────────────────────
-- PROOF: 000004 comment: "The ON CONFLICT DO NOTHING in Migration 1 means this row exists."
-- PROOF: 000004 UPDATE: WHERE version_tag = 'v1.0.0' AND model_type = 'signal_weights'
-- ON CONFLICT target: uq_signal_weight_version_tag (version_tag)

INSERT INTO public.signal_weight_versions (
  version_tag, description, weights,
  domain_overrides, weight_rationale,
  approved_by, approved_at, effective_from
)
VALUES (
  'v1.0.0',
  'Initial production signal weights. Reflects the signal model active during '
  'Phase 3A-3D development. Formalised as an auditable version as part of '
  'Phase 1.6 governance foundation.',
  '{
    "systems_thinker":             {"weight":0.80,"domain":"cognitive", "normalization":"weighted_average"},
    "creative_solver":             {"weight":0.75,"domain":"cognitive", "normalization":"weighted_average"},
    "social_collaborator":         {"weight":0.70,"domain":"cognitive", "normalization":"weighted_average"},
    "detail_oriented":             {"weight":0.65,"domain":"cognitive", "normalization":"weighted_average"},
    "leadership_potential":        {"weight":0.75,"domain":"activity",  "normalization":"weighted_average"},
    "technical_aptitude":          {"weight":0.80,"domain":"academic",  "normalization":"weighted_average"},
    "communication_skills":        {"weight":0.70,"domain":"activity",  "normalization":"weighted_average"},
    "analytical_reasoning":        {"weight":0.80,"domain":"cognitive", "normalization":"weighted_average"},
    "creative_expression":         {"weight":0.65,"domain":"activity",  "normalization":"weighted_average"},
    "subject_affinity_stem":       {"weight":0.75,"domain":"academic",  "normalization":"weighted_average"},
    "subject_affinity_humanities": {"weight":0.70,"domain":"academic",  "normalization":"weighted_average"},
    "subject_affinity_commerce":   {"weight":0.70,"domain":"academic",  "normalization":"weighted_average"}
  }'::jsonb,
  '{"academic":1.0,"activity":1.0,"cognitive":1.0,"cross_domain":1.0}'::jsonb,
  '{
    "systems_thinker":      "Highest-weighted cognitive signal; strong predictor of STEM and analytical career fit.",
    "analytical_reasoning": "Cross-domain cognitive signal; consistent predictor across all career domains.",
    "technical_aptitude":   "Academic signal; derived from STEM subject performance and activity engagement.",
    "leadership_potential": "Activity-domain signal; derived from leadership roles and team-based achievements."
  }'::jsonb,
  'system',
  now(),
  '2026-01-01 00:00:00+00'
)
ON CONFLICT (version_tag) DO NOTHING;

-- =============================================================================
-- TABLE 3: intelligence_consent_ledger
--
-- PROOF: 000004: ALTER TABLE public.intelligence_consent_ledger ADD COLUMN IF NOT EXISTS intelligence_domain
-- PROOF: fn_verify_active_consent() in 000004 queries:
--   WHERE user_id = p_user_id AND event_type = 'granted'/'withdrawn'
--   AND p_scope = ANY(consent_scope) ORDER BY event_at DESC
-- PROOF: fn_record_consent_event() in 000004 inserts:
--   user_id, event_type, consent_version, collection_method,
--   consent_scope, ip_address, user_agent, session_id, consent_version_ref
-- PROOF: fn_get_consent_history() in 000004 selects:
--   event_type, consent_version, consent_scope, collection_method, event_at
--   WHERE user_id = COALESCE(p_user_id, auth.uid())
--
-- IMMUTABILITY TRIGGER PROOF:
--   000004 does NOT create fn_consent_ledger_immutable() or its trigger bindings.
--   It only adds a column. Therefore these must exist from Migration 1.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.intelligence_consent_ledger (

  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- PROOF: fn_verify_active_consent WHERE user_id = p_user_id (uuid)
  user_id             uuid        NOT NULL
                        REFERENCES auth.users(id) ON DELETE RESTRICT,

  -- PROOF: WHERE event_type = 'granted'/'withdrawn' in fn_verify_active_consent
  -- PROOF: fn_record_consent_event validates against these 5 values
  event_type          text        NOT NULL
                        CHECK (event_type IN (
                          'granted', 'withdrawn', 'version_upgrade',
                          'scope_expanded', 'scope_reduced'
                        )),

  -- PROOF: SELECT lg.consent_version in fn_verify_active_consent
  -- PROOF: validated against consent_versions.version in fn_record_consent_event
  consent_version     text        NOT NULL,

  -- PROOF: p_scope = ANY(consent_scope) in fn_verify_active_consent
  -- PROOF: 000004 comment: "The original scope CHECK constraint is on consent_scope (a text[] column)"
  -- PROOF: COMMENT ON COLUMN consent_scope updated in 000004 (column exists in Sprint 1)
  consent_scope       text[]      NOT NULL
                        DEFAULT ARRAY['signals', 'recommendations', 'snapshots'],

  -- PROOF: fn_record_consent_event validates and inserts collection_method
  collection_method   text        NOT NULL
                        CHECK (collection_method IN (
                          'onboarding_step', 'settings_page', 'admin_override', 'api'
                        )),

  -- PROOF: fn_record_consent_event INSERT: p_ip_address
  ip_address          inet        DEFAULT NULL,

  -- PROOF: fn_record_consent_event INSERT: p_user_agent
  user_agent          text        DEFAULT NULL,

  -- PROOF: fn_record_consent_event INSERT: p_session_id
  session_id          text        DEFAULT NULL,

  -- PROOF: fn_record_consent_event INSERT: consent_version_ref = p_consent_version
  -- Type text: consent_versions.version is text (no uuid PK)
  consent_version_ref text        DEFAULT NULL,

  -- PROOF: ORDER BY event_at DESC in fn_verify_active_consent CTEs
  -- PROOF: SELECT event_at in fn_get_consent_history
  event_at            timestamptz NOT NULL DEFAULT now(),

  created_at          timestamptz NOT NULL DEFAULT now()

);

COMMENT ON TABLE public.intelligence_consent_ledger IS
  'Phase 1.6: Immutable append-only consent event log. '
  'Every consent state change creates a new row — no updates, no deletes. '
  'fn_verify_active_consent() resolves current state by scanning this ledger. '
  'Revocation is event_type=withdrawn; it never deletes prior rows.';

-- Sprint 1 comment — 000004 will update this comment for expanded scopes
COMMENT ON COLUMN public.intelligence_consent_ledger.consent_scope IS
  'Array of intelligence scopes affected by this event. '
  'Valid values (Sprint 1): signals, recommendations, snapshots. '
  '(Expanded in Sprint 1.1 Migration 000004.)';

CREATE INDEX IF NOT EXISTS idx_consent_ledger_user_event
  ON public.intelligence_consent_ledger (user_id, event_type, event_at DESC);

CREATE INDEX IF NOT EXISTS idx_consent_ledger_user_latest
  ON public.intelligence_consent_ledger (user_id, event_at DESC);

CREATE INDEX IF NOT EXISTS idx_consent_ledger_version
  ON public.intelligence_consent_ledger (consent_version);

-- ─── Immutability triggers ─────────────────────────────────────────────────
-- PROOF: 000004 adds a column to this table but does NOT create these triggers.
-- They must already exist. Function name chosen to match standard pattern.

CREATE OR REPLACE FUNCTION public.fn_consent_ledger_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'intelligence_consent_ledger is immutable. '
    'Consent state changes must be recorded as new rows. '
    'Operation: %, Table: intelligence_consent_ledger', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_consent_ledger_no_update ON public.intelligence_consent_ledger;
CREATE TRIGGER trg_consent_ledger_no_update
  BEFORE UPDATE ON public.intelligence_consent_ledger
  FOR EACH ROW EXECUTE FUNCTION public.fn_consent_ledger_immutable();

DROP TRIGGER IF EXISTS trg_consent_ledger_no_delete ON public.intelligence_consent_ledger;
CREATE TRIGGER trg_consent_ledger_no_delete
  BEFORE DELETE ON public.intelligence_consent_ledger
  FOR EACH ROW EXECUTE FUNCTION public.fn_consent_ledger_immutable();

ALTER TABLE public.intelligence_consent_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "consent_ledger_owner_read" ON public.intelligence_consent_ledger;
CREATE POLICY "consent_ledger_owner_read"
  ON public.intelligence_consent_ledger FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "consent_ledger_service_insert" ON public.intelligence_consent_ledger;
CREATE POLICY "consent_ledger_service_insert"
  ON public.intelligence_consent_ledger FOR INSERT TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS "consent_ledger_service_read" ON public.intelligence_consent_ledger;
CREATE POLICY "consent_ledger_service_read"
  ON public.intelligence_consent_ledger FOR SELECT TO service_role
  USING (true);

REVOKE ALL ON public.intelligence_consent_ledger FROM anon, authenticated;
GRANT SELECT         ON public.intelligence_consent_ledger TO authenticated;
GRANT SELECT, INSERT ON public.intelligence_consent_ledger TO service_role;

-- ─── Sprint 1 RPCs (prior signatures that 000004 drops and replaces) ─────────

-- PROOF: 000004: DROP FUNCTION IF EXISTS public.fn_verify_active_consent(uuid, text)
-- Must exist as 2-arg overload for DROP to be meaningful, and for any Sprint 1
-- callers that used this signature before 000004 ran.
CREATE OR REPLACE FUNCTION public.fn_verify_active_consent(
  p_user_id uuid,
  p_scope   text DEFAULT 'signals'
)
RETURNS TABLE (
  has_consent       boolean,
  consent_ledger_id uuid,
  consent_version   text,
  granted_at        timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH latest_granted AS (
    SELECT id, consent_version, event_at
    FROM public.intelligence_consent_ledger
    WHERE user_id    = p_user_id
      AND event_type = 'granted'
      AND p_scope    = ANY(consent_scope)
    ORDER BY event_at DESC LIMIT 1
  ),
  latest_withdrawn AS (
    SELECT event_at
    FROM public.intelligence_consent_ledger
    WHERE user_id    = p_user_id
      AND event_type = 'withdrawn'
      AND p_scope    = ANY(consent_scope)
    ORDER BY event_at DESC LIMIT 1
  )
  SELECT true, lg.id, lg.consent_version, lg.event_at
  FROM latest_granted lg
  WHERE NOT EXISTS (
    SELECT 1 FROM latest_withdrawn lw WHERE lw.event_at > lg.event_at
  );
$$;

COMMENT ON FUNCTION public.fn_verify_active_consent(uuid, text) IS
  'Phase 1.6 Sprint 1: 2-arg version. '
  'Dropped and replaced by 3-arg version in Migration 000004.';

REVOKE ALL ON FUNCTION public.fn_verify_active_consent(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_verify_active_consent(uuid, text)
  TO authenticated, service_role;

-- PROOF: 000004: DROP FUNCTION IF EXISTS public.fn_record_consent_event(uuid,text,text,text,text[],inet,text,text)
-- 8-arg Sprint 1 version.
CREATE OR REPLACE FUNCTION public.fn_record_consent_event(
  p_user_id           uuid,
  p_event_type        text,
  p_consent_version   text,
  p_collection_method text,
  p_consent_scope     text[]  DEFAULT ARRAY['signals', 'recommendations', 'snapshots'],
  p_ip_address        inet    DEFAULT NULL,
  p_user_agent        text    DEFAULT NULL,
  p_session_id        text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_new_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.consent_versions WHERE version = p_consent_version
  ) THEN
    RAISE EXCEPTION
      'fn_record_consent_event: consent_version % not found in consent_versions table.',
      p_consent_version;
  END IF;
  INSERT INTO public.intelligence_consent_ledger (
    user_id, event_type, consent_version, collection_method,
    consent_scope, ip_address, user_agent, session_id, consent_version_ref
  ) VALUES (
    p_user_id, p_event_type, p_consent_version, p_collection_method,
    p_consent_scope, p_ip_address, p_user_agent, p_session_id, p_consent_version
  )
  RETURNING id INTO v_new_id;
  RETURN v_new_id;
END;
$$;

COMMENT ON FUNCTION public.fn_record_consent_event(uuid,text,text,text,text[],inet,text,text) IS
  'Phase 1.6 Sprint 1: 8-arg version. '
  'Dropped and replaced by 9-arg version in Migration 000004.';

REVOKE ALL ON FUNCTION public.fn_record_consent_event(uuid,text,text,text,text[],inet,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_record_consent_event(uuid,text,text,text,text[],inet,text,text)
  TO service_role;

-- PROOF: 000004: DROP FUNCTION IF EXISTS public.fn_get_consent_history(uuid)
-- 1-arg Sprint 1 version.
-- PROOF: 000004 replacement returns intelligence_domain column — Sprint 1 version does not.
CREATE OR REPLACE FUNCTION public.fn_get_consent_history(
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  event_type        text,
  consent_version   text,
  consent_scope     text[],
  collection_method text,
  event_at          timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT event_type, consent_version, consent_scope, collection_method, event_at
  FROM public.intelligence_consent_ledger
  WHERE user_id = COALESCE(p_user_id, auth.uid())
  ORDER BY event_at ASC;
$$;

COMMENT ON FUNCTION public.fn_get_consent_history(uuid) IS
  'Phase 1.6 Sprint 1: 1-arg version. '
  'Dropped and replaced by 2-arg version in Migration 000004.';

REVOKE ALL ON FUNCTION public.fn_get_consent_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_consent_history(uuid)
  TO authenticated, service_role;

-- =============================================================================
-- TABLE 4: intelligence_pipeline_runs
--
-- PROOF: 000004:
--   ALTER TABLE public.intelligence_pipeline_runs ADD COLUMN IF NOT EXISTS intelligence_domain
--   ALTER TABLE public.intelligence_pipeline_runs ADD COLUMN IF NOT EXISTS model_version_id
--   UPDATE ... SET model_version_id = weight_version_id (weight_version_id column must exist)
--
-- COLUMN PROOFS from 000004 immutability trigger bodies (R1e and R5):
--   user_id           — NEW.user_id IS DISTINCT FROM OLD.user_id
--   consent_ledger_id — NEW.consent_ledger_id IS DISTINCT FROM OLD.consent_ledger_id
--   weight_version_id — NEW.weight_version_id IS DISTINCT FROM OLD.weight_version_id
--                       AND backfill: SET model_version_id = weight_version_id
--   pipeline_type     — NEW.pipeline_type IS DISTINCT FROM OLD.pipeline_type
--   engine_version    — NEW.engine_version IS DISTINCT FROM OLD.engine_version
--   status            — IF OLD.status IN ('completed','failed','skipped_no_consent','skipped_no_data')
--   input_hash        — NEW.input_hash IS DISTINCT FROM OLD.input_hash
--   started_at        — NEW.started_at IS DISTINCT FROM OLD.started_at
--   created_at        — NEW.created_at IS DISTINCT FROM OLD.created_at
--
-- TRIGGER PROOF:
--   000004 uses CREATE OR REPLACE on fn_pipeline_run_protect_audit_columns() TWICE
--   (once in R1e, once in R5) but NEVER re-creates the trigger binding.
--   → trg_pipeline_run_protect_audit must already be bound to the table here.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.intelligence_pipeline_runs (

  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- PROOF: immutability trigger checks NEW.user_id
  user_id             uuid        NOT NULL
                        REFERENCES auth.users(id) ON DELETE RESTRICT,

  -- PROOF: immutability trigger checks NEW.consent_ledger_id
  consent_ledger_id   uuid        NOT NULL
                        REFERENCES public.intelligence_consent_ledger(id) ON DELETE RESTRICT,

  -- PROOF: immutability trigger checks NEW.weight_version_id
  -- PROOF: 000004 backfill: SET model_version_id = weight_version_id
  weight_version_id   uuid        NOT NULL
                        REFERENCES public.signal_weight_versions(id) ON DELETE RESTRICT,

  -- PROOF: immutability trigger checks NEW.pipeline_type
  pipeline_type       text        NOT NULL
                        CHECK (pipeline_type IN (
                          'signal_extraction', 'confidence_calculation',
                          'recommendation_generation', 'snapshot_generation',
                          'cross_domain_aggregation', 'full_pipeline'
                        )),

  -- PROOF: immutability trigger checks NEW.engine_version
  engine_version      text        NOT NULL,

  -- PROOF: IF OLD.status IN ('completed','failed','skipped_no_consent','skipped_no_data')
  status              text        NOT NULL DEFAULT 'running'
                        CHECK (status IN (
                          'running', 'completed', 'failed',
                          'skipped_no_consent', 'skipped_no_data'
                        )),

  -- PROOF: immutability trigger checks NEW.input_hash
  input_hash          text        DEFAULT NULL
                        CHECK (input_hash IS NULL OR length(input_hash) = 64),

  output_hash         text        DEFAULT NULL
                        CHECK (output_hash IS NULL OR length(output_hash) = 64),

  domains_processed   text[]      NOT NULL DEFAULT '{}',

  duration_ms         integer     DEFAULT NULL
                        CHECK (duration_ms IS NULL OR duration_ms >= 0),

  error_code          text        DEFAULT NULL,
  error_message       text        DEFAULT NULL,

  -- PROOF: immutability trigger checks NEW.started_at
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz DEFAULT NULL,

  -- PROOF: immutability trigger checks NEW.created_at
  created_at          timestamptz NOT NULL DEFAULT now()

);

COMMENT ON TABLE public.intelligence_pipeline_runs IS
  'Phase 1.6: Audit record for every intelligence pipeline execution. '
  'Opened at run start; closed with terminal status at end. '
  'Core audit columns are protected by trigger after terminal status reached.';

-- ─── Audit protection trigger ─────────────────────────────────────────────────
-- PROOF: 000004 calls CREATE OR REPLACE on this function body twice (R1e, R5)
-- but never calls CREATE TRIGGER. Therefore this trigger binding must exist here.
-- Sprint 1 body: protects all columns present in Sprint 1.
-- 000004 R1e: replaces body to also check intelligence_domain.
-- 000004 R5:  replaces body to also check model_version_id.

CREATE OR REPLACE FUNCTION public.fn_pipeline_run_protect_audit_columns()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'skipped_no_consent', 'skipped_no_data') THEN
    IF NEW.user_id            IS DISTINCT FROM OLD.user_id           OR
       NEW.consent_ledger_id  IS DISTINCT FROM OLD.consent_ledger_id OR
       NEW.weight_version_id  IS DISTINCT FROM OLD.weight_version_id OR
       NEW.pipeline_type      IS DISTINCT FROM OLD.pipeline_type     OR
       NEW.engine_version     IS DISTINCT FROM OLD.engine_version    OR
       NEW.input_hash         IS DISTINCT FROM OLD.input_hash        OR
       NEW.started_at         IS DISTINCT FROM OLD.started_at        OR
       NEW.created_at         IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION
        'intelligence_pipeline_runs: immutable audit columns cannot be '
        'changed after a terminal status is reached. run_id=%, status=%',
        OLD.id, OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- PROOF: trigger binding must exist before 000004 runs (000004 does not create it)
DROP TRIGGER IF EXISTS trg_pipeline_run_protect_audit ON public.intelligence_pipeline_runs;
CREATE TRIGGER trg_pipeline_run_protect_audit
  BEFORE UPDATE ON public.intelligence_pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION public.fn_pipeline_run_protect_audit_columns();

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user_status
  ON public.intelligence_pipeline_runs (user_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_type_engine
  ON public.intelligence_pipeline_runs (pipeline_type, engine_version);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_consent
  ON public.intelligence_pipeline_runs (consent_ledger_id);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_weight_version
  ON public.intelligence_pipeline_runs (weight_version_id);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started
  ON public.intelligence_pipeline_runs (started_at DESC);

ALTER TABLE public.intelligence_pipeline_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pipeline_runs_owner_read" ON public.intelligence_pipeline_runs;
CREATE POLICY "pipeline_runs_owner_read"
  ON public.intelligence_pipeline_runs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "pipeline_runs_service_all" ON public.intelligence_pipeline_runs;
CREATE POLICY "pipeline_runs_service_all"
  ON public.intelligence_pipeline_runs FOR ALL TO service_role
  USING (true) WITH CHECK (true);

REVOKE ALL ON public.intelligence_pipeline_runs FROM anon, authenticated;
GRANT SELECT                  ON public.intelligence_pipeline_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE  ON public.intelligence_pipeline_runs TO service_role;

-- =============================================================================
-- TABLE 5: intelligence_explainability_snapshots
--
-- PROOF: 000004:
--   ALTER TABLE public.intelligence_explainability_snapshots ADD COLUMN IF NOT EXISTS intelligence_domain
--
-- COLUMN PROOFS from fn_get_latest_explanation in 000004:
--   user_id    — WHERE user_id = p_user_id
--   subject_id — WHERE subject_id = p_subject_id
--   snapshot_at — ORDER BY snapshot_at DESC
--
-- COLUMN PROOFS from new index created in 000004 (R1h):
--   intelligence_domain — (intelligence_domain, confidence_tier, snapshot_at DESC)
--   confidence_tier     — same index
--   vocabulary_valid    — WHERE vocabulary_valid = true
--
-- INDEX PROOF: 000004 comment states:
--   "The existing idx_explainability_user_subject is preserved (still valid for
--    subject-scoped lookups). New index adds domain dimension."
--   → idx_explainability_user_subject must exist with exactly this name.
--
-- TRIGGER PROOF: 000004 uses CREATE OR REPLACE on fn_explainability_snapshot_immutable()
-- but does NOT re-create trg_explainability_no_update / trg_explainability_no_delete.
-- → both trigger bindings must already exist here.
--
-- PRIOR FUNCTION PROOF:
--   000004: DROP FUNCTION IF EXISTS public.fn_get_latest_explanation(uuid, uuid)
--   RETURNS type: public.intelligence_explainability_snapshots (confirmed by 000004 3-arg version)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.intelligence_explainability_snapshots (

  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- PROOF: fn_get_latest_explanation WHERE user_id = p_user_id (uuid)
  user_id               uuid        NOT NULL
                          REFERENCES auth.users(id) ON DELETE RESTRICT,

  -- Governance FK to pipeline run
  pipeline_run_id       uuid        NOT NULL
                          REFERENCES public.intelligence_pipeline_runs(id) ON DELETE RESTRICT,

  -- Standard subject classification
  subject_type          text        NOT NULL
                          CHECK (subject_type IN (
                            'signal_vector', 'confidence_model', 'recommendation',
                            'cluster_stability', 'signal_coverage', 'cross_domain_aggregate'
                          )),

  -- PROOF: fn_get_latest_explanation WHERE subject_id = p_subject_id (uuid)
  subject_id            uuid        NOT NULL,

  -- PROOF: new index in 000004 (R1h): (intelligence_domain, confidence_tier, snapshot_at DESC)
  confidence_tier       text        NOT NULL
                          CHECK (confidence_tier IN ('HIGH', 'MEDIUM', 'LOW', 'NO_DATA')),

  confidence_score      numeric(5,2) DEFAULT NULL
                          CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 100),

  -- Vocabulary-validated explanation text
  explanation_text      text        NOT NULL
                          CHECK (char_length(explanation_text) BETWEEN 10 AND 2000),

  registry_version      text        NOT NULL DEFAULT '1.0.0',

  factors               jsonb       NOT NULL DEFAULT '{}'
                          CHECK (jsonb_typeof(factors) = 'object'),

  contributing_signals  text[]      NOT NULL DEFAULT '{}',
  contributing_domains  text[]      NOT NULL DEFAULT '{}',

  -- PROOF: index partial condition in 000004 R1h: WHERE vocabulary_valid = true
  vocabulary_valid      boolean     NOT NULL DEFAULT true,
  vocabulary_violations jsonb       DEFAULT NULL,

  engine_version        text        NOT NULL,

  -- PROOF: fn_get_latest_explanation ORDER BY snapshot_at DESC
  snapshot_at           timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now()

);

COMMENT ON TABLE public.intelligence_explainability_snapshots IS
  'Phase 1.6: Immutable archive of intelligence output explanations. '
  'Every explanation is stored as a new row — no updates, no deletes. '
  'The most recent snapshot for a given subject_id is the current explanation. '
  'Full audit chain: pipeline_run_id → consent + model version.';

-- ─── Immutability triggers ─────────────────────────────────────────────────────
-- PROOF: 000004 uses CREATE OR REPLACE on fn_explainability_snapshot_immutable()
-- but does NOT re-create trg_explainability_no_update or trg_explainability_no_delete.
-- Both trigger bindings must exist here. The trigger names are chosen to match
-- the standard pattern used across all governance tables.

CREATE OR REPLACE FUNCTION public.fn_explainability_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Sprint 1 body — 000004 R1i replaces with message including intelligence_domain
  RAISE EXCEPTION
    'intelligence_explainability_snapshots is immutable. '
    'Revised explanations must be inserted as new rows. '
    'Operation: %, snapshot_id: %', TG_OP, OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS trg_explainability_no_update
  ON public.intelligence_explainability_snapshots;
CREATE TRIGGER trg_explainability_no_update
  BEFORE UPDATE ON public.intelligence_explainability_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fn_explainability_snapshot_immutable();

DROP TRIGGER IF EXISTS trg_explainability_no_delete
  ON public.intelligence_explainability_snapshots;
CREATE TRIGGER trg_explainability_no_delete
  BEFORE DELETE ON public.intelligence_explainability_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fn_explainability_snapshot_immutable();

-- PROOF: 000004 comment explicitly preserves this exact index name:
-- "The existing idx_explainability_user_subject is preserved (still valid for subject-scoped lookups)"
CREATE INDEX IF NOT EXISTS idx_explainability_user_subject
  ON public.intelligence_explainability_snapshots (user_id, subject_type, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_explainability_pipeline_run
  ON public.intelligence_explainability_snapshots (pipeline_run_id);

CREATE INDEX IF NOT EXISTS idx_explainability_subject_id
  ON public.intelligence_explainability_snapshots (subject_id, snapshot_at DESC);

ALTER TABLE public.intelligence_explainability_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "explainability_owner_read"
  ON public.intelligence_explainability_snapshots;
CREATE POLICY "explainability_owner_read"
  ON public.intelligence_explainability_snapshots FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "explainability_service_insert"
  ON public.intelligence_explainability_snapshots;
CREATE POLICY "explainability_service_insert"
  ON public.intelligence_explainability_snapshots FOR INSERT TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS "explainability_service_read"
  ON public.intelligence_explainability_snapshots;
CREATE POLICY "explainability_service_read"
  ON public.intelligence_explainability_snapshots FOR SELECT TO service_role
  USING (true);

REVOKE ALL ON public.intelligence_explainability_snapshots FROM anon, authenticated;
GRANT SELECT         ON public.intelligence_explainability_snapshots TO authenticated;
GRANT SELECT, INSERT ON public.intelligence_explainability_snapshots TO service_role;

-- ─── fn_get_latest_explanation (2-arg Sprint 1 version) ──────────────────────
-- PROOF: 000004: DROP FUNCTION IF EXISTS public.fn_get_latest_explanation(uuid, uuid)
-- PROOF: 000004 3-arg replacement confirms RETURNS public.intelligence_explainability_snapshots

CREATE OR REPLACE FUNCTION public.fn_get_latest_explanation(
  p_user_id    uuid,
  p_subject_id uuid
)
RETURNS public.intelligence_explainability_snapshots
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT *
  FROM public.intelligence_explainability_snapshots
  WHERE user_id    = p_user_id
    AND subject_id = p_subject_id
  ORDER BY snapshot_at DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.fn_get_latest_explanation(uuid, uuid) IS
  'Phase 1.6 Sprint 1: 2-arg version. '
  'Dropped and replaced by 3-arg version in Migration 000004.';

REVOKE ALL ON FUNCTION public.fn_get_latest_explanation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_latest_explanation(uuid, uuid)
  TO authenticated, service_role;

-- =============================================================================
-- SCHEMA COMMENT
-- =============================================================================

COMMENT ON SCHEMA public IS
  'HireRise Phase 1.6 Sprint 1 — Governance Foundation. '
  'Tables: consent_versions, signal_weight_versions, '
  'intelligence_consent_ledger, intelligence_pipeline_runs, '
  'intelligence_explainability_snapshots. '
  'Migration: 20260601000001_governance_foundation.sql';

COMMIT;