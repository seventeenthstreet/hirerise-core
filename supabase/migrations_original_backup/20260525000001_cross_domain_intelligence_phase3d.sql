-- =============================================================================
-- HireRise Phase 3D — Cross-Domain Intelligence Layer
-- Migration: 20260525000001_cross_domain_intelligence_phase3d.sql
--
-- PRODUCTION-READY VERSION
-- Compatible with Supabase migrations
-- =============================================================================

-- =============================================================================
-- EXTENSIONS
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- GLOBAL UPDATED_AT TRIGGER FUNCTION
-- =============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- =============================================================================
-- SIGNAL KEY VALIDATION FUNCTION
-- =============================================================================

CREATE OR REPLACE FUNCTION validate_signal_key_exists()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM intelligence_signal_registry
    WHERE signal_key = NEW.signal_key
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Invalid signal_key: %', NEW.signal_key;
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE intelligence_domain_enum AS ENUM (
  'academic',
  'activity',
  'cognitive',
  'cross_domain'
);

CREATE TYPE signal_category_enum AS ENUM (
  'reasoning',
  'creative',
  'social',
  'technical',
  'cognitive_style',
  'subject_affinity',
  'behavioral',
  'meta'
);

CREATE TYPE evidence_source_enum AS ENUM (
  'explicit_response',
  'activity_record',
  'achievement_record',
  'subject_performance',
  'cross_domain_merge',
  'reflection_entry'
);

CREATE TYPE signal_relationship_type_enum AS ENUM (
  'reinforces',
  'contradicts',
  'subsumes',
  'correlates'
);

CREATE TYPE contradiction_severity_enum AS ENUM (
  'none',
  'weak',
  'moderate',
  'strong'
);

CREATE TYPE aggregation_version_enum AS ENUM (
  'v1'
);

CREATE TYPE taxonomy_version_enum AS ENUM (
  'v1'
);

CREATE TYPE signal_version_enum AS ENUM (
  'v1'
);

-- =============================================================================
-- TABLE 1: intelligence_signal_registry
-- =============================================================================

CREATE TABLE IF NOT EXISTS intelligence_signal_registry (

  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  signal_key                  text NOT NULL,

  taxonomy_version            taxonomy_version_enum NOT NULL DEFAULT 'v1',

  category                    signal_category_enum NOT NULL,

  primary_domain              intelligence_domain_enum NOT NULL,

  compatible_domains          intelligence_domain_enum[] NOT NULL DEFAULT '{}',

  normalization_strategy      text NOT NULL DEFAULT 'weighted_average',

  aggregation_compatible      boolean NOT NULL DEFAULT true,

  engine_compatible           boolean NOT NULL DEFAULT true,

  longitudinal_trackable      boolean NOT NULL DEFAULT true,

  display_name                text NOT NULL,

  description                 text,

  signal_version              signal_version_enum NOT NULL DEFAULT 'v1',

  deprecated_at               timestamptz DEFAULT NULL,

  created_at                  timestamptz NOT NULL DEFAULT now(),

  updated_at                  timestamptz NOT NULL DEFAULT now(),

  deleted_at                  timestamptz DEFAULT NULL,

  CONSTRAINT uq_signal_registry_key_version
    UNIQUE (signal_key, taxonomy_version),

  CONSTRAINT chk_normalization_strategy
    CHECK (
      normalization_strategy IN (
        'weighted_average',
        'max_pooling',
        'min_pooling',
        'evidence_count'
      )
    ),

  CONSTRAINT chk_signal_key_format
    CHECK (
      signal_key ~ '^[a-z][a-z0-9_]{1,63}$'
    )
);

-- =============================================================================
-- TABLE 2: student_signal_vectors
-- =============================================================================

