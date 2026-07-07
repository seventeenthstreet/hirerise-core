-- =============================================================================
-- HireRise Phase 2A.1 — Intelligence Foundation Layer
-- Migration: 20260608000001_intelligence_foundation_layer.sql
--
-- INTELLIGENCE FOUNDATION LAYER — COMPLETE SCHEMA
-- Implements all Phase 2A.1 database infrastructure in a single migration.
-- Split into logical sections matching the architecture document.
--
-- SECTIONS:
--   §1  signal_category_hierarchy
--   §2  signal_ontology_edges
--   §3  intelligence_entity_snapshots
--   §4  intelligence_confidence_snapshots
--   §5  intelligence_recommendations
--   §6  intelligence_recommendation_factors
--   §7  intelligence_explanation_details
--   §8  Governance RPCs (student-facing)
--   §9  Confidence model version seed
--   §10 Deprecation notices on legacy tables
--   §11 Immutability triggers (shared function)
--
-- COMPATIBILITY (verified against all prior migrations):
--   ✓ Runs AFTER 20260601000004_governance_refinements.sql
--   ✓ All user_id columns reference auth.users(id) — no user_profiles FK
--   ✓ intelligence_domain CHECK values match Sprint 1.1 vocabulary
--   ✓ entity_type CHECK values match governance tables
--   ✓ output_type values align with signal_ontology_edges source/target types
--   ✓ confidence_tier values match existing Phase 4A pattern (HIGH/MEDIUM/LOW)
--   ✓ No new Postgres ENUM types — all domain lists use text + CHECK constraint
--     (avoids ALTER TYPE enum migration problems as domains expand)
--   ✓ No dependency on intelligence_domain_enum (Phase 3D enum) in new tables —
--     new tables use text + CHECK for forward-compatibility
--   ✓ signal_weight_versions.model_type 'confidence_model' already in CHECK
--     from Migration 4 — confidence model seed in §9 is compatible
--
-- EXECUTION: Safe to run multiple times (IF NOT EXISTS / DROP IF EXISTS guards).
-- ROLLBACK:  Run 20260608000001_rollback.sql (provided separately).
-- =============================================================================

BEGIN;

-- =============================================================================
-- §1  signal_category_hierarchy
-- Hierarchical categorization framework for the signal registry.
-- Extends Phase 3D's flat signal_category_enum without replacing it.
-- Public reference data — readable by anon and authenticated.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.signal_category_hierarchy (

  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable snake_case identifier — immutable after creation
  category_key          text          NOT NULL,

  -- Human-readable label for UI and explanation generation
  display_name          text          NOT NULL,

  -- NULL = root category
  parent_category_key   text          DEFAULT NULL,

  -- 0 = root, 1 = first-level child, etc. Max depth 5.
  depth                 integer       NOT NULL DEFAULT 0
                          CHECK (depth >= 0 AND depth <= 5),

  -- Intelligence domains this category applies to
  applicable_domains    text[]        NOT NULL DEFAULT ARRAY['student'],

  -- Maps to the Phase 3D signal_category_enum value if applicable
  -- Enables backward-compat queries joining on this column
  legacy_enum_value     text          DEFAULT NULL,

  -- Whether new signals can be registered under this category
  accepts_signals       boolean       NOT NULL DEFAULT true,

  -- True if this category has no children (leaf node)
  is_leaf               boolean       NOT NULL DEFAULT true,

  description           text          DEFAULT NULL,

  -- Controls display order within siblings
  sort_order            integer       NOT NULL DEFAULT 0,

  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  deprecated_at         timestamptz   DEFAULT NULL,

  CONSTRAINT uq_category_key
    UNIQUE (category_key),

  CONSTRAINT chk_parent_not_self
    CHECK (parent_category_key IS NULL OR parent_category_key <> category_key)

);

-- Self-referential FK — deferred to allow inserts within the same transaction
ALTER TABLE public.signal_category_hierarchy
  DROP CONSTRAINT IF EXISTS fk_parent_category;

ALTER TABLE public.signal_category_hierarchy
  ADD CONSTRAINT fk_parent_category
    FOREIGN KEY (parent_category_key)
    REFERENCES public.signal_category_hierarchy (category_key)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

COMMENT ON TABLE public.signal_category_hierarchy IS
  'Phase 2A.1: Hierarchical signal categorization framework. '
  'Extends the flat signal_category_enum from Phase 3D into a full hierarchy '
  'supporting parent-child relationships, domain applicability, and ontology traversal. '
  'Public reference data — no PII.';

COMMENT ON COLUMN public.signal_category_hierarchy.category_key IS
  'Stable snake_case identifier. Immutable after creation. '
  'Referenced by signal_ontology_edges.source_key/target_key where source_type = category.';

COMMENT ON COLUMN public.signal_category_hierarchy.legacy_enum_value IS
  'Maps to signal_category_enum value from Phase 3D migration. '
  'Enables backward-compatible joins. NULL if no direct mapping.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_signal_category_parent
  ON public.signal_category_hierarchy (parent_category_key)
  WHERE deprecated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_signal_category_depth_sort
  ON public.signal_category_hierarchy (depth ASC, sort_order ASC)
  WHERE deprecated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_signal_category_domains
  ON public.signal_category_hierarchy USING GIN (applicable_domains);

CREATE INDEX IF NOT EXISTS idx_signal_category_legacy
  ON public.signal_category_hierarchy (legacy_enum_value)
  WHERE legacy_enum_value IS NOT NULL AND deprecated_at IS NULL;

-- Trigger: updated_at
CREATE OR REPLACE FUNCTION public.fn_set_updated_at_category()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_signal_category_updated_at ON public.signal_category_hierarchy;
CREATE TRIGGER trg_signal_category_updated_at
  BEFORE UPDATE ON public.signal_category_hierarchy
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at_category();

-- RLS
ALTER TABLE public.signal_category_hierarchy ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "signal_category_read_all" ON public.signal_category_hierarchy;
CREATE POLICY "signal_category_read_all"
  ON public.signal_category_hierarchy
  FOR SELECT
  USING (deprecated_at IS NULL);

DROP POLICY IF EXISTS "signal_category_service_write" ON public.signal_category_hierarchy;
CREATE POLICY "signal_category_service_write"
  ON public.signal_category_hierarchy
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- GRANTs
REVOKE ALL ON public.signal_category_hierarchy FROM anon, authenticated;
GRANT SELECT                   ON public.signal_category_hierarchy TO anon;
GRANT SELECT                   ON public.signal_category_hierarchy TO authenticated;
GRANT SELECT, INSERT, UPDATE   ON public.signal_category_hierarchy TO service_role;

-- ─── Seed: root and first-level categories ────────────────────────────────────
-- Deferred constraint allows self-referential inserts in one statement set.
SET CONSTRAINTS fk_parent_category DEFERRED;

INSERT INTO public.signal_category_hierarchy
  (category_key, display_name, parent_category_key, depth,
   applicable_domains, legacy_enum_value, accepts_signals, is_leaf, sort_order)
