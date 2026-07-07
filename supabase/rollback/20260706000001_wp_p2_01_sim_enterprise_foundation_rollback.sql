-- =============================================================================
-- Migration: 20260706000001_wp_p2_01_sim_enterprise_foundation_rollback.sql
-- Work Package: WP-P2-01 — Source Intelligence Management (Enterprise
--   Enhancement Rollback)
--
-- PART MAPPING (mirrors the forward migration's Part A/B/C/D exactly)
--   PART A — Baseline schema (sim_sources, sim_source_health_snapshots,
--            sim_source_audit_log). NOT reversed here — see safety warning.
--   PART B — Enterprise Enhancement columns + sim_source_relationships.
--            Reversed below in "Reverse Part B".
--   PART C — WP-P2-01A Enterprise Enhancement & Closure (external_key,
--            data-integrity CHECK constraints, updated_at trigger, index
--            review). Reversed below in "Reverse Part C".
--   PART D — Pre-Freeze Production Hardening Review (lifecycle CHECK
--            constraints, partial-unique external_key index). Reversed
--            below in "Reverse Part D".
--
-- SAFETY WARNING — READ BEFORE EXECUTING
--   - This rollback reverses PART B, PART C, and PART D (the enterprise
--     enhancement columns, sim_source_relationships, the WP-P2-01A closure
--     items — external_key, the CHECK constraints, and the updated_at
--     trigger — and the pre-freeze hardening pass — lifecycle CHECK
--     constraints and the partial-unique external_key index) of the forward
--     migration.
--   - It deliberately does NOT drop sim_sources, sim_source_health_snapshots,
--     or sim_source_audit_log (Part A). Once sources are registered and any
--     downstream module (COM, EDF, audit history) has read from them, those
--     tables are load-bearing; dropping them is a separate, explicitly
--     reviewed decision, not a side effect of un-doing this enhancement.
--   - Do NOT execute this rollback once COM or any other consumer has begun
--     reading capability_profile, knowledge_domains, canonical_entity_
--     coverage, data_quality_profile, compliance_metadata,
--     connector_compatibility, freshness_policy, external_key, or
--     sim_source_relationships. Confirm with WP-COM owners first.
--   - Rolling back is destructive for any enterprise metadata already
--     captured on existing sources — it is not recoverable after COMMIT.
-- =============================================================================

BEGIN;

-- ── Reverse Part D ───────────────────────────────────────────────────────

ALTER TABLE public.sim_source_health_snapshots
  DROP CONSTRAINT IF EXISTS chk_sim_source_health_snapshots_health_status_valid;
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_health_status_valid;
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_approval_status_valid;
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_status_valid;

DROP INDEX IF EXISTS public.uq_sim_sources_external_key_live;

-- ── Reverse Part C ───────────────────────────────────────────────────────

-- Trigger is dropped by name before the function, so the function has zero
-- dependents by the time it's dropped and plain DROP FUNCTION IF EXISTS
-- already succeeds without CASCADE. CASCADE is deliberately NOT added here:
-- with zero known dependents it changes nothing today, but if a future
-- migration ever attaches another trigger to sim_set_updated_at() without
-- updating this rollback, CASCADE would silently drop that unrelated
-- trigger too instead of failing loudly — the failure is the desired
-- outcome (a signal this script needs updating), so CASCADE would trade
-- robustness for a silent scope expansion, not a genuine safety
-- improvement.
DROP TRIGGER IF EXISTS trg_sim_sources_set_updated_at ON public.sim_sources;
DROP FUNCTION IF EXISTS public.sim_set_updated_at();

-- idx_sim_source_relationships_type is NOT dropped explicitly here: it lives
-- on sim_source_relationships, which is dropped below in "Reverse Part B",
-- and DROP TABLE already removes every index defined on that table. The
-- three sim_sources indexes below are NOT redundant in the same way — they
-- belong to a surviving table, so they still need an explicit statement.
DROP INDEX IF EXISTS public.idx_sim_sources_capability_profile;
DROP INDEX IF EXISTS public.idx_sim_sources_compliance_metadata;

ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_version_positive;
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_failure_count_non_negative;
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_reliability_score_range;
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_trust_score_range;
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_external_key_format;
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS uq_sim_sources_external_key;

ALTER TABLE public.sim_sources DROP COLUMN IF EXISTS external_key;

-- ── Reverse Part B ───────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.sim_source_relationships;

DROP INDEX IF EXISTS public.idx_sim_sources_knowledge_domains;
DROP INDEX IF EXISTS public.idx_sim_sources_canonical_entity_coverage;
DROP INDEX IF EXISTS public.idx_sim_sources_connector_compatibility;

ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_knowledge_domains_valid;
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_canonical_entities_valid;
ALTER TABLE public.sim_sources
  DROP CONSTRAINT IF EXISTS chk_sim_sources_connector_compatibility_valid;

ALTER TABLE public.sim_sources DROP COLUMN IF EXISTS capability_profile;
ALTER TABLE public.sim_sources DROP COLUMN IF EXISTS knowledge_domains;
ALTER TABLE public.sim_sources DROP COLUMN IF EXISTS canonical_entity_coverage;
ALTER TABLE public.sim_sources DROP COLUMN IF EXISTS data_quality_profile;
ALTER TABLE public.sim_sources DROP COLUMN IF EXISTS compliance_metadata;
ALTER TABLE public.sim_sources DROP COLUMN IF EXISTS connector_compatibility;
ALTER TABLE public.sim_sources DROP COLUMN IF EXISTS freshness_policy;

COMMIT;

-- =============================================================================
-- POST-ROLLBACK STATE
-- =============================================================================
--
-- PRESERVED (Part A baseline — never touched by this script)
--   • sim_sources                    — with only its Part A baseline columns
--     (metadata, system-managed lifecycle fields, audit/versioning columns)
--   • sim_source_health_snapshots    — unchanged
--   • sim_source_audit_log           — unchanged
--
-- REMOVED (Parts B, C, D — everything this script reverses)
--   • Enterprise enhancement columns on sim_sources: capability_profile,
--     knowledge_domains, canonical_entity_coverage, data_quality_profile,
--     compliance_metadata, connector_compatibility, freshness_policy
--   • Relationship graph: the sim_source_relationships table in full,
--     including every index and constraint defined on it
--   • External key: the external_key column and its format/uniqueness
--     enforcement (uq_sim_sources_external_key_live,
--     chk_sim_sources_external_key_format)
--   • Enterprise data-integrity constraints: trust_score, reliability_score,
--     failure_count, and version range checks; the lifecycle CHECK
--     constraints on status, approval_status, and health_status (both
--     sim_sources and sim_source_health_snapshots)
--   • Trigger: trg_sim_sources_set_updated_at and its function
--     sim_set_updated_at()
--   • Enterprise indexes: idx_sim_sources_knowledge_domains,
--     idx_sim_sources_canonical_entity_coverage,
--     idx_sim_sources_connector_compatibility,
--     idx_sim_sources_capability_profile, idx_sim_sources_compliance_metadata
--     (idx_sim_source_relationships_type is removed implicitly along with
--     the table it belongs to)
--
-- Net result: sim_sources, sim_source_health_snapshots, and
-- sim_source_audit_log return to exactly their Part A baseline shape,
-- suitable for use by any repository code that predates the WP-P2-01/
-- WP-P2-01A enterprise enhancements. No table is dropped and no row in the
-- surviving tables is deleted; only columns, constraints, indexes, a
-- trigger, its function, and one enhancement table are removed.
-- =============================================================================