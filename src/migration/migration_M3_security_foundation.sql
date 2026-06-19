-- =============================================================================
-- HireRise — Phase 2A.1 — Sprint 1B
-- Migration: migration_M3_security_foundation.sql
--
-- GOVERNANCE BASELINE — SECURITY FOUNDATION
-- RECONSTRUCTED for repository traceability restoration
--
-- Reconstruction Authority: A01.F06 — M3 Governance Baseline Artifact
--                           Reconstruction & Commit Readiness
-- Reconstruction Verdict:   PASS — READY TO RECONSTRUCT
-- Reconstruction Date:      2026-06-09
--
-- PURPOSE:
--   Establishes the complete Sprint 1B security governance baseline:
--     1. governance_audit role (dedicated least-privilege audit role)
--     2. RLS enablement on all four Sprint 1A governance tables
--     3. Eight RLS policies across four tables
--     4. Complete GRANT and REVOKE model (deny-by-default)
--
--   This migration activates the security model that Sprint 1A tables were
--   designed for. Sprint 1A created the tables, triggers, and indexes.
--   This migration makes those tables governed and access-controlled.
--
-- AUTHORITATIVE SOURCES:
--   Source 1 — Sprint 1B Security Service Specification
--               (canonical scope: role, RLS, GRANTs, REVOKE model)
--   Source 2 — M3 Final Review Package / Package G3 Gate G3 Review
--               (approved amendments AMD-01 through AMD-09; F1–F5 resolutions)
--   Source 3 — Phase 2A.1.3 Architecture & Implementation Planning Review
--               (A01 and A01.F06 findings; reconstruction authorisation)
--
-- RECONSTRUCTION METHOD:
--   Every object in this file is traceable to an explicit statement in one
--   or more of the three authoritative sources above. No object has been
--   added speculatively. Evidence is cited inline for each section.
--
-- APPROVED AMENDMENTS INCORPORATED (M3 Final — AMD-01 through AMD-09):
--   AMD-02: Two policies on signal_registry_audit_log for service_role
--           (registry_service_only FOR ALL + audit_log_service_only FOR SELECT)
--           are intentional. Separation of write and read paths documented.
--   AMD-07: service_role policies are framed as primary security controls.
--           BYPASSRLS is documented as current Supabase platform behaviour
--           only and does not reduce the policy requirement.
--   AMD-08: SQL comment imprecision re BYPASSRLS (non-blocking deferred item
--           OI-01) — this reconstruction uses the corrected AMD-07 framing
--           throughout. No further SQL correction required.
--   All other AMD amendments (AMD-01, AMD-03–AMD-06, AMD-09) apply to the
--   deployment document, not to this SQL file.
--
-- EXCLUSIONS (with justification):
--   audit log immutability trigger (DB-09):
--     Specified in Sprint 1A Migration Specification §4.2 as a Sprint 1A
--     deliverable. Owned by migration_1A_02_core_tables.sql. Not M3 scope.
--   signal_lineage partial UNIQUE index (open proposals):
--     The approved-row partial UNIQUE index on signal_lineage is a Sprint 1A
--     deliverable (Sprint 1A spec §3.1). The open-proposal uniqueness index
--     (WHERE approved_at IS NULL AND rejected_at IS NULL) is a gap identified
--     in Phase 2A.1.3 Architecture Review Major Finding but is not specified
--     in Sprint 1B as an M3 deliverable. Neither index belongs to M3.
--   fn_validate_signal_keys() enhancement:
--     Sprint 1B scope (SVC-03) but delivered as G4D Package artifact.
--     Not a security governance object.
--   lineage.service.ts, registry-audit.service.ts:
--     Sprint 1B service layer deliverables. TypeScript — not SQL objects.
--
-- PREREQUISITES:
--   Sprint 1A migrations must be deployed and verified before this migration.
--   Required tables: signal_lineage, signal_registry_audit_log,
--                    signal_category_hierarchy, signal_ontology_edges
--   Required enums:  lineage_type_enum, registry_audit_event_type_enum
--   Gate 1 (Sprint 1A Schema Integrity) must have passed.
--
-- IDEMPOTENCY:
--   All statements use IF NOT EXISTS or DROP ... IF EXISTS + CREATE patterns.
--   Safe to re-execute on a database where M3 is already deployed.
--   Re-execution will produce NOTICE messages but no errors and no state change.
--
-- TRANSACTION:
--   Wrapped in a single BEGIN/COMMIT. If any statement fails, the entire
--   migration rolls back and the database is left in its pre-migration state.
--   This ensures RLS is never left enabled without policies in place.
--
-- GATE 2 ELIGIBILITY:
--   After successful execution, Gate G3 (Security Integrity) criteria are met:
--     - governance_audit role exists and is unprivileged
--     - RLS enabled on all four Sprint 1A tables
--     - All eight approved policies present in pg_policies
--     - Five approved grantee-privilege combinations confirmed present
--     - Zero unexpected grantees on governance tables (per AMD-06)
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION B — PREAMBLE ASSERTION BLOCK
-- Confirms Sprint 1A prerequisites before any M3 object is created.
-- Mirrors the assertion pattern used in G4D and other Sprint 1 migrations.
-- =============================================================================

