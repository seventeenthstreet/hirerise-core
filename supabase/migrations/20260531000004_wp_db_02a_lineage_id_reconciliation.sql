-- =============================================================================
-- HIRERISE  ·  WP-DB-02A-1  ·  Forward Reconciliation Migration
-- Audit Log Lineage Reconciliation — signal_registry_audit_log.lineage_id
-- =============================================================================
--
-- Document Classification : Production Migration
-- File                    : 20260719080000_wp_db_02a_lineage_id_reconciliation.sql
-- Work Package            : WP-DB-02A-1 (Phase 1 of WP-DB-02A)
-- Governance Basis        : WP-DB-01I (Migration Lineage Reconciliation &
--                            Canonical Recovery — Strategy D, accepted)
--                            WP-DB-01K (Canonical Replay Architecture Decision —
--                            Model C, Dual-Lineage Baseline Architecture, accepted)
--                            WP-DB-02A Revision 3 (Implementation Design, approved)
-- Governance Status       : WP-DB-01D/F/G/H/I/K are frozen and are not reopened,
--                            reinterpreted, or redesigned by this migration.
--
-- Scope:
--   Adds the lineage_id column, its foreign key to signal_lineage(id), and its
--   partial index to signal_registry_audit_log — the three objects WP-DB-01I
--   confirmed already exist in production but are created by no migration in
--   this repository. This migration closes that gap going forward; it makes
--   no change to already-applied historical migrations and does not alter
--   already-existing production objects (see Idempotency, below).
--
-- Objects Created (guarded — see Idempotency):
--   1. Column     signal_registry_audit_log.lineage_id                (uuid, nullable)
--   2. Constraint signal_registry_audit_log_lineage_id_fkey             (FK → signal_lineage.id, ON DELETE SET NULL)
--   3. Index      idx_audit_log_lineage_id                              (btree, partial: WHERE lineage_id IS NOT NULL)
--
-- Specification Source:
--   Exact column type, nullability, constraint definition, ON DELETE behavior,
--   index definition, and object comments are taken verbatim from the
--   production schema captured in core/backups/post_wp_db_005_schema.sql,
--   independently verified during WP-DB-01I. This migration does not invent
--   or infer any part of the specification.
--
-- Prerequisites (validated in preamble):
--   - signal_lineage table must exist (created well before this work package;
--     Sprint 1C and G4D both already depend on it).
--
-- Idempotency:
--   Every object below is created with an existence guard, so this migration
--   is a full no-op wherever the target object already exists — including
--   current production, where all three objects are already present. It is
--   therefore safe to run against: production (no-op), a partially migrated
--   repository (creates only what's missing), a fresh/clean database (creates
--   all three), a post-baseline replay, and any staging or certification
--   environment cloned from any of the above.
--
-- Out of scope for this migration (see WP-DB-02A Phase 1 work package split):
--   - Rollback SQL                  → WP-DB-02A-2
--   - Validation query file         → WP-DB-02A-3
--   - Canonical baseline generation → WP-DB-02A-4 (Phase 2)
--   - ADR / governance documentation → WP-DB-02A-5 (Phase 3)
--   - CI integration                 → WP-DB-02A-7 (Phase 4)
--
-- Self-review (per WP-DB-02A-1 prompt):
--   Strategy D preserved            — yes, this is exactly the forward
--                                      reconciliation migration Strategy D calls for.
--   Model C preserved               — yes, this migration is authored to land
--                                      before the canonical baseline is generated
--                                      (Phase 2), per Model C's sequencing.
--   Approved schema only            — yes, spec taken verbatim from the
--                                      WP-DB-01I-verified production schema.
--   Governance unchanged            — yes, no governance document is modified
--                                      or reinterpreted by this file.
--   Migration ordering preserved    — yes, timestamp 20260719080000 is later
--                                      than the most recent migration in the
--                                      repository (20260718120000...) and no
--                                      historical migration is touched.
--   Production-safe                 — yes, see Idempotency above.
--   Replay-safe                     — yes, safe on fresh, partial, and
--                                      post-baseline replay.
--   Idempotent                      — yes, every statement is guarded.
--   Supabase-compatible             — yes, standard PostgreSQL DDL/PLpgSQL,
--                                      no Supabase-specific extensions required.
--
--   No deviation from the approved specification was required to author this
--   migration; nothing here needed to stop and explain instead of proceeding.
--
-- =============================================================================

-- =============================================================================
-- PREAMBLE — Prerequisite Verification
-- =============================================================================
-- Fails clearly and immediately if signal_lineage does not exist, rather than
-- allowing the FK creation below to fail with a less legible Postgres error.

DO $$
DECLARE
    v_count integer;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'signal_lineage';

    IF v_count = 0 THEN
        RAISE EXCEPTION
            'PREAMBLE FAILED [WP-DB-02A-1-P1]: signal_lineage table not found in '
            'schema public. This migration reconciles signal_registry_audit_log.'
            'lineage_id, which requires signal_lineage(id) as its foreign-key '
            'target. signal_lineage is expected to already exist from Sprint 1A '
            '— verify Sprint 1A migrations have been applied before re-running '
            'this migration.';
    END IF;
END $$;

-- =============================================================================
-- STEP 1 — Column: signal_registry_audit_log.lineage_id
-- =============================================================================
-- Guarded with IF NOT EXISTS: no-ops in production and in any environment
-- where a prior run of this migration (or the original out-of-band G4D
-- Patch P2 change) already created the column.

ALTER TABLE "public"."signal_registry_audit_log"
    ADD COLUMN IF NOT EXISTS "lineage_id" "uuid";

