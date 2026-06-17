-- =============================================================================
-- HIRERISE  Phase 2A.1  ·  Sprint 1  ·  Package G4D — Rollback
-- G4D_rollback.sql
-- =============================================================================
--
-- Execute ONLY after confirming:
--   1. G4D was deployed (all four functions exist)
--   2. No production lineage proposals have been created via G4D RPCs
--   3. Principal Database Architect has approved rollback
--   4. Database backup has been verified restorable
--
-- This rollback is DESTRUCTIVE only if data was inserted via G4D RPCs.
-- It does NOT drop signal_lineage data (additive columns are left in place).
-- =============================================================================

BEGIN;

-- Drop G4D functions
DROP FUNCTION IF EXISTS public.fn_propose_lineage_transition(
    text, text, public.lineage_type, text, timestamptz, text, text, boolean, uuid
);

DROP FUNCTION IF EXISTS public.fn_approve_lineage_transition(uuid, text);
DROP FUNCTION IF EXISTS public.fn_reject_lineage_transition(uuid, text, text);

DROP FUNCTION IF EXISTS public.fn_validate_signal_keys(text, text, text, text, text);

-- Restore pre-G4D immutability trigger (approval-only version)
-- If M2 defined fn_signal_lineage_immutability_guard, restore it here.
-- The function below is a minimal restore that covers approved-row immutability only.
CREATE OR REPLACE FUNCTION public.fn_signal_lineage_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF OLD.approved_at IS NOT NULL THEN
        IF (NEW.predecessor_signal_key  IS DISTINCT FROM OLD.predecessor_signal_key  OR
            NEW.successor_signal_key    IS DISTINCT FROM OLD.successor_signal_key    OR
            NEW.lineage_type            IS DISTINCT FROM OLD.lineage_type            OR
            NEW.lineage_reason          IS DISTINCT FROM OLD.lineage_reason          OR
            NEW.effective_date          IS DISTINCT FROM OLD.effective_date          OR
            NEW.taxonomy_version        IS DISTINCT FROM OLD.taxonomy_version        OR
            NEW.created_at              IS DISTINCT FROM OLD.created_at              OR
            NEW.approved_by             IS DISTINCT FROM OLD.approved_by             OR
            NEW.approved_at             IS DISTINCT FROM OLD.approved_at) THEN
            RAISE EXCEPTION
                'signal_lineage row % is approved and immutable. Op: %.',
                OLD.id, TG_OP;
        END IF;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- NOTE: rejection columns (rejected_at, rejected_by, rejection_reason) and
-- the chk_lineage_not_approved_and_rejected constraint are LEFT IN PLACE.
-- Removing them would require ALTER TABLE ... DROP COLUMN which is potentially
-- destructive if data exists.  The columns are additive and harmless if empty.

RAISE NOTICE 'G4D ROLLBACK COMPLETE: 4 functions dropped, immutability guard restored to M2 state. '
    'Rejection columns and constraint remain on signal_lineage.';

COMMIT;
