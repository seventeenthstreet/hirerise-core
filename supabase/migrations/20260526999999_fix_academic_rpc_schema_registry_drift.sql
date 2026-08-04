-- =============================================================================
-- Fix: academic_rpc_schema_registry drift reconciliation
--
-- Context: on the linked remote project, this table already exists from an
-- earlier/different migration path than 20260527000002_phase2_hardening.sql
-- (see WP-DB-01 Enterprise Drift Analysis Report, Section 6 — this table was
-- flagged as showing a "create-then-drop-next-migration" pattern). The live
-- version is missing the UNIQUE(rpc_name, field_path) constraint the seed
-- INSERTs rely on via ON CONFLICT, and has rpc_signature as NOT NULL with
-- no default (the intended design leaves it nullable).
--
-- Ordering: this file is deliberately timestamped BEFORE
-- 20260527000002_phase2_hardening.sql so it runs first and the seed INSERT
-- in that file succeeds against the already-corrected remote table.
--
-- Safety: on a fresh local `db reset`, this table doesn't exist yet at this
-- point in the chain (it's created later, by phase2_hardening.sql itself),
-- so every statement here is guarded to no-op if the table is absent.
-- =============================================================================

DO $$
BEGIN
  -- No-op entirely if the table doesn't exist yet (fresh db reset case)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'academic_rpc_schema_registry'
  ) THEN
    RETURN;
  END IF;

  -- 1. Add the missing unique constraint required by ON CONFLICT
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.academic_rpc_schema_registry'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (rpc_name, field_path)'
  ) THEN
    ALTER TABLE public.academic_rpc_schema_registry
      ADD CONSTRAINT uq_academic_rpc_field UNIQUE (rpc_name, field_path);
  END IF;

  -- 2. Relax rpc_signature back to nullable (matches the intended design in
  --    20260527000002_phase2_hardening.sql, where it's declared without NOT NULL,
  --    and is never populated by the seed INSERTs)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'academic_rpc_schema_registry'
      AND column_name = 'rpc_signature' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.academic_rpc_schema_registry
      ALTER COLUMN rpc_signature DROP NOT NULL;
  END IF;

  -- 3. Restore the intended CHECK constraint on stability, absent on the
  --    live table. Confirmed safe: all existing rows are 'stable'.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.academic_rpc_schema_registry'::regclass
      AND contype = 'c'
      AND conname = 'chk_academic_rpc_stability'
  ) THEN
    ALTER TABLE public.academic_rpc_schema_registry
      ADD CONSTRAINT chk_academic_rpc_stability
      CHECK (stability IN ('stable', 'additive', 'deprecated'));
  END IF;
END $$;
