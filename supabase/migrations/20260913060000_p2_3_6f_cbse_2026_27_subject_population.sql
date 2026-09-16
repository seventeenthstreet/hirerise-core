-- =============================================================================
-- HireRise Curriculum Architecture — PHASE 2 / P2.3.6F
-- Migration: 20260913060000_p2_3_6f_cbse_2026_27_subject_population.sql
--
-- SCOPE: DATA POPULATION ONLY for the frozen CBSE 2026-27 curriculum delta.
-- No DDL. No schema changes. Population itself is unchanged from the prior
-- revision of this file — only the pre-write guards and post-write
-- assertions were strengthened.
--
-- Delta (unchanged):
--   academic_subjects        +3  (INFORMATICS_PRACTICES, INFORMATION_TECHNOLOGY,
--                                 BUSINESS_ADMINISTRATION)
--   subject_group_map        +3  (MATH_OR_APPLIED_MATH, CS_IP_IT_CHOICE,
--                                 BUSINESS_STUDIES_OR_ADMIN)
--   subject_group_members    +7
--   subject_stream_map       +0
--   curriculum_pathways      +0
--
-- NOTE ON SCHEMA FIT: public.academic_subjects has no column for a
-- board-specific numeric code (CBSE 065/802/833). Documented in comments
-- only, not persisted as data.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_version_id      UUID;
  v_board_code      TEXT;
  v_effective_from  DATE;
  v_math_group      UUID;
  v_cs_group        UUID;
  v_biz_group       UUID;
  v_existing_subject_count INTEGER;
  v_existing_group_count   INTEGER;
  v_legacy_stream_map_count_pre  INTEGER;
  v_legacy_stream_map_count_post INTEGER;
  v_dep_maths_advanced   UUID;
  v_dep_applied_math     UUID;
  v_dep_computer_science UUID;
  v_dep_business_studies UUID;
  r RECORD;
