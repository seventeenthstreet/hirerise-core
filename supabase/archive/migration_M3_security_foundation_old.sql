-- =============================================================================
-- HireRise — Phase 2A.1 Sprint 1B
-- Migration: M3 — Security Foundation
-- Migration ID: migration_M3_security_foundation
-- Sprint: 1B (Security & Service Layer)
-- Amendment: A01 — M3 Recovery (Phase 2A.1.3)
-- Recovery Date: 8 June 2026
-- Architecture Basis:
--   Sprint 1A Migration Specification (approved)
--   Sprint 1B Security & Service Specification §§2-5 (approved, C3 incorporated)
--   Sprint 1 Implementation Plan §§5.1-5.3 (approved)
--   R1 Final Approved Amendment C1/C2/C3 (approved)
-- Prerequisites:
--   Sprint 1A migrations fully deployed and verified:
--     signal_lineage (DB-04)
--     signal_registry_audit_log (DB-05)
--     signal_category_hierarchy (DB-06)
--     signal_ontology_edges (DB-07)
-- Deployment role: postgres (superuser / migration executor)
-- Author note: This migration was absent from the repository. It is reconstructed
--   from specification and is authoritative. See A01 Recovery Report for full
--   forensic determination.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 0: PREREQUISITE VERIFICATION
-- Assert all four Sprint 1A tables exist before applying any security objects.
-- If any table is missing, this block aborts the transaction immediately.
-- =============================================================================

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_lineage'
  ), 'M3 PREREQUISITE FAILED: signal_lineage table does not exist. '
     'Sprint 1A must be fully deployed before M3.';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_registry_audit_log'
  ), 'M3 PREREQUISITE FAILED: signal_registry_audit_log table does not exist. '
     'Sprint 1A must be fully deployed before M3.';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_category_hierarchy'
  ), 'M3 PREREQUISITE FAILED: signal_category_hierarchy table does not exist. '
     'Sprint 1A must be fully deployed before M3.';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signal_ontology_edges'
  ), 'M3 PREREQUISITE FAILED: signal_ontology_edges table does not exist. '
     'Sprint 1A must be fully deployed before M3.';

  RAISE NOTICE 'M3 §0: All Sprint 1A prerequisite tables confirmed. Proceeding with security foundation.';
END;
$$;


-- =============================================================================
-- SECTION 1: ROLE CREATION
-- SEC-01: governance_audit role
-- Must be created BEFORE any RLS policy that references it (Policy lineage_audit_read).
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

    COMMENT ON ROLE governance_audit IS
      'Dedicated read-only role for HireRise governance audit access to signal_lineage. '
      'SELECT-only on signal_lineage (all rows including unapproved proposals). '
      'No direct access to signal_registry_audit_log — audit log access via SECURITY DEFINER RPCs only. '
      'Must NEVER be issued to Supabase Auth user sessions or appear in JWT claims. '
      'Sprint 1B SEC-01. Governance: service-level role for dedicated governance processes only. '
      'M3 Security Foundation Migration — 8 June 2026.';

    RAISE NOTICE 'M3 §1: governance_audit role CREATED.';
  ELSE
    RAISE NOTICE 'M3 §1: governance_audit role already exists — skipped creation.';
  END IF;
END;
$$;


-- =============================================================================
-- SECTION 2: RLS ENABLEMENT
-- Enable Row Level Security on all four Sprint 1A governance tables.
-- These statements are idempotent: safe to run if RLS is already enabled.
-- =============================================================================

ALTER TABLE public.signal_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_registry_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_category_hierarchy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_ontology_edges ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  RAISE NOTICE 'M3 §2: RLS ENABLED on all four Sprint 1A governance tables.';
END;
$$;


-- =============================================================================
-- SECTION 3: RLS POLICIES — signal_lineage
-- Two policies: lineage_service_full (service_role) + lineage_audit_read (governance_audit)
-- Default deny applies to all other roles: anon, authenticated have zero access.
-- Sprint 1B §4.1
-- =============================================================================

-- Policy: lineage_service_full
-- Grants service_role complete operational access (SELECT, INSERT, UPDATE).
-- Used by lineage.service.ts for all write operations.
-- NOTE: No DELETE policy — no DELETE GRANT exists either (defence in depth).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'signal_lineage'
      AND policyname = 'lineage_service_full'
  ) THEN
    CREATE POLICY lineage_service_full
      ON public.signal_lineage
      AS PERMISSIVE
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
    RAISE NOTICE 'M3 §3: lineage_service_full policy CREATED on signal_lineage.';
  ELSE
    RAISE NOTICE 'M3 §3: lineage_service_full policy already exists on signal_lineage — skipped.';
  END IF;
