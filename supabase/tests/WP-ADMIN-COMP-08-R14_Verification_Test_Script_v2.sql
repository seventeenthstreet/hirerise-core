-- =============================================================================
-- WP-ADMIN-COMP-08-R14-T02 — Verification Test Script v2.1
-- =============================================================================
-- File: supabase/tests/WP-ADMIN-COMP-08-R14_Verification_Test_Script_v2.1.sql
-- Supersedes: WP-ADMIN-COMP-08-R14_Verification_Test_Script_v2.sql
-- Aligned exactly with (UNCHANGED, not modified in this correction):
--   supabase/migrations/20260813150000_r14_bulk_import_graph_hardening.sql
--
-- v2.1 CORRECTIONS (minimal, only these two changes from v2):
--   1. T6 (PART 2) now first checks actual database evidence — the full
--      row counts of role_skills, role_transitions, role_education, and
--      role_salary_market — before asserting against the R12 §12.1
--      baseline. If all four are completely empty (a freshly
--      `supabase db reset` local environment has no historical graph data
--      at all), T6 prints `T6 SKIPPED — HISTORICAL BASELINE DATA ABSENT
--      LOCALLY` and the script continues. Any other state runs the exact
--      same, unweakened R12 baseline assertions v2 already had
--      (110/60/70/77/317, 29-ID canonical list) and fails on any drift.
--      This was found by running v2 against a freshly reset local
--      Supabase database: `supabase db reset` and `supabase db lint`
--      (`No schema errors found`) succeeded, but T6 failed with
--      `expected 110, got 0` because that environment legitimately has no
--      historical data to check against — an environment/baseline gap, not
--      evidence the migration touched historical data.
--   2. Fixed a real PL/pgSQL syntax defect in v2: a bare
--      `RAISE NOTICE 'PART 1 ... ALL PASSED';` appeared directly in the
--      transaction body, outside any `DO $$ ... $$` block. `RAISE` is only
--      valid inside PL/pgSQL (a DO block or function body), so this would
--      have raised a syntax error the first time PART 1 actually reached
--      that line. It is now wrapped in its own `DO $$ BEGIN ... END $$;`.
--
-- Everything else — T1-T5, T7-T9, the committed audit-persistence test,
-- and cleanup verification — is byte-for-byte unchanged from v2.
--
-- Verified against the actual migration source and actual schema before
-- being written (not assumed):
--   - Return JSON shape: {inserted, updated, total, rejected} — read directly
--     from the migration's final `RETURN jsonb_build_object(...)`.
--   - import_logs columns actually written by the migration: entity_type,
--     row_results, imported_at, dataset_name, rows_processed, rows_imported,
--     rows_skipped, rows_failed, import_mode — read directly from the
--     migration's `INSERT INTO import_logs (...)` list, cross-checked
--     against the import_logs table definition in 000_initial_schema.sql
--     (row_results jsonb NOT NULL DEFAULT '[]'::jsonb — confirmed present).
--   - ON CONFLICT targets and business-key unique indexes for all five
--     hardened branches — confirmed present in 000_initial_schema.sql plus
--     20260727000002_role_skills_unique_index_reconciliation.sql
--     (role_skills' 2-column index specifically depends on that migration,
--     which predates this one).
--   - GRANT state for bulk_import_graph — confirmed from
--     000_initial_schema.sql: GRANT ALL ... TO anon/authenticated/
--     service_role, unmodified by any later migration through
--     20260811070000 or by this R14 migration itself (grants are
--     deliberately unchanged — see the R14 migration's own header).
--   - The 29 canonical orphan role_id values and the 317-row/4-table
--     baseline (role_skills 110, role_transitions 60, role_education 70,
--     role_salary_market 77) — taken verbatim from
--     WP-ADMIN-COMP-08-R11_readonly_sql_appendix_v2.sql's confirmed Phase A
--     list and WP-ADMIN-COMP-08-R12_Stewardship_Decision_and_Remediation_Plan.md
--     V-01/V-02 (role_transitions matches on EITHER from_role_id OR
--     to_role_id being in the 29-list — V-02's documented method, not
--     guessed).
--
-- Structure:
--   PART 1 — rollback-safe smoke tests (T1-T5, T8, T9). Wrapped in
--            BEGIN...ROLLBACK; nothing here persists.
--   PART 2 — T6, historical-compatibility baseline check. Read-only, no
--            transaction wrapper needed. SKIPS (does not fail) when actual
--            evidence shows the R12 historical baseline data is absent
--            (e.g. a freshly reset local environment); otherwise asserts
--            the full, unweakened R12 baseline.
--   PART 3 — T7, authorization/grant state check. Read-only.
--   PART 4 — committed audit-persistence test (NOT rollback-safe by
--            design — this is the point: it proves the audit trail
--            survives past the calling transaction, which a ROLLBACK-
--            wrapped test structurally cannot demonstrate). Explicitly
--            cleans up only the r14_test_%-namespaced rows it creates,
--            then proves zero test artifacts remain.
--
-- Uses only 'r14_test_%'-namespaced identifiers throughout. Never deletes
-- anything outside that namespace. Each block RAISEs EXCEPTION on failure
-- so a failed run is unambiguous; a clean run prints only NOTICEs, ending
-- in 'ZERO TEST ARTIFACTS REMAIN'.
--
-- PRECONDITIONS TO RUN:
--   1. Non-production environment with
--      20260813150000_r14_bulk_import_graph_hardening.sql already applied.
--   2. Connect as a role that bypasses Row Level Security — `roles` has
--      FORCE ROW LEVEL SECURITY (confirmed in 000_initial_schema.sql), and
--      this script inserts into `roles` directly outside of
--      bulk_import_graph's SECURITY DEFINER context.
--   3. Run PART 4 only if you intend a committed write/cleanup cycle against
--      this environment — it is not rollback-safe by design.
-- =============================================================================


-- #############################################################################
-- PART 1 — ROLLBACK-SAFE SMOKE TESTS (T1, T2, T3, T4, T5, T8, T9)
-- #############################################################################

BEGIN;

INSERT INTO roles (role_id, role_name, normalized_name)
VALUES ('r14_test_valid_role', 'R14 Test Valid Role', 'r14 test valid role')
ON CONFLICT (role_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- T1 — Valid identity succeeds
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_result JSONB;
BEGIN
    v_result := bulk_import_graph('role_skills', jsonb_build_array(
        jsonb_build_object('role_id', 'r14_test_valid_role', 'skill_id', 'r14_test_skill', 'importance_weight', 1)
    ));

    IF (v_result->>'inserted')::int <> 1 THEN
        RAISE EXCEPTION 'T1 FAILED: expected inserted=1, got %', v_result;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM role_skills WHERE role_id = 'r14_test_valid_role' AND skill_id = 'r14_test_skill'
    ) THEN
        RAISE EXCEPTION 'T1 FAILED: expected row not found in role_skills';
    END IF;

    RAISE NOTICE 'T1 PASSED';
END $$;

-- ---------------------------------------------------------------------------
-- T2 — Invalid identity: rejected, not written, no exception, logged
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_result JSONB;
    v_log_count INT;
BEGIN
    v_result := bulk_import_graph('role_skills', jsonb_build_array(
        jsonb_build_object('role_id', 'r14_test_nonexistent_role', 'skill_id', 'r14_test_skill_2', 'importance_weight', 1)
    ));

    IF (v_result->>'inserted')::int <> 0 THEN
        RAISE EXCEPTION 'T2 FAILED: expected inserted=0, got %', v_result;
    END IF;

    IF jsonb_array_length(v_result->'rejected') <> 1 THEN
        RAISE EXCEPTION 'T2 FAILED: expected 1 rejected row, got %', v_result;
    END IF;

    IF EXISTS (
        SELECT 1 FROM role_skills WHERE role_id = 'r14_test_nonexistent_role'
    ) THEN
        RAISE EXCEPTION 'T2 FAILED: an orphan row was written for a nonexistent role_id';
    END IF;

    SELECT COUNT(*) INTO v_log_count
    FROM import_logs
    WHERE dataset_name = 'role_skills'
      AND row_results @> jsonb_build_array(jsonb_build_object('role_id', 'r14_test_nonexistent_role', 'skill_id', 'r14_test_skill_2', 'importance_weight', 1));

    IF v_log_count < 1 THEN
        RAISE EXCEPTION 'T2 FAILED: rejection was not written to import_logs.row_results';
    END IF;

    RAISE NOTICE 'T2 PASSED';
END $$;

-- ---------------------------------------------------------------------------
-- T3 — Mixed batch: valid rows commit, invalid rows are rejected, in one call
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_result JSONB;
BEGIN
    v_result := bulk_import_graph('role_transitions', jsonb_build_array(
        jsonb_build_object('from_role_id', 'r14_test_valid_role', 'to_role_id', 'r14_test_valid_role', 'probability', 0.5, 'years_required', 1, 'transition_type', 'lateral'),
        jsonb_build_object('from_role_id', 'r14_test_valid_role', 'to_role_id', 'r14_test_nonexistent_role_2', 'probability', 0.5, 'years_required', 1, 'transition_type', 'lateral')
    ));

    IF (v_result->>'inserted')::int <> 1 THEN
        RAISE EXCEPTION 'T3 FAILED: expected inserted=1 (the valid transition), got %', v_result;
    END IF;

    IF jsonb_array_length(v_result->'rejected') <> 1 THEN
        RAISE EXCEPTION 'T3 FAILED: expected 1 rejected row (invalid to_role_id), got %', v_result;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM role_transitions
        WHERE from_role_id = 'r14_test_valid_role' AND to_role_id = 'r14_test_valid_role'
    ) THEN
        RAISE EXCEPTION 'T3 FAILED: the valid transition row was not found in role_transitions';
    END IF;

    IF EXISTS (
        SELECT 1 FROM role_transitions WHERE to_role_id = 'r14_test_nonexistent_role_2'
    ) THEN
        RAISE EXCEPTION 'T3 FAILED: the invalid transition row was written to role_transitions';
    END IF;

    RAISE NOTICE 'T3 PASSED';
