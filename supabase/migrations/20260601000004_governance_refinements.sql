-- =============================================================================
-- HireRise Phase 1.6 Sprint 1.1
-- Migration: 20260601000004_governance_refinements.sql
--
-- GOVERNANCE FOUNDATION REFINEMENT — DELTA ONLY
-- Applies five targeted refinements to the Sprint 1 governance foundation.
-- This migration contains ONLY the changes not present in:
--   20260601000001_governance_foundation.sql
--   20260601000002_intelligence_grant_remediation.sql
--   20260601000003_disable_firebase_bridge.sql
--
-- REFINEMENTS APPLIED:
--   R1 — intelligence_domain added to signal_weight_versions,
--          intelligence_pipeline_runs, intelligence_explainability_snapshots
--   R2 — Consent scope expanded to full HireRise domain vocabulary
--   R3 — signal_weight_versions extended into generic model_registry
--          (model_type column + updated unique constraint)
--   R4 — fn_get_active_weight_version() replaced by fn_get_active_model_version()
--   R5 — intelligence_pipeline_runs gains model_version_id column linking to
--          a model registry row (replaces the student-only weight_version_id FK
--          for multi-domain future use — weight_version_id is preserved for
--          Sprint 1 backward compatibility)
--
-- BACKWARD COMPATIBILITY:
--   ✓ All new columns are nullable or have defaults — no existing row breaks.
--   ✓ fn_get_active_weight_version() is PRESERVED as a wrapper around the new
--     fn_get_active_model_version() — zero impact on existing callers.
--   ✓ fn_verify_active_consent() and fn_record_consent_event() are updated
--     to validate against the expanded scope list; the default scope array is
--     updated but existing rows with old scope values remain valid.
--   ✓ weight_version_id FK on pipeline_runs is preserved; model_version_id is
--     additive.
--   ✓ All CHECK constraint changes use DROP CONSTRAINT + ADD CONSTRAINT pattern
--     (idempotent-safe with IF NOT EXISTS guards on new constraints).
--   ✓ No table is dropped or renamed.
--   ✓ No index is dropped (new indexes are additive).
--
-- EXECUTION ORDER:
--   Must run AFTER 20260601000001, 000002, 000003.
--   Tables must already exist.
--
-- EXECUTION: Safe to run multiple times (CREATE OR REPLACE / IF NOT EXISTS /
--            ADD COLUMN IF NOT EXISTS throughout).
-- =============================================================================

BEGIN;

-- =============================================================================
-- REFINEMENT 3 FIRST: Extend signal_weight_versions into generic model registry
-- (Must precede R1 and R4 because they depend on the model_type column)
-- =============================================================================

-- ─── R3: Add model_type column ───────────────────────────────────────────────
-- Extends signal_weight_versions into a generic model registry.
-- Existing rows get model_type = 'signal_weights' (the only model type that
-- has existed so far). The NOT NULL constraint is applied after backfill.

ALTER TABLE public.signal_weight_versions
  ADD COLUMN IF NOT EXISTS model_type text DEFAULT 'signal_weights';

-- Backfill existing rows (the v1.0.0 seed row)
UPDATE public.signal_weight_versions
SET model_type = 'signal_weights'
WHERE model_type IS NULL;

-- Enforce NOT NULL after backfill
ALTER TABLE public.signal_weight_versions
  ALTER COLUMN model_type SET NOT NULL;

-- ─── R3: Add CHECK constraint on model_type ───────────────────────────────────
-- Extensible list of model types HireRise will need.
-- New types are added via ALTER TABLE ... ADD/DROP CONSTRAINT as needed.
-- Using DROP + ADD ensures idempotent re-run safety.

ALTER TABLE public.signal_weight_versions
  DROP CONSTRAINT IF EXISTS chk_model_type_valid;

ALTER TABLE public.signal_weight_versions
  ADD CONSTRAINT chk_model_type_valid
    CHECK (model_type IN (
      'signal_weights',         -- Phase 1.6: initial student signal weights
      'confidence_model',       -- Phase 2A: confidence scoring parameters
      'recommendation_model',   -- Phase 2A.2: recommendation engine parameters
      'matching_model',         -- Future: employer-student matching
      'clustering_model',       -- Future: capability cluster definitions
      'explainability_model'    -- Future: explanation template configuration
    ));

-- ─── R3: Drop the old version_tag-only unique constraint ─────────────────────
-- version_tag alone is no longer sufficient — 'v1.0.0' of signal_weights and
-- 'v1.0.0' of confidence_model are different entities and must coexist.

ALTER TABLE public.signal_weight_versions
  DROP CONSTRAINT IF EXISTS uq_signal_weight_version_tag;