CREATE TABLE IF NOT EXISTS student_signal_vectors (

  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id                     uuid NOT NULL
    REFERENCES auth.users(id)
    ON DELETE CASCADE,

  aggregation_version         aggregation_version_enum NOT NULL DEFAULT 'v1',

  signal_weights              jsonb NOT NULL DEFAULT '{}',

  domain_vectors              jsonb NOT NULL DEFAULT '{}',

  evidence_summary            jsonb NOT NULL DEFAULT '{}',

  confidence_data             jsonb NOT NULL DEFAULT '{}',

  contradiction_metadata      jsonb NOT NULL DEFAULT '{}',

  pipeline_run_id             text DEFAULT NULL,

  domains_included            intelligence_domain_enum[] NOT NULL DEFAULT '{}',

  is_complete_vector          boolean NOT NULL DEFAULT false,

  aggregated_at               timestamptz NOT NULL DEFAULT now(),

  created_at                  timestamptz NOT NULL DEFAULT now(),

  updated_at                  timestamptz NOT NULL DEFAULT now(),

  deleted_at                  timestamptz DEFAULT NULL,

  CONSTRAINT chk_signal_weights_object
    CHECK (jsonb_typeof(signal_weights) = 'object'),

  CONSTRAINT chk_domain_vectors_object
    CHECK (jsonb_typeof(domain_vectors) = 'object'),

  CONSTRAINT chk_evidence_summary_object
    CHECK (jsonb_typeof(evidence_summary) = 'object'),

  CONSTRAINT chk_confidence_data_object
    CHECK (jsonb_typeof(confidence_data) = 'object'),

  CONSTRAINT chk_contradiction_metadata_object
    CHECK (jsonb_typeof(contradiction_metadata) = 'object'),

  CONSTRAINT uq_student_vector_user_version
    UNIQUE (user_id, aggregation_version)
);

-- =============================================================================
-- TABLE 3: student_signal_evidence
-- =============================================================================

CREATE TABLE IF NOT EXISTS student_signal_evidence (

  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id                     uuid NOT NULL
    REFERENCES auth.users(id)
    ON DELETE CASCADE,

  signal_key                  text NOT NULL,

  source_type                 evidence_source_enum NOT NULL,

  source_domain               intelligence_domain_enum NOT NULL,

  source_reference_id         text NOT NULL,

  source_reference_table      text DEFAULT NULL,

  contribution_weight         numeric(5,4) NOT NULL DEFAULT 0.0,

  raw_confidence              numeric(5,4) DEFAULT NULL,

  evidence_metadata           jsonb NOT NULL DEFAULT '{}',

  taxonomy_version            taxonomy_version_enum NOT NULL DEFAULT 'v1',

  aggregation_version         aggregation_version_enum NOT NULL DEFAULT 'v1',

  recorded_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_contribution_weight_range
    CHECK (
      contribution_weight >= 0.0
      AND contribution_weight <= 1.0
    ),

  CONSTRAINT chk_raw_confidence_range
    CHECK (
      raw_confidence IS NULL
      OR (
        raw_confidence >= 0.0
        AND raw_confidence <= 1.0
      )
    ),

  CONSTRAINT chk_signal_key_evidence_format
    CHECK (
      signal_key ~ '^[a-z][a-z0-9_]{1,63}$'
    ),

  CONSTRAINT chk_evidence_metadata_object
    CHECK (
      jsonb_typeof(evidence_metadata) = 'object'
    )
);

-- =============================================================================
-- TABLE 4: signal_relationships
-- =============================================================================

CREATE TABLE IF NOT EXISTS signal_relationships (

  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  signal_key_a                text NOT NULL,

  signal_key_b                text NOT NULL,

  relationship_type           signal_relationship_type_enum NOT NULL,

  relationship_weight         numeric(5,4) NOT NULL DEFAULT 1.0,

  taxonomy_version            taxonomy_version_enum NOT NULL DEFAULT 'v1',

  rationale                   text DEFAULT NULL,

  created_at                  timestamptz NOT NULL DEFAULT now(),

  updated_at                  timestamptz NOT NULL DEFAULT now(),

  deleted_at                  timestamptz DEFAULT NULL,

  CONSTRAINT uq_signal_relationship
    UNIQUE (
      signal_key_a,
      signal_key_b,
      relationship_type,
      taxonomy_version
    ),

  CONSTRAINT chk_no_self_relationship
    CHECK (
      signal_key_a <> signal_key_b
    ),

  CONSTRAINT chk_relationship_weight_range
    CHECK (
      relationship_weight > 0.0
      AND relationship_weight <= 1.0
    )
);

