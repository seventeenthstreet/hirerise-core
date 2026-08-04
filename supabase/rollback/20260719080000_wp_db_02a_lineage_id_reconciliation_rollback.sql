-- =============================================================================
-- HIRERISE  ·  WP-DB-02A-2  ·  Rollback Migration
-- Audit Log Lineage Reconciliation — Rollback of WP-DB-02A-1
-- =============================================================================
--
-- Document Classification : Production Rollback
-- File                    : rollback/20260719080000_wp_db_02a_lineage_id_reconciliation_rollback.sql
-- Rollback Target         : migrations/20260719080000_wp_db_02a_lineage_id_reconciliation.sql
--                           (WP-DB-02A-1, Phase 1 of WP-DB-02A)
-- Work Package            : WP-DB-02A-2 (Phase 1 of WP-DB-02A)
-- Governance Basis        : WP-DB-01I (Strategy D, accepted)
--                           WP-DB-01K (Model C, accepted)
--                           WP-DB-02A Revision 3 (Implementation Design, approved)
-- Governance Status       : WP-DB-01D/F/G/H/I/K and WP-DB-02A Rev. 3 are frozen
--                            and are not reopened, reinterpreted, or redesigned
--                            by this rollback.
--
-- Purpose:
--   Reverses the three objects WP-DB-02A-1 adds to
--   signal_registry_audit_log — the lineage_id column, its foreign key, and
--   its partial index — for use in an environment where WP-DB-02A-1 actually
--   created them (e.g. a fresh or partially migrated repository build, or a
--   staging/certification environment). This rollback is a repository
--   development and certification aid, not a change intended for certified
--   production.
--
-- Scope:
--   Rollback only. No validation SQL, migration inventory updates, baseline
--   artifacts, ADRs, documentation, CI, certification artifacts, or release
--   notes are produced here — those belong to later WP-DB-02A work packages
--   (WP-DB-02A-3 and Phases 2–5).
--
-- Rollback Philosophy:
--   Production already contains all three objects independently of this
--   repository's migration history (per WP-DB-01I's forensic finding —
--   they were created out-of-band, prior to and outside of WP-DB-02A-1).
--   This rollback is therefore explicitly NOT a production-reversal tool: it
--   exists solely to undo what WP-DB-02A-1 itself created in an environment
--   where WP-DB-02A-1 was the thing that created these objects. Running it
--   against production would attempt to remove objects this rollback did not
--   create and that production depends on independently — the safety checks
--   below exist specifically to refuse that outcome rather than to enable it.
--
-- Repository Safety / Production Safety:
--   The foreign key and the partial index are dropped unconditionally
--   (guarded by IF EXISTS) because doing so is non-destructive to data — no
--   audit rows are lost, and lineage_id values already written are
--   unaffected. The column itself is the one truly destructive operation in
--   this rollback (DROP COLUMN discards data), so it is removed only if ALL
--   of the following hold:
--     1. The column currently contains zero non-NULL values (nothing to lose).
--     2. No other repository object (view, generated column, etc.) depends on
--        the column via a tracked catalog dependency.
--   If either condition fails, this migration RAISES EXCEPTION before
--   dropping anything, and the entire rollback — including the FK and index
--   drops above — is rolled back atomically (see transaction wrapping below).
--   This is a deliberate design choice: a partially-completed rollback (FK
--   and index gone, column and its data still present but now unenforced and
--   unindexed) is considered a worse outcome than the whole rollback failing
--   cleanly and leaving the environment exactly as it was. If this rollback
--   fails, the correct response is to inspect why (populated data found, or a
--   dependency found) and decide manually — not to re-run with the checks
--   weakened.
--
-- Idempotency:
--   Safe for: a fresh rollback (objects exist, all get dropped); a repeated
--   rollback (IF EXISTS guards make the FK/index drops no-ops on a second
--   run; the column-drop DO block detects the column is already gone and
--   exits without action); an already-rolled-back environment (no-op
--   throughout); and — per the safety design above — production, where the
--   populated-data check is expected to fail closed and abort the rollback
--   with no changes made, rather than removing objects production depends on.
--
-- Preamble:
--   Confirms signal_registry_audit_log exists before attempting any rollback
--   step, failing with a repository-style PREAMBLE FAILED message if not —
--   consistent with the assertion convention used elsewhere in this
--   repository (e.g. Sprint 1C's 1C-01-P3/P4 preamble checks).
--
-- Out of Scope for this work package:
--   Validation query file           → WP-DB-02A-3
--   Migration inventory update      → WP-DB-02A (Phase 1 artifact plan)
--   Canonical baseline generation   → WP-DB-02A-4 (Phase 2)
--   ADR / governance documentation  → WP-DB-02A-5 (Phase 3)
--   CI integration                  → WP-DB-02A-7 (Phase 4)
--
-- Self-review (per WP-DB-02A-2 prompt):
--   Strategy D preserved         — yes; this rollback reverses only the
--                                   forward-migration objects Strategy D
--                                   introduced, nothing else.
--   Model C preserved            — yes; no baseline, replay-architecture, or
--                                   sequencing decision is touched.
--   Repository-safe              — yes; guarded, additive-object-cautious,
--                                   matches the G4D_rollback.sql precedent of
--                                   leaving additive columns in place when
--                                   removal cannot be shown safe.
--   Production-safe               — yes; the populated-data and dependency
--                                   checks are specifically designed to fail
--                                   closed against production rather than
--                                   silently destroying lineage data.
--   Idempotent                    — yes; see Idempotency above.
--   Defensive rollback             — yes; two independent safety checks gate
--                                   the only destructive operation.
--   No historical migrations modified — yes; only this new rollback file is
--                                   introduced.
--   No governance reopened         — yes; no governance document is modified
--                                   or reinterpreted.
--   Supabase/PostgreSQL compatible — yes; standard PostgreSQL DDL/PLpgSQL.
--   No SQL outside rollback scope  — yes; no validation, baseline, CI, or
--                                   documentation SQL is included.
--
--   No requirement above could not be satisfied; nothing here required
--   stopping to explain instead of proceeding.
--
-- =============================================================================

BEGIN;

-- =============================================================================
-- PREAMBLE — Prerequisite Verification
-- =============================================================================

DO $$
DECLARE
    v_count integer;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'signal_registry_audit_log';

    IF v_count = 0 THEN
        RAISE EXCEPTION
            'PREAMBLE FAILED [WP-DB-02A-2-P1]: signal_registry_audit_log table '
            'not found in schema public. There is nothing for this rollback to '
            'reverse. Verify this is the intended environment before proceeding.';
    END IF;
END $$;

-- =============================================================================
-- STEP 1 — Drop Foreign Key: signal_registry_audit_log_lineage_id_fkey
-- =============================================================================
-- Non-destructive to data. Native IF EXISTS guard: no-op if already absent.

ALTER TABLE "public"."signal_registry_audit_log"
    DROP CONSTRAINT IF EXISTS "signal_registry_audit_log_lineage_id_fkey";

-- =============================================================================
-- STEP 2 — Drop Partial Index: idx_audit_log_lineage_id
-- =============================================================================
-- Non-destructive to data. Native IF EXISTS guard: no-op if already absent.

DROP INDEX IF EXISTS "public"."idx_audit_log_lineage_id";

-- =============================================================================
-- STEP 3 — Conditionally Drop Column: lineage_id
-- =============================================================================
-- The only destructive step. Proceeds only if the column exists, contains no
-- populated (non-NULL) values, and has no tracked catalog dependents. Any
-- failure here raises an exception, which — per the BEGIN/COMMIT wrapping
-- this entire file — rolls back Steps 1 and 2 as well, leaving the
-- environment completely unchanged rather than partially rolled back.

DO $$
DECLARE
    v_column_exists   boolean;
    v_populated_count bigint;
    v_dependent_count bigint;
    v_attnum          smallint;
BEGIN
    -- ── Existence check — already-rolled-back environments exit here ────────
    SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'signal_registry_audit_log'
          AND column_name = 'lineage_id'
    ) INTO v_column_exists;

    IF NOT v_column_exists THEN
        RAISE NOTICE
            'WP-DB-02A-2: lineage_id column already absent on '
            'signal_registry_audit_log — nothing to drop. Rollback is a no-op '
            'for Step 3 (already-rolled-back environment).';
        RETURN;
    END IF;

    -- ── Safety check 1: populated data ───────────────────────────────────────
    EXECUTE format(
        'SELECT COUNT(*) FROM %I.%I WHERE %I IS NOT NULL',
        'public', 'signal_registry_audit_log', 'lineage_id'
    ) INTO v_populated_count;

    IF v_populated_count > 0 THEN
        RAISE EXCEPTION
            'ROLLBACK REFUSED [WP-DB-02A-2-S1]: signal_registry_audit_log.'
            'lineage_id contains % populated (non-NULL) row(s). Dropping this '
            'column would permanently discard that lineage data. This '
            'rollback will not do so automatically. If you are certain this '
            'environment is not production and the data is disposable, '
            'remove the column manually with explicit review — do not weaken '
            'this check and re-run.',
            v_populated_count;
    END IF;

    -- ── Safety check 2: catalog dependents ───────────────────────────────────
    SELECT attnum INTO v_attnum
    FROM pg_attribute
    WHERE attrelid = '"public"."signal_registry_audit_log"'::regclass
      AND attname = 'lineage_id'
      AND NOT attisdropped;

    SELECT COUNT(*) INTO v_dependent_count
    FROM pg_depend d
    WHERE d.refobjid = '"public"."signal_registry_audit_log"'::regclass
      AND d.refobjsubid = v_attnum
      AND d.deptype IN ('n', 'a');

    IF v_dependent_count > 0 THEN
        RAISE EXCEPTION
            'ROLLBACK REFUSED [WP-DB-02A-2-S2]: % repository object(s) still '
            'hold a tracked catalog dependency on '
            'signal_registry_audit_log.lineage_id (e.g. a view or another '
            'constraint). Dropping the column would break those objects. '
            'Identify and resolve the dependency manually before attempting '
            'this rollback again.',
            v_dependent_count;
    END IF;

    -- ── Safe to proceed ───────────────────────────────────────────────────────
    ALTER TABLE "public"."signal_registry_audit_log"
        DROP COLUMN IF EXISTS "lineage_id";

    RAISE NOTICE
        'WP-DB-02A-2: lineage_id column dropped from '
        'signal_registry_audit_log (0 populated rows, 0 tracked dependents '
        'confirmed before drop).';
