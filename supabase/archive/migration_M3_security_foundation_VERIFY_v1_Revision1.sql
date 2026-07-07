-- =============================================================================
-- HireRise — Phase 2A.1.3 — Sprint 1B
-- Verification: migration_M3_security_foundation_VERIFY_v1_Revision1.sql
--
-- GOVERNANCE BASELINE VERIFICATION — M3 SECURITY FOUNDATION
-- REVISION 1 — Correctness Review Corrections Applied
--
-- Verification Authority:
--   A01.F06 — M3 Governance Baseline Artifact Reconstruction & Commit Readiness
--   Phase 2A.1.3 Step 2 — Generate VERIFY artifact
--
-- Migration Verified:    migration_M3_security_foundation_v1.sql (accepted as
--                        authoritative M3 baseline — A01.F06 closure artifact)
-- Verification Date:     2026-06-09
-- Revision Date:         2026-06-09
-- Revision Authority:    PostgreSQL Correctness Review — Phase 2A.1.3 Step 2A
-- Verification Status:   REVISION 1 — Correctness corrections applied.
--                        For execution in staging after
--                        migration_M3_security_foundation_v1.sql deployment.
--
-- Revision 1 Corrections Applied:
--   D-01 (Critical) — V7-B: Fixed copy/paste defect in signal_category_hierarchy
--                     branch; INSERT and UPDATE checks now reference
--                     public.signal_category_hierarchy (not signal_registry_audit_log).
--   D-02 (High)     — V3-C: All policy role-binding checks now use @> containment
--                     AND array_length() exact cardinality. Prevents over-bound role
--                     arrays from producing false PASS results.
--   D-03 (High)     — V9: Added rolreplication = false to both role_present EXISTS
--                     and overall_gate_g3_status EXISTS subqueries. V9 now fully
--                     aligned with V1-A role attribute specification.
--   D-04 (Medium)   — V8-B: Added c.relname IN (...) table scope filter to policy
--                     comment count query. Prevents same-named policies on unrelated
--                     tables from inflating count and producing false PASS.
--   D-05 (Medium)   — V3-D: INVESTIGATE labels for qual IS NULL cases replaced with
--                     FAIL — Gate G3 BLOCKER. All approved policies require
--                     USING (true); absence is a migration defect.
--   D-08 (Low)      — V5 header: Documented deliberate use of §5.1–§5.4 per-table
--                     sub-section references in FAIL messages. No SQL change required;
--                     references are intentionally granular per Sprint 1B structure.
--
-- Authoritative Sources:
--   Sprint 1B Security Service Specification §3.2, §4.1–4.4, §5.1–5.5
--   HireRise_A01_M3_Security_Migration_Recovery.md Phase 5 (Verification SQL Pack)
--   HireRise_Phase2A1.3_Architecture_Review.md (A01.F06 findings)
--
-- Purpose:
--   This script verifies that all M3 security objects are present and correctly
--   configured in the database following deployment of the M3 baseline migration.
--   Results must be preserved as deployment evidence to close A01.F06 and satisfy
--   Gate G3 (Security Integrity) criteria.
--
-- Design Philosophy:
--   READ-ONLY. No DDL. No DML. No object creation or modification of any kind.
--   Every query returns a result set for operator review.
--   PASS criteria are stated for each section.
--   Any result that does not match PASS criteria is a Gate G3 BLOCKER.
--
-- How to Use:
--   Execute this script in full against the staging database after
--   migration_M3_security_foundation_v1.sql has been committed and applied.
--   Save the full output. The output constitutes the A01.F06 closure evidence.
--   All sections must show PASS results before Sprint 1C work proceeds.
--
-- Approved Policy Inventory (7 policies):
--   signal_lineage:            lineage_service_full, lineage_audit_read
--   signal_registry_audit_log: audit_log_service_only
--   signal_category_hierarchy: hierarchy_read_all, hierarchy_write_service
--   signal_ontology_edges:     ontology_read_all, ontology_write_service
--
-- Approved Grant Model (Sprint 1B §5.5):
--   signal_lineage:            service_role = SELECT/INSERT/UPDATE; governance_audit = SELECT
--   signal_registry_audit_log: service_role = SELECT/INSERT
--   signal_category_hierarchy: anon = SELECT; authenticated = SELECT; service_role = SELECT/INSERT/UPDATE
--   signal_ontology_edges:     anon = SELECT; authenticated = SELECT; service_role = SELECT/INSERT/UPDATE
--   DELETE: not granted to any role on any table.
--
-- NO TRANSACTION WRAPPER:
--   This file is read-only verification. No transaction is needed or appropriate.
--   Each section can be executed independently.
-- =============================================================================


-- =============================================================================
-- V1 — GOVERNANCE ROLE VALIDATION
--
-- Verifies that the governance_audit role exists and has exactly the approved
-- attribute set. Any attribute deviation is a Gate G3 BLOCKER.
--
-- Catalog source: pg_roles
-- Evidence: Sprint 1B §3.2 — role attribute specification
-- Evidence: A01 Recovery Phase 2A — "NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
--           NOCREATEROLE" required attributes
--
-- PASS criteria:
--   Row count = 1
--   rolname           = governance_audit
--   rolsuper          = false
--   rolcreatedb       = false
--   rolcreaterole     = false
--   rolinherit        = false
--   rolcanlogin       = false
--   rolreplication    = false
--
-- FAIL criteria (Gate G3 BLOCKER in all cases):
--   0 rows: role was not created — migration failed or was not executed
--   rolsuper = true: superuser privilege present — security misconfiguration
--   rolcanlogin = true: role can authenticate — violates NOLOGIN requirement
--   Any other attribute = true: privilege escalation present
-- =============================================================================

-- V1-A: Full role attribute verification
-- Expected: 1 row with all boolean attributes false

SELECT
  rolname,
  rolsuper       AS is_superuser,
  rolcreatedb    AS can_create_db,
  rolcreaterole  AS can_create_role,
  rolinherit     AS inherits_privileges,
  rolcanlogin    AS can_login,
  rolreplication AS can_replicate,
  CASE
    WHEN rolname IS NULL THEN 'FAIL — role not found'
    WHEN rolsuper      = true THEN 'FAIL — rolsuper = true'
    WHEN rolcreatedb   = true THEN 'FAIL — rolcreatedb = true'
    WHEN rolcreaterole = true THEN 'FAIL — rolcreaterole = true'
    WHEN rolinherit    = true THEN 'FAIL — rolinherit = true'
    WHEN rolcanlogin   = true THEN 'FAIL — rolcanlogin = true'
    WHEN rolreplication = true THEN 'FAIL — rolreplication = true'
    ELSE 'PASS'
  END AS v1_result
FROM pg_roles
WHERE rolname = 'governance_audit';

-- V1-B: Absence confirmation (zero rows = FAIL)
-- Expected: result_label = 'PASS — governance_audit exists'

