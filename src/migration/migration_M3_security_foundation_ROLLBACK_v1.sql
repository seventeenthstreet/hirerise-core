-- =============================================================================
-- HireRise — Phase 2A.1.3 — Sprint 1B
-- Rollback: migration_M3_security_foundation_ROLLBACK_v1.sql
--
-- GOVERNANCE BASELINE ROLLBACK — M3 SECURITY FOUNDATION
--
-- Rollback Authority:
--   A01.F06 — M3 Governance Baseline Artifact Reconstruction & Commit Readiness
--   Phase 2A.1.3 Step 3 — Generate ROLLBACK artifact
--
-- Migration Reversed:    migration_M3_security_foundation_v1.sql
-- Verification Artifact: migration_M3_security_foundation_VERIFY_v1_Revision1.sql
-- Generated:             2026-06-09
-- Package:               A01.F06 completion artifact — Sprint 1B / Gate G3
--
-- Authoritative Sources:
--   Sprint 1B Security Service Specification §3.2, §4.1–4.4, §5.1–5.5
--   HireRise_A01_M3_Security_Migration_Recovery.md Phase 5
--   HireRise_Phase2A1.3_Architecture_Review.md (A01.F06 findings)
--   migration_M3_security_foundation_v1.sql (accepted M3 baseline)
--   migration_M3_security_foundation_VERIFY_v1_Revision1.sql (Gate G3 evidence)
--
-- =============================================================================
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!                                                                         !!
-- !!                    GOVERNANCE WARNING — READ BEFORE EXECUTION           !!
-- !!                                                                         !!
-- !!  Executing this rollback removes the reconstructed M3 governance        !!
-- !!  baseline. This is a SECURITY-DEGRADING operation.                      !!
-- !!                                                                         !!
-- !!  This rollback:                                                          !!
-- !!    - removes governance_audit role                                       !!
-- !!    - removes all 7 M3 RLS policies                                       !!
-- !!    - removes the approved M3 grant model                                 !!
-- !!    - disables RLS on all 4 governance tables                             !!
-- !!    - disables all M3 governance protections                              !!
-- !!                                                                         !!
-- !!  After execution:                                                        !!
-- !!    - signal_lineage has NO row-level access controls                     !!
-- !!    - signal_registry_audit_log has NO row-level access controls          !!
-- !!    - signal_category_hierarchy has NO row-level access controls          !!
-- !!    - signal_ontology_edges has NO row-level access controls              !!
-- !!    - governance_audit role DOES NOT EXIST                                !!
-- !!                                                                         !!
-- !!  Execution requires EXPLICIT GOVERNANCE APPROVAL.                       !!
-- !!                                                                         !!
-- !!  Intended uses:                                                          !!
-- !!    - Emergency recovery from failed M3 deployment                       !!
-- !!    - Rollback testing in staging                                         !!
-- !!    - Package completeness / disaster recovery preparedness              !!
-- !!                                                                         !!
-- !!  NOT intended for routine or scheduled execution.                       !!
-- !!                                                                         !!
-- !!  REQUIRED AFTER ROLLBACK:                                               !!
-- !!  Re-deployment of migration_M3_security_foundation_v1.sql MUST occur    !!
-- !!  immediately after rollback testing to restore the M3 governance        !!
-- !!  baseline. Gate G3 must be re-certified before Sprint 1C proceeds.      !!
-- !!                                                                         !!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
--
-- =============================================================================
-- Rollback Scope
--
-- This rollback reverses ONLY the objects created by:
--   migration_M3_security_foundation_v1.sql
--
-- It does NOT touch:
--   Sprint 1A tables         (signal_lineage, signal_registry_audit_log,
--                             signal_category_hierarchy, signal_ontology_edges)
--   Sprint 1A indexes
--   Sprint 1A constraints
--   Sprint 1A triggers
--   A02 remediation objects
--   Supabase system roles    (anon, authenticated, service_role, postgres)
--   Any governance object outside the M3 baseline
--
-- Rollback sections:
--   RB1 — Policy Removal          (7 policies)
--   RB2 — Grant Model Reversal    (M3-issued grants)
--   RB3 — RLS Disablement         (4 tables)
--   RB4 — governance_audit Role Removal
--   RB5 — Rollback Assertions     (completion guards)
--
-- Execution order is architecturally mandatory:
--   RB1 must precede RB3 (clean state before RLS disable)
--   RB1 and RB2 must precede RB4 (policy and privilege dependencies cleared
--   before role removal)
--   RB5 executes last to confirm completion
--
-- =============================================================================
-- Transaction Wrapper
--
-- The rollback is wrapped in a single explicit transaction.
-- All sections execute atomically. If any step fails — including RB5 assertion
-- failures — the entire rollback is rolled back to the pre-execution state.
-- A partial rollback is more dangerous than no rollback.
-- =============================================================================