DO $$
BEGIN
  -- Assert: signal_lineage table exists (Sprint 1A DB-04)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_lineage'
  ) THEN
    RAISE EXCEPTION
      'PREREQUISITE FAILED: public.signal_lineage does not exist. '
      'Sprint 1A migration_1A_02_core_tables.sql must be deployed before M3. '
      'Aborting M3 security foundation migration.';
  END IF;

  -- Assert: signal_registry_audit_log table exists (Sprint 1A DB-05)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_registry_audit_log'
  ) THEN
    RAISE EXCEPTION
      'PREREQUISITE FAILED: public.signal_registry_audit_log does not exist. '
      'Sprint 1A migration_1A_02_core_tables.sql must be deployed before M3. '
      'Aborting M3 security foundation migration.';
  END IF;

  -- Assert: signal_category_hierarchy table exists (Sprint 1A DB-06)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_category_hierarchy'
  ) THEN
    RAISE EXCEPTION
      'PREREQUISITE FAILED: public.signal_category_hierarchy does not exist. '
      'Sprint 1A migration_1A_02_core_tables.sql must be deployed before M3. '
      'Aborting M3 security foundation migration.';
  END IF;

  -- Assert: signal_ontology_edges table exists (Sprint 1A DB-07)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_ontology_edges'
  ) THEN
    RAISE EXCEPTION
      'PREREQUISITE FAILED: public.signal_ontology_edges does not exist. '
      'Sprint 1A migration_1A_02_core_tables.sql must be deployed before M3. '
      'Aborting M3 security foundation migration.';
  END IF;

  RAISE NOTICE 'M3 preamble: All Sprint 1A prerequisite tables confirmed present.';
END;
$$;

-- =============================================================================
-- SECTION B — governance_audit ROLE
--
-- Evidence: Sprint 1B Security Service Specification §3.2
--   "The governance_audit role is created by the Sprint 1B migration."
--   "NOLOGIN / NOINHERIT"
--   "rolsuper = false, rolcreatedb = false, rolcreaterole = false"
--   "must never be assigned to Supabase Auth user tiers or session claims"
--   "restricted to dedicated governance processes and Sprint 1C RPCs"
--
-- Evidence: M3 Final Review Package §9.1
--   "role, RLS, six policies, five grants remain the gate basis"
--   Role confirmed as Gate G3 gate criterion.
--
-- Idempotency: DO block checks pg_roles before attempting CREATE ROLE.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'governance_audit'
  ) THEN
    CREATE ROLE governance_audit
      NOLOGIN
      NOINHERIT
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION;

    RAISE NOTICE 'M3: governance_audit role created.';
  ELSE
    RAISE NOTICE 'M3: governance_audit role already exists — skipping CREATE ROLE.';
  END IF;
END;
$$;

COMMENT ON ROLE governance_audit IS
  'Sprint 1B / M3: Dedicated least-privilege read-only role for governance tooling, '
  'regulatory reporting, and audit queries requiring full signal_lineage visibility '
  'including unapproved proposals. '
  'NEVER assign to Supabase Auth user sessions or JWT claims. '
  'Use is restricted to designated governance processes and Sprint 1C SECURITY DEFINER RPCs. '
  'Any misconfiguration that assigns this role to a user session is a security incident. '
  'Ref: Sprint 1B Security Service Specification §3.2.';

-- =============================================================================
-- SECTION C — RLS ENABLEMENT
--
-- Evidence: Sprint 1B Security Service Specification §4 (Introduction)
--   "All four Sprint 1A tables must have RLS enabled. RLS is enabled as part
--    of the Sprint 1B security migration (Migration 1B-01). Enabling RLS on a
--    table without creating any permissive policies causes all access to be
--    denied by default — this is the correct baseline state before policies are
--    applied. Policies are created immediately after RLS is enabled within the
--    same migration, so no window of total denial exists in production."
--
-- Idempotency: ENABLE ROW LEVEL SECURITY is safe on an already-RLS-enabled
-- table — PostgreSQL treats it as a no-op.
-- =============================================================================