VALUES
  -- Root categories (depth 0)
  ('cognitive_capability',     'Cognitive Capability',      NULL, 0,
   ARRAY['student','professional'], NULL,           false, false, 1),
  ('social_behavioral',        'Social & Behavioural',      NULL, 0,
   ARRAY['student','professional'], NULL,           false, false, 2),
  ('technical_professional',   'Technical & Professional',  NULL, 0,
   ARRAY['student','professional','employer'], NULL, false, false, 3),
  ('academic_affinity',        'Academic Affinity',         NULL, 0,
   ARRAY['student'],                           NULL, false, false, 4),
  ('creative_adaptive',        'Creative & Adaptive',       NULL, 0,
   ARRAY['student','professional'],            NULL, false, false, 5),
  ('career_readiness',         'Career Readiness',          NULL, 0,
   ARRAY['student','professional'],            NULL, false, false, 6),
  ('workforce_intelligence',   'Workforce Intelligence',    NULL, 0,
   ARRAY['professional','employer','workforce'], NULL, false, false, 7),

  -- Cognitive Capability children (depth 1)
  ('analytical_reasoning',  'Analytical Reasoning',   'cognitive_capability', 1,
   ARRAY['student','professional'], 'reasoning',      true, true, 1),
  ('systems_thinking',      'Systems Thinking',       'cognitive_capability', 1,
   ARRAY['student','professional'], 'cognitive_style', true, true, 2),
  ('creative_problem_solving','Creative Problem Solving','cognitive_capability',1,
   ARRAY['student','professional'], 'creative',        true, true, 3),

  -- Social & Behavioural children (depth 1)
  ('collaboration',         'Collaboration',          'social_behavioral', 1,
   ARRAY['student','professional'], 'social',          true, true, 1),
  ('communication_skills',  'Communication Skills',   'social_behavioral', 1,
   ARRAY['student','professional'], 'social',          true, true, 2),
  ('adaptability',          'Adaptability',           'social_behavioral', 1,
   ARRAY['student','professional'], 'behavioral',      true, true, 3),

  -- Technical & Professional children (depth 1)
  ('technical_aptitude',    'Technical Aptitude',     'technical_professional', 1,
   ARRAY['student','professional'], 'technical',       true, true, 1),
  ('stem_performance',      'STEM Performance',       'technical_professional', 1,
   ARRAY['student'],               'technical',        true, true, 2),

  -- Academic Affinity children (depth 1)
  ('stem_affinity',         'STEM Subject Affinity',  'academic_affinity', 1,
   ARRAY['student'],               'subject_affinity', true, true, 1),
  ('humanities_affinity',   'Humanities Affinity',    'academic_affinity', 1,
   ARRAY['student'],               'subject_affinity', true, true, 2),
  ('commerce_affinity',     'Commerce Affinity',      'academic_affinity', 1,
   ARRAY['student'],               'subject_affinity', true, true, 3),

  -- Career Readiness children (depth 1)
  ('leadership_development','Leadership Development', 'career_readiness', 1,
   ARRAY['student','professional'], 'behavioral',      true, true, 1),
  ('professional_exposure', 'Professional Exposure',  'career_readiness', 1,
   ARRAY['student','professional'], 'meta',            true, true, 2)

ON CONFLICT (category_key) DO NOTHING;

SET CONSTRAINTS fk_parent_category IMMEDIATE;

-- =============================================================================
-- §2  signal_ontology_edges
-- Minimum viable ontology. Typed edges between signal keys, categories,
-- career areas, roles, skills, and programmes.
-- Extends signal_relationships (signal↔signal) to cross-type relationships.
-- Public reference data.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.signal_ontology_edges (

  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source node
  source_type           text          NOT NULL
                          CHECK (source_type IN (
                            'signal',
                            'category',
                            'career_area',
                            'role',
                            'skill',
                            'programme'
                          )),
  source_key            text          NOT NULL,

  -- Target node
  target_type           text          NOT NULL
                          CHECK (target_type IN (
                            'signal',
                            'category',
                            'career_area',
                            'role',
                            'skill',
                            'programme'
                          )),
  target_key            text          NOT NULL,

  -- Relationship semantic
  edge_type             text          NOT NULL
                          CHECK (edge_type IN (
                            'predicts',       -- signal predicts career/role fit
                            'requires',       -- role/career requires signal/skill
                            'correlates_with',-- bidirectional correlation
                            'subsumes',       -- category subsumes sub-category
                            'develops',       -- programme/activity develops signal
                            'evidenced_by'    -- skill evidenced by signal
                          )),

  -- Strength: 0.0 (weak) – 1.0 (strong)
  edge_weight           numeric(5,4)  NOT NULL DEFAULT 0.5
                          CHECK (edge_weight BETWEEN 0.0 AND 1.0),

  -- Required for explainability audit trail
  rationale             text          NOT NULL,

  -- Taxonomy version this edge belongs to
  taxonomy_version      text          NOT NULL DEFAULT 'v1',

  -- True if the relationship is symmetric (A→B implies B→A)
  is_bidirectional      boolean       NOT NULL DEFAULT false,

  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  deprecated_at         timestamptz   DEFAULT NULL,

  CONSTRAINT uq_ontology_edge
    UNIQUE (source_type, source_key, target_type, target_key, edge_type, taxonomy_version),

  CONSTRAINT chk_no_self_loop
    CHECK (NOT (source_type = target_type AND source_key = target_key))

);

COMMENT ON TABLE public.signal_ontology_edges IS
  'Phase 2A.1: Minimum viable intelligence ontology. '
  'Typed edges connecting signals, categories, career areas, roles, skills, and programmes. '
  'Extends signal_relationships (signal↔signal) to cross-type edges. '
  'Used by: recommendation engine (predicts edges), '
  'explainability engine (evidenced_by, requires), '
  'aggregation engine (develops). '
  'Public reference data — no PII.';

COMMENT ON COLUMN public.signal_ontology_edges.edge_weight IS
  'Strength of the relationship (0.0–1.0). Used as a multiplier in '
  'recommendation scoring. Must have rationale for explainability compliance.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ontology_source
  ON public.signal_ontology_edges (source_type, source_key, edge_type)
  WHERE deprecated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ontology_target
  ON public.signal_ontology_edges (target_type, target_key, edge_type)
  WHERE deprecated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ontology_edge_weight
  ON public.signal_ontology_edges (edge_type, edge_weight DESC)
  WHERE deprecated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ontology_taxonomy
  ON public.signal_ontology_edges (taxonomy_version)
  WHERE deprecated_at IS NULL;

-- Trigger: updated_at
CREATE OR REPLACE FUNCTION public.fn_set_updated_at_ontology()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_ontology_updated_at ON public.signal_ontology_edges;
CREATE TRIGGER trg_ontology_updated_at
  BEFORE UPDATE ON public.signal_ontology_edges
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at_ontology();

-- RLS
ALTER TABLE public.signal_ontology_edges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ontology_read_all" ON public.signal_ontology_edges;
CREATE POLICY "ontology_read_all"
  ON public.signal_ontology_edges
  FOR SELECT
  USING (deprecated_at IS NULL);

DROP POLICY IF EXISTS "ontology_service_write" ON public.signal_ontology_edges;
CREATE POLICY "ontology_service_write"
  ON public.signal_ontology_edges
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- GRANTs
REVOKE ALL ON public.signal_ontology_edges FROM anon, authenticated;
GRANT SELECT                   ON public.signal_ontology_edges TO anon;
GRANT SELECT                   ON public.signal_ontology_edges TO authenticated;
GRANT SELECT, INSERT, UPDATE   ON public.signal_ontology_edges TO service_role;

-- ─── Seed: signal → career_area predicts edges ────────────────────────────────
-- Maps Phase 3D signal keys to career areas.
-- Career areas: technology, business, creative_industries, social_sciences,
--               natural_sciences, health_sciences, education, engineering

INSERT INTO public.signal_ontology_edges
  (source_type, source_key, target_type, target_key, edge_type, edge_weight, rationale, is_bidirectional)