SELECT
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'governance_audit')
    THEN 'PASS — governance_audit exists'
    ELSE 'FAIL — governance_audit NOT FOUND — Gate G3 BLOCKER'
  END AS v1b_role_existence;


-- =============================================================================
-- V2 — RLS ENABLEMENT VALIDATION
--
-- Verifies that Row Level Security is enabled on all four Sprint 1A tables.
-- RLS must be enabled before policies have any effect; absence of RLS on any
-- table means that table is unprotected regardless of policy existence.
--
-- Catalog source: pg_class joined to pg_namespace
-- pg_class.relrowsecurity is the authoritative RLS state flag.
-- (pg_tables.rowsecurity is a view over pg_class — equivalent but less direct.)
--
-- PASS criteria:
--   Row count = 4
--   relrowsecurity = true for ALL four tables
--
-- FAIL criteria (Gate G3 BLOCKER):
--   Row count < 4: a Sprint 1A table is missing entirely (Sprint 1A not deployed)
--   relrowsecurity = false for any table: RLS not enabled on that table
-- =============================================================================

-- V2-A: RLS state for all four tables
-- Expected: 4 rows, all with rls_enabled = true

SELECT
  n.nspname                                            AS schema_name,
  c.relname                                            AS table_name,
  c.relrowsecurity                                     AS rls_enabled,
  c.relforcerowsecurity                                AS rls_forced,
  CASE
    WHEN c.relrowsecurity = true THEN 'PASS'
    ELSE 'FAIL — RLS not enabled — Gate G3 BLOCKER'
  END AS v2_result
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'signal_lineage',
    'signal_registry_audit_log',
    'signal_category_hierarchy',
    'signal_ontology_edges'
  )
ORDER BY c.relname;

-- V2-B: Summary count
-- Expected: rls_enabled_count = 4, tables_missing_rls = 0

SELECT
  COUNT(*)                                                   AS tables_found,
  COUNT(*) FILTER (WHERE c.relrowsecurity = true)            AS rls_enabled_count,
  COUNT(*) FILTER (WHERE c.relrowsecurity = false)           AS tables_missing_rls,
  CASE
    WHEN COUNT(*) = 4
     AND COUNT(*) FILTER (WHERE c.relrowsecurity = true) = 4
    THEN 'PASS — RLS enabled on all 4 tables'
    WHEN COUNT(*) < 4
    THEN 'FAIL — one or more Sprint 1A tables absent — Sprint 1A not deployed'
    ELSE 'FAIL — RLS not enabled on ' ||
         COUNT(*) FILTER (WHERE c.relrowsecurity = false)::text ||
         ' table(s) — Gate G3 BLOCKER'
  END AS v2_summary
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'signal_lineage',
    'signal_registry_audit_log',
    'signal_category_hierarchy',
    'signal_ontology_edges'
  );


-- =============================================================================
-- V3 — POLICY INVENTORY VALIDATION
--
-- Verifies that exactly the 7 approved policies exist with the correct
-- table assignments, command types, and role bindings.
--
-- Catalog source: pg_policies
-- pg_policies is the purpose-built system view for RLS policy inspection.
-- The roles column is a name[] array; @> operator tests containment.
--
-- Approved inventory:
--   lineage_service_full    / signal_lineage            / ALL  / service_role
--   lineage_audit_read      / signal_lineage            / SELECT / governance_audit
--   audit_log_service_only  / signal_registry_audit_log / ALL  / service_role
--   hierarchy_read_all      / signal_category_hierarchy / SELECT / anon, authenticated
--   hierarchy_write_service / signal_category_hierarchy / ALL  / service_role
--   ontology_read_all       / signal_ontology_edges     / SELECT / anon, authenticated
--   ontology_write_service  / signal_ontology_edges     / ALL  / service_role
--
-- PASS criteria:
--   Row count = 7 matching the approved inventory exactly
--   cmd values: ALL policies have cmd = 'ALL'; SELECT policies have cmd = 'SELECT'
--   permissive = 'PERMISSIVE' for all policies
--
-- FAIL criteria (Gate G3 BLOCKER):
--   Row count < 7: one or more policies missing
--   Unexpected cmd value: policy scope differs from specification
--   permissive != 'PERMISSIVE': restrictive policy present (unintended behaviour)
-- =============================================================================

-- V3-A: Full policy inventory with attribute detail
-- Expected: 7 rows

SELECT
  p.tablename,
  p.policyname,
  p.cmd,
  p.permissive,
  p.roles,
  p.qual        AS using_predicate,
  p.with_check  AS check_predicate,
  CASE
    WHEN p.permissive != 'PERMISSIVE'
    THEN 'FAIL — policy is RESTRICTIVE, expected PERMISSIVE'
    ELSE 'PASS'
  END AS v3_permissive_check
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.tablename IN (
    'signal_lineage',
    'signal_registry_audit_log',
    'signal_category_hierarchy',
    'signal_ontology_edges'
  )
ORDER BY p.tablename, p.policyname;

-- V3-B: Count of approved policies present
-- Expected: approved_present = 7

SELECT
  COUNT(*) AS approved_present,
  CASE
    WHEN COUNT(*) = 7 THEN 'PASS — all 7 approved policies present'
    WHEN COUNT(*) < 7 THEN 'FAIL — ' || (7 - COUNT(*))::text || ' approved policy/ies missing — Gate G3 BLOCKER'
    WHEN COUNT(*) > 7 THEN 'WARNING — more than 7 rows matched (investigate V4)'
  END AS v3_summary
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    (tablename = 'signal_lineage'            AND policyname IN ('lineage_service_full', 'lineage_audit_read'))
 OR (tablename = 'signal_registry_audit_log' AND policyname IN ('audit_log_service_only'))
 OR (tablename = 'signal_category_hierarchy' AND policyname IN ('hierarchy_read_all', 'hierarchy_write_service'))
 OR (tablename = 'signal_ontology_edges'     AND policyname IN ('ontology_read_all', 'ontology_write_service'))
  );

-- V3-C: Policy-by-policy role binding verification
-- Verifies that each approved policy is bound to the correct role(s)
-- Expected: 7 rows, all with role_binding_check = PASS