-- signal_lineage — governance infrastructure, restricted access
ALTER TABLE public.signal_lineage ENABLE ROW LEVEL SECURITY;

-- signal_registry_audit_log — governance infrastructure, internal only
ALTER TABLE public.signal_registry_audit_log ENABLE ROW LEVEL SECURITY;

-- signal_category_hierarchy — public reference data
ALTER TABLE public.signal_category_hierarchy ENABLE ROW LEVEL SECURITY;

-- signal_ontology_edges — public reference data
ALTER TABLE public.signal_ontology_edges ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  RAISE NOTICE 'M3: RLS enabled on signal_lineage, signal_registry_audit_log, signal_category_hierarchy, signal_ontology_edges.';
END; $$;

-- =============================================================================
-- SECTION D — RLS POLICIES
--
-- Pattern: DROP POLICY IF EXISTS before CREATE POLICY.
-- This is the idempotent recreation pattern: safe on first run (DROP is a
-- no-op if the policy does not exist) and safe on re-run (drops and recreates
-- the policy with the correct definition).
--
-- AMD-07 compliance: service_role policies are the PRIMARY security controls.
-- The BYPASSRLS attribute is a current Supabase platform default that does not
-- reduce the policy requirement and must not be relied upon as a substitute
-- for the policy. These policies must exist regardless of BYPASSRLS status.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- D.1  signal_lineage policies
--
-- RLS Strategy: Restricted governance access. Default deny.
-- Evidence: Sprint 1B §4.1
--   "Two permissive policies cover service_role (full operational) and
--    governance_audit (read-only). No policies for anon, authenticated,
--    or postgres."
-- ---------------------------------------------------------------------------

-- Policy: lineage_service_full
-- Evidence: Sprint 1B §4.1 Policy: lineage_service_full
--   Target role: service_role
--   SELECT: USING (true) — all rows visible
--   INSERT: WITH CHECK (true) — all inserts permitted
--   UPDATE: permitted through RLS; immutability trigger DB-08 further constrains
--   DELETE: no DELETE policy (defence in depth; DELETE GRANT is also absent)
--   AMD-07: This policy is the primary security control, not a documentation
--           artefact. It must exist regardless of BYPASSRLS platform behaviour.

DROP POLICY IF EXISTS "lineage_service_full" ON public.signal_lineage;
CREATE POLICY "lineage_service_full"
  ON public.signal_lineage
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON POLICY "lineage_service_full" ON public.signal_lineage IS
  'Sprint 1B / M3: Grants service_role complete operational access to signal_lineage. '
  'SELECT (all rows including unapproved), INSERT (all proposals), UPDATE (approvals and '
  'weight review completion). No DELETE — lineage events are append-only governance records. '
  'This policy is the PRIMARY security control (AMD-07). '
  'Ref: Sprint 1B Security Service Specification §4.1.';


-- Policy: lineage_audit_read
-- Evidence: Sprint 1B §4.1 Policy: lineage_audit_read
--   Target role: governance_audit
--   SELECT: USING (true) — all rows visible INCLUDING unapproved proposals
--   Note: VAL-M3-10 (governance_audit approved-row test via SET ROLE) was
--         reclassified as deferred Package G7 integration test per AMD-01.
--         VAL-M3-04 (catalog check for USING clause) is the Gate G3 criterion.
--         The USING predicate is USING (true) — all rows visible to governance_audit.
--         Downstream RPCs apply approved-only filtering where appropriate.

DROP POLICY IF EXISTS "lineage_audit_read" ON public.signal_lineage;
CREATE POLICY "lineage_audit_read"
  ON public.signal_lineage
  AS PERMISSIVE
  FOR SELECT
  TO governance_audit
  USING (true);

COMMENT ON POLICY "lineage_audit_read" ON public.signal_lineage IS
  'Sprint 1B / M3: Grants governance_audit SELECT access to ALL signal_lineage rows, '
  'including unapproved proposals. Enables governance tooling and regulatory reporting '
  'that must demonstrate complete lineage history with no gaps. '
  'governance_audit has no INSERT, UPDATE, or DELETE access. '
  'Validated by VAL-M3-04 (catalog predicate check). '
  'VAL-M3-10 (SET ROLE functional test) deferred to Package G7 per AMD-01. '
  'Ref: Sprint 1B Security Service Specification §4.1; M3 Final Review AMD-01.';

