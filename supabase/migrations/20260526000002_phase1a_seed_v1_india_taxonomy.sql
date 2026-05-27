-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 1B — SEED MIGRATION (FIXED + READY TO APPLY)
-- File: 20260526000002_phase1b_seed_v1_india_taxonomy.sql
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. COUNTRIES
-- =============================================================================

INSERT INTO public.countries_master (
  country_code,
  country_name,
  is_active
)
VALUES
  ('IN', 'India', TRUE),
  ('GB', 'United Kingdom', TRUE),
  ('SG', 'Singapore', TRUE),
  ('AE', 'United Arab Emirates', TRUE)
ON CONFLICT (country_code) DO NOTHING;

-- =============================================================================
-- 2. CURRICULUM REGIONS
-- =============================================================================

INSERT INTO public.curriculum_regions (
  country_id,
  region_code,
  region_name,
  is_active
)
SELECT
  cm.id,
  v.region_code,
  v.region_name,
  TRUE
FROM public.countries_master cm
CROSS JOIN (
  VALUES
    ('IN-KL', 'Kerala'),
    ('IN-TN', 'Tamil Nadu'),
    ('IN-KA', 'Karnataka'),
    ('IN-MH', 'Maharashtra'),
    ('IN-DL', 'Delhi')
) AS v(region_code, region_name)
WHERE cm.country_code = 'IN'
ON CONFLICT (country_id, region_code) DO NOTHING;

-- =============================================================================
-- 3. ACADEMIC BOARDS
-- =============================================================================

INSERT INTO public.academic_boards (
  country_id,
  board_code,
  board_name,
  board_type,
  is_active
)
SELECT
  cm.id,
  v.board_code,
  v.board_name,
  v.board_type,
  TRUE
FROM public.countries_master cm
CROSS JOIN (
  VALUES
    ('CBSE', 'Central Board of Secondary Education', 'national'),
    ('CISCE', 'Council for the Indian School Certificate Examinations', 'national'),
    ('IB', 'International Baccalaureate', 'international'),
    ('IGCSE', 'Cambridge IGCSE', 'international'),
    ('KL_SCERT', 'Kerala State Curriculum (SCERT)', 'state')
) AS v(board_code, board_name, board_type)
WHERE cm.country_code = 'IN'
ON CONFLICT (country_id, board_code) DO NOTHING;

-- =============================================================================
-- 4. ACADEMIC STREAMS
-- =============================================================================

INSERT INTO public.academic_streams (
  board_id,
  stream_code,
  stream_name,
  applicable_from_class,
  applicable_to_class,
  is_active
)
SELECT
  ab.id,
  v.stream_code,
  v.stream_name,
  11,
  12,
  TRUE
FROM public.academic_boards ab
JOIN public.countries_master cm
  ON cm.id = ab.country_id
CROSS JOIN (
  VALUES
    ('SCIENCE', 'Science'),
    ('COMMERCE', 'Commerce'),
    ('HUMANITIES', 'Humanities'),
    ('VOCATIONAL', 'Vocational')
) AS v(stream_code, stream_name)
WHERE cm.country_code = 'IN'
AND ab.board_code IN ('CBSE', 'CISCE', 'KL_SCERT')
ON CONFLICT (board_id, stream_code) DO NOTHING;

-- =============================================================================
-- 5. ACADEMIC LANGUAGES
-- =============================================================================

INSERT INTO public.academic_languages (
  language_code,
  language_name,
  is_active
)
VALUES
  ('en', 'English', TRUE),
  ('hi', 'Hindi', TRUE),
  ('ml', 'Malayalam', TRUE),
  ('ta', 'Tamil', TRUE),
  ('kn', 'Kannada', TRUE),
  ('te', 'Telugu', TRUE),
  ('mr', 'Marathi', TRUE),
  ('gu', 'Gujarati', TRUE),
  ('pa', 'Punjabi', TRUE),
  ('bn', 'Bengali', TRUE),
  ('ur', 'Urdu', TRUE),
  ('od', 'Odia', TRUE),
  ('sa', 'Sanskrit', TRUE),
  ('fr', 'French', TRUE),
  ('de', 'German', TRUE),
  ('ar', 'Arabic', TRUE)
ON CONFLICT (language_code) DO NOTHING;

-- =============================================================================
-- 6. ACADEMIC SUBJECTS
-- =============================================================================

INSERT INTO public.academic_subjects (
  subject_code,
  subject_name,
  subject_category,
  applicable_from_class,
  applicable_to_class,
  requires_stream,
  is_language,
  is_integrated,
  is_optional,
  is_active
)
VALUES

-- Integrated subjects

