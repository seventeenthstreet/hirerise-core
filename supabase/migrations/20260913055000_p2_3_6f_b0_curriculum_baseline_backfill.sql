-- =============================================================================
-- HireRise Curriculum Architecture — P2.3.6F-B0
-- Migration: 20260913055000_p2_3_6f_b0_curriculum_baseline_backfill.sql
--
-- SCOPE: Minimum baseline required for P2.3.6F to execute reproducibly from
-- a fresh database reset. Establishes the CBSE 2026-27 curriculum_versions
-- row, backfills the four existing (Phase 1A) academic_streams rows to
-- reference it, and establishes the canonical APPLIED_MATHEMATICS
-- academic_subjects row. No curriculum_pathways, subject_group_map,
-- subject_group_members, or subject_stream_map rows are created or
-- modified.
--
-- Depends on: 20260526000002_phase1a_seed_v1_india_taxonomy.sql
--             20260913020000_p1_curriculum_schema_foundation.sql
-- Must run before: 20260913060000_p2_3_6f_cbse_2026_27_subject_population.sql
--
-- Does NOT modify P2.3.6F (20260913060000). The ae7e/ae7b id discrepancy in
-- that file is corrected separately, under its own authorized change — not
-- here. See P2.3.6F-B0 gate report §8 / Pre-Implementation SQL Review.
--
-- Does NOT modify RLS. The accepted, owner-acknowledged consequence of this
-- migration is that the four CBSE streams become hidden from the
-- academic_streams_public_read policy (anon/authenticated) once their
-- curriculum_version_id resolves to this DRAFT version, until the version
-- is later published. See 20260913030000 for that policy.
--
-- Identifier resolution (P2.3.6F-B0-R1 / R2 correction):
--   * The CBSE academic_boards row is resolved at runtime by its stable
--     business key (countries_master.country_code + academic_boards.board_code
--     + board_type + is_active), NOT by a fixed literal UUID. Exactly one
--     match must exist; zero matches and multiple matches both abort.
--   * The four CBSE academic_streams rows (SCIENCE, COMMERCE, HUMANITIES,
--     VOCATIONAL) are likewise resolved at runtime by business key
--     (board_id + stream_code), NOT by fixed literal UUIDs. Each is resolved
--     independently, must match exactly one row, and has its attributes
--     validated before use.
--   * curriculum_versions.id REMAINS a fixed canonical literal UUID.
--   * APPLIED_MATHEMATICS academic_subjects.id REMAINS a fixed canonical
--     literal UUID.
-- Rationale: board and stream ids are environment-dependent (gen_random_uuid
-- at Phase 1A seed time) and are therefore not reproducible across a fresh
-- reset; the two canonical ids above are governance-frozen and must not move.
--
-- Idempotency: fixed canonical UUIDs for the two written rows + runtime
-- business-key resolution for board/stream targeting + explicit pre-write
-- attribute guards + ON CONFLICT (id) DO NOTHING + full-field post-write
-- assertions. An existing row at either fixed id with attributes that do NOT
-- match the frozen spec below causes the migration to fail loudly and roll
-- back (both before the write, via the pre-write guard, and after, via the
-- post-write assertion) — it is never silently accepted or repaired.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  -- Resolved at runtime by business key (A1 / A2) — never fixed literals.
  v_board_id             UUID;
  v_stream_commerce      UUID;
  v_stream_humanities    UUID;
  v_stream_science       UUID;
  v_stream_vocational    UUID;
  -- Governance-frozen canonical identifiers — these remain fixed literals.
  v_version_id           UUID := '98da09ce-2d21-45da-80db-ae7b53c105d5';
  v_applied_math_id      UUID := '1799e1f6-aa0d-4acf-8cae-0e8e2c6c9adc';
  -- Business-key expectations + resolution working variables (R2).
  v_country_code_expected TEXT := 'IN';
  v_board_code_expected   TEXT := 'CBSE';
  v_board_type_expected   TEXT := 'national';
  v_board_match_count     INTEGER;
  v_stream_match_count    INTEGER;
  v_stream_row            RECORD;
  v_stream_count         INTEGER;
  v_streams_bad_version  INTEGER;
  v_conflicting_version  UUID;
  v_conflicting_subject  UUID;
  v_existing_version     RECORD;
  v_existing_subject     RECORD;