END;
$$;

-- Policy: lineage_audit_read
-- Grants governance_audit SELECT access to ALL rows including unapproved proposals.
-- Supports governance tooling, regulatory reporting, and fn_get_lineage_audit_log() RPC context.
-- R1 Correction C3: anon and authenticated receive NO policy — default deny.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'signal_lineage'
      AND policyname = 'lineage_audit_read'
  ) THEN
    CREATE POLICY lineage_audit_read
      ON public.signal_lineage
      AS PERMISSIVE
      FOR SELECT
      TO governance_audit
      USING (true);
    RAISE NOTICE 'M3 §3: lineage_audit_read policy CREATED on signal_lineage.';
  ELSE
    RAISE NOTICE 'M3 §3: lineage_audit_read policy already exists on signal_lineage — skipped.';
  END IF;
END;
$$;


-- =============================================================================
-- SECTION 4: RLS POLICIES — signal_registry_audit_log
-- One policy: audit_log_service_only (service_role).
-- No other role may access this table directly.
-- The immutability trigger (trg_registry_audit_no_mutate, DB-09) provides
-- additional UPDATE/DELETE blocking for service_role beyond what RLS provides.
-- Sprint 1B §4.2
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'signal_registry_audit_log'
      AND policyname = 'audit_log_service_only'
  ) THEN
    CREATE POLICY audit_log_service_only
      ON public.signal_registry_audit_log
      AS PERMISSIVE
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
    RAISE NOTICE 'M3 §4: audit_log_service_only policy CREATED on signal_registry_audit_log.';
  ELSE
    RAISE NOTICE 'M3 §4: audit_log_service_only policy already exists on signal_registry_audit_log — skipped.';
  END IF;
END;
$$;


-- =============================================================================
-- SECTION 5: RLS POLICIES — signal_category_hierarchy
-- Two policies: hierarchy_read_all (anon, authenticated) + hierarchy_write_service (service_role)
-- Public reference data — broad read access is intentional.
-- Sprint 1B §4.3
-- =============================================================================

-- Policy: hierarchy_read_all
-- Public taxonomy reference data. Enables client-side taxonomy rendering.
-- Note: RLS does not filter inactive categories — application layer must filter
-- on is_active = true for production taxonomy queries.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'signal_category_hierarchy'
      AND policyname = 'hierarchy_read_all'
  ) THEN
    CREATE POLICY hierarchy_read_all
      ON public.signal_category_hierarchy
      AS PERMISSIVE
      FOR SELECT
      TO anon, authenticated
      USING (true);
    RAISE NOTICE 'M3 §5: hierarchy_read_all policy CREATED on signal_category_hierarchy.';
  ELSE
    RAISE NOTICE 'M3 §5: hierarchy_read_all policy already exists on signal_category_hierarchy — skipped.';
  END IF;
END;
$$;

-- Policy: hierarchy_write_service
-- Taxonomy administration. INSERT/UPDATE for taxonomy additions and soft-deactivations.
-- No DELETE — soft-delete via is_active = false is the only approved removal.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'signal_category_hierarchy'
      AND policyname = 'hierarchy_write_service'
  ) THEN
    CREATE POLICY hierarchy_write_service
      ON public.signal_category_hierarchy
      AS PERMISSIVE
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
    RAISE NOTICE 'M3 §5: hierarchy_write_service policy CREATED on signal_category_hierarchy.';
  ELSE
    RAISE NOTICE 'M3 §5: hierarchy_write_service policy already exists on signal_category_hierarchy — skipped.';
  END IF;
END;
$$;


-- =============================================================================
-- SECTION 6: RLS POLICIES — signal_ontology_edges
-- Identical access model to signal_category_hierarchy.
-- Two policies: ontology_read_all (anon, authenticated) + ontology_write_service (service_role)
-- Sprint 1B §4.4
-- =============================================================================

-- Policy: ontology_read_all
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'signal_ontology_edges'
      AND policyname = 'ontology_read_all'
  ) THEN
    CREATE POLICY ontology_read_all
      ON public.signal_ontology_edges
      AS PERMISSIVE
      FOR SELECT
      TO anon, authenticated
      USING (true);
    RAISE NOTICE 'M3 §6: ontology_read_all policy CREATED on signal_ontology_edges.';
  ELSE
    RAISE NOTICE 'M3 §6: ontology_read_all policy already exists on signal_ontology_edges — skipped.';
  END IF;