-- =============================================================================
-- TABLE 5: signal_confidence_models
-- =============================================================================

CREATE TABLE IF NOT EXISTS signal_confidence_models (

  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id                         uuid NOT NULL
    REFERENCES auth.users(id)
    ON DELETE CASCADE,

  signal_key                      text NOT NULL,

  aggregation_version             aggregation_version_enum NOT NULL DEFAULT 'v1',

  evidence_count                  integer NOT NULL DEFAULT 0,

  source_diversity                numeric(5,4) NOT NULL DEFAULT 0.0,

  cross_domain_reinforcement      boolean NOT NULL DEFAULT false,

  contradiction_severity          contradiction_severity_enum NOT NULL DEFAULT 'none',

  composite_confidence            numeric(5,4) DEFAULT NULL,

  first_evidence_at               timestamptz DEFAULT NULL,

  last_evidence_at                timestamptz DEFAULT NULL,

  evidence_delta_30d              integer DEFAULT 0,

  computed_at                     timestamptz NOT NULL DEFAULT now(),

  created_at                      timestamptz NOT NULL DEFAULT now(),

  updated_at                      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_confidence_model_user_signal_version
    UNIQUE (
      user_id,
      signal_key,
      aggregation_version
    ),

  CONSTRAINT chk_evidence_count_non_negative
    CHECK (
      evidence_count >= 0
    ),

  CONSTRAINT chk_source_diversity_range
    CHECK (
      source_diversity >= 0.0
      AND source_diversity <= 1.0
    ),

  CONSTRAINT chk_composite_confidence_range
    CHECK (
      composite_confidence IS NULL
      OR (
        composite_confidence >= 0.0
        AND composite_confidence <= 1.0
      )
    )
);

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_signal_registry_key
ON intelligence_signal_registry (signal_key)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_signal_registry_category
ON intelligence_signal_registry (category)
WHERE deleted_at IS NULL
AND deprecated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_signal_registry_domain
ON intelligence_signal_registry (primary_domain)
WHERE deleted_at IS NULL
AND deprecated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_student_signal_vectors_user
ON student_signal_vectors (user_id)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_student_signal_vectors_aggregated
ON student_signal_vectors (aggregated_at DESC)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_student_signal_vectors_weights_gin
ON student_signal_vectors
USING GIN (signal_weights jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_signal_evidence_user_signal
ON student_signal_evidence (user_id, signal_key);

CREATE INDEX IF NOT EXISTS idx_signal_evidence_user_domain
ON student_signal_evidence (user_id, source_domain);

CREATE INDEX IF NOT EXISTS idx_signal_evidence_source_ref
ON student_signal_evidence (source_reference_id);

CREATE INDEX IF NOT EXISTS idx_signal_evidence_recorded
ON student_signal_evidence (recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_relationships_a
ON signal_relationships (signal_key_a)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_signal_relationships_b
ON signal_relationships (signal_key_b)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_signal_relationships_type
ON signal_relationships (relationship_type)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_confidence_models_user
ON signal_confidence_models (user_id);

CREATE INDEX IF NOT EXISTS idx_confidence_models_user_signal
ON signal_confidence_models (user_id, signal_key);

CREATE INDEX IF NOT EXISTS idx_confidence_models_cross_domain
ON signal_confidence_models (user_id)
WHERE cross_domain_reinforcement = true;

-- =============================================================================
-- ENABLE RLS
-- =============================================================================

ALTER TABLE intelligence_signal_registry ENABLE ROW LEVEL SECURITY;

ALTER TABLE student_signal_vectors ENABLE ROW LEVEL SECURITY;

ALTER TABLE student_signal_evidence ENABLE ROW LEVEL SECURITY;

ALTER TABLE signal_relationships ENABLE ROW LEVEL SECURITY;

ALTER TABLE signal_confidence_models ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- POLICIES
-- =============================================================================

CREATE POLICY "registry_read_authenticated"
ON intelligence_signal_registry
FOR SELECT
TO authenticated
USING (deleted_at IS NULL);

CREATE POLICY "registry_write_service_only"
ON intelligence_signal_registry
FOR ALL
TO service_role
USING (deleted_at IS NULL)
WITH CHECK (true);

CREATE POLICY "vectors_owner_read"
ON student_signal_vectors
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  AND deleted_at IS NULL
);

CREATE POLICY "vectors_service_write"
ON student_signal_vectors
FOR ALL
TO service_role
USING (deleted_at IS NULL)
WITH CHECK (true);

CREATE POLICY "evidence_owner_read"
ON student_signal_evidence
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
);