END $$;

-- ---------------------------------------------------------------------------
-- T4 — Malformed/unknown p_dataset still raises (call-level behavior
-- unchanged). The inner BEGIN/EXCEPTION exists only to catch the function's
-- OWN raised exception for assertion purposes — it does not swallow or
-- mask the failure: if the function does NOT raise, the outer RAISE
-- EXCEPTION on the next line fires instead, so the test still fails loudly.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_raised BOOLEAN := FALSE;
BEGIN
    BEGIN
        PERFORM bulk_import_graph('not_a_real_dataset', jsonb_build_array(jsonb_build_object('x', 1)));
    EXCEPTION
        WHEN OTHERS THEN
            v_raised := TRUE;
            IF SQLERRM NOT LIKE '%unknown dataset%' THEN
                RAISE EXCEPTION 'T4 FAILED: wrong error text for unknown dataset: %', SQLERRM;
            END IF;
    END;

    IF NOT v_raised THEN
        RAISE EXCEPTION 'T4 FAILED: expected an exception for an unknown dataset, none was raised';
    END IF;

    RAISE NOTICE 'T4 PASSED';
END $$;

-- ---------------------------------------------------------------------------
-- T5 — role_market_demand branch: same validation behavior as the other four
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_result JSONB;
BEGIN
    v_result := bulk_import_graph('role_market_demand', jsonb_build_array(
        jsonb_build_object('role_id', 'r14_test_valid_role', 'country', 'IN', 'job_postings', 10),
        jsonb_build_object('role_id', 'r14_test_nonexistent_role_3', 'country', 'IN', 'job_postings', 10)
    ));

    IF (v_result->>'inserted')::int <> 1 THEN
        RAISE EXCEPTION 'T5 FAILED: expected inserted=1, got %', v_result;
    END IF;

    IF jsonb_array_length(v_result->'rejected') <> 1 THEN
        RAISE EXCEPTION 'T5 FAILED: expected 1 rejected row, got %', v_result;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM role_market_demand WHERE role_id = 'r14_test_valid_role' AND country = 'IN'
    ) THEN
        RAISE EXCEPTION 'T5 FAILED: the valid row was not found in role_market_demand';
    END IF;

    IF EXISTS (
        SELECT 1 FROM role_market_demand WHERE role_id = 'r14_test_nonexistent_role_3'
    ) THEN
        RAISE EXCEPTION 'T5 FAILED: an orphan row was written for a nonexistent role_id';
    END IF;

    RAISE NOTICE 'T5 PASSED';