-- ─── R3: Add composite unique constraint ─────────────────────────────────────
-- A version tag must be unique within a model_type.
-- 'v1.0.0' of signal_weights is distinct from 'v1.0.0' of confidence_model.

ALTER TABLE public.signal_weight_versions
  DROP CONSTRAINT IF EXISTS uq_model_version_tag_per_type;

ALTER TABLE public.signal_weight_versions
  ADD CONSTRAINT uq_model_version_tag_per_type
    UNIQUE (model_type, version_tag);

-- ─── R3: Update table comment ─────────────────────────────────────────────────

COMMENT ON TABLE public.signal_weight_versions IS
  'Phase 1.6 (extended in Sprint 1.1): Generic model version registry. '
  'Each row is an approved, point-in-time snapshot of a versioned intelligence '
  'model configuration. model_type identifies which model family the row belongs '
  'to (signal_weights, confidence_model, recommendation_model, etc.). '
  'version_tag is unique per model_type. Rows are immutable after approval. '
  'Deprecation is the only permitted post-approval state change. '
  'Pipeline runs reference the model version active at execution time.';

COMMENT ON COLUMN public.signal_weight_versions.model_type IS
  'Model family this version belongs to. '
  'Valid values: signal_weights, confidence_model, recommendation_model, '
  'matching_model, clustering_model, explainability_model. '
  'Together with version_tag forms the composite unique key.';

COMMENT ON COLUMN public.signal_weight_versions.weights IS
  'Model configuration payload. Shape is model_type-specific. '
  'For signal_weights: { signal_key: { weight, domain, normalization, rationale } }. '
  'For confidence_model: { parameter_key: { value, rationale } }. '
  'For other model types: consult the model type documentation.';

-- ─── R3: Update immutability trigger to include model_type ───────────────────
-- model_type is part of the composite identity — it must not change after approval.

CREATE OR REPLACE FUNCTION public.fn_signal_weight_version_protect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.approved_at IS NOT NULL THEN
    IF NEW.version_tag    IS DISTINCT FROM OLD.version_tag   OR
       NEW.model_type     IS DISTINCT FROM OLD.model_type    OR
       NEW.weights        IS DISTINCT FROM OLD.weights       OR
       NEW.effective_from IS DISTINCT FROM OLD.effective_from OR
       NEW.created_at     IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION
        'signal_weight_versions (model registry): immutable columns '
        '(version_tag, model_type, weights, effective_from, created_at) '
        'cannot be changed after approval. Create a new version instead. '
        'model_type=%, version_tag=%, id=%',
        OLD.model_type, OLD.version_tag, OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ─── R3: Add composite index for active-version lookups per model_type ────────
-- Replaces the single idx_signal_weight_versions_active which did not include
-- model_type — that index is preserved for backward-compat queries.

CREATE INDEX IF NOT EXISTS idx_model_registry_active_per_type
  ON public.signal_weight_versions (model_type, effective_from DESC)
  WHERE deprecated_at IS NULL AND approved_at IS NOT NULL;

-- =============================================================================
-- REFINEMENT 1: Add intelligence_domain to governance tables
-- =============================================================================
-- intelligence_domain identifies which HireRise domain produced or owns an
-- intelligence artifact. It is the primary cross-cutting dimension across all
-- future modules.
--
-- Valid values:
--   'student'       — Phase 2A student intelligence
--   'professional'  — Future professional intelligence
--   'institution'   — Future institution intelligence
--   'employer'      — Future employer intelligence
--   'workforce'     — Future workforce intelligence
--   'cross_domain'  — Aggregations spanning multiple domains
-- =============================================================================

-- ─── R1a: signal_weight_versions — add intelligence_domain ───────────────────
-- A model version is scoped to an intelligence domain.
-- The v1.0.0 seed row is student domain (student signal weights).

ALTER TABLE public.signal_weight_versions
  ADD COLUMN IF NOT EXISTS intelligence_domain text
    DEFAULT 'student'
    CHECK (intelligence_domain IN (
      'student',
      'professional',
      'institution',
      'employer',
      'workforce',
      'cross_domain'
    ));

-- Backfill existing rows
UPDATE public.signal_weight_versions
SET intelligence_domain = 'student'
WHERE intelligence_domain IS NULL;

ALTER TABLE public.signal_weight_versions
  ALTER COLUMN intelligence_domain SET NOT NULL;

COMMENT ON COLUMN public.signal_weight_versions.intelligence_domain IS
  'HireRise intelligence domain this model version applies to. '
  'Valid: student, professional, institution, employer, workforce, cross_domain. '
  'Together with model_type and version_tag provides full model identity.';