CREATE POLICY "evidence_service_write"
ON student_signal_evidence
FOR INSERT
TO service_role
WITH CHECK (true);

CREATE POLICY "relationships_read_authenticated"
ON signal_relationships
FOR SELECT
TO authenticated
USING (deleted_at IS NULL);

CREATE POLICY "relationships_write_service_only"
ON signal_relationships
FOR ALL
TO service_role
USING (deleted_at IS NULL)
WITH CHECK (true);

CREATE POLICY "confidence_owner_read"
ON signal_confidence_models
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
);

CREATE POLICY "confidence_service_write"
ON signal_confidence_models
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- =============================================================================
-- TRIGGERS
-- =============================================================================

CREATE TRIGGER trg_signal_registry_updated_at
BEFORE UPDATE ON intelligence_signal_registry
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_student_signal_vectors_updated_at
BEFORE UPDATE ON student_signal_vectors
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_signal_relationships_updated_at
BEFORE UPDATE ON signal_relationships
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_signal_confidence_models_updated_at
BEFORE UPDATE ON signal_confidence_models
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_validate_signal_key_evidence
BEFORE INSERT ON student_signal_evidence
FOR EACH ROW
EXECUTE FUNCTION validate_signal_key_exists();

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON TABLE intelligence_signal_registry
IS 'Phase 3D: Canonical signal definitions';

COMMENT ON TABLE student_signal_vectors
IS 'Phase 3D: Cross-domain aggregated signal state';

COMMENT ON TABLE student_signal_evidence
IS 'Phase 3D: Immutable evidence log';

COMMENT ON TABLE signal_relationships
IS 'Phase 3D: Structural signal relationships';

COMMENT ON TABLE signal_confidence_models
IS 'Phase 3D: Confidence tracking models';

-- =============================================================================
-- IMPORTANT
-- =============================================================================
-- AFTER THIS:
--
-- 1. ADD YOUR EXISTING SEED INSERTS
--    (registry + relationships)
--
-- 2. RUN:
--
--    supabase db push
--
-- 3. VERIFY TABLES
--
-- =============================================================================
-- =============================================================================
-- SEED: intelligence_signal_registry
-- =============================================================================

INSERT INTO intelligence_signal_registry
(
  signal_key,
  taxonomy_version,
  category,
  primary_domain,
  compatible_domains,
  normalization_strategy,
  aggregation_compatible,
  engine_compatible,
  longitudinal_trackable,
  display_name,
  description,
  signal_version
)
VALUES

-- =============================================================================
-- ACADEMIC DOMAIN
-- =============================================================================

(
  'analytical_strength',
  'v1',
  'reasoning',
  'academic',
  ARRAY['academic','cognitive']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Analytical Strength',
  'Capacity for structured logical analysis derived from academic and cognitive indicators.',
  'v1'
),