END $$;

-- ---------------------------------------------------------------------------
-- T8 — Retry/idempotency: first call inserts, second call (same key,
-- different value) updates.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_result1 JSONB;
    v_result2 JSONB;
BEGIN
    v_result1 := bulk_import_graph('role_education', jsonb_build_array(
        jsonb_build_object('role_id', 'r14_test_valid_role', 'education_level', 'bachelors', 'match_score', 0.8)
    ));
    v_result2 := bulk_import_graph('role_education', jsonb_build_array(
        jsonb_build_object('role_id', 'r14_test_valid_role', 'education_level', 'bachelors', 'match_score', 0.9)
    ));

    IF (v_result1->>'inserted')::int <> 1 OR (v_result2->>'updated')::int <> 1 THEN
        RAISE EXCEPTION 'T8 FAILED: expected first call to insert, second to update. Got % / %', v_result1, v_result2;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM role_education
        WHERE role_id = 'r14_test_valid_role' AND education_level = 'bachelors' AND match_score = 0.9
    ) THEN
        RAISE EXCEPTION 'T8 FAILED: final database state does not reflect the second (update) call';
    END IF;

    RAISE NOTICE 'T8 PASSED';
END $$;

-- ---------------------------------------------------------------------------
-- T9 — Row-level malformed input inside a hardened branch (distinct from
-- T4's call-level check): a non-numeric importance_weight fails the
-- `(rec->>'importance_weight')::NUMERIC` cast inside the role_skills INSERT,
-- after identity validation has already partitioned the row as valid.
-- Caught by the function's own `WHEN invalid_text_representation` handler.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_raised BOOLEAN := FALSE;
BEGIN
    BEGIN
        PERFORM bulk_import_graph('role_skills', jsonb_build_array(
            jsonb_build_object('role_id', 'r14_test_valid_role', 'skill_id', 'r14_test_skill_bad_weight', 'importance_weight', 'not_a_number')
        ));
    EXCEPTION
        WHEN OTHERS THEN
            v_raised := TRUE;
            IF SQLERRM NOT LIKE '%malformed value%' THEN
                RAISE EXCEPTION 'T9 FAILED: wrong error text for row-level malformed input: %', SQLERRM;
            END IF;
    END;

    IF NOT v_raised THEN
        RAISE EXCEPTION 'T9 FAILED: expected an exception for a non-numeric importance_weight, none was raised';
    END IF;

    IF EXISTS (
        SELECT 1 FROM role_skills WHERE skill_id = 'r14_test_skill_bad_weight'
    ) THEN
        RAISE EXCEPTION 'T9 FAILED: a row was written despite the cast failure';
    END IF;

    RAISE NOTICE 'T9 PASSED';
END $$;

DO $$
BEGIN
    RAISE NOTICE 'PART 1 (T1,T2,T3,T4,T5,T8,T9) ALL PASSED';
END $$;

-- Discard every fixture and result PART 1 created. Nothing here is meant to
-- persist.
ROLLBACK;


-- #############################################################################
-- PART 2 — T6: HISTORICAL COMPATIBILITY (executable, read-only)
-- Baseline: WP-ADMIN-COMP-08-R12 §12.1 V-01/V-02 — 317 orphaned rows total
-- (role_skills 110, role_transitions 60, role_education 70,
-- role_salary_market 77), against the 29-ID canonical orphan set confirmed
-- live in WP-ADMIN-COMP-08-R11 Phase A. This migration must not change
-- either the per-table counts or which IDs they belong to, because it never
-- reads, writes, or scans any existing row in these tables (see the
-- migration's own header). Re-run this immediately before AND after
-- applying the migration in the target environment — both runs must match.
--
-- v2.1: T6 now has two evidence-driven paths, both in the block below —
-- this is not two copies of T6, it is one baseline check that first
-- determines, from actual data, which of the two situations it is in:
--
--   (2A) CLEAN LOCAL RESET ENVIRONMENT — a freshly `supabase db reset`
--        database has none of R12's historical graph data at all (this is
--        expected and correct for that environment, not a defect). Detected
--        from actual evidence: all four baseline-bearing tables
--        (role_skills, role_transitions, role_education,
--        role_salary_market) are completely empty — their full row counts,
--        not just their orphan-filtered subsets, are zero. That distinction
--        matters: a table that has rows but whose orphan-specific subset is
--        zero is NOT this case, and must fall through to (2B) and fail —
--        that would mean the canonical orphan rows were specifically
--        removed, which is exactly the regression T6 exists to catch.
--        When (2A) is detected, T6 is SKIPPED, and this script continues to
--        T7 onward — it never has and never will use the empty local state
--        as a substitute baseline.
--
--   (2B) HISTORICAL-DATA ENVIRONMENT — any state other than "all four
--        tables completely empty". Runs the full, unmodified R12 §12.1
--        assertions: exact per-table orphan-row counts (110/60/70/77), the
--        combined 317 total, and the 29-ID canonical list itself. Fails on
--        any drift, remap, or deletion — identical logic to the original
--        v2 T6, none of its assertions were changed, weakened, or removed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_orphan_ids TEXT[] := ARRAY[
        'software_engineer','senior_software_engineer','product_manager',
        'devops_engineer','frontend_engineer','ml_engineer','staff_engineer',
        'ux_designer','data_scientist','fullstack_engineer','junior_data_analyst',
        'junior_software_engineer','senior_data_scientist','senior_devops_engineer',
        'data_analyst','junior_product_manager','senior_data_analyst',
        'backend_engineer','junior_ux_designer','marketing_analyst',
        'senior_ux_designer','director_product','growth_manager','qa_engineer',
        'senior_ml_engineer','junior_marketing_analyst','principal_engineer',
        'product_marketing_manager','security_engineer'
    ];
    v_role_skills_total        INT;
    v_role_transitions_total   INT;
    v_role_education_total     INT;
    v_role_salary_market_total INT;
    v_role_skills_count        INT;
    v_role_transitions_count   INT;
    v_role_education_count     INT;
    v_role_salary_market_count INT;
    v_total                    INT;
BEGIN
    -- ---- Evidence gathering: full table counts, not orphan-filtered ----
    SELECT COUNT(*) INTO v_role_skills_total        FROM role_skills;
    SELECT COUNT(*) INTO v_role_transitions_total   FROM role_transitions;
    SELECT COUNT(*) INTO v_role_education_total     FROM role_education;
    SELECT COUNT(*) INTO v_role_salary_market_total FROM role_salary_market;

    IF v_role_skills_total = 0
       AND v_role_transitions_total = 0
       AND v_role_education_total = 0
       AND v_role_salary_market_total = 0
    THEN
        -- ---- (2A) Clean Local Reset Environment ----
        RAISE NOTICE 'T6 SKIPPED — HISTORICAL BASELINE DATA ABSENT LOCALLY';
    ELSE
        -- ---- (2B) Historical-Data Environment: original R12 baseline, unchanged ----
        IF array_length(v_orphan_ids, 1) <> 29 THEN
            RAISE EXCEPTION 'T6 FAILED: canonical orphan ID list in this test does not contain 29 entries (got %) — do not proceed, the baseline itself is wrong', array_length(v_orphan_ids, 1);
        END IF;

        SELECT COUNT(*) INTO v_role_skills_count
        FROM role_skills WHERE role_id = ANY(v_orphan_ids);

        SELECT COUNT(*) INTO v_role_transitions_count
        FROM role_transitions
        WHERE from_role_id = ANY(v_orphan_ids) OR to_role_id = ANY(v_orphan_ids);

        SELECT COUNT(*) INTO v_role_education_count
        FROM role_education WHERE role_id = ANY(v_orphan_ids);

        SELECT COUNT(*) INTO v_role_salary_market_count
        FROM role_salary_market WHERE role_id = ANY(v_orphan_ids);

        v_total := v_role_skills_count + v_role_transitions_count + v_role_education_count + v_role_salary_market_count;

        IF v_role_skills_count <> 110 THEN
            RAISE EXCEPTION 'T6 FAILED: role_skills orphan-row count drifted from R12 §12.1 baseline (expected 110, got %)', v_role_skills_count;
        END IF;

        IF v_role_transitions_count <> 60 THEN
            RAISE EXCEPTION 'T6 FAILED: role_transitions orphan-row count drifted from R12 §12.1 baseline (expected 60, got %)', v_role_transitions_count;
        END IF;

        IF v_role_education_count <> 70 THEN
            RAISE EXCEPTION 'T6 FAILED: role_education orphan-row count drifted from R12 §12.1 baseline (expected 70, got %)', v_role_education_count;
        END IF;

        IF v_role_salary_market_count <> 77 THEN
            RAISE EXCEPTION 'T6 FAILED: role_salary_market orphan-row count drifted from R12 §12.1 baseline (expected 77, got %)', v_role_salary_market_count;
        END IF;

        IF v_total <> 317 THEN
            RAISE EXCEPTION 'T6 FAILED: combined orphan-row total drifted from R12 §12.1 baseline (expected 317, got %)', v_total;
        END IF;

        RAISE NOTICE 'T6 PASSED: 317/29 baseline unchanged (role_skills=%, role_transitions=%, role_education=%, role_salary_market=%)',
            v_role_skills_count, v_role_transitions_count, v_role_education_count, v_role_salary_market_count;
    END IF;
END $$;


-- #############################################################################
-- PART 3 — T7: AUTHORIZATION / GRANT STATE (executable, read-only)
-- Expected result for THIS migration specifically: all three still TRUE.
-- Grants are deliberately unchanged (see the migration's own header) pending
-- the human sign-off on anon/authenticated revocation described in the R14
-- implementation report §8 — TRUE here is the correct expected state for
-- this migration, not a target end-state.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_anon_can_exec          BOOLEAN;
    v_authenticated_can_exec BOOLEAN;
    v_service_role_can_exec  BOOLEAN;
BEGIN
    SELECT has_function_privilege('anon', 'bulk_import_graph(text,jsonb)', 'EXECUTE') INTO v_anon_can_exec;
    SELECT has_function_privilege('authenticated', 'bulk_import_graph(text,jsonb)', 'EXECUTE') INTO v_authenticated_can_exec;
    SELECT has_function_privilege('service_role', 'bulk_import_graph(text,jsonb)', 'EXECUTE') INTO v_service_role_can_exec;

    IF v_anon_can_exec IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'T7 FAILED: anon EXECUTE grant changed unexpectedly (expected TRUE, got %) — this migration does not touch grants', v_anon_can_exec;
    END IF;

    IF v_authenticated_can_exec IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'T7 FAILED: authenticated EXECUTE grant changed unexpectedly (expected TRUE, got %) — this migration does not touch grants', v_authenticated_can_exec;
    END IF;

    IF v_service_role_can_exec IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'T7 FAILED: service_role EXECUTE grant changed unexpectedly (expected TRUE, got %) — this migration does not touch grants', v_service_role_can_exec;
    END IF;

    RAISE NOTICE 'T7 PASSED: grants unchanged (anon=%, authenticated=%, service_role=%)',
        v_anon_can_exec, v_authenticated_can_exec, v_service_role_can_exec;
END $$;


-- #############################################################################
-- PART 4 — COMMITTED AUDIT-PERSISTENCE TEST
-- Not rollback-safe by design: a ROLLBACK-wrapped test (as in PART 1) cannot
-- prove an audit row survives past its own transaction, because rolling
-- back is exactly what would make that indistinguishable from failure. This
-- section COMMITs deliberately, then explicitly deletes only the
-- r14_test_%-namespaced rows it created, then proves zero remain.
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
DECLARE
    v_result JSONB;
BEGIN
    v_result := bulk_import_graph('role_skills', jsonb_build_array(
        jsonb_build_object('role_id', 'r14_test_persist_invalid_role', 'skill_id', 'r14_test_persist_skill', 'importance_weight', 1)
    ));

    IF (v_result->>'inserted')::int <> 0 THEN
        RAISE EXCEPTION 'PERSIST-TEST FAILED: expected inserted=0 for an invalid identity, got %', v_result;
    END IF;

    IF jsonb_array_length(v_result->'rejected') <> 1 THEN
        RAISE EXCEPTION 'PERSIST-TEST FAILED: expected 1 rejected row, got %', v_result;
    END IF;
END $$;

COMMIT;

-- New transaction: the inserting transaction above has already committed,
-- so this SELECT can only see the audit row if it genuinely persisted.
DO $$
DECLARE
    v_log_count INT;
BEGIN
    SELECT COUNT(*) INTO v_log_count
    FROM import_logs
    WHERE dataset_name = 'role_skills'
      AND row_results @> jsonb_build_array(jsonb_build_object('role_id', 'r14_test_persist_invalid_role', 'skill_id', 'r14_test_persist_skill', 'importance_weight', 1));

    IF v_log_count < 1 THEN
        RAISE EXCEPTION 'PERSIST-TEST FAILED: committed rejection audit row not visible in a subsequent transaction';
    END IF;

    IF EXISTS (
        SELECT 1 FROM role_skills WHERE role_id = 'r14_test_persist_invalid_role'
    ) THEN
        RAISE EXCEPTION 'PERSIST-TEST FAILED: an orphan row was committed to role_skills';
    END IF;

    RAISE NOTICE 'PERSIST-TEST PASSED: rejection audit persisted past COMMIT, no orphan row committed';
END $$;

-- ---------------------------------------------------------------------------
-- Explicit cleanup: delete ONLY r14_test_%-namespaced records this section
-- created. Never touches anything outside that namespace.
-- ---------------------------------------------------------------------------
BEGIN;

DELETE FROM import_logs
WHERE dataset_name = 'role_skills'
  AND row_results @> jsonb_build_array(jsonb_build_object('role_id', 'r14_test_persist_invalid_role', 'skill_id', 'r14_test_persist_skill', 'importance_weight', 1));

-- Defensive: role_skills should already have zero matching rows (that's
-- what PERSIST-TEST just proved), but delete by namespace anyway so this
-- cleanup step is correct even if a future regression changes that.
DELETE FROM role_skills
WHERE role_id LIKE 'r14_test_%' OR skill_id LIKE 'r14_test_%';

DELETE FROM roles WHERE role_id LIKE 'r14_test_%';

COMMIT;

-- ---------------------------------------------------------------------------
-- Cleanup verification: prove zero r14_test_%-namespaced artifacts remain,
-- across every table this script or the function under test could have
-- written to.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_remaining INT;
BEGIN
    SELECT
        (SELECT COUNT(*) FROM roles WHERE role_id LIKE 'r14_test_%') +
        (SELECT COUNT(*) FROM role_skills WHERE role_id LIKE 'r14_test_%' OR skill_id LIKE 'r14_test_%') +
        (SELECT COUNT(*) FROM role_transitions WHERE from_role_id LIKE 'r14_test_%' OR to_role_id LIKE 'r14_test_%') +
        (SELECT COUNT(*) FROM role_education WHERE role_id LIKE 'r14_test_%') +
        (SELECT COUNT(*) FROM role_salary_market WHERE role_id LIKE 'r14_test_%') +
        (SELECT COUNT(*) FROM role_market_demand WHERE role_id LIKE 'r14_test_%') +
        (SELECT COUNT(*) FROM import_logs WHERE row_results::text LIKE '%r14_test_%')
    INTO v_remaining;

    IF v_remaining <> 0 THEN
        RAISE EXCEPTION 'CLEANUP FAILED: % r14_test_%%-namespaced artifact(s) remain after cleanup', v_remaining;
    END IF;

    RAISE NOTICE 'ZERO TEST ARTIFACTS REMAIN';
END $$;