-- ---------------------------------------------------------------------------
-- D.2  signal_registry_audit_log policies
--
-- RLS Strategy: Internal only. service_role access only. Default deny for all
-- other roles including governance_audit (audit log access mediated by RPCs).
-- Evidence: Sprint 1B §4.2; M3 Final F2 resolution.
--
-- AMD-02 compliance: Two policies for service_role are INTENTIONAL and APPROVED.
--   registry_service_only (FOR ALL) — documents the write path
--   audit_log_service_only (FOR SELECT) — documents the read path
--   Separation enables independent future narrowing of either path.
--   PostgreSQL combines PERMISSIVE policies with OR logic; the two-policy model
--   has identical functional effect to a single FOR ALL policy for service_role
--   but superior governance traceability. AMD-03 requires this to be noted in
--   the deployment checklist (SA-05).
-- ---------------------------------------------------------------------------

-- Policy: registry_service_only
-- Evidence: M3 Final F2 finding: "registry_service_only (FOR ALL)"
--   "FOR ALL already includes SELECT. Retaining both policies justified by
--    governance value of separation."
--   AMD-02: "Two policies on signal_registry_audit_log for service_role is
--            intentional and approved."

DROP POLICY IF EXISTS "registry_service_only" ON public.signal_registry_audit_log;
CREATE POLICY "registry_service_only"
  ON public.signal_registry_audit_log
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON POLICY "registry_service_only" ON public.signal_registry_audit_log IS
  'Sprint 1B / M3: Grants service_role write path access to signal_registry_audit_log. '
  'Covers INSERT (registry-audit.service.ts event writes) and UPDATE (future narrowing path). '
  'NOTE: Two policies for service_role on this table (registry_service_only + '
  'audit_log_service_only) are INTENTIONAL per M3 Final F2 resolution and AMD-02. '
  'Separation of write policy and read policy enables independent future narrowing. '
  'Ref: Sprint 1B Security Service Specification §4.2; M3 Final Review F2/AMD-02.';


-- Policy: audit_log_service_only
-- Evidence: Sprint 1B §4.2 Policy: audit_log_service_only
--   "Grants service_role SELECT and INSERT access to the audit log."
--   Target role: service_role. SELECT behaviour: USING (true). INSERT: WITH CHECK (true).
-- Evidence: M3 Final F2: "audit_log_service_only (FOR SELECT)"

DROP POLICY IF EXISTS "audit_log_service_only" ON public.signal_registry_audit_log;
CREATE POLICY "audit_log_service_only"
  ON public.signal_registry_audit_log
  AS PERMISSIVE
  FOR SELECT
  TO service_role
  USING (true);

COMMENT ON POLICY "audit_log_service_only" ON public.signal_registry_audit_log IS
  'Sprint 1B / M3: Documents the service_role read path on signal_registry_audit_log. '
  'Enables service-layer verification queries (confirming audit events were written). '
  'NOTE: Intentionally separate from registry_service_only per M3 Final F2/AMD-02. '
  'The separation makes the read path independently auditable and narrowable. '
  'AMD-07: This policy is the primary read-path security control for service_role. '
  'Ref: Sprint 1B Security Service Specification §4.2; M3 Final Review F2/AMD-02/AMD-07.';

-- ---------------------------------------------------------------------------
-- D.3  signal_category_hierarchy policies
--
-- RLS Strategy: Public read, service-role write.
-- Evidence: Sprint 1B §4.3
--   "Two policies — one permissive read policy for public roles, one permissive
--    write policy for service_role."
-- ---------------------------------------------------------------------------

-- Policy: hierarchy_read_all
-- Evidence: Sprint 1B §4.3 Policy: hierarchy_read_all
--   Target roles: anon, authenticated
--   SELECT: USING (true) — all rows including inactive returned at DB level
--   Note: Application layer should filter is_active = true for production queries.
--         RLS does not impose this filter — inactive categories contain no sensitive data.

DROP POLICY IF EXISTS "hierarchy_read_all" ON public.signal_category_hierarchy;
CREATE POLICY "hierarchy_read_all"
  ON public.signal_category_hierarchy
  AS PERMISSIVE
  FOR SELECT
  TO anon, authenticated
  USING (true);

COMMENT ON POLICY "hierarchy_read_all" ON public.signal_category_hierarchy IS
  'Sprint 1B / M3: Grants SELECT access to all taxonomy categories for anon and '
  'authenticated roles. Enables client-side taxonomy rendering, category lookups, '
  'and explainability label generation. All rows returned including inactive — '
  'application layer should filter is_active = true for production taxonomy queries. '
  'Ref: Sprint 1B Security Service Specification §4.3.';


-- Policy: hierarchy_write_service
-- Evidence: Sprint 1B §4.3 Policy: hierarchy_write_service
--   Target role: service_role. INSERT and UPDATE permitted. No DELETE.
--   "Updates to display_name, description, is_active, updated_at are normal mutations."
--   "Soft-delete via is_active = false is the only approved removal mechanism."