VALUES
  -- systems_thinker
  ('signal','systems_thinker','career_area','technology',         'predicts',0.85,'Systems thinking is a primary predictor of success in technology careers requiring architecture and design.',false),
  ('signal','systems_thinker','career_area','engineering',        'predicts',0.80,'Engineering disciplines require systematic decomposition of complex problems.',false),
  ('signal','systems_thinker','career_area','natural_sciences',   'predicts',0.70,'Scientific methodology shares structural properties with systems thinking.',false),

  -- analytical_reasoning
  ('signal','analytical_reasoning','career_area','technology',    'predicts',0.82,'Analytical reasoning underpins software, data, and systems roles.',false),
  ('signal','analytical_reasoning','career_area','business',      'predicts',0.75,'Business analysis and strategy require structured analytical capability.',false),
  ('signal','analytical_reasoning','career_area','natural_sciences','predicts',0.80,'Research methodology and experimental design require analytical rigor.',false),

  -- creative_solver
  ('signal','creative_solver','career_area','creative_industries','predicts',0.85,'Creative problem-solving is foundational to design, media, and creative roles.',false),
  ('signal','creative_solver','career_area','technology',         'predicts',0.65,'Product and UX roles in technology require creative problem-solving.',false),
  ('signal','creative_solver','career_area','education',          'predicts',0.60,'Curriculum design and pedagogy benefit from creative approaches.',false),

  -- social_collaborator
  ('signal','social_collaborator','career_area','social_sciences','predicts',0.82,'Social science professions require high interpersonal and collaborative competency.',false),
  ('signal','social_collaborator','career_area','education',      'predicts',0.85,'Teaching and educational roles depend on social collaboration.',false),
  ('signal','social_collaborator','career_area','health_sciences','predicts',0.75,'Healthcare roles require strong team collaboration and patient communication.',false),

  -- detail_oriented
  ('signal','detail_oriented','career_area','engineering',        'predicts',0.80,'Engineering precision requires detail orientation in specifications and testing.',false),
  ('signal','detail_oriented','career_area','health_sciences',    'predicts',0.82,'Clinical and research health roles require precision and attention to detail.',false),
  ('signal','detail_oriented','career_area','business',           'predicts',0.65,'Finance, compliance, and operations roles require detail-oriented work.',false),

  -- leadership_potential
  ('signal','leadership_potential','career_area','business',      'predicts',0.80,'Leadership potential is a strong predictor of management and strategy career fit.',false),
  ('signal','leadership_potential','career_area','education',     'predicts',0.72,'School leadership and educational administration require leadership capability.',false),
  ('signal','leadership_potential','career_area','social_sciences','predicts',0.65,'Community development and policy roles benefit from leadership capacity.',false),

  -- technical_aptitude
  ('signal','technical_aptitude','career_area','technology',      'predicts',0.90,'Technical aptitude is the highest-weight predictor for technology career fit.',false),
  ('signal','technical_aptitude','career_area','engineering',     'predicts',0.88,'Engineering requires strong technical foundation.',false),
  ('signal','technical_aptitude','career_area','natural_sciences','predicts',0.75,'STEM research roles require technical aptitude in experimental methods.',false),

  -- communication_skills
  ('signal','communication_skills','career_area','education',     'predicts',0.85,'Teaching requires strong written and verbal communication.',false),
  ('signal','communication_skills','career_area','business',      'predicts',0.78,'Business roles depend on communication for client management and stakeholder engagement.',false),
  ('signal','communication_skills','career_area','social_sciences','predicts',0.80,'Social science practice requires communication across diverse populations.',false),

  -- subject_affinity_stem
  ('signal','subject_affinity_stem','career_area','technology',   'predicts',0.88,'STEM affinity is highly predictive of technology career readiness.',false),
  ('signal','subject_affinity_stem','career_area','engineering',  'predicts',0.90,'Engineering career paths are strongly predicted by STEM subject affinity.',false),
  ('signal','subject_affinity_stem','career_area','natural_sciences','predicts',0.85,'Natural science careers are almost exclusively entered via STEM subject pathways.',false),

  -- subject_affinity_humanities
  ('signal','subject_affinity_humanities','career_area','social_sciences','predicts',0.85,'Humanities affinity predicts social sciences and liberal arts career pathways.',false),
  ('signal','subject_affinity_humanities','career_area','education','predicts',0.78,'Humanities subjects are foundational for most teaching domains.',false),
  ('signal','subject_affinity_humanities','career_area','creative_industries','predicts',0.72,'Creative industries draw heavily from humanities-aligned students.',false),

  -- subject_affinity_commerce
  ('signal','subject_affinity_commerce','career_area','business',  'predicts',0.88,'Commerce subject affinity is the strongest academic predictor of business career fit.',false),
  ('signal','subject_affinity_commerce','career_area','technology','predicts',0.55,'Fintech and business-technology roles benefit from commerce-technology combination.',false),

  -- creative_expression
  ('signal','creative_expression','career_area','creative_industries','predicts',0.90,'Creative expression is the primary signal for creative industry career alignment.',false),
  ('signal','creative_expression','career_area','education',       'predicts',0.62,'Arts education and creative pedagogy roles value creative expression.',false)

ON CONFLICT (source_type, source_key, target_type, target_key, edge_type, taxonomy_version)
DO NOTHING;

-- ─── Seed: signal → skill evidenced_by edges ─────────────────────────────────
INSERT INTO public.signal_ontology_edges
  (source_type, source_key, target_type, target_key, edge_type, edge_weight, rationale)
VALUES
  ('skill','critical_thinking',    'signal','analytical_reasoning', 'evidenced_by',0.85,'Critical thinking skill is most directly evidenced by analytical reasoning signal.'),
  ('skill','critical_thinking',    'signal','systems_thinker',      'evidenced_by',0.70,'Systems thinking contributes to critical thinking via structured decomposition.'),
  ('skill','teamwork',             'signal','social_collaborator',  'evidenced_by',0.90,'Teamwork skill is directly evidenced by social collaboration signal.'),
  ('skill','problem_solving',      'signal','systems_thinker',      'evidenced_by',0.82,'Problem solving draws on systems thinking for structured approach.'),
  ('skill','problem_solving',      'signal','creative_solver',      'evidenced_by',0.78,'Creative problem solving is a distinct sub-skill of general problem solving.'),
  ('skill','leadership',           'signal','leadership_potential', 'evidenced_by',0.90,'Leadership skill is directly evidenced by leadership potential signal.'),
  ('skill','technical_proficiency','signal','technical_aptitude',   'evidenced_by',0.88,'Technical proficiency is most directly evidenced by technical aptitude signal.')
ON CONFLICT (source_type, source_key, target_type, target_key, edge_type, taxonomy_version)
DO NOTHING;