BEGIN;

-- =============================================================================
-- RB1 — POLICY REMOVAL
--
-- Removes all 7 RLS policies created by migration_M3_security_foundation_v1.sql.
--
-- Approved policy inventory (7 policies):
--   signal_lineage:            lineage_service_full, lineage_audit_read
--   signal_registry_audit_log: audit_log_service_only
--   signal_category_hierarchy: hierarchy_read_all, hierarchy_write_service
--   signal_ontology_edges:     ontology_read_all, ontology_write_service
--
-- DROP POLICY IF EXISTS is used throughout:
--   - Idempotent: safe if migration was only partially applied
--   - Safe for re-execution
--   - No error if policy does not exist
--
-- Policies are removed before RLS is disabled (RB3) to produce a clean state.
-- Policies are removed before the role is dropped (RB4) because lineage_audit_read
-- is bound to governance_audit; the policy binding must be cleared before PostgreSQL
-- will accept DROP ROLE.
--
-- Order within RB1 is arbitrary; policies are mutually independent.
-- =============================================================================

-- RB1-A: signal_lineage policies
DROP POLICY IF EXISTS lineage_service_full ON public.signal_lineage;
DROP POLICY IF EXISTS lineage_audit_read   ON public.signal_lineage;

-- RB1-B: signal_registry_audit_log policies
DROP POLICY IF EXISTS audit_log_service_only ON public.signal_registry_audit_log;

-- RB1-C: signal_category_hierarchy policies
DROP POLICY IF EXISTS hierarchy_read_all      ON public.signal_category_hierarchy;
DROP POLICY IF EXISTS hierarchy_write_service ON public.signal_category_hierarchy;

-- RB1-D: signal_ontology_edges policies
DROP POLICY IF EXISTS ontology_read_all      ON public.signal_ontology_edges;
DROP POLICY IF EXISTS ontology_write_service ON public.signal_ontology_edges;


-- =============================================================================
-- RB2 — GRANT MODEL REVERSAL
--
-- Reverses all grants issued by migration_M3_security_foundation_v1.sql.
--
-- M3 approved grant model (Sprint 1B §5.5):
--   signal_lineage:            service_role  = SELECT, INSERT, UPDATE
--                              governance_audit = SELECT
--   signal_registry_audit_log: service_role  = SELECT, INSERT
--   signal_category_hierarchy: anon          = SELECT
--                              authenticated = SELECT
--                              service_role  = SELECT, INSERT, UPDATE
--   signal_ontology_edges:     anon          = SELECT
--                              authenticated = SELECT
--                              service_role  = SELECT, INSERT, UPDATE
--
-- Pre-M3 state reasoning:
--   service_role is a Supabase system superuser-equivalent. In Supabase, service_role
--   typically holds broad access by default. The M3 migration explicitly granted
--   SELECT/INSERT/UPDATE to make those privileges appear in the declared grant model
--   (information_schema.role_table_grants) for governance auditing purposes. Revoking
--   these grants restores the pre-M3 declared grant state; service_role's effective
--   superuser access remains via its system-level configuration, which M3 did not alter.
--
--   governance_audit was created by M3 with no pre-existing state. Revoking its
--   SELECT on signal_lineage is a prerequisite for DROP ROLE in RB4.
--
--   anon and authenticated: M3 granted SELECT on signal_category_hierarchy and
--   signal_ontology_edges. Pre-M3 state = no explicit SELECT grant on these tables
--   for these roles. Revocation restores that state. These roles had no grants on
--   signal_lineage or signal_registry_audit_log from M3; no action needed there.
--
-- REVOKE IF EXISTS is not valid PostgreSQL syntax. Standard REVOKE is used.
-- If the grant was never issued (partial migration), REVOKE produces a WARNING,
-- not an error, and the transaction continues safely.
-- =============================================================================

