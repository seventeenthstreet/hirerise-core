-- =============================================================================
-- HireRise Phase 2 — WP-P2-01 Source Intelligence Management (SIM)
-- Migration: 20260706000001_wp_p2_01_sim_enterprise_foundation.sql
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------------------------------------------------------
-- The SIM module (src/modules/source-intelligence) was implemented against
-- three tables — sim_sources, sim_source_health_snapshots,
-- sim_source_audit_log — but no prior migration in this repository actually
-- creates them. This migration is therefore split into two clearly labeled
-- parts:
--
--   PART A — Baseline schema (CREATE TABLE IF NOT EXISTS). Brings the
--            database in line with what source.model.js / the repositories
--            have always assumed. If these tables already exist in the live
--            database (e.g. created out-of-band and simply never committed),
--            every statement here is a no-op for them.
--
--   PART B — WP-P2-01 Enterprise Enhancement columns (ADD COLUMN IF NOT
--            EXISTS), all nullable/defaulted, plus the new
--            sim_source_relationships table (Enhancement 8).
--
--   PART C — WP-P2-01A Enterprise Enhancement & Closure. Adds the
--            remaining items from the closure spec that Part B did not yet
--            cover: a stable external_key identifier (Enhancement 9),
--            enterprise data-integrity CHECK constraints validated against
--            any existing rows (Enhancement 10), an idempotent
--            updated_at-maintenance trigger (Enhancement 11), and a small
--            set of additional indexes identified in the enterprise index
--            review (Enhancement 12).
--
-- NOTE ON NAMING — Part B already implemented several items from the
-- closure spec under names that match this repository's existing
-- conventions rather than the spec's suggested names, e.g.
-- capability_profile (spec: capabilities), canonical_entity_coverage
-- (spec: canonical_entities), connector_compatibility (spec:
-- supported_connectors). Part C does not rename or duplicate these; see
-- the Enterprise Closure Assessment at the end of this file for the full
-- mapping.
--
-- BACKWARD COMPATIBILITY
--   - No existing table, column, or constraint is dropped, renamed, or
--     narrowed.
--   - All new columns are nullable or carry a safe default — no existing
--     row (if any already exist) breaks.
--   - All new indexes are additive.
--   - Enum-like values are enforced with CHECK constraints that mirror the
--     JS-side enums in source.model.js exactly, so validator.js and this
--     migration can never silently drift apart without both failing loudly.
--
-- EXECUTION: Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT
--            EXISTS throughout).
-- =============================================================================

BEGIN;

-- =============================================================================
-- PART A — Baseline schema
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.sim_sources (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Metadata (see SOURCE_METADATA_FIELDS in source.model.js)
  display_name              text NOT NULL,
  description               text,
  category                  text,
  subcategory               text,
  owner                     text,
  maintainer                text,
  country                   text,
  region                    text,
  coverage                  text,
  language                  text,
  source_type               text NOT NULL,
  authentication_method     text,
  api_endpoint              text,
  website                   text,
  license                   text,
  usage_restrictions        text,
  update_frequency          text,
  expected_freshness_hours  integer,
  collection_method         text,
  preferred_connector       text,
  priority                  text,
  tags                      text[] DEFAULT '{}'::text[],
  notes                     text,
  auth_metadata             jsonb,
  licensing_metadata        jsonb,
  monitoring_config         jsonb,
  governance_metadata       jsonb,

  -- System-managed fields (see SOURCE_SYSTEM_FIELDS in source.model.js)
  trust_score               numeric,
  reliability_score         numeric,
  status                    text NOT NULL DEFAULT 'pending_approval',
  approval_status           text NOT NULL DEFAULT 'not_submitted',
  approved_by               text,
  approved_at               timestamptz,
  health_status             text NOT NULL DEFAULT 'unknown',
  failure_count             integer DEFAULT 0,
  last_successful_access    timestamptz,
  last_failure              timestamptz,

  -- BaseRepository audit/versioning columns
  version                   integer NOT NULL DEFAULT 1,
  soft_deleted              boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  created_by                text NOT NULL DEFAULT 'system',
  updated_by                text NOT NULL DEFAULT 'system'
);

