-- =============================================================================
-- HIRERISE  Phase 2A.1  ·  Sprint 1  ·  Package G4D
-- Validation Query Suite
-- G4D_validation_queries.sql
-- =============================================================================
-- Run all queries after deployment.  Every query must return its expected
-- result before Gate G4D can be confirmed PASS.
-- =============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-01: fn_propose_lineage_transition exists with correct signature
-- Expected: 1 row
-- ────────────────────────────────────────────────────────────────────────────
SELECT
    p.proname                           AS function_name,
    pg_get_function_arguments(p.oid)    AS arguments,
    p.prosecdef                         AS security_definer,  -- expected: true
    p.provolatile                       AS volatility         -- expected: 'v' (volatile)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'fn_propose_lineage_transition'
  AND n.nspname = 'public';
-- Expected: 1 row, security_definer = true

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-02: fn_approve_lineage_transition exists
-- Expected: 1 row, security_definer = true
-- ────────────────────────────────────────────────────────────────────────────
SELECT
    p.proname,
    pg_get_function_arguments(p.oid) AS arguments,
    p.prosecdef                       AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'fn_approve_lineage_transition'
  AND n.nspname = 'public';

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-03: fn_reject_lineage_transition exists
-- Expected: 1 row, security_definer = true
-- ────────────────────────────────────────────────────────────────────────────
SELECT
    p.proname,
    pg_get_function_arguments(p.oid) AS arguments,
    p.prosecdef                       AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'fn_reject_lineage_transition'
  AND n.nspname = 'public';

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-04: fn_validate_signal_keys exists (enhanced version)
-- Expected: 1 row, prosecdef = true, provolatile = 's' (stable)
-- ────────────────────────────────────────────────────────────────────────────
SELECT
    p.proname,
    pg_get_function_arguments(p.oid) AS arguments,
    p.prosecdef                       AS security_definer,
    p.provolatile                     AS volatility  -- expected: 's' = STABLE
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'fn_validate_signal_keys'
  AND n.nspname = 'public';

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-05: signal_lineage has rejection columns
-- Expected: 3 rows (rejected_at, rejected_by, rejection_reason)
-- ────────────────────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'signal_lineage'
  AND column_name  IN ('rejected_at', 'rejected_by', 'rejection_reason')
ORDER BY column_name;

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-06: chk_lineage_not_approved_and_rejected constraint exists
-- Expected: 1 row
-- ────────────────────────────────────────────────────────────────────────────
SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname  = 'chk_lineage_not_approved_and_rejected'
  AND conrelid = 'public.signal_lineage'::regclass;

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-07: Immutability triggers exist on signal_lineage
-- Expected: 2 rows (trg_signal_lineage_immutability, trg_signal_lineage_no_delete)
-- ────────────────────────────────────────────────────────────────────────────
SELECT t.tgname, t.tgenabled, t.tgtype
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname  = 'signal_lineage'
  AND n.nspname  = 'public'
  AND t.tgname   IN ('trg_signal_lineage_immutability', 'trg_signal_lineage_no_delete')
ORDER BY t.tgname;

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-08: EXECUTE grants on G4D functions — service_role only
-- Expected: 4 rows (one per function), grantee = 'service_role'
-- ────────────────────────────────────────────────────────────────────────────
SELECT
    r.routine_name,
    g.grantee,
    g.privilege_type
FROM information_schema.role_routine_grants g
JOIN information_schema.routines r
    ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name   IN (
      'fn_propose_lineage_transition',
      'fn_approve_lineage_transition',
      'fn_reject_lineage_transition',
      'fn_validate_signal_keys'
  )
ORDER BY r.routine_name, g.grantee;

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-09: search_path = public on all G4D functions
-- Expected: 4 rows, proconfig contains 'search_path=public'
-- ────────────────────────────────────────────────────────────────────────────
SELECT
    p.proname,
    p.proconfig  -- expected: contains 'search_path=public'
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname IN (
    'fn_propose_lineage_transition',
    'fn_approve_lineage_transition',
    'fn_reject_lineage_transition',
    'fn_validate_signal_keys'
)
  AND n.nspname = 'public'
ORDER BY p.proname;

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-10: Governance dry-run — fn_validate_signal_keys returns correct shape
-- Expected: { "valid": false, "violations": [...], "predecessor": null, ... }
-- (no active signal_key 'NONEXISTENT' exists in registry)
-- ────────────────────────────────────────────────────────────────────────────
SELECT public.fn_validate_signal_keys(
    p_predecessor_key  => 'NONEXISTENT_KEY_G4D_TEST',
    p_successor_key    => NULL,
    p_taxonomy_version => 'v1',
    p_lineage_type     => 'retired_no_successor',
    p_context          => 'proposal'
) AS validation_result;
-- Expected: valid = false, violations contains INVALID_SIGNAL_KEY or INVALID_TAXONOMY_VERSION

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-11: Four-eyes governance gap check
-- Confirms no approved lineage rows exist where approved_by = proposed_by
-- (should return 0 rows in all environments)
-- ────────────────────────────────────────────────────────────────────────────
SELECT
    sl.id,
    sl.approved_by,
    aud.event_payload->>'proposedBy' AS proposed_by
FROM public.signal_lineage sl
JOIN public.signal_registry_audit_log aud
    ON aud.lineage_id = sl.id
   AND aud.event_type = 'lineage_event_proposed'
WHERE sl.approved_at IS NOT NULL
  AND aud.event_payload->>'proposedBy' IS NOT NULL
  AND lower(trim(sl.approved_by)) = lower(trim(aud.event_payload->>'proposedBy'));
-- Expected: 0 rows

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-12: Audit completeness check
-- Every approved or rejected signal_lineage row has a corresponding audit record
-- Expected: 0 rows (no approved/rejected lineage without audit trace)
-- ────────────────────────────────────────────────────────────────────────────
SELECT sl.id, sl.approved_at, sl.rejected_at
FROM public.signal_lineage sl
WHERE (sl.approved_at IS NOT NULL OR sl.rejected_at IS NOT NULL)
  AND NOT EXISTS (
      SELECT 1
      FROM public.signal_registry_audit_log aud
      WHERE aud.lineage_id = sl.id
        AND aud.event_type IN ('lineage_event_proposed', 'lineage_event_approved', 'signal_metadata_changed')
  );
-- Expected: 0 rows

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-13: No signal_lineage rows are both approved and rejected
-- Expected: 0 rows (CHECK constraint should prevent this, but verify)
-- ────────────────────────────────────────────────────────────────────────────
SELECT id, approved_at, rejected_at
FROM public.signal_lineage
WHERE approved_at IS NOT NULL
  AND rejected_at IS NOT NULL;
-- Expected: 0 rows

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-14: No direct EXECUTE grants to anon or authenticated on G4D functions
-- Expected: 0 rows
-- ────────────────────────────────────────────────────────────────────────────
SELECT r.routine_name, g.grantee
FROM information_schema.role_routine_grants g
JOIN information_schema.routines r
    ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name   IN (
      'fn_propose_lineage_transition',
      'fn_approve_lineage_transition',
      'fn_reject_lineage_transition',
      'fn_validate_signal_keys'
  )
  AND g.grantee IN ('anon', 'authenticated');
-- Expected: 0 rows

-- ────────────────────────────────────────────────────────────────────────────
-- VAL-15: idx_signal_lineage_rejected_at index exists
-- Expected: 1 row
-- ────────────────────────────────────────────────────────────────────────────
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename  = 'signal_lineage'
  AND indexname  = 'idx_signal_lineage_rejected_at';
-- Expected: 1 row