BEGIN
  -- =========================================================================
  -- A. PRE-WRITE ASSERTIONS (fail fast — no write occurs until all pass)
  -- =========================================================================

  -- A1. Resolve the CBSE board by stable business key, not by fixed UUID.
  --     Exactly one active row must match (country_code + board_code +
  --     board_type). Zero matches and multiple matches BOTH abort — a
  --     candidate is never silently chosen.
  SELECT COUNT(*) INTO v_board_match_count
  FROM public.academic_boards ab
  JOIN public.countries_master cm
    ON cm.id = ab.country_id
  WHERE cm.country_code = v_country_code_expected
    AND ab.board_code   = v_board_code_expected
    AND ab.board_type   = v_board_type_expected
    AND ab.is_active    = TRUE;

  IF v_board_match_count = 0 THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: no active academic_boards row matches the business key (country_code=%, board_code=%, board_type=%). Aborting before any write.',
      v_country_code_expected, v_board_code_expected, v_board_type_expected;
  END IF;

  IF v_board_match_count > 1 THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: % active academic_boards rows match the business key (country_code=%, board_code=%, board_type=%). Ambiguous — aborting before any write rather than selecting a candidate.',
      v_board_match_count, v_country_code_expected, v_board_code_expected, v_board_type_expected;
  END IF;

  -- Exactly one match proven above — safe to capture the actual id.
  SELECT ab.id INTO v_board_id
  FROM public.academic_boards ab
  JOIN public.countries_master cm
    ON cm.id = ab.country_id
  WHERE cm.country_code = v_country_code_expected
    AND ab.board_code   = v_board_code_expected
    AND ab.board_type   = v_board_type_expected
    AND ab.is_active    = TRUE;

  -- A2. Resolve each of the four legacy Phase-1A CBSE streams independently by
  --     business key (board_id + stream_code), not by fixed UUID. For each:
  --     zero matches aborts, multiple matches aborts, then the actual id is
  --     captured and its baseline attributes are validated.

  -- A2.1 SCIENCE
  SELECT COUNT(*) INTO v_stream_match_count
  FROM public.academic_streams
  WHERE board_id = v_board_id AND stream_code = 'SCIENCE';

  IF v_stream_match_count = 0 THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: no academic_streams row matches board % with stream_code SCIENCE. Aborting before any write.', v_board_id;
  END IF;

  IF v_stream_match_count > 1 THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: % academic_streams rows match board % with stream_code SCIENCE. Ambiguous — aborting before any write rather than selecting a candidate.',
      v_stream_match_count, v_board_id;
  END IF;

  SELECT * INTO v_stream_row
  FROM public.academic_streams
  WHERE board_id = v_board_id AND stream_code = 'SCIENCE';

  IF NOT (
    v_stream_row.stream_name              IS NOT DISTINCT FROM 'Science'
    AND v_stream_row.applicable_from_class IS NOT DISTINCT FROM 11::SMALLINT
    AND v_stream_row.applicable_to_class   IS NOT DISTINCT FROM 12::SMALLINT
    AND v_stream_row.is_active             IS NOT DISTINCT FROM TRUE
  ) THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: academic_streams row % (SCIENCE, board %) does not match the expected baseline attributes. Aborting before any write.',
      v_stream_row.id, v_board_id;
  END IF;

  v_stream_science := v_stream_row.id;

  -- A2.2 COMMERCE
  SELECT COUNT(*) INTO v_stream_match_count
  FROM public.academic_streams
  WHERE board_id = v_board_id AND stream_code = 'COMMERCE';

  IF v_stream_match_count = 0 THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: no academic_streams row matches board % with stream_code COMMERCE. Aborting before any write.', v_board_id;
  END IF;

  IF v_stream_match_count > 1 THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: % academic_streams rows match board % with stream_code COMMERCE. Ambiguous — aborting before any write rather than selecting a candidate.',
      v_stream_match_count, v_board_id;
  END IF;

  SELECT * INTO v_stream_row
  FROM public.academic_streams
  WHERE board_id = v_board_id AND stream_code = 'COMMERCE';

  IF NOT (
    v_stream_row.stream_name              IS NOT DISTINCT FROM 'Commerce'
    AND v_stream_row.applicable_from_class IS NOT DISTINCT FROM 11::SMALLINT
    AND v_stream_row.applicable_to_class   IS NOT DISTINCT FROM 12::SMALLINT
    AND v_stream_row.is_active             IS NOT DISTINCT FROM TRUE
  ) THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: academic_streams row % (COMMERCE, board %) does not match the expected baseline attributes. Aborting before any write.',
      v_stream_row.id, v_board_id;
  END IF;

  v_stream_commerce := v_stream_row.id;

  -- A2.3 HUMANITIES
  SELECT COUNT(*) INTO v_stream_match_count
  FROM public.academic_streams
  WHERE board_id = v_board_id AND stream_code = 'HUMANITIES';

  IF v_stream_match_count = 0 THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: no academic_streams row matches board % with stream_code HUMANITIES. Aborting before any write.', v_board_id;
  END IF;

  IF v_stream_match_count > 1 THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: % academic_streams rows match board % with stream_code HUMANITIES. Ambiguous — aborting before any write rather than selecting a candidate.',
      v_stream_match_count, v_board_id;
  END IF;

  SELECT * INTO v_stream_row
  FROM public.academic_streams
  WHERE board_id = v_board_id AND stream_code = 'HUMANITIES';

  IF NOT (
    v_stream_row.stream_name              IS NOT DISTINCT FROM 'Humanities'
    AND v_stream_row.applicable_from_class IS NOT DISTINCT FROM 11::SMALLINT
    AND v_stream_row.applicable_to_class   IS NOT DISTINCT FROM 12::SMALLINT
    AND v_stream_row.is_active             IS NOT DISTINCT FROM TRUE
  ) THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: academic_streams row % (HUMANITIES, board %) does not match the expected baseline attributes. Aborting before any write.',
      v_stream_row.id, v_board_id;
  END IF;

  v_stream_humanities := v_stream_row.id;

  -- A2.4 VOCATIONAL
  SELECT COUNT(*) INTO v_stream_match_count
  FROM public.academic_streams
  WHERE board_id = v_board_id AND stream_code = 'VOCATIONAL';

  IF v_stream_match_count = 0 THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: no academic_streams row matches board % with stream_code VOCATIONAL. Aborting before any write.', v_board_id;
  END IF;

  IF v_stream_match_count > 1 THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: % academic_streams rows match board % with stream_code VOCATIONAL. Ambiguous — aborting before any write rather than selecting a candidate.',
      v_stream_match_count, v_board_id;
  END IF;

  SELECT * INTO v_stream_row
  FROM public.academic_streams
  WHERE board_id = v_board_id AND stream_code = 'VOCATIONAL';

  IF NOT (
    v_stream_row.stream_name              IS NOT DISTINCT FROM 'Vocational'
    AND v_stream_row.applicable_from_class IS NOT DISTINCT FROM 11::SMALLINT
    AND v_stream_row.applicable_to_class   IS NOT DISTINCT FROM 12::SMALLINT
    AND v_stream_row.is_active             IS NOT DISTINCT FROM TRUE
  ) THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: academic_streams row % (VOCATIONAL, board %) does not match the expected baseline attributes. Aborting before any write.',
      v_stream_row.id, v_board_id;
  END IF;

  v_stream_vocational := v_stream_row.id;

  -- A2b. None of the four streams may already carry a DIFFERENT (non-NULL)
  --      curriculum_version_id. Fail loud, do not silently repair.
  SELECT COUNT(*) INTO v_streams_bad_version
  FROM public.academic_streams
  WHERE id IN (v_stream_commerce, v_stream_humanities, v_stream_science, v_stream_vocational)
    AND curriculum_version_id IS NOT NULL
    AND curriculum_version_id <> v_version_id;

  IF v_streams_bad_version > 0 THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: % of the 4 legacy streams already carry a curriculum_version_id different from %. Aborting before any write — not silently repairing.',
      v_streams_bad_version, v_version_id;
  END IF;

  -- A3. No CBSE 2026-27 curriculum_versions row may already exist under a
  --     DIFFERENT id (natural-key check: board_id + version_label, region
  --     NULL). A same-id match is handled by A3b below, not here.
  SELECT id INTO v_conflicting_version
  FROM public.curriculum_versions
  WHERE board_id = v_board_id AND version_label = '2026-27' AND region_id IS NULL
    AND id <> v_version_id;

  IF v_conflicting_version IS NOT NULL THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: a CBSE 2026-27 curriculum_versions row already exists under a different id (%). Aborting before any write.', v_conflicting_version;
  END IF;

  -- A3b. If a row already exists at the exact fixed id, it must match the
  --      frozen baseline spec on EVERY column. CORRECT UUID + WRONG DATA
  --      must fail loudly here, before any write — never silently accepted,
  --      never repaired with an UPDATE.
  SELECT * INTO v_existing_version
  FROM public.curriculum_versions
  WHERE id = v_version_id;

  IF FOUND THEN
    IF NOT (
      v_existing_version.board_id            IS NOT DISTINCT FROM v_board_id
      AND v_existing_version.region_id        IS NOT DISTINCT FROM NULL
      AND v_existing_version.version_label    IS NOT DISTINCT FROM '2026-27'
      AND v_existing_version.status           IS NOT DISTINCT FROM 'draft'
      AND v_existing_version.effective_from   IS NOT DISTINCT FROM DATE '2026-04-01'
      AND v_existing_version.effective_to     IS NOT DISTINCT FROM NULL
      AND v_existing_version.ncert_relationship IS NOT DISTINCT FROM NULL
      AND v_existing_version.published_at     IS NOT DISTINCT FROM NULL
      AND v_existing_version.archived_at      IS NOT DISTINCT FROM NULL
      AND v_existing_version.created_by       IS NOT DISTINCT FROM NULL
      AND v_existing_version.notes            IS NOT DISTINCT FROM 'CBSE Circular Acad-14/2026 (F.1001/CBSE-Acad/Curriculum/2026), dated 01.04.2026 — Curriculum for Academic Session 2026-27, Classes XI-XII.'
    ) THEN
      RAISE EXCEPTION
        'P2_3_6F_B0_BLOCKED: curriculum_versions row % already exists but one or more attributes do not match the frozen baseline spec. Aborting before any write — not silently accepting or repairing an incorrect existing row. Inspect manually.',
        v_version_id;
    END IF;
  END IF;

  -- A4. No APPLIED_MATHEMATICS subject may already exist under a DIFFERENT
  --     id (business-key check: subject_code).
  SELECT id INTO v_conflicting_subject
  FROM public.academic_subjects
  WHERE subject_code = 'APPLIED_MATHEMATICS' AND id <> v_applied_math_id;

  IF v_conflicting_subject IS NOT NULL THEN
    RAISE EXCEPTION
      'P2_3_6F_B0_BLOCKED: an APPLIED_MATHEMATICS academic_subjects row already exists under a different id (%). Aborting before any write.', v_conflicting_subject;
  END IF;

  -- A4b. If a row already exists at the exact fixed id, it must match the
  --      frozen baseline spec on EVERY column. Same rule as A3b.
  SELECT * INTO v_existing_subject
  FROM public.academic_subjects
  WHERE id = v_applied_math_id;

  IF FOUND THEN
    IF NOT (
      v_existing_subject.subject_code          IS NOT DISTINCT FROM 'APPLIED_MATHEMATICS'
      AND v_existing_subject.subject_name       IS NOT DISTINCT FROM 'Applied Mathematics'
      AND v_existing_subject.subject_category   IS NOT DISTINCT FROM 'elective'
      AND v_existing_subject.applicable_from_class IS NOT DISTINCT FROM 11::SMALLINT
      AND v_existing_subject.applicable_to_class   IS NOT DISTINCT FROM 12::SMALLINT
      AND v_existing_subject.requires_stream    IS NOT DISTINCT FROM TRUE
      AND v_existing_subject.is_language        IS NOT DISTINCT FROM FALSE
      AND v_existing_subject.is_integrated      IS NOT DISTINCT FROM FALSE
      AND v_existing_subject.is_optional        IS NOT DISTINCT FROM TRUE
      AND v_existing_subject.is_active          IS NOT DISTINCT FROM TRUE
    ) THEN
      RAISE EXCEPTION
        'P2_3_6F_B0_BLOCKED: academic_subjects row % (APPLIED_MATHEMATICS) already exists but one or more attributes do not match the frozen baseline spec. Aborting before any write — not silently accepting or repairing an incorrect existing row. Inspect manually.',
        v_applied_math_id;
    END IF;
  END IF;

  -- =========================================================================
  -- B. CURRICULUM VERSION
  --    status = 'draft' satisfies trg_curriculum_versions_lifecycle_guard's
  --    INSERT requirement; any other value would raise GOVERNANCE_VIOLATION.
  --    ON CONFLICT (id) DO NOTHING is safe here only because A3b has already
  --    proven that any pre-existing row at this id matches the spec exactly.
  -- =========================================================================

  INSERT INTO public.curriculum_versions (
    id, board_id, region_id, version_label, status,
    effective_from, effective_to, ncert_relationship,
    published_at, archived_at, created_by, notes
  )
  VALUES (
    v_version_id, v_board_id, NULL, '2026-27', 'draft',
    DATE '2026-04-01', NULL, NULL,
    NULL, NULL, NULL,
    'CBSE Circular Acad-14/2026 (F.1001/CBSE-Acad/Curriculum/2026), dated 01.04.2026 — Curriculum for Academic Session 2026-27, Classes XI-XII.'
  )
  ON CONFLICT (id) DO NOTHING;

  -- =========================================================================
  -- C. STREAM BACKFILL (UPDATE, not INSERT — these are the existing Phase 1A
  --    rows. Naturally idempotent; A2b already proved no conflicting value
  --    exists, so this can never silently overwrite a different version.)
  -- =========================================================================

  UPDATE public.academic_streams
  SET curriculum_version_id = v_version_id
  WHERE id IN (v_stream_commerce, v_stream_humanities, v_stream_science, v_stream_vocational)
    AND curriculum_version_id IS NULL;
  -- stream_code, stream_name, board_id, class ranges, is_active, and
  -- deprecated_at are never touched by this statement.

  -- =========================================================================
  -- D. APPLIED MATHEMATICS SUBJECT
  --    ON CONFLICT (id) DO NOTHING is safe here only because A4b has already
  --    proven that any pre-existing row at this id matches the spec exactly.
  -- =========================================================================

  INSERT INTO public.academic_subjects (
    id, subject_code, subject_name, subject_category,
    applicable_from_class, applicable_to_class,
    requires_stream, is_language, is_integrated, is_optional, is_active
  )
  VALUES (
    v_applied_math_id, 'APPLIED_MATHEMATICS', 'Applied Mathematics', 'elective',
    11, 12,
    TRUE, FALSE, FALSE, TRUE, TRUE
    -- Official CBSE subject code 241 is documentation-only — academic_subjects
    -- has no column to persist it (confirmed in 20260913060000's own header).
  )
  ON CONFLICT (id) DO NOTHING;

  -- =========================================================================
  -- E. POST-WRITE ASSERTIONS
  --    Full-field checks — a second, independent closure of the same
  --    "correct UUID + wrong data" gap the pre-write guards (A3b/A4b) close,
  --    so a defect in the pre-write logic cannot itself let bad data through.
  -- =========================================================================

  SELECT * INTO v_existing_version
  FROM public.curriculum_versions
  WHERE id = v_version_id;

  IF NOT FOUND
     OR NOT (
       v_existing_version.board_id            IS NOT DISTINCT FROM v_board_id
       AND v_existing_version.region_id        IS NOT DISTINCT FROM NULL
       AND v_existing_version.version_label    IS NOT DISTINCT FROM '2026-27'
       AND v_existing_version.status           IS NOT DISTINCT FROM 'draft'
       AND v_existing_version.effective_from   IS NOT DISTINCT FROM DATE '2026-04-01'
       AND v_existing_version.effective_to     IS NOT DISTINCT FROM NULL
       AND v_existing_version.ncert_relationship IS NOT DISTINCT FROM NULL
       AND v_existing_version.published_at     IS NOT DISTINCT FROM NULL
       AND v_existing_version.archived_at      IS NOT DISTINCT FROM NULL
       AND v_existing_version.created_by       IS NOT DISTINCT FROM NULL
       AND v_existing_version.notes            IS NOT DISTINCT FROM 'CBSE Circular Acad-14/2026 (F.1001/CBSE-Acad/Curriculum/2026), dated 01.04.2026 — Curriculum for Academic Session 2026-27, Classes XI-XII.'
     )
  THEN
    RAISE EXCEPTION 'P2_3_6F_B0_BLOCKED: post-write curriculum_versions state does not match expected. Rolling back.';
  END IF;

  IF (
    SELECT COUNT(*) FROM public.academic_streams
    WHERE id IN (v_stream_commerce, v_stream_humanities, v_stream_science, v_stream_vocational)
      AND curriculum_version_id = v_version_id
  ) <> 4 THEN
    RAISE EXCEPTION 'P2_3_6F_B0_BLOCKED: not all 4 legacy streams resolved to the expected curriculum_version_id post-write. Rolling back.';
  END IF;

  SELECT * INTO v_existing_subject
  FROM public.academic_subjects
  WHERE id = v_applied_math_id;

  IF NOT FOUND
     OR NOT (
       v_existing_subject.subject_code          IS NOT DISTINCT FROM 'APPLIED_MATHEMATICS'
       AND v_existing_subject.subject_name       IS NOT DISTINCT FROM 'Applied Mathematics'
       AND v_existing_subject.subject_category   IS NOT DISTINCT FROM 'elective'
       AND v_existing_subject.applicable_from_class IS NOT DISTINCT FROM 11::SMALLINT
       AND v_existing_subject.applicable_to_class   IS NOT DISTINCT FROM 12::SMALLINT
       AND v_existing_subject.requires_stream    IS NOT DISTINCT FROM TRUE
       AND v_existing_subject.is_language        IS NOT DISTINCT FROM FALSE
       AND v_existing_subject.is_integrated      IS NOT DISTINCT FROM FALSE
       AND v_existing_subject.is_optional        IS NOT DISTINCT FROM TRUE
       AND v_existing_subject.is_active          IS NOT DISTINCT FROM TRUE
     )
  THEN
    RAISE EXCEPTION 'P2_3_6F_B0_BLOCKED: post-write APPLIED_MATHEMATICS state does not match expected. Rolling back.';
  END IF;

END $$;

COMMIT;