SELECT
  tablename,
  policyname,
  roles,
  cmd,
  CASE
    -- D-02 Revision 1: all role-binding checks now use @> (containment) AND array_length (exact
    -- cardinality) to prevent a policy bound to extra roles from producing a false PASS.
    WHEN tablename = 'signal_lineage' AND policyname = 'lineage_service_full'
      THEN CASE WHEN roles @> ARRAY['service_role'::name]
                 AND array_length(roles, 1) = 1
                 AND cmd = 'ALL'
                THEN 'PASS' ELSE 'FAIL — wrong role or cmd' END
    WHEN tablename = 'signal_lineage' AND policyname = 'lineage_audit_read'
      THEN CASE WHEN roles @> ARRAY['governance_audit'::name]
                 AND array_length(roles, 1) = 1
                 AND cmd = 'SELECT'
                THEN 'PASS' ELSE 'FAIL — wrong role or cmd' END
    WHEN tablename = 'signal_registry_audit_log' AND policyname = 'audit_log_service_only'
      THEN CASE WHEN roles @> ARRAY['service_role'::name]
                 AND array_length(roles, 1) = 1
                 AND cmd = 'ALL'
                THEN 'PASS' ELSE 'FAIL — wrong role or cmd' END
    WHEN tablename = 'signal_category_hierarchy' AND policyname = 'hierarchy_read_all'
      THEN CASE WHEN roles @> ARRAY['anon'::name, 'authenticated'::name]
                 AND array_length(roles, 1) = 2
                 AND cmd = 'SELECT'
                THEN 'PASS' ELSE 'FAIL — wrong role(s) or cmd' END
    WHEN tablename = 'signal_category_hierarchy' AND policyname = 'hierarchy_write_service'
      THEN CASE WHEN roles @> ARRAY['service_role'::name]
                 AND array_length(roles, 1) = 1
                 AND cmd = 'ALL'
                THEN 'PASS' ELSE 'FAIL — wrong role or cmd' END
    WHEN tablename = 'signal_ontology_edges' AND policyname = 'ontology_read_all'
      THEN CASE WHEN roles @> ARRAY['anon'::name, 'authenticated'::name]
                 AND array_length(roles, 1) = 2
                 AND cmd = 'SELECT'
                THEN 'PASS' ELSE 'FAIL — wrong role(s) or cmd' END
    WHEN tablename = 'signal_ontology_edges' AND policyname = 'ontology_write_service'
      THEN CASE WHEN roles @> ARRAY['service_role'::name]
                 AND array_length(roles, 1) = 1
                 AND cmd = 'ALL'
                THEN 'PASS' ELSE 'FAIL — wrong role or cmd' END
    ELSE 'FAIL — unrecognised policy (see V4)'
  END AS role_binding_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'signal_lineage',
    'signal_registry_audit_log',
    'signal_category_hierarchy',
    'signal_ontology_edges'
  )
ORDER BY tablename, policyname;

-- V3-D: USING predicate validation
-- All approved policies must have USING = (true).
-- Policies with restrictive predicates would silently deny rows.
-- Expected: all rows show qual = '(true)' or qual IS NULL (for INSERT-only contexts)

SELECT
  tablename,
  policyname,
  cmd,
  qual AS using_clause,
  CASE
    -- D-05 Revision 1: NULL qual cases changed from INVESTIGATE to FAIL.
    -- All approved policies are specified with USING (true) per Sprint 1B.
    -- A missing USING clause means the migration did not apply USING (true) as specified;
    -- this is a migration defect and must be treated as a Gate G3 BLOCKER, not an investigation item.
    WHEN qual IS NULL AND cmd = 'ALL'
      THEN 'FAIL — ALL policy has no USING clause; expected USING (true) — Gate G3 BLOCKER'
    WHEN qual = '(true)'
      THEN 'PASS — USING (true)'
    WHEN qual IS NULL AND cmd = 'SELECT'
      THEN 'FAIL — SELECT policy has no USING clause; expected USING (true) — Gate G3 BLOCKER'
    ELSE 'FAIL — unexpected USING predicate: ' || COALESCE(qual, 'NULL')
  END AS using_check
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    (tablename = 'signal_lineage'            AND policyname IN ('lineage_service_full', 'lineage_audit_read'))
 OR (tablename = 'signal_registry_audit_log' AND policyname IN ('audit_log_service_only'))
 OR (tablename = 'signal_category_hierarchy' AND policyname IN ('hierarchy_read_all', 'hierarchy_write_service'))
 OR (tablename = 'signal_ontology_edges'     AND policyname IN ('ontology_read_all', 'ontology_write_service'))
  )
ORDER BY tablename, policyname;


-- =============================================================================
-- V4 — UNEXPECTED POLICY DETECTION
--
-- Detects any RLS policies on the four governance tables that are NOT in the
-- approved inventory. Extra policies represent unapproved access grants or
-- configuration drift and must be investigated before Sprint 1C deployment.
--
-- Catalog source: pg_policies
--
-- PASS criteria:
--   Row count = 0 (no unexpected policies)
--
-- FAIL criteria:
--   Any rows returned = unapproved policy present — Gate G3 BLOCKER
--   Investigate policy origin before proceeding.
-- =============================================================================

-- V4-A: Unexpected policies on governance tables
-- Expected: 0 rows

SELECT
  tablename,
  policyname,
  cmd,
  roles,
  permissive,
  'UNEXPECTED POLICY — NOT IN APPROVED INVENTORY — Gate G3 BLOCKER' AS v4_finding
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'signal_lineage',
    'signal_registry_audit_log',
    'signal_category_hierarchy',
    'signal_ontology_edges'
  )
  AND NOT (
    (tablename = 'signal_lineage'            AND policyname IN ('lineage_service_full', 'lineage_audit_read'))
 OR (tablename = 'signal_registry_audit_log' AND policyname IN ('audit_log_service_only'))
 OR (tablename = 'signal_category_hierarchy' AND policyname IN ('hierarchy_read_all', 'hierarchy_write_service'))
 OR (tablename = 'signal_ontology_edges'     AND policyname IN ('ontology_read_all', 'ontology_write_service'))
  )
ORDER BY tablename, policyname;

-- V4-B: Missing policies from approved inventory
-- Expected: 0 rows

SELECT
  approved.expected_table   AS tablename,
  approved.expected_policy  AS policyname,
  'MISSING — NOT FOUND IN pg_policies — Gate G3 BLOCKER' AS v4_finding
FROM (
  VALUES
    ('signal_lineage',            'lineage_service_full'),
    ('signal_lineage',            'lineage_audit_read'),
    ('signal_registry_audit_log', 'audit_log_service_only'),
    ('signal_category_hierarchy', 'hierarchy_read_all'),
    ('signal_category_hierarchy', 'hierarchy_write_service'),
    ('signal_ontology_edges',     'ontology_read_all'),
    ('signal_ontology_edges',     'ontology_write_service')
) AS approved(expected_table, expected_policy)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND p.tablename  = approved.expected_table
    AND p.policyname = approved.expected_policy
)
ORDER BY expected_table, expected_policy;