(
  'quantitative_reasoning',
  'v1',
  'reasoning',
  'academic',
  ARRAY['academic','cognitive']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Quantitative Reasoning',
  'Numerical and mathematical reasoning ability.',
  'v1'
),

(
  'language_affinity',
  'v1',
  'subject_affinity',
  'academic',
  ARRAY['academic']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Language Affinity',
  'Strength in language, writing, and verbal communication subjects.',
  'v1'
),

(
  'scientific_orientation',
  'v1',
  'subject_affinity',
  'academic',
  ARRAY['academic','activity']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Scientific Orientation',
  'Orientation toward scientific inquiry and empirical thinking.',
  'v1'
),

(
  'social_science_interest',
  'v1',
  'subject_affinity',
  'academic',
  ARRAY['academic','cognitive']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Social Science Interest',
  'Interest and strength in social sciences and humanities.',
  'v1'
),

-- =============================================================================
-- ACTIVITY DOMAIN
-- =============================================================================

(
  'leadership',
  'v1',
  'social',
  'activity',
  ARRAY['activity','cognitive']::intelligence_domain_enum[],
  'max_pooling',
  true,
  true,
  true,
  'Leadership',
  'Evidence of leadership roles and responsibility.',
  'v1'
),

(
  'technical_execution',
  'v1',
  'technical',
  'activity',
  ARRAY['activity','academic','cognitive']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Technical Execution',
  'Capacity to build, implement, or execute technical systems.',
  'v1'
),

(
  'creative_expression',
  'v1',
  'creative',
  'activity',
  ARRAY['activity','cognitive']::intelligence_domain_enum[],
  'max_pooling',
  true,
  true,
  true,
  'Creative Expression',
  'Demonstrated creative and expressive output.',
  'v1'
),

(
  'collaboration',
  'v1',
  'social',
  'activity',
  ARRAY['activity','cognitive']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Collaboration',
  'Evidence of effective teamwork and collaboration.',
  'v1'
),

(
  'persistence',
  'v1',
  'behavioral',
  'activity',
  ARRAY['activity','cognitive']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Persistence',
  'Sustained commitment and consistency across activities.',
  'v1'
),

(
  'achievement_orientation',
  'v1',
  'behavioral',
  'activity',
  ARRAY['activity']::intelligence_domain_enum[],
  'max_pooling',
  true,
  true,
  true,
  'Achievement Orientation',
  'Drive toward competition, recognition, and achievement.',
  'v1'
),

-- =============================================================================
-- COGNITIVE DOMAIN
-- =============================================================================

(
  'systems_thinking',
  'v1',
  'reasoning',
  'cognitive',
  ARRAY['cognitive','academic','activity']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Systems Thinking',
  'Ability to reason about interconnected systems.',
  'v1'
),

(
  'hands_on_learning',
  'v1',
  'cognitive_style',
  'cognitive',
  ARRAY['cognitive','activity']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Hands-On Learning',
  'Preference for experiential and practical learning.',
  'v1'
),

(
  'structured_problem_solving',
  'v1',
  'reasoning',
  'cognitive',
  ARRAY['cognitive','academic']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Structured Problem Solving',
  'Methodical approach to decomposing and solving problems.',
  'v1'
),

(
  'exploratory_decision_making',
  'v1',
  'cognitive_style',
  'cognitive',
  ARRAY['cognitive']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Exploratory Decision Making',
  'Preference for broad information gathering before decisions.',
  'v1'
),

(
  'detail_orientation',
  'v1',
  'cognitive_style',
  'cognitive',
  ARRAY['cognitive','academic']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Detail Orientation',
  'Focus on precision, completeness, and accuracy.',
  'v1'
),

(
  'independent_working',
  'v1',
  'cognitive_style',
  'cognitive',
  ARRAY['cognitive','activity']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Independent Working',
  'Preference and effectiveness in autonomous work.',
  'v1'
),