BEGIN
  -- =========================================================================
  -- PRE-WRITE ASSERTIONS
  -- =========================================================================

  -- -------------------------------------------------------------------
  -- 1. Target curriculum version: id, label, status, lifecycle fields
  -- -------------------------------------------------------------------
  SELECT id, effective_from INTO v_version_id, v_effective_from
  FROM public.curriculum_versions
  WHERE id = '98da09ce-2d21-45da-80db-ae7b53c105d5'
    AND version_label = '2026-27'
    AND status = 'draft'
    AND published_at IS NULL
    AND archived_at IS NULL;

  IF v_version_id IS NULL THEN
    RAISE EXCEPTION
      'P2_3_6F_BLOCKED: curriculum_versions row 98da09ce-2d21-45da-80db-ae7b53c105d5 does not match expected (version_label=''2026-27'', status=''draft'', published_at IS NULL, archived_at IS NULL). Aborting before any write.';
  END IF;

  IF v_effective_from IS DISTINCT FROM DATE '2026-04-01' THEN
    RAISE EXCEPTION
      'P2_3_6F_BLOCKED: curriculum_versions.effective_from is % but frozen spec requires 2026-04-01. Aborting before any write.', v_effective_from;
  END IF;

  -- -------------------------------------------------------------------
  -- 2. Board assertion: the target version must belong to CBSE
  -- -------------------------------------------------------------------
  SELECT ab.board_code INTO v_board_code
  FROM public.curriculum_versions cv
  JOIN public.academic_boards ab ON ab.id = cv.board_id
  WHERE cv.id = v_version_id;

  IF v_board_code IS DISTINCT FROM 'CBSE' THEN
    RAISE EXCEPTION
      'P2_3_6F_BLOCKED: target curriculum_versions row is board_code=% , expected CBSE. Aborting before any write.', v_board_code;
  END IF;

  -- -------------------------------------------------------------------
  -- 3. Guard: none of the three new subject codes may already exist
  -- -------------------------------------------------------------------
  SELECT COUNT(*) INTO v_existing_subject_count
  FROM public.academic_subjects
  WHERE subject_code IN ('INFORMATICS_PRACTICES', 'INFORMATION_TECHNOLOGY', 'BUSINESS_ADMINISTRATION');

  IF v_existing_subject_count > 0 THEN
    RAISE EXCEPTION
      'P2_3_6F_BLOCKED: one or more of the three target subject codes already exist (% found). Aborting before any write.', v_existing_subject_count;
  END IF;

  -- -------------------------------------------------------------------
  -- 4. Guard: none of the three target group codes may already exist for
  --    this curriculum version; and this version must currently have zero
  --    subject_group_map rows of any kind (frozen baseline: 0 target rows)
  -- -------------------------------------------------------------------
  SELECT COUNT(*) INTO v_existing_group_count
  FROM public.subject_group_map
  WHERE curriculum_version_id = v_version_id;

  IF v_existing_group_count > 0 THEN
    RAISE EXCEPTION
      'P2_3_6F_BLOCKED: curriculum_version_id % already has % subject_group_map row(s); frozen baseline expects 0. Aborting before any write.',
      v_version_id, v_existing_group_count;
  END IF;

  -- -------------------------------------------------------------------
  -- 5. Guard: this version must currently have zero subject_stream_map
  --    and zero curriculum_pathways rows (frozen baseline)
  -- -------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.subject_stream_map WHERE curriculum_version_id = v_version_id) THEN
    RAISE EXCEPTION
      'P2_3_6F_BLOCKED: curriculum_version_id % already has subject_stream_map row(s); frozen baseline expects 0. Aborting before any write.', v_version_id;
  END IF;

  IF EXISTS (SELECT 1 FROM public.curriculum_pathways WHERE curriculum_version_id = v_version_id) THEN
    RAISE EXCEPTION
      'P2_3_6F_BLOCKED: curriculum_version_id % already has curriculum_pathways row(s); frozen baseline expects 0. Aborting before any write.', v_version_id;
  END IF;

  -- -------------------------------------------------------------------
  -- 6. Legacy subject_stream_map baseline: exactly 22 rows, all with
  --    curriculum_version_id IS NULL. Captured now so it can be
  --    reasserted unchanged post-write.
  -- -------------------------------------------------------------------
  SELECT COUNT(*) INTO v_legacy_stream_map_count_pre
  FROM public.subject_stream_map
  WHERE curriculum_version_id IS NULL;

  IF v_legacy_stream_map_count_pre <> 22 THEN
    RAISE EXCEPTION
      'P2_3_6F_BLOCKED: legacy subject_stream_map row count (curriculum_version_id IS NULL) is % but frozen baseline expects 22. Aborting before any write.', v_legacy_stream_map_count_pre;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.subject_stream_map
    WHERE curriculum_version_id IS NULL AND stream_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'P2_3_6F_BLOCKED: found a legacy subject_stream_map row with stream_id IS NULL; frozen baseline assumes all 22 legacy rows are stream-scoped. Aborting before any write.';
  END IF;

  -- -------------------------------------------------------------------
  -- 7. Dependency subject assertions: the four pre-existing subjects this
  --    population attaches to must exist, be active, and (where the spec
  --    gives an explicit id) match that id exactly.
  -- -------------------------------------------------------------------
  SELECT id INTO v_dep_maths_advanced FROM public.academic_subjects
    WHERE subject_code = 'MATHS_ADVANCED' AND is_active = TRUE;
  IF v_dep_maths_advanced IS NULL THEN
    RAISE EXCEPTION 'P2_3_6F_BLOCKED: active subject MATHS_ADVANCED not found. Aborting before any write.';
  END IF;

  SELECT id INTO v_dep_applied_math FROM public.academic_subjects
    WHERE subject_code = 'APPLIED_MATHEMATICS' AND is_active = TRUE;
  IF v_dep_applied_math IS NULL THEN
    RAISE EXCEPTION 'P2_3_6F_BLOCKED: active subject APPLIED_MATHEMATICS not found. Aborting before any write.';
  END IF;
  IF v_dep_applied_math <> '1799e1f6-aa0d-4acf-8cae-0e8e2c6c9adc' THEN
    RAISE EXCEPTION
      'P2_3_6F_BLOCKED: APPLIED_MATHEMATICS id is % but frozen spec expects 1799e1f6-aa0d-4acf-8cae-0e8e2c6c9adc. Aborting before any write.', v_dep_applied_math;
  END IF;

  SELECT id INTO v_dep_computer_science FROM public.academic_subjects
    WHERE subject_code = 'COMPUTER_SCIENCE' AND is_active = TRUE;
  IF v_dep_computer_science IS NULL THEN
    RAISE EXCEPTION 'P2_3_6F_BLOCKED: active subject COMPUTER_SCIENCE not found. Aborting before any write.';
  END IF;

  SELECT id INTO v_dep_business_studies FROM public.academic_subjects
    WHERE subject_code = 'BUSINESS_STUDIES' AND is_active = TRUE;
  IF v_dep_business_studies IS NULL THEN
    RAISE EXCEPTION 'P2_3_6F_BLOCKED: active subject BUSINESS_STUDIES not found. Aborting before any write.';
  END IF;

  -- =========================================================================
  -- WRITE (frozen population — unchanged)
  -- =========================================================================

  INSERT INTO public.academic_subjects (
    subject_code, subject_name, subject_category,
    applicable_from_class, applicable_to_class,
    requires_stream, is_language, is_integrated, is_optional, is_active
  )
  VALUES
    ('INFORMATICS_PRACTICES', 'Informatics Practices', 'elective', 11, 12, TRUE, FALSE, FALSE, TRUE, TRUE),
    ('INFORMATION_TECHNOLOGY', 'Information Technology', 'elective', 11, 12, TRUE, FALSE, FALSE, TRUE, TRUE),
    ('BUSINESS_ADMINISTRATION', 'Business Administration', 'elective', 11, 12, TRUE, FALSE, FALSE, TRUE, TRUE);

  INSERT INTO public.subject_group_map (
    curriculum_version_id, stream_id, pathway_id,
    group_code, group_label, min_select, max_select, is_active
  )
  VALUES
    (v_version_id, NULL, NULL, 'MATH_OR_APPLIED_MATH', 'MATH_OR_APPLIED_MATH', 0, 1, TRUE),
    (v_version_id, NULL, NULL, 'CS_IP_IT_CHOICE', 'CS_IP_IT_CHOICE', 0, 1, TRUE),
    (v_version_id, NULL, NULL, 'BUSINESS_STUDIES_OR_ADMIN', 'BUSINESS_STUDIES_OR_ADMIN', 0, 1, TRUE);

  SELECT id INTO v_math_group FROM public.subject_group_map
    WHERE curriculum_version_id = v_version_id AND group_code = 'MATH_OR_APPLIED_MATH';
  SELECT id INTO v_cs_group FROM public.subject_group_map
    WHERE curriculum_version_id = v_version_id AND group_code = 'CS_IP_IT_CHOICE';
  SELECT id INTO v_biz_group FROM public.subject_group_map
    WHERE curriculum_version_id = v_version_id AND group_code = 'BUSINESS_STUDIES_OR_ADMIN';

  INSERT INTO public.subject_group_members (group_id, subject_id, is_mandatory)
  SELECT v_math_group, s.id, FALSE
  FROM public.academic_subjects s WHERE s.subject_code = 'MATHS_ADVANCED'
  UNION ALL
  SELECT v_math_group, s.id, FALSE
  FROM public.academic_subjects s WHERE s.subject_code = 'APPLIED_MATHEMATICS'
  UNION ALL
  SELECT v_cs_group, s.id, FALSE
  FROM public.academic_subjects s WHERE s.subject_code = 'COMPUTER_SCIENCE'
  UNION ALL
  SELECT v_cs_group, s.id, FALSE
  FROM public.academic_subjects s WHERE s.subject_code = 'INFORMATICS_PRACTICES'
  UNION ALL
  SELECT v_cs_group, s.id, FALSE
  FROM public.academic_subjects s WHERE s.subject_code = 'INFORMATION_TECHNOLOGY'
  UNION ALL
  SELECT v_biz_group, s.id, FALSE
  FROM public.academic_subjects s WHERE s.subject_code = 'BUSINESS_STUDIES'
  UNION ALL
  SELECT v_biz_group, s.id, FALSE
  FROM public.academic_subjects s WHERE s.subject_code = 'BUSINESS_ADMINISTRATION';

  -- =========================================================================
  -- POST-WRITE ASSERTIONS (exact, not count-only)
  -- =========================================================================

  -- -------------------------------------------------------------------
  -- A. Subjects: exactly 3, every frozen attribute matches
  -- -------------------------------------------------------------------
  FOR r IN
    SELECT * FROM (VALUES
      ('INFORMATICS_PRACTICES'),
      ('INFORMATION_TECHNOLOGY'),
      ('BUSINESS_ADMINISTRATION')
    ) AS expected(subject_code)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.academic_subjects s
      WHERE s.subject_code = r.subject_code
        AND s.subject_category = 'elective'
        AND s.applicable_from_class = 11
        AND s.applicable_to_class = 12
        AND s.requires_stream = TRUE
        AND s.is_language = FALSE
        AND s.is_integrated = FALSE
        AND s.is_optional = TRUE
        AND s.is_active = TRUE
    ) THEN
      RAISE EXCEPTION 'P2_3_6F_FAIL: subject % missing or attribute mismatch post-write. Rolling back.', r.subject_code;
    END IF;
  END LOOP;

  IF (SELECT COUNT(*) FROM public.academic_subjects
      WHERE subject_code IN ('INFORMATICS_PRACTICES', 'INFORMATION_TECHNOLOGY', 'BUSINESS_ADMINISTRATION')) <> 3 THEN
    RAISE EXCEPTION 'P2_3_6F_FAIL: expected exactly 3 new subject rows, found %. Rolling back.',
      (SELECT COUNT(*) FROM public.academic_subjects
       WHERE subject_code IN ('INFORMATICS_PRACTICES', 'INFORMATION_TECHNOLOGY', 'BUSINESS_ADMINISTRATION'));
  END IF;

  -- -------------------------------------------------------------------
  -- B. Groups: exactly 3 for this version, every frozen attribute matches
  -- -------------------------------------------------------------------
  FOR r IN
    SELECT * FROM (VALUES
      ('MATH_OR_APPLIED_MATH'),
      ('CS_IP_IT_CHOICE'),
      ('BUSINESS_STUDIES_OR_ADMIN')
    ) AS expected(group_code)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.subject_group_map g
      WHERE g.group_code = r.group_code
        AND g.curriculum_version_id = v_version_id
        AND g.stream_id IS NULL
        AND g.pathway_id IS NULL
        AND g.min_select = 0
        AND g.max_select = 1
        AND g.is_active = TRUE
    ) THEN
      RAISE EXCEPTION 'P2_3_6F_FAIL: group % missing or attribute mismatch post-write. Rolling back.', r.group_code;
    END IF;
  END LOOP;

  IF (SELECT COUNT(*) FROM public.subject_group_map WHERE curriculum_version_id = v_version_id) <> 3 THEN
    RAISE EXCEPTION 'P2_3_6F_FAIL: expected exactly 3 subject_group_map rows for this version, found %. Rolling back.',
      (SELECT COUNT(*) FROM public.subject_group_map WHERE curriculum_version_id = v_version_id);
  END IF;

  -- -------------------------------------------------------------------
  -- C. Memberships: exactly the 7 (group_code, subject_code) pairs,
  --    each is_mandatory = FALSE, no extras
  -- -------------------------------------------------------------------
  FOR r IN
    SELECT * FROM (VALUES
      ('MATH_OR_APPLIED_MATH', 'MATHS_ADVANCED'),
      ('MATH_OR_APPLIED_MATH', 'APPLIED_MATHEMATICS'),
      ('CS_IP_IT_CHOICE', 'COMPUTER_SCIENCE'),
      ('CS_IP_IT_CHOICE', 'INFORMATICS_PRACTICES'),
      ('CS_IP_IT_CHOICE', 'INFORMATION_TECHNOLOGY'),
      ('BUSINESS_STUDIES_OR_ADMIN', 'BUSINESS_STUDIES'),
      ('BUSINESS_STUDIES_OR_ADMIN', 'BUSINESS_ADMINISTRATION')
    ) AS expected(group_code, subject_code)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM public.subject_group_members m
      JOIN public.subject_group_map g ON g.id = m.group_id
      JOIN public.academic_subjects s ON s.id = m.subject_id
      WHERE g.curriculum_version_id = v_version_id
        AND g.group_code = r.group_code
        AND s.subject_code = r.subject_code
        AND m.is_mandatory = FALSE
    ) THEN
      RAISE EXCEPTION 'P2_3_6F_FAIL: membership % -> % missing or is_mandatory mismatch post-write. Rolling back.',
        r.group_code, r.subject_code;
    END IF;
  END LOOP;

  IF (SELECT COUNT(*) FROM public.subject_group_members m
      JOIN public.subject_group_map g ON g.id = m.group_id
      WHERE g.curriculum_version_id = v_version_id
        AND g.group_code IN ('MATH_OR_APPLIED_MATH', 'CS_IP_IT_CHOICE', 'BUSINESS_STUDIES_OR_ADMIN')) <> 7 THEN
    RAISE EXCEPTION 'P2_3_6F_FAIL: expected exactly 7 memberships across the 3 target groups, found %. Rolling back.',
      (SELECT COUNT(*) FROM public.subject_group_members m
       JOIN public.subject_group_map g ON g.id = m.group_id
       WHERE g.curriculum_version_id = v_version_id
         AND g.group_code IN ('MATH_OR_APPLIED_MATH', 'CS_IP_IT_CHOICE', 'BUSINESS_STUDIES_OR_ADMIN'));
  END IF;

  -- -------------------------------------------------------------------
  -- D. Zero stream mappings for this version
  -- -------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.subject_stream_map WHERE curriculum_version_id = v_version_id) THEN
    RAISE EXCEPTION 'P2_3_6F_FAIL: subject_stream_map rows exist for this version post-write; expected 0. Rolling back.';
  END IF;

  -- -------------------------------------------------------------------
  -- E. Zero pathways for this version
  -- -------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.curriculum_pathways WHERE curriculum_version_id = v_version_id) THEN
    RAISE EXCEPTION 'P2_3_6F_FAIL: curriculum_pathways rows exist for this version post-write; expected 0. Rolling back.';
  END IF;

  -- -------------------------------------------------------------------
  -- F. Legacy integrity: still exactly 22, unchanged from pre-write count
  -- -------------------------------------------------------------------
  SELECT COUNT(*) INTO v_legacy_stream_map_count_post
  FROM public.subject_stream_map
  WHERE curriculum_version_id IS NULL;

  IF v_legacy_stream_map_count_post <> v_legacy_stream_map_count_pre
     OR v_legacy_stream_map_count_post <> 22 THEN
    RAISE EXCEPTION
      'P2_3_6F_FAIL: legacy subject_stream_map count changed or drifted from 22 (pre=%, post=%). Rolling back.',
      v_legacy_stream_map_count_pre, v_legacy_stream_map_count_post;
  END IF;

  -- -------------------------------------------------------------------
  -- G. Target version unchanged (draft, unpublished, unarchived)
  -- -------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM public.curriculum_versions
    WHERE id = v_version_id AND status = 'draft' AND published_at IS NULL AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'P2_3_6F_FAIL: target curriculum_versions row is no longer draft/unpublished/unarchived post-write. Rolling back.';
  END IF;

  RAISE NOTICE 'P2_3_6F: population complete and fully verified for curriculum_version_id=%', v_version_id;
END $$;

COMMIT;

-- =============================================================================
-- END OF MIGRATION: 20260913060000_p2_3_6f_cbse_2026_27_subject_population.sql
-- =============================================================================