('ENGLISH', 'English', 'language', 1, 12, FALSE, TRUE, TRUE, FALSE, TRUE),
('MATHEMATICS', 'Mathematics', 'core', 1, 12, FALSE, FALSE, TRUE, FALSE, TRUE),
('SCIENCE', 'Science', 'core', 6, 10, FALSE, FALSE, TRUE, FALSE, TRUE),
('SOCIAL_SCIENCE', 'Social Science', 'core', 6, 10, FALSE, FALSE, TRUE, FALSE, TRUE),
('EVS', 'Environmental Studies', 'core', 1, 5, FALSE, FALSE, TRUE, FALSE, TRUE),
('PHYSICAL_EDUCATION', 'Physical Education', 'core', 1, 12, FALSE, FALSE, TRUE, FALSE, TRUE),

-- Science stream

('PHYSICS', 'Physics', 'core', 11, 12, TRUE, FALSE, FALSE, FALSE, TRUE),
('CHEMISTRY', 'Chemistry', 'core', 11, 12, TRUE, FALSE, FALSE, FALSE, TRUE),
('BIOLOGY', 'Biology', 'core', 11, 12, TRUE, FALSE, FALSE, FALSE, TRUE),
('MATHS_ADVANCED', 'Mathematics Advanced', 'core', 11, 12, TRUE, FALSE, FALSE, FALSE, TRUE),
('COMPUTER_SCIENCE', 'Computer Science', 'elective', 11, 12, TRUE, FALSE, FALSE, TRUE, TRUE),
('ARTIFICIAL_INTELLIGENCE', 'Artificial Intelligence', 'elective', 11, 12, TRUE, FALSE, FALSE, TRUE, TRUE),

-- Commerce stream

('ACCOUNTANCY', 'Accountancy', 'core', 11, 12, TRUE, FALSE, FALSE, FALSE, TRUE),
('BUSINESS_STUDIES', 'Business Studies', 'core', 11, 12, TRUE, FALSE, FALSE, FALSE, TRUE),
('ECONOMICS', 'Economics', 'core', 11, 12, TRUE, FALSE, FALSE, FALSE, TRUE),
('ENTREPRENEURSHIP', 'Entrepreneurship', 'elective', 11, 12, TRUE, FALSE, FALSE, TRUE, TRUE),

-- Humanities stream

('HISTORY', 'History', 'core', 11, 12, TRUE, FALSE, FALSE, FALSE, TRUE),
('GEOGRAPHY', 'Geography', 'core', 11, 12, TRUE, FALSE, FALSE, FALSE, TRUE),
('POLITICAL_SCIENCE', 'Political Science', 'core', 11, 12, TRUE, FALSE, FALSE, FALSE, TRUE),
('PSYCHOLOGY', 'Psychology', 'elective', 11, 12, TRUE, FALSE, FALSE, TRUE, TRUE),
('SOCIOLOGY', 'Sociology', 'elective', 11, 12, TRUE, FALSE, FALSE, TRUE, TRUE),

-- Language electives

('LANG_HINDI', 'Hindi', 'language', 11, 12, TRUE, TRUE, FALSE, TRUE, TRUE),
('LANG_MALAYALAM', 'Malayalam', 'language', 11, 12, TRUE, TRUE, FALSE, TRUE, TRUE),
('LANG_TAMIL', 'Tamil', 'language', 11, 12, TRUE, TRUE, FALSE, TRUE, TRUE),
('LANG_KANNADA', 'Kannada', 'language', 11, 12, TRUE, TRUE, FALSE, TRUE, TRUE),
('LANG_SANSKRIT', 'Sanskrit', 'language', 11, 12, TRUE, TRUE, FALSE, TRUE, TRUE),
('LANG_FRENCH', 'French', 'language', 11, 12, TRUE, TRUE, FALSE, TRUE, TRUE)

ON CONFLICT (subject_code) DO NOTHING;

-- =============================================================================
-- 7. SUBJECT → STREAM MAP
-- =============================================================================

-- SCIENCE

INSERT INTO public.subject_stream_map (
  subject_id,
  stream_id,
  is_mandatory,
  is_active
)
SELECT
  sub.id,
  ast.id,
  v.is_mandatory,
  TRUE
FROM public.academic_boards ab
JOIN public.academic_streams ast
  ON ast.board_id = ab.id
  AND ast.stream_code = 'SCIENCE'

CROSS JOIN (
  VALUES
    ('PHYSICS', TRUE),
    ('CHEMISTRY', TRUE),
    ('BIOLOGY', TRUE),
    ('MATHS_ADVANCED', TRUE),
    ('COMPUTER_SCIENCE', FALSE),
    ('ARTIFICIAL_INTELLIGENCE', FALSE),
    ('LANG_HINDI', FALSE),
    ('LANG_MALAYALAM', FALSE),
    ('LANG_FRENCH', FALSE)
) AS v(subject_code, is_mandatory)