(
  'rapid_execution',
  'v1',
  'behavioral',
  'cognitive',
  ARRAY['cognitive','activity']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Rapid Execution',
  'Bias toward rapid action and iterative execution.',
  'v1'
),

-- =============================================================================
-- CROSS-DOMAIN SIGNALS
-- =============================================================================

(
  'stem_affinity',
  'v1',
  'subject_affinity',
  'cross_domain',
  ARRAY['academic','activity','cognitive']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'STEM Affinity',
  'Cross-domain orientation toward STEM fields.',
  'v1'
),

(
  'communication_strength',
  'v1',
  'social',
  'cross_domain',
  ARRAY['academic','activity','cognitive']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Communication Strength',
  'Cross-domain communication capability.',
  'v1'
),

(
  'entrepreneurial_signal',
  'v1',
  'behavioral',
  'cross_domain',
  ARRAY['activity','cognitive']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Entrepreneurial Signal',
  'Leadership, initiative, creativity, and execution orientation.',
  'v1'
)

ON CONFLICT (signal_key, taxonomy_version)
DO NOTHING;

-- =============================================================================
-- SEED: signal_relationships
-- =============================================================================

INSERT INTO signal_relationships
(
  signal_key_a,
  signal_key_b,
  relationship_type,
  relationship_weight,
  taxonomy_version,
  rationale
)
VALUES

(
  'systems_thinking',
  'technical_execution',
  'reinforces',
  0.70,
  'v1',
  'Technical execution strengthens systems-level reasoning.'
),

(
  'systems_thinking',
  'scientific_orientation',
  'reinforces',
  0.65,
  'v1',
  'Scientific inquiry reinforces systems reasoning.'
),

(
  'analytical_strength',
  'structured_problem_solving',
  'reinforces',
  0.80,
  'v1',
  'Analytical reasoning supports structured decomposition.'
),

(
  'quantitative_reasoning',
  'stem_affinity',
  'reinforces',
  0.85,
  'v1',
  'Quantitative capability is a strong STEM indicator.'
),

(
  'technical_execution',
  'stem_affinity',
  'reinforces',
  0.80,
  'v1',
  'Technical implementation strongly correlates with STEM affinity.'
),

(
  'scientific_orientation',
  'stem_affinity',
  'reinforces',
  0.75,
  'v1',
  'Scientific orientation contributes to STEM alignment.'
),

(
  'leadership',
  'entrepreneurial_signal',
  'reinforces',
  0.75,
  'v1',
  'Leadership behavior reinforces entrepreneurial orientation.'
),

(
  'creative_expression',
  'entrepreneurial_signal',
  'reinforces',
  0.55,
  'v1',
  'Creativity correlates with innovation and entrepreneurship.'
),

(
  'hands_on_learning',
  'technical_execution',
  'reinforces',
  0.60,
  'v1',
  'Practical learners often excel in technical execution.'
),

(
  'language_affinity',
  'communication_strength',
  'reinforces',
  0.85,
  'v1',
  'Language ability is a primary communication indicator.'
),

(
  'collaboration',
  'communication_strength',
  'reinforces',
  0.65,
  'v1',
  'Collaboration develops communication capability.'
),

(
  'persistence',
  'achievement_orientation',
  'reinforces',
  0.70,
  'v1',
  'Persistence supports achievement-oriented outcomes.'
),

(
  'structured_problem_solving',
  'exploratory_decision_making',
  'contradicts',
  0.60,
  'v1',
  'High structure preference can oppose exploratory behavior.'
),

(
  'rapid_execution',
  'detail_orientation',
  'contradicts',
  0.55,
  'v1',
  'Rapid execution may conflict with detail precision.'
)

ON CONFLICT
(
  signal_key_a,
  signal_key_b,
  relationship_type,
  taxonomy_version
)
DO NOTHING;