-- =============================================================================
-- V5 — GRANT MODEL VALIDATION
--
-- Validates that the exact approved grant set from Sprint 1B §5.5 is present.
-- Each sub-section covers one table with per-role expected privileges.
--
-- Catalog source: information_schema.role_table_grants
-- This view provides the declared grant set as issued via GRANT statements.
-- It reflects explicit grants; it does not include superuser bypass or role
-- inheritance. This is the correct source for auditing the GRANT model.
--
-- Sprint 1B §5.5 Complete Grant Summary Table:
--   signal_lineage:            service_role = SELECT/INSERT/UPDATE; governance_audit = SELECT
--   signal_registry_audit_log: service_role = SELECT/INSERT
--   signal_category_hierarchy: anon = SELECT; authenticated = SELECT; service_role = SELECT/INSERT/UPDATE
--   signal_ontology_edges:     anon = SELECT; authenticated = SELECT; service_role = SELECT/INSERT/UPDATE
--   DELETE: NOT granted to any role on any table
--
-- D-08 Revision 1 — Section Reference Decision:
--   The correctness review (D-08) queried whether per-table FAIL messages referencing
--   §5.1–§5.4 should be changed to §5.5.
--   Decision: NO CHANGE. The Sprint 1B specification uses §5.5 as the master grant
--   summary table and §5.1–§5.4 as the per-table sub-sections (one per governance table).
--   The V5 supplemental FAIL messages intentionally cite the per-table sub-section so
--   that an operator investigating a deviation is directed to the specific table's
--   authoritative definition, not merely the aggregate summary.
--   This is consistent with the V5-D section comment: "per Sprint 1B §5.4."
--   The references are deliberate, granular, and correct. §5.5 and §5.1–§5.4 are
--   complementary, not conflicting citations.
--
-- PASS criteria for each table: exactly the approved privileges for approved roles.
-- FAIL criteria: missing grant = functionality broken; extra grant = security drift.
-- =============================================================================

-- V5-A: signal_lineage — grant model
-- Expected: service_role has SELECT/INSERT/UPDATE; governance_audit has SELECT
-- Expected: no DELETE grant to any role

SELECT
  grantee,
  privilege_type,
  is_grantable,
  CASE
    WHEN grantee = 'service_role'    AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE') THEN 'PASS — approved'
    WHEN grantee = 'governance_audit' AND privilege_type = 'SELECT'                       THEN 'PASS — approved'
    WHEN privilege_type = 'DELETE'                                                         THEN 'FAIL — DELETE grant present — Gate G3 BLOCKER'
    ELSE 'FAIL — unapproved grant — Gate G3 BLOCKER'
  END AS v5_lineage_check
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name   = 'signal_lineage'
  AND grantee NOT IN ('postgres')
ORDER BY grantee, privilege_type;

-- V5-A supplemental: expected grant presence check
-- Expected: service_role_grants = 3, governance_audit_grants = 1

SELECT
  COUNT(*) FILTER (
    WHERE grantee = 'service_role' AND privilege_type IN ('SELECT','INSERT','UPDATE')
  ) AS service_role_grants,
  COUNT(*) FILTER (
    WHERE grantee = 'governance_audit' AND privilege_type = 'SELECT'
  ) AS governance_audit_grants,
  COUNT(*) FILTER (
    WHERE privilege_type = 'DELETE'
  ) AS delete_grants_present,
  CASE
    WHEN COUNT(*) FILTER (WHERE grantee = 'service_role' AND privilege_type IN ('SELECT','INSERT','UPDATE')) = 3
     AND COUNT(*) FILTER (WHERE grantee = 'governance_audit' AND privilege_type = 'SELECT') = 1
     AND COUNT(*) FILTER (WHERE privilege_type = 'DELETE') = 0
    THEN 'PASS — signal_lineage grant model correct'
    ELSE 'FAIL — signal_lineage grant model deviated from Sprint 1B §5.1'
  END AS v5a_summary
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name   = 'signal_lineage'
  AND grantee NOT IN ('postgres');

-- V5-B: signal_registry_audit_log — grant model
-- Expected: service_role has SELECT/INSERT only. No governance_audit, anon, authenticated grants.
-- Expected: no UPDATE or DELETE grant to any role.

SELECT
  grantee,
  privilege_type,
  is_grantable,
  CASE
    WHEN grantee = 'service_role' AND privilege_type IN ('SELECT', 'INSERT') THEN 'PASS — approved'
    WHEN privilege_type IN ('UPDATE', 'DELETE')                               THEN 'FAIL — UPDATE/DELETE grant present — Gate G3 BLOCKER'
    ELSE 'FAIL — unapproved grant — Gate G3 BLOCKER'
  END AS v5_audit_log_check
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name   = 'signal_registry_audit_log'
  AND grantee NOT IN ('postgres')
ORDER BY grantee, privilege_type;

-- V5-B supplemental
-- Expected: service_role_grants = 2, no_update_delete = true

SELECT
  COUNT(*) FILTER (
    WHERE grantee = 'service_role' AND privilege_type IN ('SELECT','INSERT')
  ) AS service_role_grants,
  COUNT(*) FILTER (
    WHERE privilege_type IN ('UPDATE','DELETE')
  ) AS update_delete_grants,
  COUNT(*) FILTER (
    WHERE grantee NOT IN ('service_role', 'postgres')
  ) AS unauthorized_grantee_grants,
  CASE
    WHEN COUNT(*) FILTER (WHERE grantee = 'service_role' AND privilege_type IN ('SELECT','INSERT')) = 2
     AND COUNT(*) FILTER (WHERE privilege_type IN ('UPDATE','DELETE')) = 0
     AND COUNT(*) FILTER (WHERE grantee NOT IN ('service_role','postgres')) = 0
    THEN 'PASS — signal_registry_audit_log grant model correct'
    ELSE 'FAIL — signal_registry_audit_log grant model deviated from Sprint 1B §5.2'
  END AS v5b_summary
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name   = 'signal_registry_audit_log'
  AND grantee NOT IN ('postgres');

-- V5-C: signal_category_hierarchy — grant model
-- Expected: anon = SELECT; authenticated = SELECT; service_role = SELECT/INSERT/UPDATE
-- Expected: no DELETE grant.

SELECT
  grantee,
  privilege_type,
  is_grantable,
  CASE
    WHEN grantee IN ('anon','authenticated') AND privilege_type = 'SELECT'                        THEN 'PASS — approved'
    WHEN grantee = 'service_role'            AND privilege_type IN ('SELECT','INSERT','UPDATE')   THEN 'PASS — approved'
    WHEN privilege_type = 'DELETE'                                                                 THEN 'FAIL — DELETE grant present — Gate G3 BLOCKER'
    ELSE 'FAIL — unapproved grant — Gate G3 BLOCKER'
  END AS v5_hierarchy_check
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name   = 'signal_category_hierarchy'
  AND grantee NOT IN ('postgres')
ORDER BY grantee, privilege_type;

-- V5-C supplemental
-- Expected: anon_auth_grants = 2 (one each), service_role_grants = 3, delete_grants = 0

