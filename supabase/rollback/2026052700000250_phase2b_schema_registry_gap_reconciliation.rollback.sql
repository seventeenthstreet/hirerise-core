-- =============================================================================
-- ROLLBACK: 2026052700000250_phase2b_schema_registry_gap_reconciliation.sql
--
-- Reverts public.academic_rpc_schema_registry to the shape produced by
-- 20260527000002_phase2_hardening.sql alone.
--
-- WARNING: This DROPs columns and will destroy any rpc_signature,
-- response_contract, taxonomy_hash, contract_version, or is_active data
-- written by 20260527000003 (or later) into this table. Do not run against
-- an environment where 20260527000003 has already executed successfully
-- unless you also intend to roll back 20260527000003 first.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_academic_rpc_schema_registry'
      AND conrelid = 'public.academic_rpc_schema_registry'::regclass
  ) THEN
    ALTER TABLE public.academic_rpc_schema_registry
      DROP CONSTRAINT uq_academic_rpc_schema_registry;
  END IF;
END $$;

ALTER TABLE public.academic_rpc_schema_registry DROP COLUMN IF EXISTS is_active;
ALTER TABLE public.academic_rpc_schema_registry DROP COLUMN IF EXISTS contract_version;
ALTER TABLE public.academic_rpc_schema_registry DROP COLUMN IF EXISTS taxonomy_hash;
ALTER TABLE public.academic_rpc_schema_registry DROP COLUMN IF EXISTS response_contract;
ALTER TABLE public.academic_rpc_schema_registry DROP COLUMN IF EXISTS rpc_signature;

-- =============================================================================
-- END ROLLBACK
-- =============================================================================