-- RB2-A: Revoke grants on signal_lineage
-- M3 issued: service_role = SELECT/INSERT/UPDATE; governance_audit = SELECT
REVOKE SELECT, INSERT, UPDATE ON public.signal_lineage FROM service_role;
REVOKE SELECT                  ON public.signal_lineage FROM governance_audit;

-- RB2-B: Revoke grants on signal_registry_audit_log
-- M3 issued: service_role = SELECT/INSERT
REVOKE SELECT, INSERT ON public.signal_registry_audit_log FROM service_role;

-- RB2-C: Revoke grants on signal_category_hierarchy
-- M3 issued: anon = SELECT; authenticated = SELECT; service_role = SELECT/INSERT/UPDATE
REVOKE SELECT                  ON public.signal_category_hierarchy FROM anon;
REVOKE SELECT                  ON public.signal_category_hierarchy FROM authenticated;
REVOKE SELECT, INSERT, UPDATE  ON public.signal_category_hierarchy FROM service_role;

-- RB2-D: Revoke grants on signal_ontology_edges
-- M3 issued: anon = SELECT; authenticated = SELECT; service_role = SELECT/INSERT/UPDATE
REVOKE SELECT                  ON public.signal_ontology_edges FROM anon;
REVOKE SELECT                  ON public.signal_ontology_edges FROM authenticated;
REVOKE SELECT, INSERT, UPDATE  ON public.signal_ontology_edges FROM service_role;


-- =============================================================================
-- RB3 — RLS DISABLEMENT
--
-- Disables Row Level Security on all four M3 governance tables.
--
-- !! SECURITY RISK — READ BEFORE PROCEEDING !!
--
-- After this section executes:
--   - All four tables are fully accessible to any role that holds a table-level
--     privilege, without any row-level filtering.
--   - Combined with RB2 (grant revocation), the net result is: no explicit
--     grants are in effect AND no RLS policies are active.
--   - service_role's effective superuser access means it can still read and
--     write all four tables via its system configuration.
--   - This state represents the minimum governance posture. It is only
--     appropriate as a transient rollback state, not a production state.
--
-- PostgreSQL syntax:
--   ALTER TABLE ... DISABLE ROW LEVEL SECURITY
--   This removes the RLS enforcement flag from pg_class.relrowsecurity.
--   Existing policies (if any remained) would become dormant, not active.
--   RB1 has already removed all policies, so this is a clean disable.
--
-- FORCE ROW LEVEL SECURITY was not enabled by M3 (relforcerowsecurity = false
-- per V2 verification criteria), so ALTER TABLE ... NO FORCE ROW LEVEL SECURITY
-- is not required. Standard disable is sufficient.
-- =============================================================================

ALTER TABLE public.signal_lineage            DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_registry_audit_log DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_category_hierarchy DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_ontology_edges     DISABLE ROW LEVEL SECURITY;