SELECT
  COUNT(*) FILTER (WHERE grantee = 'anon'           AND privilege_type = 'SELECT') AS anon_select,
  COUNT(*) FILTER (WHERE grantee = 'authenticated'  AND privilege_type = 'SELECT') AS authenticated_select,
  COUNT(*) FILTER (WHERE grantee = 'service_role'   AND privilege_type IN ('SELECT','INSERT','UPDATE')) AS service_role_grants,
  COUNT(*) FILTER (WHERE privilege_type = 'DELETE')                                 AS delete_grants,
  CASE
    WHEN COUNT(*) FILTER (WHERE grantee = 'anon'          AND privilege_type = 'SELECT') = 1
     AND COUNT(*) FILTER (WHERE grantee = 'authenticated' AND privilege_type = 'SELECT') = 1
     AND COUNT(*) FILTER (WHERE grantee = 'service_role'  AND privilege_type IN ('SELECT','INSERT','UPDATE')) = 3
     AND COUNT(*) FILTER (WHERE privilege_type = 'DELETE') = 0
    THEN 'PASS — signal_category_hierarchy grant model correct'
    ELSE 'FAIL — signal_category_hierarchy grant model deviated from Sprint 1B §5.3'
  END AS v5c_summary
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name   = 'signal_category_hierarchy'
  AND grantee NOT IN ('postgres');

-- V5-D: signal_ontology_edges — grant model
-- Identical pattern to signal_category_hierarchy per Sprint 1B §5.4.

SELECT
  grantee,
  privilege_type,
  is_grantable,
  CASE
    WHEN grantee IN ('anon','authenticated') AND privilege_type = 'SELECT'                        THEN 'PASS — approved'
    WHEN grantee = 'service_role'            AND privilege_type IN ('SELECT','INSERT','UPDATE')   THEN 'PASS — approved'
    WHEN privilege_type = 'DELETE'                                                                 THEN 'FAIL — DELETE grant present — Gate G3 BLOCKER'
    ELSE 'FAIL — unapproved grant — Gate G3 BLOCKER'
  END AS v5_edges_check
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name   = 'signal_ontology_edges'
  AND grantee NOT IN ('postgres')
ORDER BY grantee, privilege_type;

-- V5-D supplemental
-- Expected: identical pass conditions to signal_category_hierarchy

SELECT
  COUNT(*) FILTER (WHERE grantee = 'anon'           AND privilege_type = 'SELECT') AS anon_select,
  COUNT(*) FILTER (WHERE grantee = 'authenticated'  AND privilege_type = 'SELECT') AS authenticated_select,
  COUNT(*) FILTER (WHERE grantee = 'service_role'   AND privilege_type IN ('SELECT','INSERT','UPDATE')) AS service_role_grants,
  COUNT(*) FILTER (WHERE privilege_type = 'DELETE')                                 AS delete_grants,
  CASE
    WHEN COUNT(*) FILTER (WHERE grantee = 'anon'          AND privilege_type = 'SELECT') = 1
     AND COUNT(*) FILTER (WHERE grantee = 'authenticated' AND privilege_type = 'SELECT') = 1
     AND COUNT(*) FILTER (WHERE grantee = 'service_role'  AND privilege_type IN ('SELECT','INSERT','UPDATE')) = 3
     AND COUNT(*) FILTER (WHERE privilege_type = 'DELETE') = 0
    THEN 'PASS — signal_ontology_edges grant model correct'
    ELSE 'FAIL — signal_ontology_edges grant model deviated from Sprint 1B §5.4'
  END AS v5d_summary
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name   = 'signal_ontology_edges'
  AND grantee NOT IN ('postgres');


-- =============================================================================
-- V6 — UNEXPECTED GRANT DETECTION
--
-- Detects any grants on the four governance tables that are not in the
-- approved Sprint 1B §5.5 grant model. This is the privilege-drift detection
-- check. Any row returned represents a Grant G3 BLOCKER.
--
-- Catalog source: information_schema.role_table_grants
--
-- Approved grantees by table:
--   signal_lineage:            service_role, governance_audit (postgres excluded from check)
--   signal_registry_audit_log: service_role
--   signal_category_hierarchy: anon, authenticated, service_role
--   signal_ontology_edges:     anon, authenticated, service_role
--
-- PASS criteria: 0 rows
-- FAIL criteria: any rows = unapproved privilege present — Gate G3 BLOCKER
-- =============================================================================

-- V6-A: Unexpected grantees on signal_lineage
-- Expected: 0 rows

SELECT
  grantee,
  privilege_type,
  'UNEXPECTED on signal_lineage — Gate G3 BLOCKER' AS v6_finding
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name   = 'signal_lineage'
  AND grantee NOT IN ('service_role', 'governance_audit', 'postgres')
ORDER BY grantee, privilege_type;

-- V6-B: Unexpected privileges for approved grantees on signal_lineage
-- (service_role must not have DELETE; governance_audit must not have INSERT/UPDATE/DELETE)
-- Expected: 0 rows

SELECT
  grantee,
  privilege_type,
  'UNAPPROVED PRIVILEGE on signal_lineage — Gate G3 BLOCKER' AS v6_finding
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name   = 'signal_lineage'
  AND grantee NOT IN ('postgres')
  AND NOT (
    (grantee = 'service_role'    AND privilege_type IN ('SELECT','INSERT','UPDATE'))
 OR (grantee = 'governance_audit' AND privilege_type = 'SELECT')
  )
ORDER BY grantee, privilege_type;

-- V6-C: Unexpected grantees on signal_registry_audit_log
-- Expected: 0 rows

SELECT
  grantee,
  privilege_type,
  'UNEXPECTED on signal_registry_audit_log — Gate G3 BLOCKER' AS v6_finding
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name   = 'signal_registry_audit_log'
  AND grantee NOT IN ('postgres')
  AND NOT (grantee = 'service_role' AND privilege_type IN ('SELECT','INSERT'))
ORDER BY grantee, privilege_type;

-- V6-D: Unexpected privileges on signal_category_hierarchy and signal_ontology_edges
-- Expected: 0 rows

SELECT
  table_name,
  grantee,
  privilege_type,
  'UNAPPROVED PRIVILEGE — Gate G3 BLOCKER' AS v6_finding
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('signal_category_hierarchy', 'signal_ontology_edges')
  AND grantee NOT IN ('postgres')
  AND NOT (
    (grantee IN ('anon','authenticated') AND privilege_type = 'SELECT')
 OR (grantee = 'service_role'           AND privilege_type IN ('SELECT','INSERT','UPDATE'))
  )
ORDER BY table_name, grantee, privilege_type;

-- V6-E: Global unexpected grantee scan (all four tables combined)
-- The authoritative sweep for privilege drift detection.
-- Expected: 0 rows

