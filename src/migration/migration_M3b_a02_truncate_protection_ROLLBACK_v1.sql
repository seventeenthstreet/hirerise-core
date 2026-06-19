-- =============================================================================
-- HIRERISE  Phase 2A.1.3  ·  M3b A02 Recovery Migration
-- ROLLBACK BLOCK
-- migration_M3b_a02_truncate_protection_ROLLBACK.sql
-- =============================================================================
-- GOVERNANCE WARNING:
--   Executing this rollback REMOVES immutability protections from the
--   governance audit log and lineage tables, and RESTORES excess privileges.
--   This constitutes a deliberate security regression. It must only be
--   executed with explicit sign-off from the Principal Security Architect
--   and must be followed immediately by re-deployment of the migration.
--
--   Document the reason and approving authority before execution.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- RB1 — Remove TRUNCATE protection triggers
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_audit_log_no_truncate
    ON public.signal_registry_audit_log;

DROP TRIGGER IF EXISTS trg_lineage_no_truncate
    ON public.signal_lineage;


-- ---------------------------------------------------------------------------
-- RB2 — Remove TRUNCATE protection trigger functions
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.fn_trg_audit_log_no_truncate();
DROP FUNCTION IF EXISTS public.fn_trg_lineage_no_truncate();


-- ---------------------------------------------------------------------------
-- RB3 — Restore TRUNCATE to service_role on immutable governance tables
-- ---------------------------------------------------------------------------
-- NOTE: This restores the A02-Critical and A02-High findings.
-- Re-run the migration immediately after the root cause is resolved.
-- ---------------------------------------------------------------------------

GRANT TRUNCATE ON public.signal_registry_audit_log TO service_role;
GRANT TRUNCATE ON public.signal_lineage               TO service_role;


-- ---------------------------------------------------------------------------
-- RB4 — Restore excess privileges to anon / authenticated on reference tables
-- ---------------------------------------------------------------------------
-- NOTE: This restores the A02-Medium findings.
-- Re-run the migration immediately after the root cause is resolved.
-- ---------------------------------------------------------------------------

GRANT TRUNCATE   ON public.signal_category_hierarchy TO anon;
GRANT TRUNCATE   ON public.signal_category_hierarchy TO authenticated;
GRANT REFERENCES ON public.signal_category_hierarchy TO anon;
GRANT REFERENCES ON public.signal_category_hierarchy TO authenticated;
GRANT TRIGGER    ON public.signal_category_hierarchy TO anon;
GRANT TRIGGER    ON public.signal_category_hierarchy TO authenticated;

GRANT TRUNCATE   ON public.signal_ontology_edges TO anon;
GRANT TRUNCATE   ON public.signal_ontology_edges TO authenticated;
GRANT REFERENCES ON public.signal_ontology_edges TO anon;
GRANT REFERENCES ON public.signal_ontology_edges TO authenticated;
GRANT TRIGGER    ON public.signal_ontology_edges TO anon;
GRANT TRIGGER    ON public.signal_ontology_edges TO authenticated;

COMMIT;

-- =============================================================================
-- END OF ROLLBACK BLOCK
-- =============================================================================