JOIN public.academic_subjects sub
  ON sub.subject_code = v.subject_code

WHERE ab.board_code = 'CBSE'
ON CONFLICT (subject_id, stream_id) DO NOTHING;

-- COMMERCE

INSERT INTO public.subject_stream_map (
  subject_id,
  stream_id,
  is_mandatory,
  is_active
)
SELECT
  sub.id,
  ast.id,
  v.is_mandatory,
  TRUE
FROM public.academic_boards ab
JOIN public.academic_streams ast
  ON ast.board_id = ab.id
  AND ast.stream_code = 'COMMERCE'

CROSS JOIN (
  VALUES
    ('ACCOUNTANCY', TRUE),
    ('BUSINESS_STUDIES', TRUE),
    ('ECONOMICS', TRUE),
    ('ENTREPRENEURSHIP', FALSE),
    ('LANG_HINDI', FALSE),
    ('LANG_MALAYALAM', FALSE)
) AS v(subject_code, is_mandatory)

JOIN public.academic_subjects sub
  ON sub.subject_code = v.subject_code

WHERE ab.board_code = 'CBSE'
ON CONFLICT (subject_id, stream_id) DO NOTHING;

-- HUMANITIES

INSERT INTO public.subject_stream_map (
  subject_id,
  stream_id,
  is_mandatory,
  is_active
)
SELECT
  sub.id,
  ast.id,
  v.is_mandatory,
  TRUE
FROM public.academic_boards ab
JOIN public.academic_streams ast
  ON ast.board_id = ab.id
  AND ast.stream_code = 'HUMANITIES'

CROSS JOIN (
  VALUES
    ('HISTORY', TRUE),
    ('GEOGRAPHY', TRUE),
    ('POLITICAL_SCIENCE', TRUE),
    ('PSYCHOLOGY', FALSE),
    ('SOCIOLOGY', FALSE),
    ('LANG_HINDI', FALSE),
    ('LANG_MALAYALAM', FALSE)
) AS v(subject_code, is_mandatory)

JOIN public.academic_subjects sub
  ON sub.subject_code = v.subject_code

WHERE ab.board_code = 'CBSE'
ON CONFLICT (subject_id, stream_id) DO NOTHING;

-- =============================================================================
-- 8. STATE LANGUAGE MAPPINGS
-- =============================================================================

-- KERALA

INSERT INTO public.state_language_mapping (
  region_id,
  language_id,
  is_primary,
  is_common,
  is_optional,
  is_active
)
SELECT
  cr.id,
  lang.id,
  v.is_primary,
  v.is_common,
  v.is_optional,
  TRUE
FROM public.curriculum_regions cr

CROSS JOIN (
  VALUES
    ('ml', TRUE, TRUE, FALSE),
    ('en', FALSE, TRUE, FALSE),
    ('hi', FALSE, TRUE, FALSE),
    ('ar', FALSE, FALSE, TRUE),
    ('sa', FALSE, FALSE, TRUE)
) AS v(lang_code, is_primary, is_common, is_optional)

JOIN public.academic_languages lang
  ON lang.language_code = v.lang_code

WHERE cr.region_code = 'IN-KL'
ON CONFLICT (region_id, language_id) DO NOTHING;

-- TAMIL NADU

INSERT INTO public.state_language_mapping (
  region_id,
  language_id,
  is_primary,
  is_common,
  is_optional,
  is_active
)
SELECT
  cr.id,
  lang.id,
  v.is_primary,
  v.is_common,
  v.is_optional,
  TRUE
FROM public.curriculum_regions cr

CROSS JOIN (
  VALUES
    ('ta', TRUE, TRUE, FALSE),
    ('en', FALSE, TRUE, FALSE),
    ('hi', FALSE, FALSE, TRUE)
) AS v(lang_code, is_primary, is_common, is_optional)

JOIN public.academic_languages lang
  ON lang.language_code = v.lang_code

WHERE cr.region_code = 'IN-TN'
ON CONFLICT (region_id, language_id) DO NOTHING;

COMMIT;

-- =============================================================================
-- VERIFICATION
-- =============================================================================

SELECT count(*) AS countries_count FROM public.countries_master;
SELECT count(*) AS regions_count FROM public.curriculum_regions;
SELECT count(*) AS boards_count FROM public.academic_boards;
SELECT count(*) AS streams_count FROM public.academic_streams;
SELECT count(*) AS languages_count FROM public.academic_languages;
SELECT count(*) AS subjects_count FROM public.academic_subjects;
SELECT count(*) AS subject_stream_map_count FROM public.subject_stream_map;
SELECT count(*) AS state_language_mapping_count FROM public.state_language_mapping;

SELECT public.fn_academic_taxonomy_hash();