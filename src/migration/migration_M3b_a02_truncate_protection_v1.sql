-- =============================================================================
-- HIRERISE  Phase 2A.1.3  ·  Sprint 1  ·  Recovery Migration M3b
-- migration_M3b_a02_truncate_protection_v1.sql
-- =============================================================================
-- Purpose:  Remediates all confirmed A02 audit findings:
--             R1  TRUNCATE protection trigger on signal_registry_audit_log
--             R2  TRUNCATE protection trigger on signal_lineage
--             R3  Revoke TRUNCATE from service_role on both immutable tables
--             R4  Revoke TRUNCATE / REFERENCES / TRIGGER from anon /
--                 authenticated on signal_category_hierarchy and
--                 signal_ontology_edges
-- Owner:    postgres
-- Phase:    2A.1.3 — Amendment A02
-- Idempotent: YES — safe to re-execute in any order or repetition
-- =============================================================================
-- Governance contract:
--   • Preserves all existing rows and data
--   • No table rewrites; no locking risk
--   • No ownership changes
--   • No RLS changes
--   • No policy changes
--   • Only remediates confirmed A02 findings
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- DESIGN VALIDATION NOTE
-- ---------------------------------------------------------------------------
-- PostgreSQL BEFORE TRUNCATE triggers:
--   • Introduced in PostgreSQL 8.4.
--   • TRUNCATE triggers MUST be FOR EACH STATEMENT (not FOR EACH ROW).
--     Row-level TRUNCATE triggers are a compile-time error in PostgreSQL.
--   • A BEFORE TRUNCATE trigger that raises an exception prevents the
--     TRUNCATE from executing — this is the correct mechanism for
--     unconditional blocking.
--   • The trigger function return value is irrelevant for statement-level
--     triggers; RETURN NULL is the canonical form (returning NEW or OLD
--     would be a runtime error since they are undefined at statement level).
--   • SECURITY DEFINER is required to prevent search_path injection.
--     Combined with SET search_path = public, this matches the pattern
--     used across all Sprint 1 governance functions.
--   • Supabase runs PostgreSQL 15.x; all features used here are present.
--
-- TRUNCATE vs trigger defence-in-depth:
--   Privilege revocation alone (R3/R4) is necessary but not sufficient:
--     - A future GRANT or a superuser bypass would re-open the gap.
--   The trigger (R1/R2) adds a second, application-enforced barrier that
--   is independent of the privilege model. Together they provide true
--   defence-in-depth consistent with the governance architecture.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- R1 — AUDIT LOG TRUNCATE PROTECTION
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- R1.1  Trigger function: fn_trg_audit_log_no_truncate
-- ---------------------------------------------------------------------------
-- DROP + CREATE rather than CREATE OR REPLACE is used for trigger functions
-- because CREATE OR REPLACE on a function that a trigger depends on may
-- fail in some PostgreSQL configurations. We drop the trigger first (R1.2),
-- then recreate the function, then recreate the trigger. This is the cleanest
-- idempotency pattern for trigger function pairs in PostgreSQL.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON public.signal_registry_audit_log;

CREATE OR REPLACE FUNCTION public.fn_trg_audit_log_no_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RAISE EXCEPTION
        '[HireRise Governance] TRUNCATE on signal_registry_audit_log is prohibited. '
        'This table is an immutable governance audit record. All rows are permanent. '
        'Operation blocked by governance trigger trg_audit_log_no_truncate. '
        'Reference: Phase 2A.1 Sprint 1B — Audit Log Immutability Policy.';
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.fn_trg_audit_log_no_truncate() IS
    'Governance trigger function — unconditionally blocks TRUNCATE on '
    'signal_registry_audit_log. Part of the A02 immutability hardening. '
    'Phase 2A.1.3 M3b recovery migration.';

-- Restrict execution to service_role only; revoke from PUBLIC
REVOKE ALL ON FUNCTION public.fn_trg_audit_log_no_truncate() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- R1.2  Trigger: trg_audit_log_no_truncate
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_audit_log_no_truncate
    BEFORE TRUNCATE
    ON public.signal_registry_audit_log
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.fn_trg_audit_log_no_truncate();

