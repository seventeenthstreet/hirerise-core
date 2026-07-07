-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 1A — DISTRIBUTED GOVERNANCE EXTENSION ROLLBACK
-- File: 20260526000007_phase1a_distributed_governance.rollback.sql
--
-- PURPOSE: Safely reverse migration 20260526000007.
--
-- PRE-ROLLBACK CHECKLIST:
--   □ No AI outputs reference governance_contract_versions rows
--   □ No taxonomy snapshots reference governance_contract_versions rows
--   □ No cache keys built via fn_build_cache_key() are in active use
--   □ No CI pipelines call fn_governance_drift_report() for this environment
--   □ governance_contract_versions table has no rows that downstream
--     systems depend on (if rows exist, document the rollback in a new
--     governance_contract_versions row BEFORE dropping the table)
-- =============================================================================

BEGIN;

-- Step 1: Drop utility functions
DROP FUNCTION IF EXISTS public.fn_validate_replay_preconditions()              CASCADE;
DROP FUNCTION IF EXISTS public.fn_build_cache_key(TEXT, JSONB)                  CASCADE;
DROP FUNCTION IF EXISTS public.fn_governance_drift_report(TEXT, TEXT, TEXT)     CASCADE;

-- Step 2: Drop governance_contract_versions table, trigger, trigger function
DROP TRIGGER IF EXISTS trg_governance_immutable_contract_versions
  ON public.governance_contract_versions;

DROP POLICY IF EXISTS "governance_contract_versions_service_role_insert"
  ON public.governance_contract_versions;
DROP POLICY IF EXISTS "governance_contract_versions_authenticated_read"
  ON public.governance_contract_versions;

DROP FUNCTION IF EXISTS public.fn_prevent_governance_contract_mutation() CASCADE;

DROP TABLE IF EXISTS public.governance_contract_versions CASCADE;

COMMIT;

-- =============================================================================
-- END OF ROLLBACK: 20260526000007_phase1a_distributed_governance.rollback.sql
-- =============================================================================