COMMENT ON TABLE public.sim_sources IS
  'WP-P2-01 Source Intelligence Management: the authoritative registry of '
  'every external knowledge source consumed by HireRise. SIM is the only '
  'writer of this table. See src/modules/source-intelligence.';

CREATE TABLE IF NOT EXISTS public.sim_source_health_snapshots (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id                uuid NOT NULL REFERENCES public.sim_sources(id) ON DELETE CASCADE,
  observed_at              timestamptz NOT NULL DEFAULT now(),
  available                boolean,
  response_success_rate    numeric,
  latency_ms               integer,
  succeeded                boolean,
  failure_reason           text,
  health_status            text,
  raw_metadata             jsonb
);

COMMENT ON TABLE public.sim_source_health_snapshots IS
  'WP-P2-01 SIM: append-only health observation time series per source. '
  'Denormalized current-health fields on sim_sources are maintained by '
  'sourceHealth.service.js from this history.';

CREATE TABLE IF NOT EXISTS public.sim_source_audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     uuid NOT NULL REFERENCES public.sim_sources(id) ON DELETE CASCADE,
  action        text NOT NULL,
  actor_id      text NOT NULL DEFAULT 'system',
  before_state  jsonb,
  after_state   jsonb,
  reason        text,
  metadata      jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sim_source_audit_log IS
  'WP-P2-01 SIM: append-only, immutable compliance audit trail. Every '
  'governance-relevant action (registration, metadata change, status '
  'transition, approval decision, relationship change) is recorded here.';

-- Baseline indexes supporting the existing repository query patterns
-- (search, findByExternalKey, listByStatus).
CREATE INDEX IF NOT EXISTS idx_sim_sources_status
  ON public.sim_sources (status) WHERE soft_deleted = false;
CREATE INDEX IF NOT EXISTS idx_sim_sources_source_type
  ON public.sim_sources (source_type) WHERE soft_deleted = false;
CREATE INDEX IF NOT EXISTS idx_sim_sources_category
  ON public.sim_sources (category) WHERE soft_deleted = false;
CREATE INDEX IF NOT EXISTS idx_sim_sources_api_endpoint
  ON public.sim_sources (api_endpoint) WHERE soft_deleted = false;
CREATE INDEX IF NOT EXISTS idx_sim_sources_website
  ON public.sim_sources (website) WHERE soft_deleted = false;
