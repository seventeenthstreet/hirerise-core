-- =============================================================================
-- HIRERISE  Phase 2A.1.3  ·  M3b A02 Recovery Migration
-- VERIFICATION BLOCK — Revision 1
-- migration_M3b_a02_truncate_protection_VERIFY_v1.sql
-- =============================================================================
-- Changes from v0:
--   V3 — replaced information_schema with has_table_privilege() (Correction B)
--   V4 — TRUNCATE check now uses has_table_privilege(); REFERENCES/TRIGGER
--         check retained via information_schema (additional fix identified
--         during Revision 1 package review)
--   V6 — replaced invalid DO/SAVEPOINT block with valid BEGIN/ROLLBACK
--         operator blocks (Correction C)
-- All other checks (V1, V2, V5) unchanged from v0.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- V1 — TRIGGER EXISTENCE AND CONFIGURATION
-- ---------------------------------------------------------------------------
-- Expected: 2 rows — one per immutable governance table
-- tgenabled = 'O' means trigger is enabled
-- BEFORE TRUNCATE FOR EACH STATEMENT = tgtype bits 2 (BEFORE) + 32 (TRUNCATE)
-- Absence of bit 1 (ROW) confirms STATEMENT level
-- ---------------------------------------------------------------------------

SELECT
    t.tgname                           AS trigger_name,
    c.relname                          AS table_name,
    CASE t.tgenabled
        WHEN 'O' THEN 'ENABLED'
        WHEN 'D' THEN 'DISABLED'
        WHEN 'R' THEN 'REPLICA'
        WHEN 'A' THEN 'ALWAYS'
        ELSE t.tgenabled::text
    END                                AS trigger_status,
    CASE (t.tgtype & 2)  WHEN 2 THEN 'BEFORE' ELSE 'AFTER'    END AS timing,
    CASE (t.tgtype & 32) WHEN 32 THEN 'TRUNCATE' ELSE 'OTHER' END AS event,
    CASE (t.tgtype & 1)  WHEN 1  THEN 'ROW' ELSE 'STATEMENT'  END AS level,
    p.proname                          AS function_name
FROM pg_trigger        t
JOIN pg_class          c ON c.oid = t.tgrelid
JOIN pg_proc           p ON p.oid = t.tgfoid
JOIN pg_namespace      n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND t.tgname IN (
      'trg_audit_log_no_truncate',
      'trg_lineage_no_truncate'
  )
ORDER BY t.tgname;

-- EXPECTED RESULT (2 rows):
-- trigger_name                  | table_name                   | trigger_status | timing | event    | level     | function_name
-- trg_audit_log_no_truncate     | signal_registry_audit_log    | ENABLED        | BEFORE | TRUNCATE | STATEMENT | fn_trg_audit_log_no_truncate
-- trg_lineage_no_truncate       | signal_lineage               | ENABLED        | BEFORE | TRUNCATE | STATEMENT | fn_trg_lineage_no_truncate


-- ---------------------------------------------------------------------------
-- V2 — FUNCTION SECURITY CONFIGURATION
-- ---------------------------------------------------------------------------
-- Expected: 2 rows — both SECURITY DEFINER with search_path = public
-- ---------------------------------------------------------------------------

SELECT
    p.proname                          AS function_name,
    CASE p.prosecdef
        WHEN true THEN 'SECURITY DEFINER'
        ELSE 'SECURITY INVOKER'
    END                                AS security_model,
    COALESCE(
        (SELECT val
         FROM unnest(p.proconfig) AS cfg(val)
         WHERE val LIKE 'search_path%'),
        'NOT SET — CRITICAL'
    )                                  AS search_path_config
FROM pg_proc      p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname  = 'public'
  AND p.proname IN (
      'fn_trg_audit_log_no_truncate',
      'fn_trg_lineage_no_truncate'
  )
ORDER BY p.proname;

-- EXPECTED RESULT (2 rows):
-- function_name                  | security_model    | search_path_config
-- fn_trg_audit_log_no_truncate   | SECURITY DEFINER  | search_path=public
-- fn_trg_lineage_no_truncate     | SECURITY DEFINER  | search_path=public


-- ---------------------------------------------------------------------------
-- V3 — service_role: NO TRUNCATE ON IMMUTABLE TABLES
-- ---------------------------------------------------------------------------
-- Revised: uses has_table_privilege() — the authoritative PostgreSQL
-- privilege check function. information_schema.role_table_grants does not
-- reliably expose TRUNCATE privileges; has_table_privilege() queries the
-- ACL directly and is the correct mechanism for this check.
--
-- Expected: both values false
-- ---------------------------------------------------------------------------

SELECT
    has_table_privilege(
        'service_role',
        'public.signal_registry_audit_log',
        'TRUNCATE'
    ) AS audit_log_truncate_allowed,
    has_table_privilege(
        'service_role',
        'public.signal_lineage',
        'TRUNCATE'
    ) AS lineage_truncate_allowed;

-- EXPECTED RESULT:
-- audit_log_truncate_allowed | lineage_truncate_allowed
-- false                      | false