END $$;

RAISE NOTICE 'WP-DB-02A-2 ROLLBACK COMPLETE: FK and partial index removed '
    '(or already absent); column removed only where verified safe (or already '
    'absent). See preceding NOTICE for the Step 3 outcome in this run.';

COMMIT;

-- =============================================================================
-- POST-ROLLBACK VERIFICATION NOTES (informational only — no validation SQL
-- is included here; the validation query file is WP-DB-02A-3, out of scope
-- for this work package)
-- =============================================================================
--
-- After running this rollback, WP-DB-02A-3's validation query file will be
-- expected to confirm:
--   1. If Step 3 succeeded: lineage_id column, its FK, and its partial index
--      are all absent from signal_registry_audit_log.
--   2. If Step 3 raised ROLLBACK REFUSED [WP-DB-02A-2-S1] or [-S2]: the
--      transaction aborted, and the column, FK, and index are all still
--      present and unchanged — re-running WP-DB-02A-1 remains valid.
--   3. Sprint 1C's preamble check [1C-01-P3] will fail again on a fresh
--      replay once this rollback has removed the column — this is the
--      expected, correct state for an environment where WP-DB-02A-1 has been
--      reversed and not yet re-applied.
--
-- =============================================================================
-- END OF ROLLBACK
-- =============================================================================