CREATE INDEX IF NOT EXISTS idx_sim_source_health_snapshots_source_observed
  ON public.sim_source_health_snapshots (source_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sim_source_audit_log_source_occurred
  ON public.sim_source_audit_log (source_id, occurred_at DESC);

-- =============================================================================
-- PART B — WP-P2-01 Enterprise Enhancement columns (additive)
-- =============================================================================

-- ── Enhancement 1: Source Capability Profile ────────────────────────────────
-- {capability_key: boolean}. Validated app-side by isValidCapabilityProfile()
-- against SOURCE_CAPABILITIES in source.model.js.
ALTER TABLE public.sim_sources
  ADD COLUMN IF NOT EXISTS capability_profile jsonb DEFAULT NULL;

COMMENT ON COLUMN public.sim_sources.capability_profile IS
  'WP-P2-01 Enterprise Enhancement 1. Metadata only — {capability: boolean} '
  'map (incremental_sync, full_sync, search_api, bulk_export, pagination, '
  'webhooks, attachments, oauth, anonymous_access, rate_limits, '
  'delta_support, snapshot_support). Consumed by COM to plan collection.';

-- ── Enhancement 2: Knowledge Domain Classification ──────────────────────────
ALTER TABLE public.sim_sources
  ADD COLUMN IF NOT EXISTS knowledge_domains text[] DEFAULT '{}'::text[];

ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_knowledge_domains_valid;

ALTER TABLE public.sim_sources
  ADD CONSTRAINT chk_sim_sources_knowledge_domains_valid
    CHECK (knowledge_domains <@ ARRAY[
      'institution','occupation','course','scholarship','skill','employer',
      'salary','certification','admission','labour_market','future_skills',
      'government_policy','career_outcome'
    ]::text[]);

COMMENT ON COLUMN public.sim_sources.knowledge_domains IS
  'WP-P2-01 Enterprise Enhancement 2. Which knowledge domains this source '
  'provides. A source may declare multiple domains.';

CREATE INDEX IF NOT EXISTS idx_sim_sources_knowledge_domains
  ON public.sim_sources USING GIN (knowledge_domains);

-- ── Enhancement 3: Canonical Entity Coverage ────────────────────────────────
ALTER TABLE public.sim_sources
  ADD COLUMN IF NOT EXISTS canonical_entity_coverage text[] DEFAULT '{}'::text[];

ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_canonical_entities_valid;

ALTER TABLE public.sim_sources
  ADD CONSTRAINT chk_sim_sources_canonical_entities_valid
    CHECK (canonical_entity_coverage <@ ARRAY[
      'institution','occupation','skill','scholarship','employer',
      'salary_band','certification','admission_rule','industry',
      'career_outcome'
    ]::text[]);

COMMENT ON COLUMN public.sim_sources.canonical_entity_coverage IS
  'WP-P2-01 Enterprise Enhancement 3. Which canonical (published) entities '
  'this source contributes to. Feeds Canonical Knowledge Publishing '
  'provenance without SIM needing to know how publishing works.';

CREATE INDEX IF NOT EXISTS idx_sim_sources_canonical_entity_coverage
  ON public.sim_sources USING GIN (canonical_entity_coverage);

-- ── Enhancement 4: Enterprise Data Quality Profile ──────────────────────────
-- Deliberately separate from trust_score / reliability_score.
ALTER TABLE public.sim_sources
  ADD COLUMN IF NOT EXISTS data_quality_profile jsonb DEFAULT NULL;

COMMENT ON COLUMN public.sim_sources.data_quality_profile IS
  'WP-P2-01 Enterprise Enhancement 4. {dimension: 0-100 score} for '
  'completeness, accuracy, consistency, timeliness, coverage, freshness, '
  'uniqueness. Independent of trust_score (provenance/governance signal) '
  'and reliability_score (observed uptime).';

-- ── Enhancement 5: Compliance & Licensing Metadata ──────────────────────────
-- Additive alongside license / usage_restrictions / licensing_metadata,
-- which are preserved unchanged.
ALTER TABLE public.sim_sources
  ADD COLUMN IF NOT EXISTS compliance_metadata jsonb DEFAULT NULL;

COMMENT ON COLUMN public.sim_sources.compliance_metadata IS
  'WP-P2-01 Enterprise Enhancement 5. Enterprise-governance superset of '
  'licensing metadata: licenseVersion, commercialUsage, '
  'redistributionPermission, robotsPolicy, termsAccepted, piiPresence, '
  'dataRetentionPolicy, complianceNotes. licensing_metadata is preserved '
  'for backward compatibility; consolidation is tracked as technical debt.';

-- ── Enhancement 6: Connector Compatibility ──────────────────────────────────
ALTER TABLE public.sim_sources
  ADD COLUMN IF NOT EXISTS connector_compatibility text[] DEFAULT '{}'::text[];

ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_connector_compatibility_valid;

ALTER TABLE public.sim_sources
  ADD CONSTRAINT chk_sim_sources_connector_compatibility_valid
    CHECK (connector_compatibility <@ ARRAY[
      'rest','graphql','soap','rss','csv','excel','json','xml','pdf','html',
      'web_scraper','webhook','manual_upload','ai_extraction'
    ]::text[]);

COMMENT ON COLUMN public.sim_sources.connector_compatibility IS
  'WP-P2-01 Enterprise Enhancement 6. EDF connector types this source is '
  'compatible with. Lets COM select an EDF connector without SIM knowing '
  'anything about EDF internals.';

CREATE INDEX IF NOT EXISTS idx_sim_sources_connector_compatibility
  ON public.sim_sources USING GIN (connector_compatibility);

-- ── Enhancement 7: Knowledge Freshness Policy ───────────────────────────────
-- Extends (does not replace) update_frequency / expected_freshness_hours.
ALTER TABLE public.sim_sources
  ADD COLUMN IF NOT EXISTS freshness_policy jsonb DEFAULT NULL;

COMMENT ON COLUMN public.sim_sources.freshness_policy IS
  'WP-P2-01 Enterprise Enhancement 7. {expectedFreshnessHours, '
  'freshnessSlaHours, maximumAcceptableAgeHours, refreshPriority, '
  'expirationBehaviour}. Superset of the pre-existing update_frequency / '
  'expected_freshness_hours columns, which are preserved unchanged.';

-- ── Enhancement 8: Source Relationship Model ────────────────────────────────
-- Modeled as its own table (not an array column) so relationships get real
-- referential integrity and can be queried from either direction cheaply.
CREATE TABLE IF NOT EXISTS public.sim_source_relationships (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           uuid NOT NULL REFERENCES public.sim_sources(id) ON DELETE CASCADE,
  related_source_id   uuid NOT NULL REFERENCES public.sim_sources(id) ON DELETE CASCADE,
  relationship_type   text NOT NULL,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text NOT NULL DEFAULT 'system',

  CONSTRAINT chk_sim_source_relationships_no_self_reference
    CHECK (source_id <> related_source_id),

  CONSTRAINT chk_sim_source_relationships_type_valid
    CHECK (relationship_type IN (
      'parent','child','mirror','backup','depends_on','successor',
      'replaces','alternative'
    )),

  CONSTRAINT uq_sim_source_relationships_exact
    UNIQUE (source_id, related_source_id, relationship_type)
);

COMMENT ON TABLE public.sim_source_relationships IS
  'WP-P2-01 Enterprise Enhancement 8. Directed edges between two sources '
  '(parent/child, mirror, backup, depends_on, successor, replaces, '
  'alternative), enabling future COM orchestration and failover. SIM only '
  'records and exposes this graph; acting on it is a COM concern.';

CREATE INDEX IF NOT EXISTS idx_sim_source_relationships_source
  ON public.sim_source_relationships (source_id);
CREATE INDEX IF NOT EXISTS idx_sim_source_relationships_related
  ON public.sim_source_relationships (related_source_id);

-- =============================================================================
-- PART C — WP-P2-01A Enterprise Enhancement & Closure (additive)
-- =============================================================================

-- ── Enhancement 9: Stable External Source Key ───────────────────────────────
-- Human-readable, stable identifier for configuration, automation, COM/EDF
-- wiring, logging, and administration (e.g. 'ugc_india', 'ncs', 'coursera',
-- 'linkedin_learning', 'aicte', 'kerala_psc'). Independent of the surrogate
-- uuid id, which is safe for FKs but not fit for humans to type into config.
-- Nullable so existing rows (if any) are unaffected; UNIQUE permits any
-- number of NULLs in Postgres, so backfilling can happen gradually.
ALTER TABLE public.sim_sources
  ADD COLUMN IF NOT EXISTS external_key text;

ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS uq_sim_sources_external_key;
ALTER TABLE public.sim_sources
  ADD CONSTRAINT uq_sim_sources_external_key UNIQUE (external_key);

-- Format discipline: lower_snake_case only, matching every example in the
-- spec. Added NOT VALID + VALIDATE so an already-populated table is never
-- held under a long-lived exclusive lock while historical rows are checked.
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_external_key_format;
ALTER TABLE public.sim_sources
  ADD CONSTRAINT chk_sim_sources_external_key_format
    CHECK (external_key IS NULL OR external_key ~ '^[a-z0-9_]+$') NOT VALID;
ALTER TABLE public.sim_sources
  VALIDATE CONSTRAINT chk_sim_sources_external_key_format;

COMMENT ON COLUMN public.sim_sources.external_key IS
  'WP-P2-01A Enterprise Enhancement 9. Stable, human-readable, lower_snake_'
  'case identifier used by configuration, automation, COM, EDF, logging, '
  'and admin tooling. Distinct from the surrogate uuid primary key.';

-- ── Enhancement 10: Enterprise Data Integrity Constraints ───────────────────
-- Every constraint below explicitly tolerates NULL on columns that are
-- nullable today, so no existing row can violate it, and every constraint
-- is added NOT VALID then validated separately to avoid a blocking table
-- scan under an exclusive lock on a live, populated table.
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_trust_score_range;
ALTER TABLE public.sim_sources
  ADD CONSTRAINT chk_sim_sources_trust_score_range
    CHECK (trust_score IS NULL OR trust_score BETWEEN 0 AND 100) NOT VALID;
ALTER TABLE public.sim_sources
  VALIDATE CONSTRAINT chk_sim_sources_trust_score_range;

ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_reliability_score_range;
ALTER TABLE public.sim_sources
  ADD CONSTRAINT chk_sim_sources_reliability_score_range
    CHECK (reliability_score IS NULL OR reliability_score BETWEEN 0 AND 100) NOT VALID;
ALTER TABLE public.sim_sources
  VALIDATE CONSTRAINT chk_sim_sources_reliability_score_range;

ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_failure_count_non_negative;
ALTER TABLE public.sim_sources
  ADD CONSTRAINT chk_sim_sources_failure_count_non_negative
    CHECK (failure_count IS NULL OR failure_count >= 0) NOT VALID;
ALTER TABLE public.sim_sources
  VALIDATE CONSTRAINT chk_sim_sources_failure_count_non_negative;

-- version is NOT NULL DEFAULT 1 already, so no NULL branch is needed here.
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_version_positive;
ALTER TABLE public.sim_sources
  ADD CONSTRAINT chk_sim_sources_version_positive
    CHECK (version > 0) NOT VALID;
ALTER TABLE public.sim_sources
  VALIDATE CONSTRAINT chk_sim_sources_version_positive;

-- ── Enhancement 11: Automatic updated_at Trigger ────────────────────────────
-- CREATE OR REPLACE + DROP TRIGGER IF EXISTS makes this idempotent. This is
-- a database-level backstop, not a replacement for BaseRepository setting
-- updated_at on every write today — if the two ever disagree the trigger's
-- clock reading wins, which is the correct enterprise-grade behaviour (no
-- code path can ever forget to stamp updated_at again).
CREATE OR REPLACE FUNCTION public.sim_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.sim_set_updated_at() IS
  'WP-P2-01A Enterprise Enhancement 11. Stamps updated_at on every UPDATE '
  'to any table it is attached to, independent of application code.';

DROP TRIGGER IF EXISTS trg_sim_sources_set_updated_at ON public.sim_sources;
CREATE TRIGGER trg_sim_sources_set_updated_at
  BEFORE UPDATE ON public.sim_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.sim_set_updated_at();

-- ── Enhancement 12: Enterprise Index Review ─────────────────────────────────
-- external_key is already covered by the UNIQUE constraint above (Postgres
-- backs every UNIQUE constraint with an index). parent/child lookups on
-- sim_source_relationships are already covered by
-- idx_sim_source_relationships_source/_related from Part B. The two gaps
-- identified on review:
--   1. Filtering relationships by type (e.g. "all mirror relationships")
--      had no supporting index.
--   2. capability_profile and compliance_metadata are the two JSONB columns
--      most likely to be queried by containment (e.g. "sources with oauth
--      capability", "sources with piiPresent = true") from COM/EDF and
--      governance tooling, so they get GIN indexes. data_quality_profile
--      and freshness_policy are populated/read by dashboards as whole
--      objects rather than filtered by key, so a GIN index there would add
--      write overhead without a matching read pattern — intentionally
--      omitted.
CREATE INDEX IF NOT EXISTS idx_sim_source_relationships_type
  ON public.sim_source_relationships (relationship_type);

CREATE INDEX IF NOT EXISTS idx_sim_sources_capability_profile
  ON public.sim_sources USING GIN (capability_profile jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_sim_sources_compliance_metadata
  ON public.sim_sources USING GIN (compliance_metadata jsonb_path_ops);

-- =============================================================================
-- PART D — Pre-Freeze Production Hardening Review (additive)
-- =============================================================================
--
-- Scope of this review: close the two integrity gaps identified against the
-- hardening checklist (lifecycle enforcement, external_key strategy). All
-- other checklist items (JSON defaults, schema-consistency audit, index
-- review, migration-quality review) were reviewed and found to require no
-- SQL change; the reasoning for each is recorded in the ENTERPRISE CLOSURE
-- ASSESSMENT at the end of this file so the "why not" is on the record
-- alongside the "why".

-- ── Hardening 1: Lifecycle State Enforcement ────────────────────────────────
-- status / approval_status / health_status have been plain `text` with an
-- application-side allow-list (SOURCE_STATUS / APPROVAL_STATUS / HEALTH_STATUS
-- in source.model.js) but no database-level guarantee. A direct write (bad
-- migration, manual admin query, future service that doesn't import the
-- model) could silently persist a value the state machine never defined.
--
-- CHECK constraints, not PostgreSQL ENUM types, are used here — matching the
-- pattern this file already uses for knowledge_domains /
-- canonical_entity_coverage / connector_compatibility. An ENUM would require
-- converting a live `text` column via ALTER COLUMN ... TYPE with a USING
-- cast, which is a materially more invasive, harder-to-reverse structural
-- change for the same integrity guarantee, and every future addition to the
-- state machine (a realistic event for a lifecycle model) would need a
-- separate ALTER TYPE ... ADD VALUE migration with its own transactional
-- restrictions. A CHECK constraint gives identical enforcement, is dropped
-- and re-added in one statement, and needs no application or driver change
-- since node-postgres already returns `text` columns as plain strings.
-- Values mirror SOURCE_STATUS / APPROVAL_STATUS / HEALTH_STATUS in
-- source.model.js exactly; a future drift between the two will fail loudly
-- (INSERT/UPDATE error) rather than silently.
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_status_valid;
ALTER TABLE public.sim_sources
  ADD CONSTRAINT chk_sim_sources_status_valid
    CHECK (status IN (
      'pending_approval','active','inactive','review_required','deprecated',
      'blocked','archived'
    )) NOT VALID;
ALTER TABLE public.sim_sources
  VALIDATE CONSTRAINT chk_sim_sources_status_valid;

ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_approval_status_valid;
ALTER TABLE public.sim_sources
  ADD CONSTRAINT chk_sim_sources_approval_status_valid
    CHECK (approval_status IN (
      'not_submitted','pending','approved','rejected'
    )) NOT VALID;
ALTER TABLE public.sim_sources
  VALIDATE CONSTRAINT chk_sim_sources_approval_status_valid;

ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_health_status_valid;
ALTER TABLE public.sim_sources
  ADD CONSTRAINT chk_sim_sources_health_status_valid
    CHECK (health_status IN (
      'unknown','healthy','degraded','unhealthy'
    )) NOT VALID;
ALTER TABLE public.sim_sources
  VALIDATE CONSTRAINT chk_sim_sources_health_status_valid;

-- sim_source_health_snapshots.health_status is nullable (a snapshot row can
-- be recorded before a health classification is derived), so the constraint
-- explicitly tolerates NULL rather than forcing every snapshot to carry one.
ALTER TABLE public.sim_source_health_snapshots
  DROP CONSTRAINT IF EXISTS chk_sim_source_health_snapshots_health_status_valid;
ALTER TABLE public.sim_source_health_snapshots
  ADD CONSTRAINT chk_sim_source_health_snapshots_health_status_valid
    CHECK (health_status IS NULL OR health_status IN (
      'unknown','healthy','degraded','unhealthy'
    )) NOT VALID;
ALTER TABLE public.sim_source_health_snapshots
  VALIDATE CONSTRAINT chk_sim_source_health_snapshots_health_status_valid;

-- ── Hardening 2: External Key Strategy ──────────────────────────────────────
-- The Part C constraint (uq_sim_sources_external_key, a plain UNIQUE
-- constraint) makes an external_key permanently unavailable once claimed,
-- even after the owning row is soft-deleted. That is the wrong shape for an
-- enterprise source registry: soft_deleted is this repository's designated
-- "no longer part of the live set" signal (every other partial index in
-- Part A scopes on it), and a decommissioned source's human-readable slug
-- (e.g. 'ncs') should be free for a legitimate successor to claim, while any
-- source still in the live set — active, inactive, deprecated, blocked, or
-- archived, none of which imply soft_deleted — keeps its key guaranteed
-- unique. A plain UNIQUE constraint cannot express that scope; a partial
-- UNIQUE INDEX can, and Postgres already backs a UNIQUE constraint with an
-- index internally, so this is a like-for-like replacement rather than a new
-- kind of object. NULLs remain unrestricted either way (Postgres never
-- treats two NULLs as duplicates in a unique index), so nothing changes for
-- rows that haven't been backfilled with an external_key yet.
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS uq_sim_sources_external_key;
DROP INDEX IF EXISTS public.uq_sim_sources_external_key_live;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sim_sources_external_key_live
  ON public.sim_sources (external_key)
  WHERE soft_deleted = false;

COMMENT ON COLUMN public.sim_sources.external_key IS
  'WP-P2-01A Enterprise Enhancement 9 (scope hardened in Part D). Stable, '
  'human-readable, lower_snake_case identifier used by configuration, '
  'automation, COM, EDF, logging, and admin tooling. Distinct from the '
  'surrogate uuid primary key. Unique only among live rows '
  '(soft_deleted = false) via uq_sim_sources_external_key_live, so a '
  'decommissioned source''s key can be reclaimed by a legitimate successor.';

COMMIT;

-- =============================================================================
-- ENTERPRISE CLOSURE ASSESSMENT
-- =============================================================================
--
-- Spec enhancement -> implementation mapping:
--   1.  external_key                    -> Part C: external_key (unique, format-checked)
--   2.  capabilities                    -> Part B: capability_profile (jsonb)
--   3.  knowledge_domains               -> Part B: knowledge_domains (text[], CHECK-constrained, GIN)
--   4.  canonical_entities              -> Part B: canonical_entity_coverage (text[], CHECK-constrained, GIN)
--   5.  data_quality                    -> Part B: data_quality_profile (jsonb)
--   6.  compliance_metadata             -> Part B: compliance_metadata (jsonb, now GIN-indexed)
--   7.  supported_connectors            -> Part B: connector_compatibility (text[], CHECK-constrained, GIN)
--   8.  freshness_policy                -> Part B: freshness_policy (jsonb)
--   9.  parent_source_id / relationships -> Part B: sim_source_relationships table
--                                           (chosen over a single parent_source_id column so a
--                                           source can have more than one relationship and in
--                                           more than one direction, with real FK integrity)
--   10. CHECK constraints               -> Part C: trust_score, reliability_score, failure_count, version
--   11. updated_at trigger              -> Part C: sim_set_updated_at() + trg_sim_sources_set_updated_at
--   12. Index review                    -> Part C: relationship-type, capability_profile, compliance_metadata
--
-- Verification against the closure criteria:
--   - Idempotent            : every statement uses IF NOT EXISTS / OR REPLACE / DROP...IF EXISTS
--                              before CREATE, so re-running this file is a no-op past the first run.
--   - Backward compatible   : no column dropped, renamed, or narrowed; every new column is
--                              nullable or defaulted; every new CHECK explicitly tolerates the
--                              current NULL state of the column it constrains.
--   - Production ready      : new CHECK constraints on the (possibly populated) sim_sources
--                              table are added NOT VALID and validated in a separate statement,
--                              avoiding a blocking table scan under an exclusive lock.
--   - Repository compatible : no column BaseRepository or the SIM repositories read/write today
--                              changed shape; external_key and the Part C constraints are purely
--                              additive and require no repository changes to adopt later.
--   - Enterprise grade      : stable external identity, capability/quality/compliance/freshness
--                              metadata, a relationship graph, integrity constraints, an
--                              application-independent updated_at guarantee, and indexes matched
--                              to real query patterns are all present.
--
-- =============================================================================
-- PRE-FREEZE HARDENING REVIEW — findings per checklist item
-- =============================================================================
--
-- 1. Lifecycle State Enforcement
--    CHANGED. status / approval_status / health_status had no database-level
--    enforcement despite being state-machine fields. Added CHECK constraints
--    (not ENUM types — see Part D for the reasoning) mirroring SOURCE_STATUS /
--    APPROVAL_STATUS / HEALTH_STATUS in source.model.js exactly, plus the
--    matching nullable-tolerant CHECK on
--    sim_source_health_snapshots.health_status.
--
-- 2. JSON Default Consistency
--    NO CHANGE. auth_metadata, licensing_metadata, monitoring_config,
--    governance_metadata, capability_profile, data_quality_profile,
--    compliance_metadata, and freshness_policy are all optional enterprise
--    metadata objects where a source legitimately has "not yet assessed /
--    not provided" (NULL) as a distinct state from "assessed and found to be
--    empty" ({}). Collapsing that to a '{}'::jsonb default would erase a
--    real distinction dashboards and governance tooling can use (e.g. "no
--    data_quality_profile yet" vs "profiled with zero populated
--    dimensions"), which is exactly the "NULL has semantic meaning"
--    exception the review brief itself calls out. The array-typed metadata
--    columns (tags, knowledge_domains, canonical_entity_coverage,
--    connector_compatibility) already consistently default to '{}' — that
--    was verified, not changed.
--
-- 3. External Key Strategy
--    CHANGED. See Part D, Hardening 2. Partial UNIQUE INDEX
--    (uq_sim_sources_external_key_live, WHERE soft_deleted = false) replaces
--    the plain UNIQUE constraint so a decommissioned source's key can be
--    reclaimed by a legitimate successor without weakening uniqueness among
--    live rows.
--
-- 4. Schema Consistency Audit
--    NO CHANGE beyond the rename implicit in item 3. Verified: idx_/chk_/
--    uq_/trg_ naming is applied consistently across every object in this
--    file; every FK column is covered by a leading index (composite indexes
--    on the health-snapshot and audit-log tables double as the FK index);
--    every new column and table carries a COMMENT; audit columns
--    (created_at/updated_at/created_by/updated_by/version/soft_deleted) are
--    present on sim_sources and deliberately absent from the two append-only
--    tables (health_snapshots, audit_log), which is documented, not an
--    oversight; every new FK uses ON DELETE CASCADE consistently.
--
-- 5. Performance Review
--    NO CHANGE. api_endpoint and website are indexed because
--    sourceRegistry.repository.js#findByExternalKey performs equality
--    lookups on both for de-duplication — confirmed against the repository,
--    not assumed. capability_profile and compliance_metadata carry GIN
--    indexes because COM/governance tooling filter on them by containment;
--    data_quality_profile and freshness_policy deliberately do not, per
--    Part C's own reasoning, which was reviewed and confirmed still correct.
--    auth_metadata / licensing_metadata / monitoring_config /
--    governance_metadata have no identified filter-by-containment query
--    pattern in the repository layer, so no GIN index was added for them —
--    adding one now would be exactly the speculative indexing this review
--    was told to avoid.
--
-- 6. Migration Quality Review
--    NO CHANGE to structure. Part D follows the same idempotency pattern as
--    Parts A-C throughout (DROP ... IF EXISTS before CREATE/ADD, IF NOT
--    EXISTS on indexes, NOT VALID + separate VALIDATE CONSTRAINT for every
--    CHECK added against the possibly-populated sim_sources table so no
--    statement takes a blocking exclusive lock for a full table scan).
--    Single BEGIN/COMMIT transaction, gen_random_uuid() usage, and trigger
--    idempotency (DROP TRIGGER IF EXISTS + CREATE TRIGGER) were all
--    inherited unchanged from Parts A-C and re-verified rather than
--    re-implemented.
--
-- Status: READY TO FREEZE as the authoritative WP-P2-01 SIM database schema
-- for the remainder of Phase-2, subject to the one open item below.
--
-- Open item (not a blocker, flagged for the record): licensing_metadata and
-- compliance_metadata now overlap in purpose. Part B already noted this and
-- deliberately kept both for backward compatibility; consolidating them is
-- tracked as technical debt for a future migration, not part of this
-- closure.
-- =============================================================================