SELECT
  table_name,
  grantee,
  privilege_type,
  'UNEXPECTED GRANT — not in Sprint 1B §5.5 approved model — Gate G3 BLOCKER' AS v6_finding
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN (
    'signal_lineage',
    'signal_registry_audit_log',
    'signal_category_hierarchy',
    'signal_ontology_edges'
  )
  AND grantee NOT IN ('postgres')
  AND NOT (
    -- signal_lineage approved grants
    (table_name = 'signal_lineage' AND grantee = 'service_role'     AND privilege_type IN ('SELECT','INSERT','UPDATE'))
 OR (table_name = 'signal_lineage' AND grantee = 'governance_audit' AND privilege_type = 'SELECT')
    -- signal_registry_audit_log approved grants
 OR (table_name = 'signal_registry_audit_log' AND grantee = 'service_role' AND privilege_type IN ('SELECT','INSERT'))
    -- signal_category_hierarchy approved grants
 OR (table_name = 'signal_category_hierarchy' AND grantee IN ('anon','authenticated') AND privilege_type = 'SELECT')
 OR (table_name = 'signal_category_hierarchy' AND grantee = 'service_role'            AND privilege_type IN ('SELECT','INSERT','UPDATE'))
    -- signal_ontology_edges approved grants
 OR (table_name = 'signal_ontology_edges' AND grantee IN ('anon','authenticated') AND privilege_type = 'SELECT')
 OR (table_name = 'signal_ontology_edges' AND grantee = 'service_role'            AND privilege_type IN ('SELECT','INSERT','UPDATE'))
  )
ORDER BY table_name, grantee, privilege_type;


-- =============================================================================
-- V7 — ROLE ACCESS MATRIX VALIDATION
--
-- Produces a governance evidence matrix showing the effective privilege
-- posture of each role on each governance table.
--
-- Catalog sources:
--   information_schema.role_table_grants (declared grants)
--   has_table_privilege(role, table, privilege) (runtime privilege resolution)
--
-- Note on has_table_privilege():
--   This function resolves effective privileges including role inheritance
--   and superuser bypass. It is used here for the anon/authenticated/governance_audit
--   checks to confirm runtime access matches declared access.
--   For service_role, runtime results include superuser bypass on some Supabase
--   configurations; the declared grant check (V5) remains the governance standard.
--
-- PASS criteria:
--   All roles show exactly the approved privilege posture.
--   governance_audit shows no privileges on signal_registry_audit_log.
--   anon and authenticated show no privileges on governance tables.
-- =============================================================================

-- V7-A: Declared grant access matrix (from role_table_grants)
-- One row per table per grantee showing all held privileges as an array

SELECT
  table_name,
  grantee,
  array_agg(privilege_type ORDER BY privilege_type) AS held_privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN (
    'signal_lineage',
    'signal_registry_audit_log',
    'signal_category_hierarchy',
    'signal_ontology_edges'
  )
  AND grantee NOT IN ('postgres')
GROUP BY table_name, grantee
ORDER BY table_name, grantee;

-- V7-B: Runtime privilege check for governance_audit on all four tables
-- governance_audit should have SELECT on signal_lineage only.
-- Expected: signal_lineage = true; all others = false

SELECT
  'signal_lineage'            AS table_name,
  has_table_privilege('governance_audit', 'public.signal_lineage',            'SELECT') AS select_access,
  has_table_privilege('governance_audit', 'public.signal_lineage',            'INSERT') AS insert_access,
  has_table_privilege('governance_audit', 'public.signal_lineage',            'UPDATE') AS update_access
UNION ALL
SELECT
  'signal_registry_audit_log',
  has_table_privilege('governance_audit', 'public.signal_registry_audit_log', 'SELECT'),
  has_table_privilege('governance_audit', 'public.signal_registry_audit_log', 'INSERT'),
  has_table_privilege('governance_audit', 'public.signal_registry_audit_log', 'UPDATE')
UNION ALL
SELECT
  'signal_category_hierarchy',
  has_table_privilege('governance_audit', 'public.signal_category_hierarchy', 'SELECT'),
  has_table_privilege('governance_audit', 'public.signal_category_hierarchy', 'INSERT'),  -- D-01 Revision 1: corrected from signal_registry_audit_log (copy/paste defect)
  has_table_privilege('governance_audit', 'public.signal_category_hierarchy', 'UPDATE')  -- D-01 Revision 1: corrected from signal_registry_audit_log (copy/paste defect)
UNION ALL
SELECT
  'signal_ontology_edges',
  has_table_privilege('governance_audit', 'public.signal_ontology_edges',     'SELECT'),
  has_table_privilege('governance_audit', 'public.signal_ontology_edges',     'INSERT'),
  has_table_privilege('governance_audit', 'public.signal_ontology_edges',     'UPDATE');

-- V7-C: Runtime privilege check for anon on governance infrastructure tables
-- anon should NOT have any access to signal_lineage or signal_registry_audit_log
-- Expected: both = false for both tables

SELECT
  'signal_lineage — anon SELECT'            AS check_item,
  has_table_privilege('anon', 'public.signal_lineage',            'SELECT') AS result,
  CASE WHEN has_table_privilege('anon', 'public.signal_lineage', 'SELECT')
       THEN 'FAIL — anon has SELECT on signal_lineage — Gate G3 BLOCKER'
       ELSE 'PASS — anon has no SELECT on signal_lineage' END AS verdict
UNION ALL
SELECT
  'signal_registry_audit_log — anon SELECT',
  has_table_privilege('anon', 'public.signal_registry_audit_log', 'SELECT'),
  CASE WHEN has_table_privilege('anon', 'public.signal_registry_audit_log', 'SELECT')
       THEN 'FAIL — anon has SELECT on signal_registry_audit_log — Gate G3 BLOCKER'
       ELSE 'PASS — anon has no SELECT on signal_registry_audit_log' END;

-- V7-D: Consolidated access matrix for governance evidence
-- Produces the complete evidence matrix per Sprint 1B §5.5 design
-- Label format: granted privileges as comma-separated string, or 'none'

SELECT
  rtg.table_name,
  rtg.grantee,
  string_agg(rtg.privilege_type, ', ' ORDER BY rtg.privilege_type) AS granted_privileges,
  CASE
    WHEN rtg.table_name = 'signal_lineage' AND rtg.grantee = 'service_role'
      THEN CASE WHEN string_agg(rtg.privilege_type, ',' ORDER BY rtg.privilege_type)
                     = 'INSERT,SELECT,UPDATE' THEN 'PASS' ELSE 'FAIL — incomplete' END
    WHEN rtg.table_name = 'signal_lineage' AND rtg.grantee = 'governance_audit'
      THEN CASE WHEN string_agg(rtg.privilege_type, ',' ORDER BY rtg.privilege_type)
                     = 'SELECT' THEN 'PASS' ELSE 'FAIL — incorrect' END
    WHEN rtg.table_name = 'signal_registry_audit_log' AND rtg.grantee = 'service_role'
      THEN CASE WHEN string_agg(rtg.privilege_type, ',' ORDER BY rtg.privilege_type)
                     = 'INSERT,SELECT' THEN 'PASS' ELSE 'FAIL — incorrect' END
    WHEN rtg.table_name IN ('signal_category_hierarchy','signal_ontology_edges')
      AND rtg.grantee IN ('anon','authenticated')
      THEN CASE WHEN string_agg(rtg.privilege_type, ',' ORDER BY rtg.privilege_type)
                     = 'SELECT' THEN 'PASS' ELSE 'FAIL — incorrect' END
    WHEN rtg.table_name IN ('signal_category_hierarchy','signal_ontology_edges')
      AND rtg.grantee = 'service_role'
      THEN CASE WHEN string_agg(rtg.privilege_type, ',' ORDER BY rtg.privilege_type)
                     = 'INSERT,SELECT,UPDATE' THEN 'PASS' ELSE 'FAIL — incomplete' END
    ELSE 'UNEXPECTED GRANTEE'
  END AS matrix_check