-- ─── R1b: Update the composite unique constraint to include domain ─────────────
-- 'v1.0.0' of signal_weights in 'student' domain is distinct from
-- 'v1.0.0' of signal_weights in 'professional' domain.

ALTER TABLE public.signal_weight_versions
  DROP CONSTRAINT IF EXISTS uq_model_version_tag_per_type;

ALTER TABLE public.signal_weight_versions
  DROP CONSTRAINT IF EXISTS uq_model_version_per_domain_type;

ALTER TABLE public.signal_weight_versions
  ADD CONSTRAINT uq_model_version_per_domain_type
    UNIQUE (intelligence_domain, model_type, version_tag);

-- ─── R1c: Update active-version index to include domain ───────────────────────

DROP INDEX IF EXISTS idx_model_registry_active_per_type;

CREATE INDEX IF NOT EXISTS idx_model_registry_active_per_domain_type
  ON public.signal_weight_versions (intelligence_domain, model_type, effective_from DESC)
  WHERE deprecated_at IS NULL AND approved_at IS NOT NULL;

-- ─── R1d: intelligence_pipeline_runs — add intelligence_domain ───────────────

ALTER TABLE public.intelligence_pipeline_runs
  ADD COLUMN IF NOT EXISTS intelligence_domain text
    DEFAULT 'student';

-- Backfill: existing runs are student domain
UPDATE public.intelligence_pipeline_runs
SET intelligence_domain = 'student'
WHERE intelligence_domain IS NULL;

ALTER TABLE public.intelligence_pipeline_runs
  ALTER COLUMN intelligence_domain SET NOT NULL;

-- Add CHECK constraint for pipeline_runs domain
ALTER TABLE public.intelligence_pipeline_runs
  DROP CONSTRAINT IF EXISTS chk_pipeline_runs_domain_valid;

ALTER TABLE public.intelligence_pipeline_runs
  ADD CONSTRAINT chk_pipeline_runs_domain_valid
    CHECK (intelligence_domain IN (
      'student',
      'professional',
      'institution',
      'employer',
      'workforce',
      'cross_domain'
    ));

COMMENT ON COLUMN public.intelligence_pipeline_runs.intelligence_domain IS
  'HireRise intelligence domain this pipeline run belongs to. '
  'Enables per-domain pipeline auditing across all future HireRise modules.';

-- ─── R1e: Update pipeline_runs audit protection trigger ───────────────────────
-- intelligence_domain is an immutable audit column once terminal status reached.

CREATE OR REPLACE FUNCTION public.fn_pipeline_run_protect_audit_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'skipped_no_consent', 'skipped_no_data') THEN
    IF NEW.user_id              IS DISTINCT FROM OLD.user_id             OR
       NEW.consent_ledger_id    IS DISTINCT FROM OLD.consent_ledger_id   OR
       NEW.weight_version_id    IS DISTINCT FROM OLD.weight_version_id   OR
       NEW.intelligence_domain  IS DISTINCT FROM OLD.intelligence_domain  OR
       NEW.pipeline_type        IS DISTINCT FROM OLD.pipeline_type       OR
       NEW.engine_version       IS DISTINCT FROM OLD.engine_version      OR
       NEW.input_hash           IS DISTINCT FROM OLD.input_hash          OR
       NEW.started_at           IS DISTINCT FROM OLD.started_at          OR
       NEW.created_at           IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION
        'intelligence_pipeline_runs: immutable audit columns cannot be '
        'changed after a terminal status is reached. '
        'run_id=%, status=%, intelligence_domain=%',
        OLD.id, OLD.status, OLD.intelligence_domain;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ─── R1f: Add index on pipeline_runs for domain-scoped queries ────────────────

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_domain_status
  ON public.intelligence_pipeline_runs
  (intelligence_domain, status, started_at DESC);

-- ─── R1g: intelligence_explainability_snapshots — add intelligence_domain ─────

ALTER TABLE public.intelligence_explainability_snapshots
  ADD COLUMN IF NOT EXISTS intelligence_domain text
    DEFAULT 'student';

UPDATE public.intelligence_explainability_snapshots
SET intelligence_domain = 'student'
WHERE intelligence_domain IS NULL;

ALTER TABLE public.intelligence_explainability_snapshots
  ALTER COLUMN intelligence_domain SET NOT NULL;

ALTER TABLE public.intelligence_explainability_snapshots
  DROP CONSTRAINT IF EXISTS chk_snapshots_domain_valid;

ALTER TABLE public.intelligence_explainability_snapshots
  ADD CONSTRAINT chk_snapshots_domain_valid
    CHECK (intelligence_domain IN (
      'student',
      'professional',
      'institution',
      'employer',
      'workforce',
      'cross_domain'
    ));