-- ---------------------------------------------------------------------------
-- V4a — anon / authenticated: NO TRUNCATE ON REFERENCE TABLES
-- ---------------------------------------------------------------------------
-- Revised: TRUNCATE check now uses has_table_privilege() for the same
-- reason as V3. Checked for all four role/table combinations.
--
-- Expected: all four values false
-- ---------------------------------------------------------------------------

SELECT
    has_table_privilege('anon',          'public.signal_category_hierarchy', 'TRUNCATE') AS anon_hier_truncate,
    has_table_privilege('authenticated', 'public.signal_category_hierarchy', 'TRUNCATE') AS auth_hier_truncate,
    has_table_privilege('anon',          'public.signal_ontology_edges',     'TRUNCATE') AS anon_onto_truncate,
    has_table_privilege('authenticated', 'public.signal_ontology_edges',     'TRUNCATE') AS auth_onto_truncate;

-- EXPECTED RESULT:
-- anon_hier_truncate | auth_hier_truncate | anon_onto_truncate | auth_onto_truncate
-- false              | false              | false              | false


-- ---------------------------------------------------------------------------
-- V4b — anon / authenticated: NO REFERENCES / TRIGGER ON REFERENCE TABLES
-- ---------------------------------------------------------------------------
-- REFERENCES and TRIGGER are reliably exposed by information_schema.
-- This check is unchanged from v0 except the TRUNCATE filter is removed
-- (now handled in V4a above).
--
-- Expected: 0 rows
-- ---------------------------------------------------------------------------

SELECT
    grantee,
    table_name,
    privilege_type
FROM information_schema.role_table_grants
WHERE table_schema   = 'public'
  AND table_name     IN ('signal_category_hierarchy', 'signal_ontology_edges')
  AND grantee        IN ('anon', 'authenticated')
  AND privilege_type IN ('REFERENCES', 'TRIGGER');

-- EXPECTED RESULT: (0 rows)


-- ---------------------------------------------------------------------------
-- V5 — SELECT ACCESS PRESERVED ON REFERENCE TABLES
-- ---------------------------------------------------------------------------
-- Unchanged from v0. information_schema is reliable for SELECT.
-- Expected: 4 rows
-- ---------------------------------------------------------------------------

SELECT
    grantee,
    table_name,
    privilege_type
FROM information_schema.role_table_grants
WHERE table_schema   = 'public'
  AND table_name     IN ('signal_category_hierarchy', 'signal_ontology_edges')
  AND grantee        IN ('anon', 'authenticated')
  AND privilege_type = 'SELECT'
ORDER BY table_name, grantee;

-- EXPECTED RESULT (4 rows):
-- grantee        | table_name                | privilege_type
-- anon           | signal_category_hierarchy | SELECT
-- authenticated  | signal_category_hierarchy | SELECT
-- anon           | signal_ontology_edges     | SELECT
-- authenticated  | signal_ontology_edges     | SELECT


-- ---------------------------------------------------------------------------
-- V6 — SMOKE TEST: VERIFY TRUNCATE RAISES GOVERNANCE EXCEPTION
-- ---------------------------------------------------------------------------
-- Revised: replaces the invalid DO/SAVEPOINT block with two explicit
-- BEGIN/ROLLBACK operator blocks.
--
-- PostgreSQL does not permit SAVEPOINT, ROLLBACK TO SAVEPOINT, or COMMIT
-- inside a PL/pgSQL DO block (these are transaction control statements
-- that cannot appear within a function body in PostgreSQL).
--
-- The correct pattern for an operator-executed smoke test is:
--   BEGIN;
--   TRUNCATE <table>;   -- triggers fire here; exception raised
--   ROLLBACK;           -- explicit rollback ensures no state change
--                          even in the unexpected event the TRUNCATE succeeds
--
-- IMPORTANT: Run each block independently in a psql session or the Supabase
-- SQL Editor. The TRUNCATE will be immediately blocked by the trigger and
-- the error message will appear. The ROLLBACK is a safety net.
--
-- Both blocks are data-safe in all outcomes:
--   - If the trigger fires correctly: exception is raised; no rows are
--     affected; ROLLBACK is a no-op.
--   - If the trigger is somehow absent or disabled: TRUNCATE executes but
--     the enclosing transaction has not committed. The explicit ROLLBACK
--     returns the table to its pre-truncation state. TRUNCATE is
--     transactional in PostgreSQL and can be rolled back when executed
--     inside an open transaction — the ROLLBACK here is the safety net
--     for this unexpected case.
-- ---------------------------------------------------------------------------

-- Block 1: signal_registry_audit_log
-- Execute this block. Expected output:
--   ERROR:  [HireRise Governance] TRUNCATE on signal_registry_audit_log is prohibited...

BEGIN;
TRUNCATE public.signal_registry_audit_log;
ROLLBACK;

-- Block 2: signal_lineage
-- Execute this block separately. Expected output:
--   ERROR:  [HireRise Governance] TRUNCATE on signal_lineage is prohibited...

BEGIN;
TRUNCATE public.signal_lineage;
ROLLBACK;

-- =============================================================================
-- END OF VERIFICATION BLOCK — Revision 1
-- =============================================================================