COMMENT ON TRIGGER trg_audit_log_no_truncate
    ON public.signal_registry_audit_log IS
    'Governance immutability trigger — blocks all TRUNCATE attempts. '
    'Deployed by M3b A02 recovery migration (Phase 2A.1.3).';


-- ===========================================================================
-- R2 — LINEAGE TABLE TRUNCATE PROTECTION
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- R2.1  Trigger function: fn_trg_lineage_no_truncate
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_lineage_no_truncate ON public.signal_lineage;

CREATE OR REPLACE FUNCTION public.fn_trg_lineage_no_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RAISE EXCEPTION
        '[HireRise Governance] TRUNCATE on signal_lineage is prohibited. '
        'This table is an immutable governance lineage record. All rows are permanent. '
        'Operation blocked by governance trigger trg_lineage_no_truncate. '
        'Reference: Phase 2A.1 Sprint 1B — Signal Lineage Immutability Policy.';
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.fn_trg_lineage_no_truncate() IS
    'Governance trigger function — unconditionally blocks TRUNCATE on '
    'signal_lineage. Part of the A02 immutability hardening. '
    'Phase 2A.1.3 M3b recovery migration.';

-- Restrict execution to service_role only; revoke from PUBLIC
REVOKE ALL ON FUNCTION public.fn_trg_lineage_no_truncate() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- R2.2  Trigger: trg_lineage_no_truncate
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_lineage_no_truncate
    BEFORE TRUNCATE
    ON public.signal_lineage
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.fn_trg_lineage_no_truncate();

COMMENT ON TRIGGER trg_lineage_no_truncate
    ON public.signal_lineage IS
    'Governance immutability trigger — blocks all TRUNCATE attempts. '
    'Deployed by M3b A02 recovery migration (Phase 2A.1.3).';


-- ===========================================================================
-- R3 — REVOKE TRUNCATE FROM service_role ON IMMUTABLE GOVERNANCE TABLES
-- ===========================================================================
-- REVOKE is idempotent in PostgreSQL: revoking a privilege that has not been
-- granted produces a NOTICE, not an error. Safe to re-execute.
-- ---------------------------------------------------------------------------

REVOKE TRUNCATE ON public.signal_registry_audit_log FROM service_role;
REVOKE TRUNCATE ON public.signal_lineage               FROM service_role;


-- ===========================================================================
-- R4 — REVOKE EXCESS PRIVILEGES FROM anon / authenticated ON REFERENCE TABLES
-- ===========================================================================
-- Approved access model per Sprint 1B specification:
--   signal_category_hierarchy  : anon→SELECT, authenticated→SELECT, service_role→SELECT/INSERT/UPDATE
--   signal_ontology_edges       : anon→SELECT, authenticated→SELECT, service_role→SELECT/INSERT/UPDATE
-- TRUNCATE, REFERENCES, TRIGGER are excess; they were never approved by
-- the governance architecture. SELECT access is explicitly preserved.
-- ---------------------------------------------------------------------------

-- signal_category_hierarchy
REVOKE TRUNCATE   ON public.signal_category_hierarchy FROM anon;
REVOKE TRUNCATE   ON public.signal_category_hierarchy FROM authenticated;
REVOKE REFERENCES ON public.signal_category_hierarchy FROM anon;
REVOKE REFERENCES ON public.signal_category_hierarchy FROM authenticated;
REVOKE TRIGGER    ON public.signal_category_hierarchy FROM anon;
REVOKE TRIGGER    ON public.signal_category_hierarchy FROM authenticated;

-- signal_ontology_edges
REVOKE TRUNCATE   ON public.signal_ontology_edges FROM anon;
REVOKE TRUNCATE   ON public.signal_ontology_edges FROM authenticated;
REVOKE REFERENCES ON public.signal_ontology_edges FROM anon;
REVOKE REFERENCES ON public.signal_ontology_edges FROM authenticated;
REVOKE TRIGGER    ON public.signal_ontology_edges FROM anon;
REVOKE TRIGGER    ON public.signal_ontology_edges FROM authenticated;

COMMIT;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