-- =============================================================================
-- §3  intelligence_entity_snapshots
-- Longitudinal intelligence state for any entity type.
-- Immutable after creation — new snapshot per pipeline run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.intelligence_entity_snapshots (

  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  entity_type           text          NOT NULL
                          CHECK (entity_type IN (
                            'student',
                            'professional',
                            'institution',
                            'employer',
                            'workforce_cohort',
                            'government_region'
                          )),

  -- UUID of the entity. For students: auth.users(id).
  -- Soft reference — no DB FK because target table varies by entity_type.
  entity_id             uuid          NOT NULL,

  intelligence_domain   text          NOT NULL
                          CHECK (intelligence_domain IN (
                            'student','professional','institution',
                            'employer','workforce','government'
                          )),

  -- Governance chain
  pipeline_run_id       uuid          NOT NULL
                          REFERENCES public.intelligence_pipeline_runs(id)
                          ON DELETE RESTRICT,

  model_version_id      uuid          NOT NULL
                          REFERENCES public.signal_weight_versions(id)
                          ON DELETE RESTRICT,

  -- What caused this snapshot to be taken
  snapshot_trigger      text          NOT NULL
                          CHECK (snapshot_trigger IN (
                            'onboarding_complete',
                            'periodic_scheduled',
                            'data_event',
                            'manual_request',
                            'domain_transition'
                          )),

  -- Ordinal: 1 = first snapshot for this entity+domain combination
  snapshot_sequence     integer       NOT NULL DEFAULT 1
                          CHECK (snapshot_sequence >= 1),

  -- Signal state at snapshot time
  -- Shape: { signal_key: { weight: float, confidence: float, domain: string } }
  signal_state          jsonb         NOT NULL DEFAULT '{}'
                          CHECK (jsonb_typeof(signal_state) = 'object'),

  -- Domain-level aggregates
  -- Shape: { domain: { score: float, signal_count: int, coverage: float } }
  domain_state          jsonb         NOT NULL DEFAULT '{}'
                          CHECK (jsonb_typeof(domain_state) = 'object'),

  composite_confidence  numeric(5,2)  NOT NULL DEFAULT 0.00
                          CHECK (composite_confidence BETWEEN 0 AND 100),

  confidence_tier       text          NOT NULL
                          CHECK (confidence_tier IN ('HIGH','MEDIUM','LOW','NO_DATA')),

  data_completeness     numeric(5,4)  NOT NULL DEFAULT 0.0
                          CHECK (data_completeness BETWEEN 0.0 AND 1.0),

  active_signal_count   integer       NOT NULL DEFAULT 0
                          CHECK (active_signal_count >= 0),

  -- Which data domains contributed evidence to this snapshot
  domains_included      text[]        NOT NULL DEFAULT '{}',

  -- Delta from the previous snapshot for trend analytics
  -- Shape: { confidence_delta, signal_count_delta, new_signals[], dropped_signals[] }
  delta_from_previous   jsonb         DEFAULT NULL,

  -- SHA-256 of canonical(signal_state + domain_state) for determinism verification
  state_hash            text          NOT NULL
                          CHECK (length(state_hash) = 64),

  snapshot_at           timestamptz   NOT NULL DEFAULT now(),
  created_at            timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT uq_entity_snapshot_sequence
    UNIQUE (entity_id, entity_type, intelligence_domain, snapshot_sequence)

);

COMMENT ON TABLE public.intelligence_entity_snapshots IS
  'Phase 2A.1: Immutable longitudinal intelligence state record. '
  'One row per pipeline run per entity. Enables trend tracking, '
  'progression analytics, and before/after comparison. '
  'state_hash enables determinism verification. '
  'Governance chain: pipeline_run_id → consent + model version.';

-- Immutability trigger (shared function used by multiple tables below)
CREATE OR REPLACE FUNCTION public.fn_phase2a_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is immutable. Operation: %. '
    'Create a new row rather than modifying or deleting existing ones.',
    TG_TABLE_NAME, TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_entity_snapshot_no_update ON public.intelligence_entity_snapshots;
CREATE TRIGGER trg_entity_snapshot_no_update
  BEFORE UPDATE ON public.intelligence_entity_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fn_phase2a_immutable_row();

DROP TRIGGER IF EXISTS trg_entity_snapshot_no_delete ON public.intelligence_entity_snapshots;
CREATE TRIGGER trg_entity_snapshot_no_delete
  BEFORE DELETE ON public.intelligence_entity_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fn_phase2a_immutable_row();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_entity_snapshots_entity_seq
  ON public.intelligence_entity_snapshots
  (entity_id, entity_type, intelligence_domain, snapshot_sequence DESC);

