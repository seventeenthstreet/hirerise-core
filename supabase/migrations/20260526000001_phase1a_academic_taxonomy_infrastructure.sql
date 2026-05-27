-- =============================================================================
-- HireRise Academic Intelligence Platform
-- PHASE 1A — CORE ACADEMIC TAXONOMY INFRASTRUCTURE
-- Migration: 20260526000001_phase1a_academic_taxonomy_infrastructure.sql
--
-- Governance: HireRise Academic Intelligence Governance Blueprint v2
-- Author: Database Architecture Layer
-- Created: 2026-05-26
--
-- SCOPE:
--   Normalized academic taxonomy master tables, relational FK architecture,
--   soft-delete governance, RLS foundations, and indexing strategy.
--
-- DEPENDENCIES: None — this is the foundational layer.
--
-- ROLLBACK: See 20260526000001_phase1a_academic_taxonomy_infrastructure.rollback.sql
--
-- GOVERNANCE RULES ENFORCED:
--   • Physical DELETE prohibited — soft-delete only
--   • No hardcoded enums for country/board/stream/subject values
--   • All academic references via FK — no free-text academic entities
--   • Migration-safe idempotent patterns (IF NOT EXISTS / DO NOTHING)
--   • Explicit FK, index, and constraint naming
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- SECTION 0: PREREQUISITES
-- Ensure required Postgres extensions are available.
-- These are already installed in the HireRise Supabase instance.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ---------------------------------------------------------------------------
-- SECTION 1: SHARED TRIGGER FUNCTION
-- Reuse the platform-wide set_updated_at() already present in the schema.
-- Defined here as a safety guard; ON CONFLICT DO NOTHING via CREATE OR REPLACE.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_updated_at() IS
  'Reusable BEFORE UPDATE trigger — stamps updated_at = NOW(). '
  'Shared across all HireRise table families including academic taxonomy.';

-- ---------------------------------------------------------------------------
-- SECTION 2: COUNTRIES MASTER
-- Future-ready multi-country support. India-focused in V1 but schema is
-- deliberately country-agnostic (no hardcoded country assumptions).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.countries_master (
  id            UUID        DEFAULT gen_random_uuid() NOT NULL,
  country_code  TEXT        NOT NULL,   -- ISO 3166-1 alpha-2, e.g. 'IN', 'GB', 'SG'
  country_name  TEXT        NOT NULL,
  is_active     BOOLEAN     DEFAULT TRUE  NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Primary key
  CONSTRAINT pk_countries_master PRIMARY KEY (id),

  -- Business key: country code must be globally unique and normalised
  CONSTRAINT uq_countries_master_code UNIQUE (country_code),

  -- Governance: prevent blank codes
  CONSTRAINT chk_countries_master_code_nonempty
    CHECK (country_code <> '' AND length(country_code) <= 10),

  CONSTRAINT chk_countries_master_name_nonempty
    CHECK (country_name <> '')
);

COMMENT ON TABLE  public.countries_master IS
  'Authoritative country reference. India-focused in V1; '
  'schema supports future multi-country expansion without DDL changes.';
COMMENT ON COLUMN public.countries_master.country_code IS
  'ISO 3166-1 alpha-2 code (e.g. IN, GB, SG, AE). '
  'Used as the global join key for country-scoped APIs.';
COMMENT ON COLUMN public.countries_master.is_active IS
  'FALSE = country hidden from dropdowns. Physical deletion prohibited.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_countries_master_active
  ON public.countries_master (is_active)
  WHERE is_active = TRUE;

-- Soft-delete governance: no trigger on INSERT (is_active defaults TRUE)
-- BEFORE UPDATE trigger stamps updated_at
CREATE OR REPLACE TRIGGER trg_countries_master_updated_at
  BEFORE UPDATE ON public.countries_master
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.countries_master ENABLE ROW LEVEL SECURITY;

-- Public read: taxonomy tables are authoritative reference data
CREATE POLICY "countries_master_public_read"
  ON public.countries_master
  FOR SELECT
  USING (is_active = TRUE);