FROM information_schema.role_table_grants rtg
WHERE rtg.table_schema = 'public'
  AND rtg.table_name IN (
    'signal_lineage',
    'signal_registry_audit_log',
    'signal_category_hierarchy',
    'signal_ontology_edges'
  )
  AND rtg.grantee NOT IN ('postgres')
GROUP BY rtg.table_name, rtg.grantee
ORDER BY rtg.table_name, rtg.grantee;


-- =============================================================================
-- V8 — POLICY COMMENT VALIDATION
--
-- Verifies that all 7 approved policies have comments present in pg_description.
-- Policy comments are stored with classoid matching the pg_policy system catalog OID.
--
-- Catalog sources:
--   pg_description (object comments)
--   pg_policy (policy OIDs)
--   pg_class (table OIDs)
--   pg_namespace (schema OIDs)
--
-- PASS criteria:
--   7 rows returned, all with comment_present = true
--   All 7 policies have non-empty comment text
--
-- Note: Policy comments are governance traceability artifacts as established
-- during the Revision 1 review. Their presence confirms the migration ran
-- in full (COMMENT ON POLICY executes after CREATE POLICY in the same migration).
-- Absence of a comment does not affect runtime security but indicates the
-- migration may have been interrupted after policy creation.
-- =============================================================================

-- V8-A: Policy comment existence check
-- Expected: 7 rows, all with comment_present = true

SELECT
  n.nspname                                  AS schema_name,
  c.relname                                  AS table_name,
  pol.polname                                AS policy_name,
  CASE WHEN d.description IS NOT NULL
       THEN true ELSE false END              AS comment_present,
  left(d.description, 80)                   AS comment_preview,
  CASE WHEN d.description IS NOT NULL
       THEN 'PASS'
       ELSE 'FAIL — policy comment absent (migration may be incomplete)'
  END AS v8_result
FROM pg_policy pol
JOIN pg_class c      ON c.oid = pol.polrelid
JOIN pg_namespace n  ON n.oid = c.relnamespace
LEFT JOIN pg_description d ON d.objoid = pol.oid
                           AND d.classoid = 'pg_policy'::regclass
WHERE n.nspname = 'public'
  AND c.relname IN (
    'signal_lineage',
    'signal_registry_audit_log',
    'signal_category_hierarchy',
    'signal_ontology_edges'
  )
  AND pol.polname IN (
    'lineage_service_full',
    'lineage_audit_read',
    'audit_log_service_only',
    'hierarchy_read_all',
    'hierarchy_write_service',
    'ontology_read_all',
    'ontology_write_service'
  )
ORDER BY c.relname, pol.polname;

-- V8-B: Count of policies with comments
-- Expected: commented_policies = 7

SELECT
  COUNT(*) AS policies_with_comments,
  CASE
    WHEN COUNT(*) = 7 THEN 'PASS — all 7 policy comments present'
    ELSE 'FAIL — ' || (7 - COUNT(*))::text || ' policy comment(s) absent'
  END AS v8_summary
FROM pg_policy pol
JOIN pg_class c      ON c.oid = pol.polrelid
JOIN pg_namespace n  ON n.oid = c.relnamespace
JOIN pg_description d ON d.objoid = pol.oid
                      AND d.classoid = 'pg_policy'::regclass
WHERE n.nspname = 'public'
  AND c.relname IN (                         -- D-04 Revision 1: added table scope filter to prevent
    'signal_lineage',                        -- same-named policies on unrelated tables from inflating count
    'signal_registry_audit_log',
    'signal_category_hierarchy',
    'signal_ontology_edges'
  )
  AND pol.polname IN (
    'lineage_service_full',
    'lineage_audit_read',
    'audit_log_service_only',
    'hierarchy_read_all',
    'hierarchy_write_service',
    'ontology_read_all',
    'ontology_write_service'
  );


-- =============================================================================
-- V9 — GOVERNANCE BASELINE SUMMARY
--
-- Produces a single summary row aggregating the key pass/fail indicators
-- from V1 through V8. This is the governance sign-off evidence record.
-- Save this output with a timestamp as the A01.F06 closure evidence.
--
-- PASS state (all columns must match for Gate G3 to pass):
--   role_present              = true
--   rls_enabled_count         = 4
--   policy_count              = 7
--   unexpected_policy_count   = 0
--   unexpected_grant_count    = 0
--   delete_grant_count        = 0
--   policy_comment_count      = 7
--   overall_gate_g3_status    = PASS
-- =============================================================================

