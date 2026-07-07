-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 1E — BOARD REGION MAP SEED (SAFE V1)
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. NATIONAL BOARDS → ALL AVAILABLE REGIONS
-- =============================================================================

INSERT INTO public.board_region_map (
  board_id,
  region_id,
  is_primary,
  is_active
)
SELECT
  ab.id,
  cr.id,
  FALSE,
  TRUE
FROM public.academic_boards ab
JOIN public.countries_master cm
  ON cm.id = ab.country_id
  AND cm.country_code = 'IN'

CROSS JOIN public.curriculum_regions cr

WHERE ab.board_code IN (
  'CBSE',
  'CISCE'
)
AND cr.country_id = cm.id
AND cr.is_active = TRUE
AND ab.is_active = TRUE

ON CONFLICT DO NOTHING;

-- =============================================================================
-- 2. INTERNATIONAL BOARDS → METRO REGIONS
-- =============================================================================

INSERT INTO public.board_region_map (
  board_id,
  region_id,
  is_primary,
  is_active
)
SELECT
  ab.id,
  cr.id,
  FALSE,
  TRUE
FROM public.academic_boards ab
JOIN public.countries_master cm
  ON cm.id = ab.country_id
  AND cm.country_code = 'IN'

JOIN public.curriculum_regions cr
  ON cr.country_id = cm.id

WHERE ab.board_code IN (
  'IB',
  'IGCSE'
)
AND cr.region_code IN (
  'IN-DL',
  'IN-MH',
  'IN-KA',
  'IN-TN',
  'IN-KL'
)
AND cr.is_active = TRUE
AND ab.is_active = TRUE

ON CONFLICT DO NOTHING;

-- =============================================================================
-- 3. STATE BOARDS → PRIMARY REGION
-- =============================================================================

INSERT INTO public.board_region_map (
  board_id,
  region_id,
  is_primary,
  is_active
)
SELECT
  ab.id,
  cr.id,
  TRUE,
  TRUE
FROM public.academic_boards ab
JOIN public.curriculum_regions cr
  ON cr.country_id = ab.country_id

JOIN (
  VALUES
    ('KL_SCERT', 'IN-KL')
) AS v(board_code, region_code)

  ON ab.board_code = v.board_code
 AND cr.region_code = v.region_code

WHERE ab.is_active = TRUE
AND cr.is_active = TRUE

ON CONFLICT DO NOTHING;

COMMIT;

-- =============================================================================
-- VERIFICATION
-- =============================================================================

SELECT count(*) AS board_region_map_count
FROM public.board_region_map;

SELECT
  ab.board_code,
  count(brm.id) AS region_count
FROM public.academic_boards ab
LEFT JOIN public.board_region_map brm
  ON brm.board_id = ab.id
 AND brm.is_active = TRUE
GROUP BY ab.board_code
ORDER BY region_count DESC;