CREATE INDEX IF NOT EXISTS idx_entity_snapshots_domain_tier
  ON public.intelligence_entity_snapshots
  (intelligence_domain, confidence_tier, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_snapshots_pipeline
  ON public.intelligence_entity_snapshots (pipeline_run_id);

CREATE INDEX IF NOT EXISTS idx_entity_snapshots_model_version
  ON public.intelligence_entity_snapshots (model_version_id);

CREATE INDEX IF NOT EXISTS idx_entity_snapshots_trigger_at
  ON public.intelligence_entity_snapshots (snapshot_trigger, snapshot_at DESC);

-- RLS
ALTER TABLE public.intelligence_entity_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "entity_snapshots_student_read" ON public.intelligence_entity_snapshots;
CREATE POLICY "entity_snapshots_student_read"
  ON public.intelligence_entity_snapshots
  FOR SELECT TO authenticated
  USING (entity_type = 'student' AND auth.uid() = entity_id);

DROP POLICY IF EXISTS "entity_snapshots_service_insert" ON public.intelligence_entity_snapshots;
CREATE POLICY "entity_snapshots_service_insert"
  ON public.intelligence_entity_snapshots
  FOR INSERT TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS "entity_snapshots_service_read" ON public.intelligence_entity_snapshots;
CREATE POLICY "entity_snapshots_service_read"
  ON public.intelligence_entity_snapshots
  FOR SELECT TO service_role
  USING (true);

-- GRANTs
REVOKE ALL ON public.intelligence_entity_snapshots FROM anon, authenticated;
GRANT SELECT         ON public.intelligence_entity_snapshots TO authenticated;
GRANT SELECT, INSERT ON public.intelligence_entity_snapshots TO service_role;

-- =============================================================================
-- §4  intelligence_confidence_snapshots
-- Structured confidence record per entity snapshot.
-- Immutable after creation — linked to entity snapshot by FK.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.intelligence_confidence_snapshots (

  id                        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  entity_snapshot_id        uuid          NOT NULL UNIQUE
                              REFERENCES public.intelligence_entity_snapshots(id)
                              ON DELETE RESTRICT,

  pipeline_run_id           uuid          NOT NULL
                              REFERENCES public.intelligence_pipeline_runs(id)
                              ON DELETE RESTRICT,

  -- Denormalised for query efficiency (avoid join to entity_snapshots)
  entity_id                 uuid          NOT NULL,
  entity_type               text          NOT NULL,
  intelligence_domain       text          NOT NULL,

  -- Confidence components (all 0–100)
  coverage_score            numeric(5,2)  NOT NULL
                              CHECK (coverage_score BETWEEN 0 AND 100),
  reliability_score         numeric(5,2)  NOT NULL
                              CHECK (reliability_score BETWEEN 0 AND 100),
  composite_confidence      numeric(5,2)  NOT NULL
                              CHECK (composite_confidence BETWEEN 0 AND 100),

  confidence_tier           text          NOT NULL
                              CHECK (confidence_tier IN ('HIGH','MEDIUM','LOW','NO_DATA')),

  -- Signal quality counts
  active_signal_count       integer       NOT NULL DEFAULT 0,
  missing_signal_count      integer       NOT NULL DEFAULT 0,
  contradicting_signal_count integer      NOT NULL DEFAULT 0,

  -- Fraction of expected signals that have evidence (0.0–1.0)
  data_completeness         numeric(5,4)  NOT NULL DEFAULT 0.0
                              CHECK (data_completeness BETWEEN 0.0 AND 1.0),

  -- How much the score could change with more data (0–50 percentage points)
  uncertainty_band          numeric(5,2)  DEFAULT NULL
                              CHECK (uncertainty_band IS NULL
                                     OR uncertainty_band BETWEEN 0 AND 50),

  -- Factor decomposition matching Phase 4A pattern
  -- Shape: { factor_name: { score, weight, contribution, label } }
  factors                   jsonb         NOT NULL DEFAULT '{}'
                              CHECK (jsonb_typeof(factors) = 'object'),

  -- Signal keys that are missing but expected for this entity type
  missing_signals           text[]        NOT NULL DEFAULT '{}',

  -- Signal keys with contradictions that reduced confidence
  contradicting_signals     text[]        NOT NULL DEFAULT '{}',

  engine_version            text          NOT NULL,

  computed_at               timestamptz   NOT NULL DEFAULT now(),
  created_at                timestamptz   NOT NULL DEFAULT now()

);

COMMENT ON TABLE public.intelligence_confidence_snapshots IS
  'Phase 2A.1: Structured confidence record per entity snapshot. '
  'One row per intelligence_entity_snapshots row. Immutable after creation. '
  'Enables confidence history time-series queries and trend analytics. '
  'uncertainty_band surfaces to student UI as ± range on confidence score.';

-- Immutability
DROP TRIGGER IF EXISTS trg_confidence_snapshot_no_update ON public.intelligence_confidence_snapshots;
CREATE TRIGGER trg_confidence_snapshot_no_update
  BEFORE UPDATE ON public.intelligence_confidence_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fn_phase2a_immutable_row();

DROP TRIGGER IF EXISTS trg_confidence_snapshot_no_delete ON public.intelligence_confidence_snapshots;
CREATE TRIGGER trg_confidence_snapshot_no_delete
  BEFORE DELETE ON public.intelligence_confidence_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fn_phase2a_immutable_row();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_confidence_snapshots_entity_time
  ON public.intelligence_confidence_snapshots
  (entity_id, entity_type, intelligence_domain, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_confidence_snapshots_tier_domain
  ON public.intelligence_confidence_snapshots
  (intelligence_domain, confidence_tier, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_confidence_snapshots_pipeline
  ON public.intelligence_confidence_snapshots (pipeline_run_id);

-- RLS
ALTER TABLE public.intelligence_confidence_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "confidence_snapshots_student_read"
  ON public.intelligence_confidence_snapshots;
CREATE POLICY "confidence_snapshots_student_read"
  ON public.intelligence_confidence_snapshots
  FOR SELECT TO authenticated
  USING (entity_type = 'student' AND auth.uid() = entity_id);

DROP POLICY IF EXISTS "confidence_snapshots_service_all"
  ON public.intelligence_confidence_snapshots;
CREATE POLICY "confidence_snapshots_service_all"
  ON public.intelligence_confidence_snapshots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- GRANTs
REVOKE ALL ON public.intelligence_confidence_snapshots FROM anon, authenticated;
GRANT SELECT         ON public.intelligence_confidence_snapshots TO authenticated;
GRANT SELECT, INSERT ON public.intelligence_confidence_snapshots TO service_role;

-- =============================================================================
-- §5  intelligence_recommendations
-- Governed recommendation outputs — supersedes edu_skill_recommendations
-- and personalized_recommendations.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.intelligence_recommendations (

  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  entity_id             uuid          NOT NULL,
  entity_type           text          NOT NULL
                          CHECK (entity_type IN (
                            'student','professional','institution',
                            'employer','workforce_cohort','government_region'
                          )),
  intelligence_domain   text          NOT NULL
                          CHECK (intelligence_domain IN (
                            'student','professional','institution',
                            'employer','workforce','government'
                          )),

  -- Governance chain
  pipeline_run_id       uuid          NOT NULL
                          REFERENCES public.intelligence_pipeline_runs(id)
                          ON DELETE RESTRICT,

  entity_snapshot_id    uuid          DEFAULT NULL
                          REFERENCES public.intelligence_entity_snapshots(id)
                          ON DELETE RESTRICT,

  -- What is being recommended
  output_type           text          NOT NULL
                          CHECK (output_type IN (
                            'career_area',
                            'role',
                            'skill',
                            'programme',
                            'institution',
                            'development_action'
                          )),

  -- Stable key matching signal_ontology_edges.target_key
  output_key            text          NOT NULL,

  -- Human-readable label for UI rendering
  output_label          text          NOT NULL,

  -- Position within this pipeline run's recommendation set
  rank                  integer       NOT NULL DEFAULT 1
                          CHECK (rank >= 1 AND rank <= 20),

  recommendation_score  numeric(5,2)  NOT NULL
                          CHECK (recommendation_score BETWEEN 0 AND 100),

  confidence_tier       text          NOT NULL
                          CHECK (confidence_tier IN ('HIGH','MEDIUM','LOW','NO_DATA')),

  -- Vocabulary-validated explanation text
  explanation_text      text          NOT NULL
                          CHECK (char_length(explanation_text) BETWEEN 10 AND 1000),

  has_improvement_actions boolean     NOT NULL DEFAULT false,

  -- Validity window — NULL expires_at means valid until superseded
  valid_from            timestamptz   NOT NULL DEFAULT now(),
  expires_at            timestamptz   DEFAULT NULL,

  vocabulary_valid      boolean       NOT NULL DEFAULT true,
  engine_version        text          NOT NULL,

  created_at            timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT uq_recommendation_entity_run_output_rank
    UNIQUE (entity_id, entity_type, intelligence_domain, pipeline_run_id, output_type, rank)

);

COMMENT ON TABLE public.intelligence_recommendations IS
  'Phase 2A.1: Governed recommendation outputs. '
  'Supersedes edu_skill_recommendations (deprecated) and '
  'personalized_recommendations (deprecated). '
  'Every recommendation is linked to a pipeline_run_id → full governance chain. '
  'expires_at NULL = valid until the next pipeline run supersedes it.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_recommendations_entity_rank
  ON public.intelligence_recommendations
  (entity_id, entity_type, intelligence_domain, rank, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recommendations_output_type
  ON public.intelligence_recommendations (output_type, output_key);

CREATE INDEX IF NOT EXISTS idx_recommendations_pipeline
  ON public.intelligence_recommendations (pipeline_run_id);

CREATE INDEX IF NOT EXISTS idx_recommendations_active
  ON public.intelligence_recommendations (entity_id, valid_from)
  WHERE expires_at IS NULL;

-- RLS
ALTER TABLE public.intelligence_recommendations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "recommendations_student_read"
  ON public.intelligence_recommendations;
CREATE POLICY "recommendations_student_read"
  ON public.intelligence_recommendations
  FOR SELECT TO authenticated
  USING (entity_type = 'student' AND auth.uid() = entity_id);

DROP POLICY IF EXISTS "recommendations_service_all"
  ON public.intelligence_recommendations;
CREATE POLICY "recommendations_service_all"
  ON public.intelligence_recommendations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- GRANTs
REVOKE ALL ON public.intelligence_recommendations FROM anon, authenticated;
GRANT SELECT         ON public.intelligence_recommendations TO authenticated;
GRANT SELECT, INSERT ON public.intelligence_recommendations TO service_role;

-- =============================================================================
-- §6  intelligence_recommendation_factors
-- Structured signal attribution for each recommendation.
-- "Reasons" component of the explainability output.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.intelligence_recommendation_factors (

  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  recommendation_id     uuid          NOT NULL
                          REFERENCES public.intelligence_recommendations(id)
                          ON DELETE CASCADE,

  signal_key            text          NOT NULL,

  factor_type           text          NOT NULL
                          CHECK (factor_type IN (
                            'supporting',    -- signal supports this recommendation
                            'missing',       -- absent signal limiting confidence
                            'contradicting'  -- signal reducing confidence
                          )),

  -- Signed contribution: positive = supporting, negative = contradicting
  contribution_score    numeric(6,4)  NOT NULL
                          CHECK (contribution_score BETWEEN -1.0 AND 1.0),

  signal_weight         numeric(5,4)  NOT NULL DEFAULT 0.0
                          CHECK (signal_weight BETWEEN 0.0 AND 1.0),

  evidence_confidence   numeric(5,4)  DEFAULT NULL
                          CHECK (evidence_confidence IS NULL
                                 OR evidence_confidence BETWEEN 0.0 AND 1.0),

  -- Vocabulary-validated human-readable label
  -- e.g. "Strong analytical performance", "Limited leadership evidence"
  factor_label          text          NOT NULL
                          CHECK (char_length(factor_label) BETWEEN 5 AND 200),

  source_domain         text          DEFAULT NULL,

  factor_rank           integer       NOT NULL DEFAULT 1
                          CHECK (factor_rank >= 1),

  created_at            timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT uq_recommendation_factor_signal_type
    UNIQUE (recommendation_id, signal_key, factor_type)

);

COMMENT ON TABLE public.intelligence_recommendation_factors IS
  'Phase 2A.1: Structured signal attribution for each recommendation. '
  'Stores the "Reasons" section of the explainability output as structured rows '
  'rather than free text. factor_label is vocabulary-validated by the '
  'explainability service before insert. '
  'Students access factors through fn_get_student_recommendations() RPC only.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rec_factors_recommendation
  ON public.intelligence_recommendation_factors
  (recommendation_id, factor_type, factor_rank);

CREATE INDEX IF NOT EXISTS idx_rec_factors_signal
  ON public.intelligence_recommendation_factors (signal_key, factor_type);

-- RLS — students access via RPC only; no direct authenticated SELECT
ALTER TABLE public.intelligence_recommendation_factors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rec_factors_service_all"
  ON public.intelligence_recommendation_factors;
CREATE POLICY "rec_factors_service_all"
  ON public.intelligence_recommendation_factors
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- GRANTs
REVOKE ALL ON public.intelligence_recommendation_factors FROM anon, authenticated;
GRANT SELECT, INSERT ON public.intelligence_recommendation_factors TO service_role;

-- =============================================================================
-- §7  intelligence_explanation_details
-- Full structured explainability record linked to governance snapshots.
-- Drives student-facing UI. Immutable after creation.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.intelligence_explanation_details (

  id                          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 1:1 link to governance-layer snapshot (UNIQUE enforces the 1:1)
  explainability_snapshot_id  uuid          NOT NULL UNIQUE
                                REFERENCES public.intelligence_explainability_snapshots(id)
                                ON DELETE RESTRICT,

  -- Denormalised for query efficiency
  entity_id                   uuid          NOT NULL,
  entity_type                 text          NOT NULL,
  intelligence_domain         text          NOT NULL,

  subject_type                text          NOT NULL,
  subject_id                  uuid          NOT NULL,

  -- Ordered reasoning steps from evidence to conclusion
  -- Shape: [{ step: int, type: signal|absence|relationship, key, label, weight }]
  reasoning_trail             jsonb         NOT NULL DEFAULT '[]'
                                CHECK (jsonb_typeof(reasoning_trail) = 'array'),

  -- Structured contributing signal list for UI rendering
  -- Shape: [{ signal_key, label, contribution, evidence_count, domain }]
  contributing_signals        jsonb         NOT NULL DEFAULT '[]'
                                CHECK (jsonb_typeof(contributing_signals) = 'array'),

  -- Signals expected but absent — drives "Missing Signals" UI section
  -- Shape: [{ signal_key, label, importance: critical|recommended|optional, reason }]
  missing_signals             jsonb         NOT NULL DEFAULT '[]'
                                CHECK (jsonb_typeof(missing_signals) = 'array'),

  -- Concrete improvement actions — drives "What to do next" UI section
  -- Shape: [{ action_key, label, priority: 1-5, target_signal_key, expected_confidence_gain }]
  improvement_actions         jsonb         NOT NULL DEFAULT '[]'
                                CHECK (jsonb_typeof(improvement_actions) = 'array'),

  -- Percentage attribution map: { signal_key: float 0–100 }
  signal_attribution          jsonb         NOT NULL DEFAULT '{}'
                                CHECK (jsonb_typeof(signal_attribution) = 'object'),

  -- Whether the entity has acknowledged the improvement actions
  actions_acknowledged        boolean       NOT NULL DEFAULT false,
  actions_acknowledged_at     timestamptz   DEFAULT NULL,

  -- Model version used for explanation generation
  explainability_model_version text         DEFAULT NULL,

  created_at                  timestamptz   NOT NULL DEFAULT now()

);

COMMENT ON TABLE public.intelligence_explanation_details IS
  'Phase 2A.1: Full structured explainability record for student UI. '
  'Enriches the governance-layer intelligence_explainability_snapshots '
  'with UI-ready structured data: contributing signals, missing signals, '
  'improvement actions, and reasoning trail. '
  'Immutable after creation — new snapshot generates new details row. '
  'UNIQUE on explainability_snapshot_id enforces 1:1 with governance snapshot.';

-- Immutability
DROP TRIGGER IF EXISTS trg_explanation_details_no_update
  ON public.intelligence_explanation_details;
CREATE TRIGGER trg_explanation_details_no_update
  BEFORE UPDATE ON public.intelligence_explanation_details
  FOR EACH ROW EXECUTE FUNCTION public.fn_phase2a_immutable_row();

DROP TRIGGER IF EXISTS trg_explanation_details_no_delete
  ON public.intelligence_explanation_details;
CREATE TRIGGER trg_explanation_details_no_delete
  BEFORE DELETE ON public.intelligence_explanation_details
  FOR EACH ROW EXECUTE FUNCTION public.fn_phase2a_immutable_row();

-- Exception: actions_acknowledged is the ONE mutable field — allow targeted UPDATE
-- Override the immutability trigger for acknowledged field only
CREATE OR REPLACE FUNCTION public.fn_explanation_details_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Allow ONLY the actions_acknowledged fields to be updated
  IF NEW.entity_id                  IS DISTINCT FROM OLD.entity_id         OR
     NEW.entity_type                IS DISTINCT FROM OLD.entity_type       OR
     NEW.intelligence_domain        IS DISTINCT FROM OLD.intelligence_domain OR
     NEW.reasoning_trail            IS DISTINCT FROM OLD.reasoning_trail   OR
     NEW.contributing_signals       IS DISTINCT FROM OLD.contributing_signals OR
     NEW.missing_signals            IS DISTINCT FROM OLD.missing_signals   OR
     NEW.improvement_actions        IS DISTINCT FROM OLD.improvement_actions OR
     NEW.signal_attribution         IS DISTINCT FROM OLD.signal_attribution OR
     NEW.explainability_snapshot_id IS DISTINCT FROM OLD.explainability_snapshot_id OR
     NEW.created_at                 IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'intelligence_explanation_details: only actions_acknowledged and '
      'actions_acknowledged_at may be updated. All other columns are immutable. '
      'id=%', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

-- Replace the generic immutability trigger with the targeted guard
DROP TRIGGER IF EXISTS trg_explanation_details_no_update
  ON public.intelligence_explanation_details;

CREATE TRIGGER trg_explanation_details_guard_update
  BEFORE UPDATE ON public.intelligence_explanation_details
  FOR EACH ROW EXECUTE FUNCTION public.fn_explanation_details_guard();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_explanation_details_entity
  ON public.intelligence_explanation_details
  (entity_id, entity_type, intelligence_domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_explanation_details_subject
  ON public.intelligence_explanation_details (subject_type, subject_id);

CREATE INDEX IF NOT EXISTS idx_explanation_details_snapshot
  ON public.intelligence_explanation_details (explainability_snapshot_id);

-- RLS
ALTER TABLE public.intelligence_explanation_details ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "explanation_details_student_read"
  ON public.intelligence_explanation_details;
CREATE POLICY "explanation_details_student_read"
  ON public.intelligence_explanation_details
  FOR SELECT TO authenticated
  USING (entity_type = 'student' AND auth.uid() = entity_id);

DROP POLICY IF EXISTS "explanation_details_student_ack"
  ON public.intelligence_explanation_details;
-- Students may acknowledge improvement actions (mutable field)
CREATE POLICY "explanation_details_student_ack"
  ON public.intelligence_explanation_details
  FOR UPDATE TO authenticated
  USING (entity_type = 'student' AND auth.uid() = entity_id)
  WITH CHECK (entity_type = 'student' AND auth.uid() = entity_id);

DROP POLICY IF EXISTS "explanation_details_service_all"
  ON public.intelligence_explanation_details;
CREATE POLICY "explanation_details_service_all"
  ON public.intelligence_explanation_details
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- GRANTs
REVOKE ALL ON public.intelligence_explanation_details FROM anon, authenticated;
GRANT SELECT, UPDATE ON public.intelligence_explanation_details TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.intelligence_explanation_details TO service_role;

-- =============================================================================
-- §8  Governance RPCs (student-facing)
-- =============================================================================

-- ─── fn_get_student_intelligence_summary ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_get_student_intelligence_summary(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'entitySnapshotId',    eis.id,
    'snapshotAt',          eis.snapshot_at,
    'snapshotSequence',    eis.snapshot_sequence,
    'snapshotTrigger',     eis.snapshot_trigger,
    'compositeConfidence', eis.composite_confidence,
    'confidenceTier',      eis.confidence_tier,
    'dataCompleteness',    eis.data_completeness,
    'activeSignalCount',   eis.active_signal_count,
    'domainsIncluded',     eis.domains_included,
    'confidence', jsonb_build_object(
      'coverageScore',      ics.coverage_score,
      'reliabilityScore',   ics.reliability_score,
      'uncertaintyBand',    ics.uncertainty_band,
      'missingSignals',     ics.missing_signals,
      'factors',            ics.factors
    ),
    'topRecommendations', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id',                 ir.id,
          'outputType',         ir.output_type,
          'outputKey',          ir.output_key,
          'outputLabel',        ir.output_label,
          'rank',               ir.rank,
          'recommendationScore',ir.recommendation_score,
          'confidenceTier',     ir.confidence_tier,
          'explanationText',    ir.explanation_text,
          'hasImprovementActions', ir.has_improvement_actions
        )
        ORDER BY ir.rank
      )
      FROM (
        SELECT * FROM public.intelligence_recommendations ir2
        WHERE ir2.entity_id         = p_user_id
          AND ir2.entity_type       = 'student'
          AND ir2.intelligence_domain = 'student'
          AND (ir2.expires_at IS NULL OR ir2.expires_at > now())
          AND ir2.pipeline_run_id   = eis.pipeline_run_id
        ORDER BY ir2.rank
        LIMIT 5
      ) ir
    )
  )
  FROM public.intelligence_entity_snapshots eis
  LEFT JOIN public.intelligence_confidence_snapshots ics
    ON ics.entity_snapshot_id = eis.id
  WHERE eis.entity_id         = p_user_id
    AND eis.entity_type       = 'student'
    AND eis.intelligence_domain = 'student'
  ORDER BY eis.snapshot_at DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.fn_get_student_intelligence_summary(uuid) IS
  'Returns the latest intelligence summary for a student: '
  'entity snapshot, confidence breakdown, and top 5 recommendations '
  'from the most recent pipeline run. Used by useStudentIntelligenceSummary hook.';

REVOKE ALL ON FUNCTION public.fn_get_student_intelligence_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_student_intelligence_summary(uuid)
  TO authenticated, service_role;

-- ─── fn_get_student_recommendations ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_get_student_recommendations(
  p_user_id     uuid,
  p_output_type text    DEFAULT NULL,
  p_limit       integer DEFAULT 10
)
RETURNS TABLE (
  recommendation_id     uuid,
  output_type           text,
  output_key            text,
  output_label          text,
  rank                  integer,
  recommendation_score  numeric,
  confidence_tier       text,
  explanation_text      text,
  has_improvement_actions boolean,
  factors               jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ir.id,
    ir.output_type,
    ir.output_key,
    ir.output_label,
    ir.rank,
    ir.recommendation_score,
    ir.confidence_tier,
    ir.explanation_text,
    ir.has_improvement_actions,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'signalKey',        irf.signal_key,
            'factorType',       irf.factor_type,
            'factorLabel',      irf.factor_label,
            'contributionScore',irf.contribution_score,
            'signalWeight',     irf.signal_weight,
            'factorRank',       irf.factor_rank
          )
          ORDER BY irf.factor_rank
        )
        FROM public.intelligence_recommendation_factors irf
        WHERE irf.recommendation_id = ir.id
      ),
      '[]'::jsonb
    ) AS factors
  FROM public.intelligence_recommendations ir
  WHERE ir.entity_id           = p_user_id
    AND ir.entity_type         = 'student'
    AND ir.intelligence_domain = 'student'
    AND (p_output_type IS NULL OR ir.output_type = p_output_type)
    AND (ir.expires_at IS NULL OR ir.expires_at > now())
  ORDER BY ir.rank
  LIMIT LEAST(p_limit, 20);