COMMENT ON COLUMN "public"."signal_registry_audit_log"."lineage_id" IS
    'UUID of the signal_lineage row this audit event relates to. NULL for '
    'non-lineage audit events (e.g. signal_created, signal_deprecated). '
    'Populated by fn_propose_lineage_transition, fn_approve_lineage_transition, '
    'and fn_reject_lineage_transition. FK → signal_lineage(id) ON DELETE SET '
    'NULL: audit rows are retained if the referenced lineage row is deleted; '
    'lineage_id is NULLed, not cascaded. Used by fn_approve_lineage_transition '
    'VAL-3 four-eyes enforcement: queries this column to locate the '
    'lineage_event_proposed audit record and recover the proposedBy identity.';

-- =============================================================================
-- STEP 2 — Foreign Key: signal_registry_audit_log_lineage_id_fkey
-- =============================================================================
-- Standard PostgreSQL does not support "ADD CONSTRAINT IF NOT EXISTS" for
-- foreign keys, so the guard is implemented explicitly against pg_constraint,
-- keyed on the exact constraint name captured in the verified production
-- schema. No-ops wherever the constraint already exists (including current
-- production).

DO $$
DECLARE
    v_count integer;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM pg_constraint
    WHERE conname = 'signal_registry_audit_log_lineage_id_fkey'
      AND conrelid = '"public"."signal_registry_audit_log"'::regclass;

    IF v_count = 0 THEN
        ALTER TABLE "public"."signal_registry_audit_log"
            ADD CONSTRAINT "signal_registry_audit_log_lineage_id_fkey"
            FOREIGN KEY ("lineage_id")
            REFERENCES "public"."signal_lineage"("id")
            ON DELETE SET NULL;
    END IF;
END $$;

-- =============================================================================
-- STEP 3 — Partial Index: idx_audit_log_lineage_id
-- =============================================================================
-- CREATE INDEX natively supports IF NOT EXISTS. Partial predicate matches the
-- verified production definition exactly — excludes NULL lineage_id rows
-- (the majority of audit events, which are not lineage-related) to minimise
-- index size and write overhead.

CREATE INDEX IF NOT EXISTS "idx_audit_log_lineage_id"
    ON "public"."signal_registry_audit_log"
    USING "btree" ("lineage_id")
    WHERE ("lineage_id" IS NOT NULL);

COMMENT ON INDEX "public"."idx_audit_log_lineage_id" IS
    'Partial index on signal_registry_audit_log.lineage_id (WHERE lineage_id '
    'IS NOT NULL). Supports fn_approve_lineage_transition VAL-3 four-eyes '
    'lookup: WHERE lineage_id = p_lineage_id AND event_type = '
    '''lineage_event_proposed''. Partial index excludes NULL lineage_id rows '
    '(non-lineage audit events) to minimise index size and write overhead.';

-- -- =============================================================================
-- POST-MIGRATION VERIFICATION NOTES (informational only — no validation SQL
-- is included here; the validation query file is WP-DB-02A-3, which is
-- intentionally scoped as the dedicated validation work package for Phase 1)
-- =============================================================================
--
-- After applying this migration, verify the following:
--
--   1. Column verification
--      • information_schema.columns contains:
--          table_name      = signal_registry_audit_log
--          column_name     = lineage_id
--          data_type       = uuid
--          is_nullable     = YES
--      • If the column already existed before this migration, confirm its
--        definition matches the canonical production specification exactly
--        (UUID, nullable, no default) as verified during WP-DB-01I.
--
--   2. Foreign key verification
--      • pg_constraint contains:
--          conname         = signal_registry_audit_log_lineage_id_fkey
--      • conrelid resolves to:
--          public.signal_registry_audit_log
--      • confrelid resolves to:
--          public.signal_lineage
--      • confdeltype       = 'n' (ON DELETE SET NULL)
--      • Confirm the FK definition matches the canonical production schema.
--
--   3. Partial index verification
--      • pg_indexes contains:
--          indexname       = idx_audit_log_lineage_id
--      • indexdef contains:
--          WHERE (lineage_id IS NOT NULL)
--      • Confirm the index definition (including its partial predicate)
--        matches the canonical production specification exactly rather than
--        merely confirming the index name exists.
--
--   4. Replay verification
--      • Sprint 1C preamble assertion [1C-01-P3] in
--        20260531000004_sprint_1c_migration_1c_01.sql
--        now succeeds during a supported repository replay that includes
--        this reconciliation migration in the replay tail.
--
--   5. Idempotency verification
--      • Re-running this migration against an environment where the column,
--        foreign key, and index already exist (including current production)
--        completes without error and without modifying repository objects,
--        confirming the migration's idempotency guarantees.
--
--   6. Governance verification
--      • Confirm this migration introduces no schema objects beyond the
--        three approved reconciliation objects:
--            - signal_registry_audit_log.lineage_id
--            - signal_registry_audit_log_lineage_id_fkey
--            - idx_audit_log_lineage_id
--      • Confirm no historical migration has been modified or reordered.
--      • Confirm the implementation remains fully consistent with:
--            - WP-DB-01I (Strategy D)
--            - WP-DB-01K (Model C)
--            - WP-DB-02A Implementation Design (Revision 3)
--
-- =============================================================================
-- CANONICAL GOVERNANCE NOTE
-- =============================================================================
--
-- This migration formalizes repository history.
--
-- The objects created by this migration already exist in the certified
-- production schema and were independently verified during WP-DB-01I.
--
-- The purpose of this migration is therefore not to introduce a new production
-- feature, but to reconcile repository lineage so that future supported replay,
-- baseline generation, and repository certification remain consistent with the
-- canonical production schema under Strategy D and Model C.
--
-- =============================================================================
-- END OF MIGRATION
-- =============================================================================