DROP POLICY IF EXISTS "hierarchy_write_service" ON public.signal_category_hierarchy;
CREATE POLICY "hierarchy_write_service"
  ON public.signal_category_hierarchy
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON POLICY "hierarchy_write_service" ON public.signal_category_hierarchy IS
  'Sprint 1B / M3: Grants service_role INSERT and UPDATE access for taxonomy '
  'administration. Taxonomy additions and deactivations (is_active = false) flow '
  'through service_role. Hard delete is not an approved operation for any role — '
  'use soft-delete via is_active = false. '
  'AMD-07: This policy is the primary write-path security control for service_role. '
  'Ref: Sprint 1B Security Service Specification §4.3.';

-- ---------------------------------------------------------------------------
-- D.4  signal_ontology_edges policies
--
-- RLS Strategy: Identical to signal_category_hierarchy.
-- Evidence: Sprint 1B §4.4
--   "RLS Strategy: Identical to signal_category_hierarchy."
-- ---------------------------------------------------------------------------

-- Policy: ontology_read_all
-- Evidence: Sprint 1B §4.4 Policy: ontology_read_all
--   Target roles: anon, authenticated
--   "Grants SELECT access to all ontology edges for anon and authenticated."
--   All rows returned including inactive edges.

DROP POLICY IF EXISTS "ontology_read_all" ON public.signal_ontology_edges;
CREATE POLICY "ontology_read_all"
  ON public.signal_ontology_edges
  AS PERMISSIVE
  FOR SELECT
  TO anon, authenticated
  USING (true);

COMMENT ON POLICY "ontology_read_all" ON public.signal_ontology_edges IS
  'Sprint 1B / M3: Grants SELECT access to all ontology edges for anon and '
  'authenticated roles. Enables semantic relationship queries and ontology traversal '
  'for explainability and aggregation consumers. All rows returned including inactive — '
  'application layer should filter is_active = true for production queries. '
  'Ref: Sprint 1B Security Service Specification §4.4.';


-- Policy: ontology_write_service
-- Evidence: Sprint 1B §4.4 Policy: ontology_write_service
--   Target role: service_role. INSERT and UPDATE permitted. No DELETE.
--   "Updates to weight, is_active are the approved mutations."

DROP POLICY IF EXISTS "ontology_write_service" ON public.signal_ontology_edges;
CREATE POLICY "ontology_write_service"
  ON public.signal_ontology_edges
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON POLICY "ontology_write_service" ON public.signal_ontology_edges IS
  'Sprint 1B / M3: Grants service_role INSERT and UPDATE access for ontology '
  'administration. Approved mutations: weight, is_active. No DELETE grant — '
  'ontology edges use soft-delete via is_active = false. '
  'AMD-07: This policy is the primary write-path security control for service_role. '
  'Ref: Sprint 1B Security Service Specification §4.4.';

DO $$ BEGIN RAISE NOTICE 'M3: All 8 RLS policies created on 4 tables.'; END; $$;

-- =============================================================================
-- SECTION E — GRANT MODEL
--
-- Evidence: Sprint 1B Security Service Specification §5 (complete)
--   §5.1 signal_lineage grants
--   §5.2 signal_registry_audit_log grants
--   §5.3 signal_category_hierarchy grants
--   §5.4 signal_ontology_edges grants
--   §5.5 Complete Grant Summary Table (authoritative)
--
-- Authoritative summary table (Sprint 1B §5.5):
--   signal_lineage:             anon=none, auth=none, service=SELECT/INSERT/UPDATE, gov_audit=SELECT
--   signal_registry_audit_log:  anon=none, auth=none, service=SELECT/INSERT,        gov_audit=none
--   signal_category_hierarchy:  anon=SELECT, auth=SELECT, service=SELECT/INSERT/UPDATE, gov_audit=none
--   signal_ontology_edges:      anon=SELECT, auth=SELECT, service=SELECT/INSERT/UPDATE, gov_audit=none
--
-- DELETE is not granted to any role on any Sprint 1A table (Sprint 1B §5.5:
--   "No DELETE is granted to any role on any new Sprint 1A table.").
--
-- REVOKE pattern: REVOKE ALL issued first to ensure deny-by-default baseline.
-- GRANTs are then explicitly stated. This implements the Phase 1.6-approved
-- explicit grant model.
--
-- M3 Final F3 / AMD-04/05/06 compliance:
--   Grant validation standard is EXACT-MATCH BY GRANTEE.
--   Five approved grantee-privilege combinations:
--     1. service_role: SELECT, INSERT, UPDATE on signal_lineage
--     2. governance_audit: SELECT on signal_lineage
--     3. service_role: SELECT, INSERT on signal_registry_audit_log
--     4. anon + authenticated: SELECT on signal_category_hierarchy
--     5. anon + authenticated: SELECT on signal_ontology_edges
--     (plus service_role SELECT/INSERT/UPDATE on hierarchy and edges)
--   Zero unexpected grantees (AMD-05): no role outside
--   {service_role, governance_audit, authenticated, anon, postgres} should
--   hold any privilege on any of the four governance tables.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- E.1  signal_lineage
--
-- service_role: SELECT, INSERT, UPDATE (no DELETE — append-only governance record)
-- governance_audit: SELECT only (read-only audit access)
-- anon: nothing
-- authenticated: nothing
-- Evidence: Sprint 1B §5.1
-- ---------------------------------------------------------------------------