END;
$$;

-- Policy: ontology_write_service
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'signal_ontology_edges'
      AND policyname = 'ontology_write_service'
  ) THEN
    CREATE POLICY ontology_write_service
      ON public.signal_ontology_edges
      AS PERMISSIVE
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
    RAISE NOTICE 'M3 §6: ontology_write_service policy CREATED on signal_ontology_edges.';
  ELSE
    RAISE NOTICE 'M3 §6: ontology_write_service policy already exists on signal_ontology_edges — skipped.';
  END IF;
END;
$$;


-- =============================================================================
-- SECTION 7: GRANT MODEL
-- Sprint 1B §5 — complete GRANT model for all four tables.
-- NO DELETE is granted to any role on any Sprint 1A table.
-- This is a permanent architectural constraint — not a temporary restriction.
-- =============================================================================

-- --- signal_lineage ---
-- service_role: SELECT, INSERT, UPDATE (NO DELETE)
-- governance_audit: SELECT only
GRANT SELECT, INSERT, UPDATE ON public.signal_lineage TO service_role;
GRANT SELECT ON public.signal_lineage TO governance_audit;

-- --- signal_registry_audit_log ---
-- service_role: SELECT, INSERT (NO UPDATE, NO DELETE — immutability trigger enforces at DB layer)
GRANT SELECT, INSERT ON public.signal_registry_audit_log TO service_role;

-- --- signal_category_hierarchy ---
-- anon: SELECT
-- authenticated: SELECT
-- service_role: SELECT, INSERT, UPDATE (NO DELETE — soft-delete via is_active = false only)
GRANT SELECT ON public.signal_category_hierarchy TO anon;
GRANT SELECT ON public.signal_category_hierarchy TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.signal_category_hierarchy TO service_role;

-- --- signal_ontology_edges ---
-- Identical pattern to signal_category_hierarchy
GRANT SELECT ON public.signal_ontology_edges TO anon;
GRANT SELECT ON public.signal_ontology_edges TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.signal_ontology_edges TO service_role;

DO $$
BEGIN
  RAISE NOTICE 'M3 §7: All GRANTs applied.';
END;
$$;


-- =============================================================================
-- SECTION 8: DEFENSIVE REVOKES
-- Ensure DELETE grants and any unexpected over-privileged grants are absent.
-- These REVOKEs are safe to run even if the grants never existed.
-- =============================================================================

REVOKE DELETE ON public.signal_lineage FROM service_role;
REVOKE DELETE ON public.signal_lineage FROM governance_audit;
REVOKE DELETE ON public.signal_lineage FROM authenticated;
REVOKE DELETE ON public.signal_lineage FROM anon;

REVOKE UPDATE, DELETE ON public.signal_registry_audit_log FROM service_role;
REVOKE ALL ON public.signal_registry_audit_log FROM governance_audit;
REVOKE ALL ON public.signal_registry_audit_log FROM authenticated;
REVOKE ALL ON public.signal_registry_audit_log FROM anon;

REVOKE DELETE ON public.signal_category_hierarchy FROM service_role;
REVOKE INSERT, UPDATE, DELETE ON public.signal_category_hierarchy FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.signal_category_hierarchy FROM anon;

REVOKE DELETE ON public.signal_ontology_edges FROM service_role;
REVOKE INSERT, UPDATE, DELETE ON public.signal_ontology_edges FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.signal_ontology_edges FROM anon;

DO $$
BEGIN
  RAISE NOTICE 'M3 §8: Defensive REVOKEs applied.';
END;
$$;


-- =============================================================================
-- SECTION 9: POST-DEPLOYMENT ASSERTIONS
-- Self-verifying deployment gate. If any assertion fails, the transaction rolls back.
-- =============================================================================

DO $$
DECLARE
  v_role_count int;
  v_rls_count int;
  v_policy_count int;
  v_grant_count int;
  v_delete_grant_count int;