-- =============================================================================
-- RB4 — GOVERNANCE_AUDIT ROLE REMOVAL
--
-- Removes the governance_audit role created by migration_M3_security_foundation_v1.sql.
--
-- Why role removal must occur last (after RB1 and RB2):
--
--   PostgreSQL enforces that a role can only be dropped when:
--   (a) It holds no privileges on any object.
--   (b) It owns no objects.
--   (c) It is not referenced by any policy's role binding.
--
--   The M3 migration created governance_audit with:
--   - A SELECT grant on public.signal_lineage (RB2-A revoked this)
--   - A binding in the lineage_audit_read policy (RB1-A dropped this)
--   - No object ownership (governance_audit was created with NOINHERIT NOLOGIN
--     and was not used to create any objects)
--
--   Attempting DROP ROLE before RB1 and RB2 complete would fail with:
--     ERROR: role "governance_audit" cannot be dropped because some objects
--     depend on it
--   This is the correct PostgreSQL dependency-enforcement behavior.
--
--   Execution of RB1 and RB2 before RB4 is therefore architecturally mandatory,
--   not merely conventional.
--
-- DROP ROLE IF EXISTS is used for idempotency:
--   Safe if the role does not exist (partial migration scenario).
--   Produces a NOTICE, not an error.
--
-- No REASSIGN OWNED or DROP OWNED is required because governance_audit was
-- created as a pure audit role (NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
-- NOCREATEROLE) and owns no database objects. If REASSIGN OWNED / DROP OWNED
-- were needed, they would precede this statement.
-- =============================================================================

DROP ROLE IF EXISTS governance_audit;


-- =============================================================================
-- RB5 — ROLLBACK ASSERTIONS
--
-- Lightweight completion guards. Executed after RB1–RB4.
-- Each assertion raises an exception if the rollback did not complete correctly.
-- Because this script runs inside a transaction (BEGIN at top), a RAISE EXCEPTION
-- here causes the entire transaction to abort, leaving the database in its
-- pre-rollback state rather than in a partial state.
--
-- These are rollback-safety checks, NOT verification logic.
-- They test the minimum completion conditions only.
-- Full post-rollback verification is handled by re-executing
-- migration_M3_security_foundation_VERIFY_v1_Revision1.sql (all results
-- should FAIL, confirming the M3 baseline is absent).
-- =============================================================================

DO $$
DECLARE
  v_policy_count    integer;
  v_role_count      integer;
  v_rls_enabled     integer;