COMMENT ON COLUMN public.intelligence_explainability_snapshots.intelligence_domain IS
  'HireRise intelligence domain that produced this explanation. '
  'Enables domain-scoped explanation history across all future modules.';

-- ─── R1h: Update explainability snapshot indexes ──────────────────────────────
-- The existing idx_explainability_user_subject is preserved (still valid for
-- subject-scoped lookups). New index adds domain dimension for cross-module queries.

CREATE INDEX IF NOT EXISTS idx_explainability_domain_tier
  ON public.intelligence_explainability_snapshots
  (intelligence_domain, confidence_tier, snapshot_at DESC)
  WHERE vocabulary_valid = true;

-- ─── R1i: Update explainability snapshot immutability trigger ─────────────────
-- intelligence_domain is immutable — a snapshot cannot change domain after creation.

CREATE OR REPLACE FUNCTION public.fn_explainability_snapshot_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'intelligence_explainability_snapshots is immutable. '
    'Revised explanations must be inserted as new rows. '
    'Operation: %, snapshot_id: %, intelligence_domain: %',
    TG_OP, OLD.id, OLD.intelligence_domain;
END;
$$;

-- ─── R1j: intelligence_consent_ledger — add intelligence_domain ───────────────
-- Consent is scoped per intelligence domain. A user may grant consent for
-- student intelligence but not professional intelligence (different data use).
-- NULL means the consent applies to all domains (backward-compatible for
-- existing rows which pre-date domain-scoped consent).

ALTER TABLE public.intelligence_consent_ledger
  ADD COLUMN IF NOT EXISTS intelligence_domain text
    DEFAULT NULL;

-- No NOT NULL here — NULL = cross-domain consent (backward compatible)
-- Domain-specific consent uses explicit values.

ALTER TABLE public.intelligence_consent_ledger
  DROP CONSTRAINT IF EXISTS chk_consent_domain_valid;

ALTER TABLE public.intelligence_consent_ledger
  ADD CONSTRAINT chk_consent_domain_valid
    CHECK (intelligence_domain IS NULL OR intelligence_domain IN (
      'student',
      'professional',
      'institution',
      'employer',
      'workforce',
      'cross_domain'
    ));

COMMENT ON COLUMN public.intelligence_consent_ledger.intelligence_domain IS
  'Intelligence domain this consent event applies to. '
  'NULL = applies to all domains (legacy / cross-domain consent). '
  'Explicit value = domain-scoped consent (future fine-grained consent model).';

-- ─── R1k: Add domain index on consent ledger ──────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_consent_ledger_domain
  ON public.intelligence_consent_ledger (user_id, intelligence_domain, event_at DESC)
  WHERE intelligence_domain IS NOT NULL;

-- =============================================================================
-- REFINEMENT 2: Expand consent scope vocabulary
-- =============================================================================
-- The original scope CHECK constraint is on consent_scope (a text[] column).
-- Postgres does not support CHECK constraints on array element values natively
-- without a custom function. The Sprint 1 design correctly chose text[] without
-- a per-element CHECK — enforcement happens in fn_record_consent_event().
--
-- Action: Update fn_record_consent_event() to validate all elements of the
-- scope array against the expanded vocabulary. The column definition is
-- unchanged (no structural migration needed).
--
-- New valid scopes (superset of old):
--   student_intelligence      — signals, models, snapshots for student domain
--   professional_intelligence — signals, models, snapshots for professional domain
--   institution_intelligence  — signals, models, snapshots for institution domain
--   employer_intelligence     — signals, models, snapshots for employer domain
--   workforce_intelligence    — signals, models, snapshots for workforce domain
--   recommendations           — recommendation outputs (all domains)
--   analytics                 — aggregate analytics and reporting
--   research                  — data use for research purposes
--   ai_processing             — general AI/ML model training use
--
-- Old scopes ('signals', 'snapshots') are PRESERVED in the valid list for
-- backward compatibility with existing ledger rows.
-- =============================================================================

-- Update the consent scope comment only (column structure unchanged)
COMMENT ON COLUMN public.intelligence_consent_ledger.consent_scope IS
  'Array of intelligence scopes affected by this event. '
  'Valid values (Sprint 1.1 expanded): '
  'student_intelligence, professional_intelligence, institution_intelligence, '
  'employer_intelligence, workforce_intelligence, '
  'recommendations, analytics, research, ai_processing. '
  'Legacy values (Sprint 1, still valid): signals, snapshots. '
  'Scope validation is enforced by fn_record_consent_event().';