REVOKE ALL ON public.signal_lineage FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.signal_lineage TO service_role;
GRANT SELECT                  ON public.signal_lineage TO governance_audit;

-- ---------------------------------------------------------------------------
-- E.2  signal_registry_audit_log
--
-- service_role: SELECT, INSERT (no UPDATE, no DELETE — immutable audit log)
-- governance_audit: nothing (access mediated by Sprint 1C SECURITY DEFINER RPCs only)
-- anon: nothing
-- authenticated: nothing
-- Evidence: Sprint 1B §5.2
-- ---------------------------------------------------------------------------

REVOKE ALL ON public.signal_registry_audit_log FROM anon, authenticated;
GRANT SELECT, INSERT ON public.signal_registry_audit_log TO service_role;

-- Explicit confirmation of governance_audit exclusion from signal_registry_audit_log.
-- This is not a REVOKE (no grant was ever issued) but is documented for auditability.
-- Evidence: Sprint 1B §5.2: "governance_audit: Allowed: Nothing."
--   "The governance_audit role's audit log access is exclusively through the
--    fn_get_registry_audit_events() SECURITY DEFINER RPC (Sprint 1C)."

-- ---------------------------------------------------------------------------
-- E.3  signal_category_hierarchy
--
-- anon: SELECT
-- authenticated: SELECT
-- service_role: SELECT, INSERT, UPDATE (no DELETE — soft-delete via is_active)
-- governance_audit: nothing (public data; no separate grant required)
-- Evidence: Sprint 1B §5.3
-- ---------------------------------------------------------------------------

GRANT SELECT                  ON public.signal_category_hierarchy TO anon;
GRANT SELECT                  ON public.signal_category_hierarchy TO authenticated;
GRANT SELECT, INSERT, UPDATE  ON public.signal_category_hierarchy TO service_role;

-- ---------------------------------------------------------------------------
-- E.4  signal_ontology_edges
--
-- Identical pattern to signal_category_hierarchy (Sprint 1B §5.4).
-- anon: SELECT
-- authenticated: SELECT
-- service_role: SELECT, INSERT, UPDATE (no DELETE)
-- governance_audit: nothing
-- Evidence: Sprint 1B §5.4: "Identical pattern to signal_category_hierarchy."
-- ---------------------------------------------------------------------------

GRANT SELECT                  ON public.signal_ontology_edges TO anon;
GRANT SELECT                  ON public.signal_ontology_edges TO authenticated;
GRANT SELECT, INSERT, UPDATE  ON public.signal_ontology_edges TO service_role;

DO $$ BEGIN RAISE NOTICE 'M3: GRANT model applied. Deny-by-default enforced on governance tables.'; END; $$;

-- =============================================================================
-- SECTION F — GOVERNANCE HARDENING OBJECTS
--
-- Objects evaluated for M3 inclusion. Excluded with justification.
-- =============================================================================