BEGIN

  -- -------------------------------------------------------------------------
  -- RB5-A: Assert all 7 M3 policies have been removed
  -- Expected: 0 policies from the approved inventory remain in pg_policies
  -- -------------------------------------------------------------------------
  SELECT COUNT(*) INTO v_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (
      (tablename = 'signal_lineage'            AND policyname IN ('lineage_service_full', 'lineage_audit_read'))
   OR (tablename = 'signal_registry_audit_log' AND policyname IN ('audit_log_service_only'))
   OR (tablename = 'signal_category_hierarchy' AND policyname IN ('hierarchy_read_all', 'hierarchy_write_service'))
   OR (tablename = 'signal_ontology_edges'     AND policyname IN ('ontology_read_all', 'ontology_write_service'))
    );

  IF v_policy_count > 0 THEN
    RAISE EXCEPTION
      'RB5-A ASSERTION FAILED: % M3 policy/ies still present after rollback. '
      'Expected 0. Rollback did not complete. Transaction aborted.',
      v_policy_count;
  END IF;

  -- -------------------------------------------------------------------------
  -- RB5-B: Assert governance_audit role has been removed
  -- Expected: 0 rows for governance_audit in pg_roles
  -- -------------------------------------------------------------------------
  SELECT COUNT(*) INTO v_role_count
  FROM pg_roles
  WHERE rolname = 'governance_audit';

  IF v_role_count > 0 THEN
    RAISE EXCEPTION
      'RB5-B ASSERTION FAILED: governance_audit role still exists after rollback. '
      'Expected 0 rows. RB4 did not complete or role has remaining dependencies. '
      'Transaction aborted.';
  END IF;

  -- -------------------------------------------------------------------------
  -- RB5-C: Assert RLS is disabled on all 4 governance tables
  -- Expected: 0 tables with relrowsecurity = true from the approved set
  -- -------------------------------------------------------------------------
  SELECT COUNT(*) INTO v_rls_enabled
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

  IF v_rls_enabled > 0 THEN
    RAISE EXCEPTION
      'RB5-C ASSERTION FAILED: % table(s) still have RLS enabled after rollback. '
      'Expected 0. RB3 did not complete. Transaction aborted.',
      v_rls_enabled;
  END IF;

  -- -------------------------------------------------------------------------
  -- RB5-D: Assert the four Sprint 1A tables still exist (scope guard)
  -- This assertion confirms the rollback did not accidentally remove tables.
  -- Expected: 4 tables present
  -- -------------------------------------------------------------------------
  DECLARE
    v_table_count integer;
  BEGIN
    SELECT COUNT(*) INTO v_table_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN (
        'signal_lineage',
        'signal_registry_audit_log',
        'signal_category_hierarchy',
        'signal_ontology_edges'
      );

    IF v_table_count <> 4 THEN
      RAISE EXCEPTION
        'RB5-D SCOPE GUARD FAILED: Expected 4 Sprint 1A tables, found %. '
        'Rollback may have removed objects outside its approved scope. '
        'IMMEDIATE INVESTIGATION REQUIRED. Transaction aborted.',
        v_table_count;
    END IF;
  END;

  -- -------------------------------------------------------------------------
  -- All assertions passed
  -- -------------------------------------------------------------------------
  RAISE NOTICE 'RB5 ASSERTIONS PASSED: All rollback completion checks satisfied.';
  RAISE NOTICE '  RB5-A: 0 M3 policies remain         — CONFIRMED';
  RAISE NOTICE '  RB5-B: governance_audit role absent  — CONFIRMED';
  RAISE NOTICE '  RB5-C: RLS disabled on 4 tables      — CONFIRMED';
  RAISE NOTICE '  RB5-D: 4 Sprint 1A tables intact     — CONFIRMED';
  RAISE NOTICE '';
  RAISE NOTICE 'ROLLBACK COMPLETE — M3 governance baseline removed.';
  RAISE NOTICE 'SECURITY WARNING: signal_lineage, signal_registry_audit_log,';
  RAISE NOTICE '  signal_category_hierarchy, signal_ontology_edges are now';
  RAISE NOTICE '  operating WITHOUT Row Level Security protection.';
  RAISE NOTICE '';
  RAISE NOTICE 'REQUIRED NEXT STEP: Re-deploy migration_M3_security_foundation_v1.sql';
  RAISE NOTICE '  and re-certify Gate G3 before Sprint 1C proceeds.';

END;
$$;

COMMIT;

-- =============================================================================
-- Post-Execution Instructions
--
-- 1. Confirm COMMIT completed without errors.
--
-- 2. Confirm the RB5 NOTICE messages appeared in the execution log:
--      RB5 ASSERTIONS PASSED: All rollback completion checks satisfied.
--      ROLLBACK COMPLETE — M3 governance baseline removed.
--
-- 3. Save the complete execution log as rollback evidence.
--
-- 4. If this was a rollback TEST (staging only):
--      Re-deploy migration_M3_security_foundation_v1.sql immediately.
--      Re-execute migration_M3_security_foundation_VERIFY_v1_Revision1.sql.
--      Confirm overall_gate_g3_status = PASS before proceeding.
--
-- 5. If this was an EMERGENCY rollback (production):
--      Follow the HireRise incident response procedure.
--      Do not proceed to Sprint 1C until M3 baseline is restored and
--      Gate G3 is re-certified.
--
-- 6. This script is safe to re-execute (idempotent):
--      DROP POLICY IF EXISTS and DROP ROLE IF EXISTS handle absent objects.
--      REVOKE on a non-existent grant produces a WARNING, not an error.
--      The transaction wrapper ensures no partial state on failure.
--
-- =============================================================================
-- END OF ROLLBACK SCRIPT
-- migration_M3_security_foundation_ROLLBACK_v1.sql
-- Sprint 1B / Package G3 / Gate G3
-- A01.F06 Package — artifact 3 of 3
-- Generated: 2026-06-09 per Phase 2A.1.3 A01.F06 Step 3
-- =============================================================================