-- =============================================================================
-- REFINEMENT 4: fn_get_active_model_version() — domain-aware active version
-- Resolution replaces fn_get_active_weight_version() for new callers.
-- The old function is preserved as a backward-compatible wrapper.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_active_model_version(
  p_intelligence_domain  text  DEFAULT 'student',
  p_model_type           text  DEFAULT 'signal_weights'
)
RETURNS public.signal_weight_versions
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public.signal_weight_versions
  WHERE intelligence_domain = p_intelligence_domain
    AND model_type          = p_model_type
    AND deprecated_at       IS NULL
    AND approved_at         IS NOT NULL
    AND effective_from      <= now()
  ORDER BY effective_from DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.fn_get_active_model_version(text, text) IS
  'Returns the currently active (approved, not deprecated) model version for '
  'a given intelligence_domain and model_type. '
  'Returns NULL if no approved version exists for that combination. '
  'This is the authoritative version resolution function for Phase 2A onward. '
  'Example: fn_get_active_model_version(''student'', ''signal_weights'') '
  'returns the v1.0.0 row seeded in Sprint 1.';

REVOKE ALL ON FUNCTION public.fn_get_active_model_version(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_active_model_version(text, text)
  TO authenticated, service_role;

-- ─── Preserve fn_get_active_weight_version() as backward-compat wrapper ───────
-- All existing callers (intelligence.service.ts, Sprint 1 code) continue
-- to work with zero changes. This wrapper calls fn_get_active_model_version().

CREATE OR REPLACE FUNCTION public.fn_get_active_weight_version()
RETURNS public.signal_weight_versions
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.fn_get_active_model_version('student', 'signal_weights');
$$;

COMMENT ON FUNCTION public.fn_get_active_weight_version() IS
  'DEPRECATED in favour of fn_get_active_model_version(domain, model_type). '
  'Preserved as backward-compatible wrapper for Sprint 1 callers. '
  'Equivalent to fn_get_active_model_version(''student'', ''signal_weights''). '
  'Migrate callers to fn_get_active_model_version() in Phase 2A.';

-- GRANTs for wrapper (unchanged from Sprint 1)
REVOKE ALL ON FUNCTION public.fn_get_active_weight_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_active_weight_version()
  TO authenticated, service_role;

-- =============================================================================
-- REFINEMENT 2 (functions): Update fn_verify_active_consent()
-- Expanded scope vocabulary; domain-aware resolution for future callers.
-- Fully backward-compatible: existing calls with old scope values still work.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_verify_active_consent(
  p_user_id              uuid,
  p_scope                text    DEFAULT 'signals',
  p_intelligence_domain  text    DEFAULT NULL
)
RETURNS TABLE (
  has_consent         boolean,
  consent_ledger_id   uuid,
  consent_version     text,
  granted_at          timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH latest_granted AS (
    SELECT
      id,
      consent_version,
      event_at
    FROM public.intelligence_consent_ledger
    WHERE user_id    = p_user_id
      AND event_type = 'granted'
      AND p_scope    = ANY(consent_scope)
      -- Domain filter: NULL param matches NULL domain (legacy) OR explicit domain.
      -- Explicit domain param matches NULL (cross-domain) OR matching domain.
      AND (
        p_intelligence_domain IS NULL
        OR intelligence_domain IS NULL
        OR intelligence_domain = p_intelligence_domain
      )
    ORDER BY event_at DESC
    LIMIT 1
  ),
  latest_withdrawn AS (
    SELECT event_at
    FROM public.intelligence_consent_ledger
    WHERE user_id    = p_user_id
      AND event_type = 'withdrawn'
      AND p_scope    = ANY(consent_scope)
      AND (
        p_intelligence_domain IS NULL
        OR intelligence_domain IS NULL
        OR intelligence_domain = p_intelligence_domain
      )
    ORDER BY event_at DESC
    LIMIT 1
  )
  SELECT
    true              AS has_consent,
    lg.id             AS consent_ledger_id,
    lg.consent_version AS consent_version,
    lg.event_at       AS granted_at
  FROM latest_granted lg
  WHERE NOT EXISTS (
    SELECT 1
    FROM latest_withdrawn lw
    WHERE lw.event_at > lg.event_at
  );
$$;

COMMENT ON FUNCTION public.fn_verify_active_consent(uuid, text, text) IS
  'Returns the active consent record for a user, scope, and optional domain. '
  'p_scope: the consent scope to check (e.g. student_intelligence, signals). '
  'p_intelligence_domain: NULL = accept cross-domain or any domain consent. '
  '                       explicit value = require domain-specific or cross-domain consent. '
  'Returns empty result if no active consent for the scope+domain combination. '
  'Backward compatible: existing 2-arg calls (user_id, scope) still work '
  'because p_intelligence_domain defaults to NULL.';

REVOKE ALL ON FUNCTION public.fn_verify_active_consent(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_verify_active_consent(uuid, text, text)
  TO authenticated, service_role;

-- Drop old 2-arg version — new function has default third arg so old call
-- sites work without any code change.
-- NOTE: Postgres allows overloaded functions. The 2-arg signature is
-- effectively replaced because the 3-arg function with default covers it.
-- If the old 2-arg function still exists as a separate overload:
DROP FUNCTION IF EXISTS public.fn_verify_active_consent(uuid, text);

-- =============================================================================
-- REFINEMENT 2 (functions): Update fn_record_consent_event()
-- Adds scope vocabulary validation and intelligence_domain parameter.
-- Backward compatible: new params default to NULL / old scopes still valid.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_record_consent_event(
  p_user_id              uuid,
  p_event_type           text,
  p_consent_version      text,
  p_collection_method    text,
  p_consent_scope        text[]  DEFAULT ARRAY['student_intelligence'],
  p_ip_address           inet    DEFAULT NULL,
  p_user_agent           text    DEFAULT NULL,
  p_session_id           text    DEFAULT NULL,
  p_intelligence_domain  text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_id      uuid;
  v_scope_item  text;
  v_valid_scopes text[] := ARRAY[
    -- Sprint 1.1 expanded vocabulary
    'student_intelligence',
    'professional_intelligence',
    'institution_intelligence',
    'employer_intelligence',
    'workforce_intelligence',
    'recommendations',
    'analytics',
    'research',
    'ai_processing',
    -- Sprint 1 legacy values (backward compatible)
    'signals',
    'snapshots'
  ];
BEGIN
  -- Validate event_type
  IF p_event_type NOT IN (
    'granted', 'withdrawn', 'version_upgrade', 'scope_expanded', 'scope_reduced'
  ) THEN
    RAISE EXCEPTION
      'fn_record_consent_event: invalid event_type %. '
      'Valid values: granted, withdrawn, version_upgrade, scope_expanded, scope_reduced.',
      p_event_type;
  END IF;

  -- Validate collection_method
  IF p_collection_method NOT IN (
    'onboarding_step', 'settings_page', 'admin_override', 'api'
  ) THEN
    RAISE EXCEPTION
      'fn_record_consent_event: invalid collection_method %. '
      'Valid values: onboarding_step, settings_page, admin_override, api.',
      p_collection_method;
  END IF;

  -- Validate intelligence_domain if provided
  IF p_intelligence_domain IS NOT NULL AND p_intelligence_domain NOT IN (
    'student', 'professional', 'institution', 'employer', 'workforce', 'cross_domain'
  ) THEN
    RAISE EXCEPTION
      'fn_record_consent_event: invalid intelligence_domain %. '
      'Valid values: student, professional, institution, employer, workforce, cross_domain.',
      p_intelligence_domain;
  END IF;

  -- Validate each scope element
  FOREACH v_scope_item IN ARRAY p_consent_scope LOOP
    IF NOT (v_scope_item = ANY(v_valid_scopes)) THEN
      RAISE EXCEPTION
        'fn_record_consent_event: invalid consent scope value %. '
        'Valid scopes: student_intelligence, professional_intelligence, '
        'institution_intelligence, employer_intelligence, workforce_intelligence, '
        'recommendations, analytics, research, ai_processing, signals, snapshots.',
        v_scope_item;
    END IF;
  END LOOP;

  -- Validate consent_version exists
  IF NOT EXISTS (
    SELECT 1 FROM public.consent_versions WHERE version = p_consent_version
  ) THEN
    RAISE EXCEPTION
      'fn_record_consent_event: consent_version % not found in consent_versions table.',
      p_consent_version;
  END IF;

  INSERT INTO public.intelligence_consent_ledger (
    user_id,
    event_type,
    consent_version,
    collection_method,
    consent_scope,
    ip_address,
    user_agent,
    session_id,
    consent_version_ref,
    intelligence_domain
  ) VALUES (
    p_user_id,
    p_event_type,
    p_consent_version,
    p_collection_method,
    p_consent_scope,
    p_ip_address,
    p_user_agent,
    p_session_id,
    p_consent_version,
    p_intelligence_domain
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

COMMENT ON FUNCTION public.fn_record_consent_event(uuid, text, text, text, text[], inet, text, text, text) IS
  'Records a consent event to the immutable ledger. '
  'Validates event_type, collection_method, all scope values, and consent_version. '
  'p_intelligence_domain: NULL = cross-domain consent (legacy compatible). '
  'explicit = domain-scoped consent. '
  'Default scope changed from [signals, recommendations, snapshots] to '
  '[student_intelligence] in Sprint 1.1. Existing rows with old scope values '
  'remain valid (backward compatible). '
  'Returns the new ledger row UUID.';

REVOKE ALL ON FUNCTION public.fn_record_consent_event(uuid, text, text, text, text[], inet, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_record_consent_event(uuid, text, text, text, text[], inet, text, text, text)
  TO service_role;

-- Drop old 8-arg signature now that the 9-arg version (with default) replaces it
DROP FUNCTION IF EXISTS public.fn_record_consent_event(uuid, text, text, text, text[], inet, text, text);

-- =============================================================================
-- REFINEMENT 2 (functions): Update fn_get_consent_history()
-- Adds intelligence_domain filter parameter (optional).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_consent_history(
  p_user_id             uuid    DEFAULT NULL,
  p_intelligence_domain text    DEFAULT NULL
)
RETURNS TABLE (
  event_type          text,
  consent_version     text,
  consent_scope       text[],
  collection_method   text,
  intelligence_domain text,
  event_at            timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    event_type,
    consent_version,
    consent_scope,
    collection_method,
    intelligence_domain,
    event_at
  FROM public.intelligence_consent_ledger
  WHERE user_id = COALESCE(p_user_id, auth.uid())
    AND (
      p_intelligence_domain IS NULL
      OR intelligence_domain IS NULL
      OR intelligence_domain = p_intelligence_domain
    )
  ORDER BY event_at ASC;
$$;

COMMENT ON FUNCTION public.fn_get_consent_history(uuid, text) IS
  'Returns consent event history for a user, optionally filtered by domain. '
  'p_user_id NULL = defaults to auth.uid() (student self-read). '
  'p_intelligence_domain NULL = returns all domains. '
  'Adds intelligence_domain to the result set (new in Sprint 1.1).';

REVOKE ALL ON FUNCTION public.fn_get_consent_history(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_consent_history(uuid, text)
  TO authenticated, service_role;

-- Drop old 1-arg signature
DROP FUNCTION IF EXISTS public.fn_get_consent_history(uuid);

-- =============================================================================
-- REFINEMENT 5: Governance traceability chain
-- intelligence_pipeline_runs gains model_version_id — a generic FK to the
-- model registry (signal_weight_versions) that can reference any model type,
-- not just signal weights.
--
-- weight_version_id is PRESERVED for Sprint 1 backward compatibility.
-- New pipeline runs should populate BOTH:
--   weight_version_id  — the signal_weights model version (backward compat)
--   model_version_id   — the primary model version for this run (generic)
-- In Sprint 2, weight_version_id will become derived from model_version_id
-- where model_type = 'signal_weights'.
-- =============================================================================

ALTER TABLE public.intelligence_pipeline_runs
  ADD COLUMN IF NOT EXISTS model_version_id uuid DEFAULT NULL
    REFERENCES public.signal_weight_versions(id)
    ON DELETE RESTRICT;

COMMENT ON COLUMN public.intelligence_pipeline_runs.model_version_id IS
  'Sprint 1.1: Generic FK to the model registry (signal_weight_versions) for '
  'the primary model version used in this pipeline run. '
  'May reference signal_weights, confidence_model, or any future model type. '
  'weight_version_id is preserved for Sprint 1 backward compatibility. '
  'In Phase 2A, weight_version_id will be derived where model_type = signal_weights.';

-- Backfill: existing runs' model_version_id = their weight_version_id
-- (weight_version_id already references signal_weights v1.0.0)
UPDATE public.intelligence_pipeline_runs
SET model_version_id = weight_version_id
WHERE model_version_id IS NULL
  AND weight_version_id IS NOT NULL;

-- Add index for model version traceability queries
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_model_version
  ON public.intelligence_pipeline_runs (model_version_id)
  WHERE model_version_id IS NOT NULL;

-- Update audit protection trigger to protect model_version_id after terminal status
-- (already updated above in R1e — model_version_id would need to be added to
-- the protected column list in fn_pipeline_run_protect_audit_columns)

CREATE OR REPLACE FUNCTION public.fn_pipeline_run_protect_audit_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'skipped_no_consent', 'skipped_no_data') THEN
    IF NEW.user_id              IS DISTINCT FROM OLD.user_id             OR
       NEW.consent_ledger_id    IS DISTINCT FROM OLD.consent_ledger_id   OR
       NEW.weight_version_id    IS DISTINCT FROM OLD.weight_version_id   OR
       NEW.model_version_id     IS DISTINCT FROM OLD.model_version_id    OR
       NEW.intelligence_domain  IS DISTINCT FROM OLD.intelligence_domain  OR
       NEW.pipeline_type        IS DISTINCT FROM OLD.pipeline_type       OR
       NEW.engine_version       IS DISTINCT FROM OLD.engine_version      OR
       NEW.input_hash           IS DISTINCT FROM OLD.input_hash          OR
       NEW.started_at           IS DISTINCT FROM OLD.started_at          OR
       NEW.created_at           IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION
        'intelligence_pipeline_runs: immutable audit columns cannot be '
        'changed after a terminal status is reached. '
        'run_id=%, status=%, intelligence_domain=%',
        OLD.id, OLD.status, OLD.intelligence_domain;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- =============================================================================
-- Update fn_get_latest_explanation() to support domain-scoped lookup
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_latest_explanation(
  p_user_id              uuid,
  p_subject_id           uuid,
  p_intelligence_domain  text DEFAULT NULL
)
RETURNS public.intelligence_explainability_snapshots
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public.intelligence_explainability_snapshots
  WHERE user_id    = p_user_id
    AND subject_id = p_subject_id
    AND (
      p_intelligence_domain IS NULL
      OR intelligence_domain = p_intelligence_domain
    )
  ORDER BY snapshot_at DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.fn_get_latest_explanation(uuid, uuid, text) IS
  'Returns the most recent explainability snapshot for a user + subject, '
  'optionally filtered by intelligence domain. '
  'p_intelligence_domain NULL = return latest regardless of domain. '
  'Backward compatible: existing 2-arg calls still work via default.';

REVOKE ALL ON FUNCTION public.fn_get_latest_explanation(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_latest_explanation(uuid, uuid, text)
  TO authenticated, service_role;

-- Drop old 2-arg signature (new 3-arg with default replaces it)
DROP FUNCTION IF EXISTS public.fn_get_latest_explanation(uuid, uuid);

-- =============================================================================
-- GRANT: new function fn_get_active_model_version (already done above)
-- Verify existing GRANTs on modified tables are unchanged
-- (REVOKE/GRANT was set in Migration 1 — no changes needed here because
-- no new roles are granted and no existing grants are removed)
-- =============================================================================

-- =============================================================================
-- UPDATE v1.0.0 seed row to include new columns
-- The ON CONFLICT DO NOTHING in Migration 1 means this row exists.
-- We UPDATE it directly to add the new column values.
-- This is safe because model_type and intelligence_domain are being SET,
-- not changed — approved_at IS NOT NULL so the immutability trigger fires,
-- but our trigger only protects version_tag, model_type, weights,
-- effective_from, and created_at. We are only setting intelligence_domain
-- which is a new column added after approval — not in the protected set yet.
-- =============================================================================

-- Temporarily allow the domain update by checking the trigger definition:
-- fn_signal_weight_version_protect blocks changes to:
--   version_tag, model_type, weights, effective_from, created_at
-- intelligence_domain is NOT in that list → update is permitted.
UPDATE public.signal_weight_versions
SET intelligence_domain = 'student'
WHERE version_tag = 'v1.0.0'
  AND model_type  = 'signal_weights'
  AND intelligence_domain IS NULL;

-- Now add intelligence_domain to the immutability protection list
CREATE OR REPLACE FUNCTION public.fn_signal_weight_version_protect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.approved_at IS NOT NULL THEN
    IF NEW.version_tag          IS DISTINCT FROM OLD.version_tag         OR
       NEW.model_type           IS DISTINCT FROM OLD.model_type          OR
       NEW.intelligence_domain  IS DISTINCT FROM OLD.intelligence_domain  OR
       NEW.weights              IS DISTINCT FROM OLD.weights             OR
       NEW.effective_from       IS DISTINCT FROM OLD.effective_from      OR
       NEW.created_at           IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION
        'signal_weight_versions (model registry): immutable columns '
        '(version_tag, model_type, intelligence_domain, weights, effective_from, '
        'created_at) cannot be changed after approval. Create a new version instead. '
        'intelligence_domain=%, model_type=%, version_tag=%, id=%',
        OLD.intelligence_domain, OLD.model_type, OLD.version_tag, OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- =============================================================================
-- SCHEMA COMMENT UPDATE
-- =============================================================================

COMMENT ON SCHEMA public IS
  'HireRise Phase 1.6 Sprint 1.1 — Governance Foundation Refined. '
  'Sprint 1: signal_weight_versions, intelligence_consent_ledger, '
  'intelligence_pipeline_runs, intelligence_explainability_snapshots. '
  'Sprint 1.1: intelligence_domain, model_type, model_version_id, '
  'expanded consent scopes, fn_get_active_model_version(). '
  'Migration: 20260601000004_governance_refinements.sql';

COMMIT;