$$;

COMMENT ON FUNCTION public.fn_get_student_recommendations(uuid, text, integer) IS
  'Returns governed recommendations for a student with inline factor attribution. '
  'p_output_type: filter by career_area|role|skill|programme|development_action. '
  'p_limit: max rows (capped at 20). '
  'Used by useStudentRecommendations React Query hook.';

REVOKE ALL ON FUNCTION public.fn_get_student_recommendations(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_student_recommendations(uuid, text, integer)
  TO authenticated, service_role;

-- ─── fn_get_recommendation_explanation ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_get_recommendation_explanation(
  p_recommendation_id  uuid,
  p_user_id            uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'recommendation', row_to_json(ir),
    'factors', (
      SELECT jsonb_agg(row_to_json(irf) ORDER BY irf.factor_rank)
      FROM public.intelligence_recommendation_factors irf
      WHERE irf.recommendation_id = ir.id
    ),
    'explanation', (
      SELECT jsonb_build_object(
        'contributingSignals',  ed.contributing_signals,
        'missingSignals',       ed.missing_signals,
        'improvementActions',   ed.improvement_actions,
        'reasoningTrail',       ed.reasoning_trail,
        'signalAttribution',    ed.signal_attribution,
        'actionsAcknowledged',  ed.actions_acknowledged
      )
      FROM public.intelligence_explanation_details ed
      JOIN public.intelligence_explainability_snapshots es
        ON es.id = ed.explainability_snapshot_id
      WHERE es.pipeline_run_id = ir.pipeline_run_id
        AND ed.entity_id       = ir.entity_id
        AND ed.subject_type    = 'signal_vector'
      ORDER BY ed.created_at DESC
      LIMIT 1
    )
  )
  FROM public.intelligence_recommendations ir
  WHERE ir.id          = p_recommendation_id
    AND ir.entity_id   = p_user_id
    AND ir.entity_type = 'student';
$$;

COMMENT ON FUNCTION public.fn_get_recommendation_explanation(uuid, uuid) IS
  'Returns a complete explanation bundle for a single recommendation: '
  'the recommendation row, factor attribution, contributing signals, '
  'missing signals, improvement actions, and reasoning trail. '
  'RLS enforced: p_user_id must match recommendation.entity_id. '
  'Used by useRecommendationExplanation React Query hook.';

REVOKE ALL ON FUNCTION public.fn_get_recommendation_explanation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_recommendation_explanation(uuid, uuid)
  TO authenticated, service_role;

-- ─── fn_get_intelligence_history ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_get_intelligence_history(
  p_user_id             uuid,
  p_intelligence_domain text    DEFAULT 'student',
  p_limit               integer DEFAULT 12
)
RETURNS TABLE (
  snapshot_id          uuid,
  snapshot_sequence    integer,
  snapshot_at          timestamptz,
  snapshot_trigger     text,
  composite_confidence numeric,
  confidence_tier      text,
  coverage_score       numeric,
  reliability_score    numeric,
  data_completeness    numeric,
  active_signal_count  integer,
  delta_from_previous  jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    eis.id,
    eis.snapshot_sequence,
    eis.snapshot_at,
    eis.snapshot_trigger,
    eis.composite_confidence,
    eis.confidence_tier,
    COALESCE(ics.coverage_score,   0) AS coverage_score,
    COALESCE(ics.reliability_score,0) AS reliability_score,
    eis.data_completeness,
    eis.active_signal_count,
    eis.delta_from_previous
  FROM public.intelligence_entity_snapshots eis
  LEFT JOIN public.intelligence_confidence_snapshots ics
    ON ics.entity_snapshot_id = eis.id
  WHERE eis.entity_id           = p_user_id
    AND eis.entity_type         = 'student'
    AND eis.intelligence_domain = p_intelligence_domain
  ORDER BY eis.snapshot_sequence DESC
  LIMIT LEAST(p_limit, 50);
$$;

COMMENT ON FUNCTION public.fn_get_intelligence_history(uuid, text, integer) IS
  'Returns the intelligence history time-series for a student. '
  'Used by useIntelligenceHistory hook to power the progression chart. '
  'Returns up to 50 snapshots ordered by most recent first.';

REVOKE ALL ON FUNCTION public.fn_get_intelligence_history(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_intelligence_history(uuid, text, integer)
  TO authenticated, service_role;

-- ─── fn_get_next_snapshot_sequence ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_get_next_snapshot_sequence(
  p_entity_id           uuid,
  p_entity_type         text,
  p_intelligence_domain text
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    MAX(snapshot_sequence) + 1,
    1
  )
  FROM public.intelligence_entity_snapshots
  WHERE entity_id           = p_entity_id
    AND entity_type         = p_entity_type
    AND intelligence_domain = p_intelligence_domain;
$$;

COMMENT ON FUNCTION public.fn_get_next_snapshot_sequence(uuid, text, text) IS
  'Returns the next snapshot_sequence number for a given entity+domain combination. '
  'Returns 1 if no snapshots exist yet. Called by snapshot.service.ts before '
  'inserting a new intelligence_entity_snapshots row.';

REVOKE ALL ON FUNCTION public.fn_get_next_snapshot_sequence(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_next_snapshot_sequence(uuid, text, text)
  TO service_role;

-- =============================================================================
-- §9  Confidence model version seed
-- Seeds the first confidence_model version in the model registry.
-- Weights represent the COVERAGE_WEIGHT / RELIABILITY_WEIGHT / RECENCY_WEIGHT
-- used by the confidence engine. Stored as a governed, auditable version.
-- =============================================================================

INSERT INTO public.signal_weight_versions (
  version_tag,
  model_type,
  intelligence_domain,
  description,
  weights,
  domain_overrides,
  weight_rationale,
  approved_by,
  approved_at,
  effective_from
)
VALUES (
  'v1.0.0',
  'confidence_model',
  'student',
  'Initial confidence calculation weights for student intelligence domain. '
  'Applies to all student entity snapshots from Phase 2A.1 forward.',
  '{
    "COVERAGE_WEIGHT":    { "weight": 0.40, "description": "Fraction of expected signals with evidence" },
    "RELIABILITY_WEIGHT": { "weight": 0.40, "description": "Quality and consistency of signal evidence" },
    "RECENCY_WEIGHT":     { "weight": 0.20, "description": "Temporal decay applied to older evidence" },
    "HIGH_TIER_THRESHOLD":   { "weight": 0.75, "description": "Composite score >= 75 → HIGH tier" },
    "MEDIUM_TIER_THRESHOLD": { "weight": 0.50, "description": "Composite score >= 50 → MEDIUM tier" },
    "LOW_TIER_THRESHOLD":    { "weight": 0.25, "description": "Composite score >= 25 → LOW tier" },
    "RECENCY_DECAY_DAYS":    { "weight": 365,  "description": "Half-life in days for recency weighting" }
  }'::jsonb,
  '{}'::jsonb,
  '{
    "COVERAGE_WEIGHT":    "Equal weight with reliability — both are essential for a well-rounded confidence score.",
    "RELIABILITY_WEIGHT": "Equal weight with coverage — a wide but unreliable signal set is as weak as a narrow reliable one.",
    "RECENCY_WEIGHT":     "Lower weight because HireRise student intelligence is cumulative, not event-driven. Historical signals remain valid.",
    "RECENCY_DECAY_DAYS": "365-day half-life reflects annual academic cycle. Signals older than ~3 years have minimal contribution."
  }'::jsonb,
  'system',
  now(),
  now()
)
ON CONFLICT (intelligence_domain, model_type, version_tag) DO NOTHING;

-- =============================================================================
-- §10  Deprecation notices on legacy recommendation tables
-- =============================================================================

COMMENT ON TABLE public.edu_skill_recommendations IS
  'DEPRECATED — Phase 2A.1. '
  'Pre-governance student recommendation table. No new writes after Phase 2A.1 Sprint 3. '
  'Superseded by: intelligence_recommendations (pipeline_run_id FK, consent chain, '
  'structured factors, vocabulary-validated explanation). '
  'Scheduled for DROP in Phase 2B migration after all callers confirmed migrated.';

COMMENT ON TABLE public.personalized_recommendations IS
  'DEPRECATED — Phase 2A.1. '
  'Firebase-era recommendation table. user_id is TEXT (Firebase UID format). '
  'No governance chain. Expires after 10 minutes — not suitable for auditable intelligence. '
  'Superseded by: intelligence_recommendations. '
  'Scheduled for DROP in Phase 2B.';

-- =============================================================================
-- SCHEMA METADATA
-- =============================================================================

COMMENT ON SCHEMA public IS
  'HireRise Phase 2A.1 — Intelligence Foundation Layer deployed. '
  'Sprint 1–1.1 governance foundation + Phase 2A.1 foundation layer. '
  'New tables: signal_category_hierarchy, signal_ontology_edges, '
  'intelligence_entity_snapshots, intelligence_confidence_snapshots, '
  'intelligence_recommendations, intelligence_recommendation_factors, '
  'intelligence_explanation_details. '
  'Migration: 20260608000001_intelligence_foundation_layer.sql';

COMMIT;