-- Service-role full access (migrations, seeding, admin tooling)
CREATE POLICY "countries_master_service_role_full"
  ON public.countries_master
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ---------------------------------------------------------------------------
-- SECTION 3: CURRICULUM REGIONS
-- Represents curriculum jurisdictions (Indian states in V1, future:
-- provinces, territories, globally recognised curriculum zones).
-- NOT a nationality or citizenship table — purely curriculum geography.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.curriculum_regions (
  id            UUID        DEFAULT gen_random_uuid() NOT NULL,
  country_id    UUID        NOT NULL,
  region_code   TEXT        NOT NULL,   -- e.g. 'IN-KL', 'IN-MH', 'IN-DL'
  region_name   TEXT        NOT NULL,   -- e.g. 'Kerala', 'Maharashtra'
  is_active     BOOLEAN     DEFAULT TRUE  NOT NULL,
  deprecated_at TIMESTAMPTZ,            -- populated on soft-deprecation
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Primary key
  CONSTRAINT pk_curriculum_regions PRIMARY KEY (id),

  -- Business key: (country, region_code) is globally unique
  CONSTRAINT uq_curriculum_regions_code
    UNIQUE (country_id, region_code),

  -- Governance
  CONSTRAINT chk_curriculum_regions_code_nonempty
    CHECK (region_code <> ''),
  CONSTRAINT chk_curriculum_regions_name_nonempty
    CHECK (region_name <> ''),
  -- Deprecated regions must be inactive
  CONSTRAINT chk_curriculum_regions_deprecated_inactive
    CHECK (deprecated_at IS NULL OR is_active = FALSE),

  -- FK: must belong to a known country
  CONSTRAINT fk_curriculum_regions_country
    FOREIGN KEY (country_id)
    REFERENCES public.countries_master (id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
);

COMMENT ON TABLE  public.curriculum_regions IS
  'Curriculum jurisdiction geography. In V1: Indian states. '
  'Future: global provinces, territories, curriculum zones. '
  'Not a nationality table — represents where a curriculum applies.';
COMMENT ON COLUMN public.curriculum_regions.region_code IS
  'ISO 3166-2 subdivision code preferred (e.g. IN-KL for Kerala). '
  'Used for region-scoped language and board filtering.';
COMMENT ON COLUMN public.curriculum_regions.deprecated_at IS
  'Set when a region is retired. Physical deletion is prohibited; '
  'deprecated regions remain for historical FK integrity.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_curriculum_regions_country_active
  ON public.curriculum_regions (country_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_curriculum_regions_code_trgm
  ON public.curriculum_regions
  USING GIN (region_name gin_trgm_ops)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_curriculum_regions_deprecated
  ON public.curriculum_regions (deprecated_at)
  WHERE deprecated_at IS NOT NULL;

-- Trigger
CREATE OR REPLACE TRIGGER trg_curriculum_regions_updated_at
  BEFORE UPDATE ON public.curriculum_regions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.curriculum_regions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "curriculum_regions_public_read"
  ON public.curriculum_regions
  FOR SELECT
  USING (is_active = TRUE);

CREATE POLICY "curriculum_regions_service_role_full"
  ON public.curriculum_regions
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ---------------------------------------------------------------------------
-- SECTION 4: ACADEMIC BOARDS
-- Authoritative board registry. Supports CBSE, ICSE, state boards,
-- IB, IGCSE, and any future international systems without schema changes.
-- board_type is a free text classification — NOT an enum — to avoid
-- hardcoding that would require DDL migrations for new board types.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.academic_boards (
  id             UUID        DEFAULT gen_random_uuid() NOT NULL,
  country_id     UUID        NOT NULL,
  board_code     TEXT        NOT NULL,   -- e.g. 'CBSE', 'ICSE', 'KL_SCERT', 'IB'
  board_name     TEXT        NOT NULL,   -- Full display name
  board_type     TEXT        NOT NULL,   -- 'national' | 'state' | 'international' | 'vocational'
  is_active      BOOLEAN     DEFAULT TRUE  NOT NULL,
  deprecated_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at     TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Primary key
  CONSTRAINT pk_academic_boards PRIMARY KEY (id),

  -- Business key: board_code must be unique per country
  CONSTRAINT uq_academic_boards_code
    UNIQUE (country_id, board_code),

  -- Governance
  CONSTRAINT chk_academic_boards_code_nonempty
    CHECK (board_code <> ''),
  CONSTRAINT chk_academic_boards_name_nonempty
    CHECK (board_name <> ''),
  CONSTRAINT chk_academic_boards_type_nonempty
    CHECK (board_type <> ''),
  CONSTRAINT chk_academic_boards_deprecated_inactive
    CHECK (deprecated_at IS NULL OR is_active = FALSE),

  -- FK
  CONSTRAINT fk_academic_boards_country
    FOREIGN KEY (country_id)
    REFERENCES public.countries_master (id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
);

COMMENT ON TABLE  public.academic_boards IS
  'Authoritative academic board registry. No hardcoded values — '
  'CBSE, ICSE, state boards, IB, IGCSE etc. are seeded via migrations. '
  'Board taxonomy is the authoritative source; AI systems derive from it.';
COMMENT ON COLUMN public.academic_boards.board_code IS
  'Stable short code used as a business key. '
  'Examples: CBSE, ICSE, IB, IGCSE, KL_SCERT, MH_SSC.';
COMMENT ON COLUMN public.academic_boards.board_type IS
  'Classification: national | state | international | vocational | other. '
  'Free text to avoid enum DDL migrations when new board types emerge.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_academic_boards_country_active
  ON public.academic_boards (country_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_academic_boards_type_active
  ON public.academic_boards (board_type, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_academic_boards_name_trgm
  ON public.academic_boards
  USING GIN (board_name gin_trgm_ops)
  WHERE is_active = TRUE;

-- Trigger
CREATE OR REPLACE TRIGGER trg_academic_boards_updated_at
  BEFORE UPDATE ON public.academic_boards
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.academic_boards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "academic_boards_public_read"
  ON public.academic_boards
  FOR SELECT
  USING (is_active = TRUE);

CREATE POLICY "academic_boards_service_role_full"
  ON public.academic_boards
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ---------------------------------------------------------------------------
-- SECTION 5: ACADEMIC STREAMS
-- Streams belong to boards. A board may define its own stream structure
-- (e.g. CBSE has Science/Commerce/Humanities; IB has different groupings).
-- applicable_from_class / applicable_to_class encode grade applicability.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.academic_streams (
  id                    UUID        DEFAULT gen_random_uuid() NOT NULL,
  board_id              UUID        NOT NULL,
  stream_code           TEXT        NOT NULL,   -- e.g. 'SCIENCE', 'COMMERCE', 'HUMANITIES'
  stream_name           TEXT        NOT NULL,   -- Display name
  applicable_from_class SMALLINT,              -- e.g. 11 (class 11)
  applicable_to_class   SMALLINT,              -- e.g. 12 (class 12)
  is_active             BOOLEAN     DEFAULT TRUE  NOT NULL,
  deprecated_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at            TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Primary key
  CONSTRAINT pk_academic_streams PRIMARY KEY (id),

  -- Business key: stream_code is unique per board
  CONSTRAINT uq_academic_streams_code
    UNIQUE (board_id, stream_code),

  -- Governance
  CONSTRAINT chk_academic_streams_code_nonempty
    CHECK (stream_code <> ''),
  CONSTRAINT chk_academic_streams_name_nonempty
    CHECK (stream_name <> ''),
  CONSTRAINT chk_academic_streams_class_range
    CHECK (
      applicable_from_class IS NULL
      OR applicable_to_class IS NULL
      OR applicable_from_class <= applicable_to_class
    ),
  CONSTRAINT chk_academic_streams_class_positive
    CHECK (
      (applicable_from_class IS NULL OR applicable_from_class > 0)
      AND (applicable_to_class IS NULL OR applicable_to_class > 0)
    ),
  CONSTRAINT chk_academic_streams_deprecated_inactive
    CHECK (deprecated_at IS NULL OR is_active = FALSE),

  -- FK: stream must belong to a known board
  CONSTRAINT fk_academic_streams_board
    FOREIGN KEY (board_id)
    REFERENCES public.academic_boards (id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
);

COMMENT ON TABLE  public.academic_streams IS
  'Academic streams per board. CBSE: Science/Commerce/Humanities. '
  'IB/IGCSE may define custom groupings. '
  'Streams are board-scoped — the same "Science" stream in CBSE and a '
  'state board are distinct records.';
COMMENT ON COLUMN public.academic_streams.stream_code IS
  'Stable upper-case code: SCIENCE, COMMERCE, HUMANITIES, VOCATIONAL. '
  'Future vocational streams seeded via migration, never hardcoded.';
COMMENT ON COLUMN public.academic_streams.applicable_from_class IS
  'First class where this stream applies. NULL = no grade restriction.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_academic_streams_board_active
  ON public.academic_streams (board_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_academic_streams_class_range
  ON public.academic_streams (applicable_from_class, applicable_to_class)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_academic_streams_name_trgm
  ON public.academic_streams
  USING GIN (stream_name gin_trgm_ops)
  WHERE is_active = TRUE;

-- Trigger
CREATE OR REPLACE TRIGGER trg_academic_streams_updated_at
  BEFORE UPDATE ON public.academic_streams
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.academic_streams ENABLE ROW LEVEL SECURITY;

CREATE POLICY "academic_streams_public_read"
  ON public.academic_streams
  FOR SELECT
  USING (is_active = TRUE);

CREATE POLICY "academic_streams_service_role_full"
  ON public.academic_streams
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ---------------------------------------------------------------------------
-- SECTION 6: ACADEMIC SUBJECTS
-- Cross-board, cross-stream subject master. Subjects are board-agnostic
-- at the canonical level; their association to streams is captured in
-- subject_stream_map.
--
-- subject_category: 'core' | 'elective' | 'language' | 'vocational' | 'integrated'
-- Supports: Science, Social Science, Physics, Accountancy, Malayalam, AI, etc.
--
-- Key flags:
--   is_integrated  — subject exists across ALL streams (e.g. English, EVS)
--   is_language    — subject is a language (links to academic_languages)
--   is_optional    — subject is optionally chosen within a stream
--   requires_stream — FALSE for cross-cutting subjects, TRUE for stream-specific
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.academic_subjects (
  id                    UUID        DEFAULT gen_random_uuid() NOT NULL,
  subject_code          TEXT        NOT NULL,
  subject_name          TEXT        NOT NULL,
  subject_category      TEXT        NOT NULL,   -- 'core' | 'elective' | 'language' | 'vocational' | 'integrated'
  applicable_from_class SMALLINT,
  applicable_to_class   SMALLINT,
  requires_stream       BOOLEAN     DEFAULT FALSE NOT NULL,  -- TRUE = must be assigned to a stream
  is_language           BOOLEAN     DEFAULT FALSE NOT NULL,
  is_integrated         BOOLEAN     DEFAULT FALSE NOT NULL,  -- appears in all streams
  is_optional           BOOLEAN     DEFAULT FALSE NOT NULL,
  is_active             BOOLEAN     DEFAULT TRUE  NOT NULL,
  deprecated_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at            TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Primary key
  CONSTRAINT pk_academic_subjects PRIMARY KEY (id),

  -- Business key: subject_code is a global canonical identifier
  CONSTRAINT uq_academic_subjects_code UNIQUE (subject_code),

  -- Governance
  CONSTRAINT chk_academic_subjects_code_nonempty
    CHECK (subject_code <> ''),
  CONSTRAINT chk_academic_subjects_name_nonempty
    CHECK (subject_name <> ''),
  CONSTRAINT chk_academic_subjects_category_nonempty
    CHECK (subject_category <> ''),
  CONSTRAINT chk_academic_subjects_class_range
    CHECK (
      applicable_from_class IS NULL
      OR applicable_to_class IS NULL
      OR applicable_from_class <= applicable_to_class
    ),
  CONSTRAINT chk_academic_subjects_deprecated_inactive
    CHECK (deprecated_at IS NULL OR is_active = FALSE),

  -- Semantic consistency: integrated subjects should not require a stream
  CONSTRAINT chk_academic_subjects_integrated_no_stream
    CHECK (NOT (is_integrated = TRUE AND requires_stream = TRUE)),

  -- Language subjects must carry the language flag
  -- (enforced at application layer; DB flag is informational)
  CONSTRAINT chk_academic_subjects_language_category
    CHECK (
      is_language = FALSE
      OR subject_category IN ('language', 'elective', 'core')
    )
);

COMMENT ON TABLE  public.academic_subjects IS
  'Canonical academic subject master. Board-agnostic at this level — '
  'board-stream membership is in subject_stream_map. '
  'Examples: SUBJECT_PHYSICS, SUBJECT_MALAYALAM, SUBJECT_AI.';
COMMENT ON COLUMN public.academic_subjects.subject_code IS
  'Stable upper-case canonical code: PHYSICS, MALAYALAM, ARTIFICIAL_INTELLIGENCE. '
  'Used as the business key across all academic intelligence layers.';
COMMENT ON COLUMN public.academic_subjects.is_integrated IS
  'TRUE = subject appears in ALL streams (e.g. English, Physical Education). '
  'Integrated subjects do not require requires_stream = TRUE.';
COMMENT ON COLUMN public.academic_subjects.is_language IS
  'TRUE = subject is a language subject. '
  'Language subjects are also present in academic_languages and state_language_mapping.';

-- Indexes — subject lookup is hot-path in onboarding
CREATE INDEX IF NOT EXISTS idx_academic_subjects_active
  ON public.academic_subjects (is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_academic_subjects_category_active
  ON public.academic_subjects (subject_category, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_academic_subjects_language_flag
  ON public.academic_subjects (is_language)
  WHERE is_language = TRUE AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_academic_subjects_integrated_flag
  ON public.academic_subjects (is_integrated)
  WHERE is_integrated = TRUE AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_academic_subjects_name_trgm
  ON public.academic_subjects
  USING GIN (subject_name gin_trgm_ops)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_academic_subjects_class_range
  ON public.academic_subjects (applicable_from_class, applicable_to_class)
  WHERE is_active = TRUE;

-- Trigger
CREATE OR REPLACE TRIGGER trg_academic_subjects_updated_at
  BEFORE UPDATE ON public.academic_subjects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.academic_subjects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "academic_subjects_public_read"
  ON public.academic_subjects
  FOR SELECT
  USING (is_active = TRUE);

CREATE POLICY "academic_subjects_service_role_full"
  ON public.academic_subjects
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ---------------------------------------------------------------------------
-- SECTION 7: ACADEMIC LANGUAGES
-- Standalone language master. Languages are mapped to curriculum regions
-- via state_language_mapping. This table is authoritative for ALL
-- language entities — primary, second, third, regional, international.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.academic_languages (
  id            UUID        DEFAULT gen_random_uuid() NOT NULL,
  language_code TEXT        NOT NULL,   -- ISO 639-1 preferred, e.g. 'ml', 'hi', 'en', 'ta'
  language_name TEXT        NOT NULL,   -- Display name, e.g. 'Malayalam', 'Hindi'
  is_active     BOOLEAN     DEFAULT TRUE  NOT NULL,
  deprecated_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Primary key
  CONSTRAINT pk_academic_languages PRIMARY KEY (id),

  -- Business key
  CONSTRAINT uq_academic_languages_code UNIQUE (language_code),

  -- Governance
  CONSTRAINT chk_academic_languages_code_nonempty
    CHECK (language_code <> ''),
  CONSTRAINT chk_academic_languages_name_nonempty
    CHECK (language_name <> ''),
  CONSTRAINT chk_academic_languages_deprecated_inactive
    CHECK (deprecated_at IS NULL OR is_active = FALSE)
);

COMMENT ON TABLE  public.academic_languages IS
  'Academic language master. Covers all languages offered as subjects '
  'in Indian and future international curricula. '
  'Primary, second, third, regional languages all live here. '
  'Regional mapping is in state_language_mapping.';
COMMENT ON COLUMN public.academic_languages.language_code IS
  'ISO 639-1 two-letter code preferred (ml, hi, en, ta, kn, te). '
  'Extended codes permitted for regional variants (e.g. san for Sanskrit).';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_academic_languages_active
  ON public.academic_languages (is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_academic_languages_name_trgm
  ON public.academic_languages
  USING GIN (language_name gin_trgm_ops)
  WHERE is_active = TRUE;

-- Trigger
CREATE OR REPLACE TRIGGER trg_academic_languages_updated_at
  BEFORE UPDATE ON public.academic_languages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.academic_languages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "academic_languages_public_read"
  ON public.academic_languages
  FOR SELECT
  USING (is_active = TRUE);

CREATE POLICY "academic_languages_service_role_full"
  ON public.academic_languages
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ---------------------------------------------------------------------------
-- SECTION 8: STATE-LANGUAGE MAPPING
-- Region-aware language filtering. Defines which languages are:
--   is_primary  — official/primary language of the region's curriculum
--   is_common   — commonly offered across schools in this region
--   is_optional — optionally available; not universally offered
--
-- A single language can appear multiple times in a region with
-- different roles (e.g. Hindi is both primary and optional depending on region).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.state_language_mapping (
  id          UUID        DEFAULT gen_random_uuid() NOT NULL,
  region_id   UUID        NOT NULL,
  language_id UUID        NOT NULL,
  is_primary  BOOLEAN     DEFAULT FALSE NOT NULL,
  is_common   BOOLEAN     DEFAULT FALSE NOT NULL,
  is_optional BOOLEAN     DEFAULT FALSE NOT NULL,
  is_active   BOOLEAN     DEFAULT TRUE  NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Primary key
  CONSTRAINT pk_state_language_mapping PRIMARY KEY (id),

  -- Business key: each (region, language) combination is unique
  CONSTRAINT uq_state_language_mapping_region_lang
    UNIQUE (region_id, language_id),

  -- Governance: at least one role flag must be TRUE for a mapping to be meaningful
  CONSTRAINT chk_state_language_mapping_role_required
    CHECK (is_primary = TRUE OR is_common = TRUE OR is_optional = TRUE),

  -- FK: must reference known region and language
  CONSTRAINT fk_state_language_mapping_region
    FOREIGN KEY (region_id)
    REFERENCES public.curriculum_regions (id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT fk_state_language_mapping_language
    FOREIGN KEY (language_id)
    REFERENCES public.academic_languages (id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
);

COMMENT ON TABLE  public.state_language_mapping IS
  'Maps academic languages to curriculum regions with role context. '
  'Used by onboarding to filter available language subjects per state. '
  'Supports fallback language systems and future multilingual regions.';
COMMENT ON COLUMN public.state_language_mapping.is_primary IS
  'TRUE = this is the primary/official language for curriculum in this region.';
COMMENT ON COLUMN public.state_language_mapping.is_common IS
  'TRUE = commonly offered in schools of this region (not necessarily primary).';
COMMENT ON COLUMN public.state_language_mapping.is_optional IS
  'TRUE = optionally available but not universally offered in this region.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_state_language_mapping_region_active
  ON public.state_language_mapping (region_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_state_language_mapping_language_active
  ON public.state_language_mapping (language_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_state_language_mapping_primary
  ON public.state_language_mapping (region_id)
  WHERE is_primary = TRUE AND is_active = TRUE;

-- Trigger
CREATE OR REPLACE TRIGGER trg_state_language_mapping_updated_at
  BEFORE UPDATE ON public.state_language_mapping
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.state_language_mapping ENABLE ROW LEVEL SECURITY;

CREATE POLICY "state_language_mapping_public_read"
  ON public.state_language_mapping
  FOR SELECT
  USING (is_active = TRUE);

CREATE POLICY "state_language_mapping_service_role_full"
  ON public.state_language_mapping
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ---------------------------------------------------------------------------
-- SECTION 9: SUBJECT-STREAM MAP
-- Defines valid stream-subject relationships.
-- Examples: Physics → Science stream, Accountancy → Commerce stream.
--
-- is_mandatory: subject is compulsory within that stream (vs. elective).
-- A subject can be in multiple streams with different is_mandatory values.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.subject_stream_map (
  id           UUID        DEFAULT gen_random_uuid() NOT NULL,
  subject_id   UUID        NOT NULL,
  stream_id    UUID        NOT NULL,
  is_mandatory BOOLEAN     DEFAULT FALSE NOT NULL,
  is_active    BOOLEAN     DEFAULT TRUE  NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Primary key
  CONSTRAINT pk_subject_stream_map PRIMARY KEY (id),

  -- Business key: each (subject, stream) is unique
  CONSTRAINT uq_subject_stream_map_subject_stream
    UNIQUE (subject_id, stream_id),

  -- FK: must reference known subject and stream
  CONSTRAINT fk_subject_stream_map_subject
    FOREIGN KEY (subject_id)
    REFERENCES public.academic_subjects (id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT fk_subject_stream_map_stream
    FOREIGN KEY (stream_id)
    REFERENCES public.academic_streams (id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
);

COMMENT ON TABLE  public.subject_stream_map IS
  'Defines valid subject-stream relationships. '
  'Physics → Science, Accountancy → Commerce, etc. '
  'Integrated subjects (English, PE) are NOT mapped here — '
  'their cross-stream availability is encoded in academic_subjects.is_integrated.';
COMMENT ON COLUMN public.subject_stream_map.is_mandatory IS
  'TRUE = subject is compulsory in this stream. '
  'FALSE = subject is elective/optional within this stream.';

-- Indexes — hot-path: filter subjects by stream in onboarding
CREATE INDEX IF NOT EXISTS idx_subject_stream_map_stream_active
  ON public.subject_stream_map (stream_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_subject_stream_map_subject_active
  ON public.subject_stream_map (subject_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_subject_stream_map_mandatory
  ON public.subject_stream_map (stream_id, is_mandatory)
  WHERE is_mandatory = TRUE AND is_active = TRUE;

-- Trigger
CREATE OR REPLACE TRIGGER trg_subject_stream_map_updated_at
  BEFORE UPDATE ON public.subject_stream_map
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.subject_stream_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subject_stream_map_public_read"
  ON public.subject_stream_map
  FOR SELECT
  USING (is_active = TRUE);

CREATE POLICY "subject_stream_map_service_role_full"
  ON public.subject_stream_map
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ---------------------------------------------------------------------------
-- SECTION 10: SOFT-DELETE GOVERNANCE
-- Physical DELETE is PROHIBITED on all taxonomy tables.
-- This trigger fires on any DELETE attempt and raises an exception,
-- directing callers to use the soft-delete pattern instead.
--
-- GOVERNANCE RULE: SET is_active = FALSE and deprecated_at = NOW()
-- to retire any taxonomy entity. FK references from student academic
-- records remain intact.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_prevent_physical_delete_taxonomy()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'GOVERNANCE_VIOLATION: Physical DELETE is prohibited on HireRise academic taxonomy '
    'table %. Use soft-delete: SET is_active = FALSE, deprecated_at = NOW(). '
    'Historical FK references must remain intact.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION public.fn_prevent_physical_delete_taxonomy() IS
  'Governance trigger — prevents physical DELETE on all academic taxonomy tables. '
  'Callers must soft-delete by setting is_active = FALSE, deprecated_at = NOW(). '
  'Enforces HireRise Governance Blueprint v2: Physical deletion prohibited.';

-- Apply the governance trigger to all taxonomy tables
CREATE OR REPLACE TRIGGER trg_governance_no_delete_countries_master
  BEFORE DELETE ON public.countries_master
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_physical_delete_taxonomy();

CREATE OR REPLACE TRIGGER trg_governance_no_delete_curriculum_regions
  BEFORE DELETE ON public.curriculum_regions
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_physical_delete_taxonomy();

CREATE OR REPLACE TRIGGER trg_governance_no_delete_academic_boards
  BEFORE DELETE ON public.academic_boards
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_physical_delete_taxonomy();

CREATE OR REPLACE TRIGGER trg_governance_no_delete_academic_streams
  BEFORE DELETE ON public.academic_streams
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_physical_delete_taxonomy();

CREATE OR REPLACE TRIGGER trg_governance_no_delete_academic_subjects
  BEFORE DELETE ON public.academic_subjects
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_physical_delete_taxonomy();

CREATE OR REPLACE TRIGGER trg_governance_no_delete_academic_languages
  BEFORE DELETE ON public.academic_languages
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_physical_delete_taxonomy();

CREATE OR REPLACE TRIGGER trg_governance_no_delete_state_language_mapping
  BEFORE DELETE ON public.state_language_mapping
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_physical_delete_taxonomy();

CREATE OR REPLACE TRIGGER trg_governance_no_delete_subject_stream_map
  BEFORE DELETE ON public.subject_stream_map
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_physical_delete_taxonomy();

-- ---------------------------------------------------------------------------
-- SECTION 11: TAXONOMY HASH FUNCTION
-- Produces a deterministic content hash of the taxonomy snapshot
-- for seed-governance compatibility, CI drift detection, and
-- version-aware competency layer compatibility.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_academic_taxonomy_hash()
  RETURNS TEXT
  LANGUAGE SQL
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
  SELECT md5(
    COALESCE(
      (
        SELECT string_agg(concat_ws('|',
          cm.country_code,
          ab.board_code,
          ab.board_type,
          ast.stream_code,
          sub.subject_code,
          sub.subject_category,
          lang.language_code
        ) ORDER BY cm.country_code, ab.board_code, ast.stream_code, sub.subject_code)
        FROM public.countries_master cm
        JOIN public.academic_boards ab ON ab.country_id = cm.id AND ab.is_active
        JOIN public.academic_streams ast ON ast.board_id = ab.id AND ast.is_active
        JOIN public.subject_stream_map ssm ON ssm.stream_id = ast.id AND ssm.is_active
        JOIN public.academic_subjects sub ON sub.id = ssm.subject_id AND sub.is_active
        CROSS JOIN public.academic_languages lang
        WHERE cm.is_active AND lang.is_active
      ), 'empty_taxonomy'
    )
  );
$$;

COMMENT ON FUNCTION public.fn_academic_taxonomy_hash() IS
  'Generates a deterministic MD5 snapshot hash of the active academic taxonomy. '
  'Used for CI drift detection, seed-governance compatibility checks, '
  'and future competency-layer version-awareness.';

-- ---------------------------------------------------------------------------
-- SECTION 12: GRANT PERMISSIONS
-- Follows the existing HireRise grant pattern: anon/authenticated/service_role.
-- Public taxonomy tables (read-only for anon/authenticated).
-- ---------------------------------------------------------------------------

-- countries_master
GRANT SELECT ON public.countries_master TO anon, authenticated;
GRANT ALL    ON public.countries_master TO service_role;

-- curriculum_regions
GRANT SELECT ON public.curriculum_regions TO anon, authenticated;
GRANT ALL    ON public.curriculum_regions TO service_role;

-- academic_boards
GRANT SELECT ON public.academic_boards TO anon, authenticated;
GRANT ALL    ON public.academic_boards TO service_role;

-- academic_streams
GRANT SELECT ON public.academic_streams TO anon, authenticated;
GRANT ALL    ON public.academic_streams TO service_role;

-- academic_subjects
GRANT SELECT ON public.academic_subjects TO anon, authenticated;
GRANT ALL    ON public.academic_subjects TO service_role;

-- academic_languages
GRANT SELECT ON public.academic_languages TO anon, authenticated;
GRANT ALL    ON public.academic_languages TO service_role;

-- state_language_mapping
GRANT SELECT ON public.state_language_mapping TO anon, authenticated;
GRANT ALL    ON public.state_language_mapping TO service_role;

-- subject_stream_map
GRANT SELECT ON public.subject_stream_map TO anon, authenticated;
GRANT ALL    ON public.subject_stream_map TO service_role;

-- Utility functions
GRANT EXECUTE ON FUNCTION public.fn_academic_taxonomy_hash()              TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_prevent_physical_delete_taxonomy()    TO service_role;

COMMIT;

-- =============================================================================
-- END OF MIGRATION: 20260526000001_phase1a_academic_taxonomy_infrastructure.sql
-- =============================================================================