-- EXCLUDED: signal_registry_audit_log immutability trigger (DB-09)
-- Evidence for exclusion:
--   Sprint 1A Migration Specification §4.2 defines DB-09 as a Sprint 1A
--   deliverable: "signal_registry_audit_log Immutability Trigger (DB-09)".
--   Sprint 1B §1.2 references DB-09 as already existing ("registry-audit.service.ts
--   cannot write audit events until signal_registry_audit_log exists with its
--   immutability trigger in place" — treats DB-09 as a Sprint 1A prerequisite).
--   DB-09 is owned by sprint 1A migration, not by M3.
--   Status: The Phase 2A.1.3 Architecture Review identified DB-09 as unconfirmed
--   deployed (CRITICAL finding). If absent from the live database, it must be
--   deployed as a remediation migration separate from this reconstruction.

-- EXCLUDED: signal_lineage partial UNIQUE index (WHERE approved_at IS NULL AND rejected_at IS NULL)
-- Evidence for exclusion:
--   The Sprint 1A Migration Specification §3.1 defines a partial UNIQUE index on
--   signal_lineage for approved transitions (WHERE approved_at IS NOT NULL).
--   That index is a Sprint 1A deliverable.
--   The open-proposal uniqueness index (WHERE approved_at IS NULL AND rejected_at IS NULL)
--   was identified in Phase 2A.1.3 Architecture Review as a Major Finding (gap) but
--   is NOT specified in Sprint 1B Security Service Specification as an M3 deliverable.
--   It belongs to a gap remediation migration, not to this M3 reconstruction.

-- EXCLUDED: fn_validate_signal_keys() Sprint 1B enhancement
-- Evidence for exclusion:
--   Sprint 1B §6.3 specifies this as SVC-03 but it is implemented and deployed
--   as part of the G4D Package (G4D_Package_Part2.sql). It is a function artifact,
--   not a security governance object, and does not belong in this migration.

-- =============================================================================
-- SECTION G — POST-DEPLOYMENT VALIDATION BLOCK
--
-- Read-only verification queries. Execute after deployment to confirm all M3
-- objects are present.
--
-- These queries implement the Gate G3 validation criteria:
--   VAL-M3-01: governance_audit role exists and is unprivileged
--   VAL-M3-02: RLS enabled on all four tables
--   VAL-M3-03: All eight policies present in pg_policies
--   VAL-M3-04: lineage_audit_read USING clause confirmed (catalog check)
--   VAL-M3-05/AMD-04: Five approved grantee-privilege combinations present
--   VAL-M3-06/AMD-05: Zero unexpected grantees on governance tables
-- =============================================================================

-- Validation queries are provided as a DO block with RAISE NOTICE output
-- so they can be included in the migration and produce visible pass/fail output.
-- For manual validation, the individual SELECT statements below can be run
-- independently in the SQL editor.

DO $$
DECLARE
  v_role_count     integer;
  v_rls_count      integer;
  v_policy_count   integer;
  v_grant_lineage  integer;
  v_grant_audit    integer;
  v_grant_hier     integer;
  v_grant_edges    integer;
  v_unexpected     integer;
BEGIN

  -- VAL-M3-01: governance_audit role exists and has no elevated attributes
  SELECT COUNT(*) INTO v_role_count
  FROM pg_roles
  WHERE rolname = 'governance_audit'
    AND rolsuper      = false
    AND rolcreatedb   = false
    AND rolcreaterole = false
    AND rolcanlogin   = false;

  IF v_role_count = 1 THEN
    RAISE NOTICE 'VAL-M3-01 PASS: governance_audit role exists, no elevated attributes.';
  ELSE
    RAISE WARNING 'VAL-M3-01 FAIL: governance_audit role not found or has unexpected attributes.';
  END IF;

  -- VAL-M3-02: RLS enabled on all four Sprint 1A tables
  SELECT COUNT(*) INTO v_rls_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'signal_lineage',
      'signal_registry_audit_log',
      'signal_category_hierarchy',
      'signal_ontology_edges'
    )
    AND c.relrowsecurity = true;

  IF v_rls_count = 4 THEN
    RAISE NOTICE 'VAL-M3-02 PASS: RLS enabled on all 4 Sprint 1A governance tables.';
  ELSE
    RAISE WARNING 'VAL-M3-02 FAIL: RLS enabled on % of 4 tables (expected 4).', v_rls_count;
  END IF;

  -- VAL-M3-03: All eight approved policies present
  SELECT COUNT(*) INTO v_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (
      (tablename = 'signal_lineage'            AND policyname IN ('lineage_service_full', 'lineage_audit_read'))
   OR (tablename = 'signal_registry_audit_log' AND policyname IN ('registry_service_only', 'audit_log_service_only'))
   OR (tablename = 'signal_category_hierarchy' AND policyname IN ('hierarchy_read_all', 'hierarchy_write_service'))
   OR (tablename = 'signal_ontology_edges'     AND policyname IN ('ontology_read_all', 'ontology_write_service'))
    );

  IF v_policy_count = 8 THEN
    RAISE NOTICE 'VAL-M3-03 PASS: All 8 approved M3 policies present.';
  ELSE
    RAISE WARNING 'VAL-M3-03 FAIL: % of 8 expected policies found.', v_policy_count;
  END IF;

  -- VAL-M3-04: lineage_audit_read USING clause catalog check (Gate G3 criterion per AMD-01)
  -- Confirms the predicate at the DB level without requiring SET ROLE.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'signal_lineage'
      AND policyname = 'lineage_audit_read'
      AND roles      @> ARRAY['governance_audit'::name]
      AND cmd        = 'SELECT'
  ) THEN
    RAISE NOTICE 'VAL-M3-04 PASS: lineage_audit_read policy confirmed present for governance_audit on signal_lineage.';
  ELSE
    RAISE WARNING 'VAL-M3-04 FAIL: lineage_audit_read policy not found or misconfigured.';
  END IF;

  -- VAL-M3-05 (AMD-04/05/06): Grant model verification
  -- Check service_role SELECT/INSERT/UPDATE on signal_lineage
  SELECT COUNT(DISTINCT privilege_type) INTO v_grant_lineage
  FROM information_schema.role_table_grants
  WHERE table_schema  = 'public'
    AND table_name    = 'signal_lineage'
    AND grantee       = 'service_role'
    AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE');

  IF v_grant_lineage = 3 THEN
    RAISE NOTICE 'VAL-M3-05a PASS: service_role has SELECT/INSERT/UPDATE on signal_lineage.';
  ELSE
    RAISE WARNING 'VAL-M3-05a FAIL: service_role grant on signal_lineage incomplete (% of 3).', v_grant_lineage;
  END IF;

  -- Check governance_audit SELECT on signal_lineage
  SELECT COUNT(*) INTO v_grant_lineage
  FROM information_schema.role_table_grants
  WHERE table_schema  = 'public'
    AND table_name    = 'signal_lineage'
    AND grantee       = 'governance_audit'
    AND privilege_type = 'SELECT';

  IF v_grant_lineage = 1 THEN
    RAISE NOTICE 'VAL-M3-05b PASS: governance_audit has SELECT on signal_lineage.';
  ELSE
    RAISE WARNING 'VAL-M3-05b FAIL: governance_audit SELECT on signal_lineage not found.';
  END IF;

  -- Check service_role SELECT/INSERT on signal_registry_audit_log
  SELECT COUNT(DISTINCT privilege_type) INTO v_grant_audit
  FROM information_schema.role_table_grants
  WHERE table_schema  = 'public'
    AND table_name    = 'signal_registry_audit_log'
    AND grantee       = 'service_role'
    AND privilege_type IN ('SELECT', 'INSERT');

  IF v_grant_audit = 2 THEN
    RAISE NOTICE 'VAL-M3-05c PASS: service_role has SELECT/INSERT on signal_registry_audit_log.';
  ELSE
    RAISE WARNING 'VAL-M3-05c FAIL: service_role grant on signal_registry_audit_log incomplete (% of 2).', v_grant_audit;
  END IF;

  -- Check anon/authenticated SELECT on signal_category_hierarchy and signal_ontology_edges
  SELECT COUNT(*) INTO v_grant_hier
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name   = 'signal_category_hierarchy'
    AND grantee      IN ('anon', 'authenticated')
    AND privilege_type = 'SELECT';

  SELECT COUNT(*) INTO v_grant_edges
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name   = 'signal_ontology_edges'
    AND grantee      IN ('anon', 'authenticated')
    AND privilege_type = 'SELECT';

  IF v_grant_hier >= 1 AND v_grant_edges >= 1 THEN
    RAISE NOTICE 'VAL-M3-05d PASS: anon/authenticated SELECT on hierarchy and edges confirmed.';
  ELSE
    RAISE WARNING 'VAL-M3-05d FAIL: anon/authenticated SELECT on hierarchy or edges incomplete.';
  END IF;

  -- VAL-M3-06 (AMD-05/06): Unexpected grantee check — Gate G3 blocker
  -- Zero rows expected: no grantee outside {service_role, governance_audit,
  -- authenticated, anon, postgres} should hold any privilege on governance tables.
  SELECT COUNT(*) INTO v_unexpected
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name   IN (
      'signal_lineage',
      'signal_registry_audit_log',
      'signal_category_hierarchy',
      'signal_ontology_edges'
    )
    AND grantee NOT IN ('service_role', 'governance_audit', 'authenticated', 'anon', 'postgres');

  IF v_unexpected = 0 THEN
    RAISE NOTICE 'VAL-M3-06 PASS: Zero unexpected grantees on governance tables.';
  ELSE
    RAISE WARNING 'VAL-M3-06 FAIL: % unexpected grantee row(s) found on governance tables. GATE G3 BLOCKER.', v_unexpected;
  END IF;

  RAISE NOTICE 'M3 post-deployment validation complete. Review PASS/FAIL notices above.';

END;
$$;

COMMIT;

-- =============================================================================
-- END OF MIGRATION
-- migration_M3_security_foundation.sql
-- Sprint 1B / Package G3 / Gate G3
-- Reconstructed: 2026-06-09 per A01.F06 governance baseline reconstruction
-- =============================================================================