BEGIN
  -- Assert governance_audit role exists
  SELECT COUNT(*) INTO v_role_count
  FROM pg_roles WHERE rolname = 'governance_audit';

  ASSERT v_role_count = 1,
    'M3 ASSERTION FAILED (§9): governance_audit role not found in pg_roles.';

  -- Assert governance_audit is not a superuser
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'governance_audit' AND rolsuper = true
  ), 'M3 ASSERTION FAILED (§9): governance_audit must not be a superuser.';

  -- Assert governance_audit cannot login
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'governance_audit' AND rolcanlogin = true
  ), 'M3 ASSERTION FAILED (§9): governance_audit must have NOLOGIN.';

  -- Assert RLS enabled on all four tables
  SELECT COUNT(*) INTO v_rls_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('signal_lineage', 'signal_registry_audit_log',
                      'signal_category_hierarchy', 'signal_ontology_edges')
    AND rowsecurity = true;

  ASSERT v_rls_count = 4,
    'M3 ASSERTION FAILED (§9): RLS not enabled on all four Sprint 1A tables. '
    'Expected 4, found: ' || v_rls_count::text;

  -- Assert all 7 RLS policies exist
  SELECT COUNT(*) INTO v_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND policyname IN (
      'lineage_service_full', 'lineage_audit_read',
      'audit_log_service_only',
      'hierarchy_read_all', 'hierarchy_write_service',
      'ontology_read_all', 'ontology_write_service'
    );

  ASSERT v_policy_count = 7,
    'M3 ASSERTION FAILED (§9): Expected 7 RLS policies, found: ' || v_policy_count::text;

  -- Assert no DELETE grants exist
  SELECT COUNT(*) INTO v_delete_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('signal_lineage', 'signal_registry_audit_log',
                       'signal_category_hierarchy', 'signal_ontology_edges')
    AND privilege_type = 'DELETE'
    AND grantee NOT IN ('postgres');

  ASSERT v_delete_grant_count = 0,
    'M3 ASSERTION FAILED (§9): DELETE grant exists on a Sprint 1A table. '
    'Count: ' || v_delete_grant_count::text || '. Investigate immediately.';

  -- Assert governance_audit has no access to signal_registry_audit_log
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'signal_registry_audit_log'
      AND grantee = 'governance_audit'
  ), 'M3 ASSERTION FAILED (§9): governance_audit has a grant on signal_registry_audit_log. '
     'Audit log must be inaccessible to governance_audit at the table level.';

  RAISE NOTICE 'M3 §9: ALL POST-DEPLOYMENT ASSERTIONS PASSED.';
  RAISE NOTICE 'M3 §9: governance_audit role: VERIFIED';
  RAISE NOTICE 'M3 §9: RLS enabled on 4 tables: VERIFIED';
  RAISE NOTICE 'M3 §9: 7 RLS policies deployed: VERIFIED';
  RAISE NOTICE 'M3 §9: Zero DELETE grants: VERIFIED';
  RAISE NOTICE 'M3 §9: governance_audit excluded from audit_log: VERIFIED';
  RAISE NOTICE '======================================================';
  RAISE NOTICE 'M3 SECURITY FOUNDATION MIGRATION: DEPLOYMENT COMPLETE.';
  RAISE NOTICE 'Sprint 1B SEC-01 through SEC-07: SATISFIED.';
  RAISE NOTICE 'DEV-11 database deployment: CONFIRMED.';
  RAISE NOTICE '======================================================';
END;
$$;

COMMIT;

-- =============================================================================
-- POST-COMMIT VERIFICATION QUERIES
-- Run these after COMMIT to produce evidence for DEV-11 closure record.
-- Copy output to the DEV-11 closure ticket.
-- =============================================================================

-- VQ-01: Role verification
SELECT
  rolname,
  rolsuper,
  rolcreatedb,
  rolcreaterole,
  rolinherit,
  rolcanlogin,
  rolreplication
FROM pg_roles
WHERE rolname = 'governance_audit';

-- VQ-02: RLS enablement verification
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'signal_lineage', 'signal_registry_audit_log',
    'signal_category_hierarchy', 'signal_ontology_edges'
  )
ORDER BY tablename;

-- VQ-03: Policy existence verification
SELECT schemaname, tablename, policyname, roles, cmd, permissive
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'signal_lineage', 'signal_registry_audit_log',
    'signal_category_hierarchy', 'signal_ontology_edges'
  )
ORDER BY tablename, policyname;

-- VQ-05: Grant verification
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN (
    'signal_lineage', 'signal_registry_audit_log',
    'signal_category_hierarchy', 'signal_ontology_edges'
  )
  AND grantee NOT IN ('postgres', 'PUBLIC')
ORDER BY table_name, grantee, privilege_type;

-- VQ-06: Confirm zero DELETE grants
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN (
    'signal_lineage', 'signal_registry_audit_log',
    'signal_category_hierarchy', 'signal_ontology_edges'
  )
  AND privilege_type = 'DELETE'
  AND grantee NOT IN ('postgres');
-- Expected: 0 rows