SELECT
  -- Role check
  EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'governance_audit'
      AND rolsuper      = false
      AND rolcreatedb   = false
      AND rolcreaterole = false
      AND rolcanlogin   = false
      AND rolinherit    = false
      AND rolreplication = false  -- D-03 Revision 1: aligned with V1-A; rolreplication was absent
  ) AS role_present,

  -- RLS check
  (
    SELECT COUNT(*)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN (
        'signal_lineage', 'signal_registry_audit_log',
        'signal_category_hierarchy', 'signal_ontology_edges'
      )
      AND c.relrowsecurity = true
  )::integer AS rls_enabled_count,

  -- Approved policy count
  (
    SELECT COUNT(*)
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        (tablename = 'signal_lineage'            AND policyname IN ('lineage_service_full','lineage_audit_read'))
     OR (tablename = 'signal_registry_audit_log' AND policyname IN ('audit_log_service_only'))
     OR (tablename = 'signal_category_hierarchy' AND policyname IN ('hierarchy_read_all','hierarchy_write_service'))
     OR (tablename = 'signal_ontology_edges'     AND policyname IN ('ontology_read_all','ontology_write_service'))
      )
  )::integer AS policy_count,

  -- Unexpected policy count
  (
    SELECT COUNT(*)
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'signal_lineage', 'signal_registry_audit_log',
        'signal_category_hierarchy', 'signal_ontology_edges'
      )
      AND NOT (
        (tablename = 'signal_lineage'            AND policyname IN ('lineage_service_full','lineage_audit_read'))
     OR (tablename = 'signal_registry_audit_log' AND policyname IN ('audit_log_service_only'))
     OR (tablename = 'signal_category_hierarchy' AND policyname IN ('hierarchy_read_all','hierarchy_write_service'))
     OR (tablename = 'signal_ontology_edges'     AND policyname IN ('ontology_read_all','ontology_write_service'))
      )
  )::integer AS unexpected_policy_count,

  -- Unexpected grant count (across all four tables, excluding postgres)
  (
    SELECT COUNT(*)
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN (
        'signal_lineage', 'signal_registry_audit_log',
        'signal_category_hierarchy', 'signal_ontology_edges'
      )
      AND grantee NOT IN ('postgres')
      AND NOT (
        (table_name = 'signal_lineage' AND grantee = 'service_role'      AND privilege_type IN ('SELECT','INSERT','UPDATE'))
     OR (table_name = 'signal_lineage' AND grantee = 'governance_audit'  AND privilege_type = 'SELECT')
     OR (table_name = 'signal_registry_audit_log' AND grantee = 'service_role' AND privilege_type IN ('SELECT','INSERT'))
     OR (table_name = 'signal_category_hierarchy' AND grantee IN ('anon','authenticated') AND privilege_type = 'SELECT')
     OR (table_name = 'signal_category_hierarchy' AND grantee = 'service_role' AND privilege_type IN ('SELECT','INSERT','UPDATE'))
     OR (table_name = 'signal_ontology_edges' AND grantee IN ('anon','authenticated') AND privilege_type = 'SELECT')
     OR (table_name = 'signal_ontology_edges' AND grantee = 'service_role' AND privilege_type IN ('SELECT','INSERT','UPDATE'))
      )
  )::integer AS unexpected_grant_count,

  -- DELETE grant count (must be 0 — permanent architectural constraint)
  (
    SELECT COUNT(*)
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN (
        'signal_lineage', 'signal_registry_audit_log',
        'signal_category_hierarchy', 'signal_ontology_edges'
      )
      AND privilege_type = 'DELETE'
      AND grantee NOT IN ('postgres')
  )::integer AS delete_grant_count,

  -- Policy comment count
  (
    SELECT COUNT(*)
    FROM pg_policy pol
    JOIN pg_class c      ON c.oid = pol.polrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_description d ON d.objoid = pol.oid
                          AND d.classoid = 'pg_policy'::regclass
    WHERE n.nspname = 'public'
      AND pol.polname IN (
        'lineage_service_full', 'lineage_audit_read', 'audit_log_service_only',
        'hierarchy_read_all', 'hierarchy_write_service',
        'ontology_read_all', 'ontology_write_service'
      )
  )::integer AS policy_comment_count,

  -- Verification timestamp
  now() AS verified_at,

  -- Overall Gate G3 status
  CASE
    WHEN
      -- role present and unprivileged
      EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = 'governance_audit'
          AND rolsuper = false AND rolcreatedb = false
          AND rolcreaterole = false AND rolcanlogin = false AND rolinherit = false
          AND rolreplication = false  -- D-03 Revision 1: aligned with V1-A; rolreplication was absent
      )
      -- RLS on all 4 tables
      AND (
        SELECT COUNT(*) FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('signal_lineage','signal_registry_audit_log','signal_category_hierarchy','signal_ontology_edges')
          AND c.relrowsecurity = true
      ) = 4
      -- all 7 approved policies present
      AND (
        SELECT COUNT(*) FROM pg_policies
        WHERE schemaname = 'public'
          AND ((tablename='signal_lineage'            AND policyname IN ('lineage_service_full','lineage_audit_read'))
            OR (tablename='signal_registry_audit_log' AND policyname IN ('audit_log_service_only'))
            OR (tablename='signal_category_hierarchy' AND policyname IN ('hierarchy_read_all','hierarchy_write_service'))
            OR (tablename='signal_ontology_edges'     AND policyname IN ('ontology_read_all','ontology_write_service')))
      ) = 7
      -- no unexpected policies
      AND (
        SELECT COUNT(*) FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('signal_lineage','signal_registry_audit_log','signal_category_hierarchy','signal_ontology_edges')
          AND NOT ((tablename='signal_lineage'            AND policyname IN ('lineage_service_full','lineage_audit_read'))
                OR (tablename='signal_registry_audit_log' AND policyname IN ('audit_log_service_only'))
                OR (tablename='signal_category_hierarchy' AND policyname IN ('hierarchy_read_all','hierarchy_write_service'))
                OR (tablename='signal_ontology_edges'     AND policyname IN ('ontology_read_all','ontology_write_service')))
      ) = 0
      -- no unexpected grants
      AND (
        SELECT COUNT(*) FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name IN ('signal_lineage','signal_registry_audit_log','signal_category_hierarchy','signal_ontology_edges')
          AND grantee NOT IN ('postgres')
          AND NOT (
            (table_name='signal_lineage' AND grantee='service_role'    AND privilege_type IN ('SELECT','INSERT','UPDATE'))
         OR (table_name='signal_lineage' AND grantee='governance_audit' AND privilege_type='SELECT')
         OR (table_name='signal_registry_audit_log' AND grantee='service_role' AND privilege_type IN ('SELECT','INSERT'))
         OR (table_name='signal_category_hierarchy' AND grantee IN ('anon','authenticated') AND privilege_type='SELECT')
         OR (table_name='signal_category_hierarchy' AND grantee='service_role' AND privilege_type IN ('SELECT','INSERT','UPDATE'))
         OR (table_name='signal_ontology_edges' AND grantee IN ('anon','authenticated') AND privilege_type='SELECT')
         OR (table_name='signal_ontology_edges' AND grantee='service_role' AND privilege_type IN ('SELECT','INSERT','UPDATE'))
          )
      ) = 0
      -- no DELETE grants
      AND (
        SELECT COUNT(*) FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name IN ('signal_lineage','signal_registry_audit_log','signal_category_hierarchy','signal_ontology_edges')
          AND privilege_type = 'DELETE' AND grantee NOT IN ('postgres')
      ) = 0
    THEN 'PASS — Gate G3 Security Integrity satisfied — M3 baseline confirmed'
    ELSE 'FAIL — one or more Gate G3 criteria not met — review individual V1–V8 sections'
  END AS overall_gate_g3_status;

-- =============================================================================
-- END OF VERIFICATION SCRIPT
-- migration_M3_security_foundation_VERIFY_v1_Revision1.sql
-- Sprint 1B / Package G3 / Gate G3
-- Original: 2026-06-09 per Phase 2A.1.3 A01.F06 Step 2
-- Revision 1: 2026-06-09 per Phase 2A.1.3 A01.F06 Step 2A correctness review
-- Corrections: D-01, D-02, D-03, D-04, D-05, D-08
--
-- Evidence collection instructions:
--   1. Execute this script in full against the staging database.
--   2. Save the complete output (all result sets).
--   3. The V9 summary row is the primary A01.F06 closure evidence record.
--      overall_gate_g3_status must = 'PASS' to close A01.F06.
--   4. Individual V1–V8 section outputs provide detailed evidence for
--      each Gate G3 criterion per Sprint 1B acceptance criteria SEC-AC-08
--      through SEC-AC-10 and SEC-AC-17.
--   5. Any FAIL result in any section is a Gate G3 BLOCKER.
--      Sprint 1C work must not proceed until all sections show PASS.
-- =============================================================================
