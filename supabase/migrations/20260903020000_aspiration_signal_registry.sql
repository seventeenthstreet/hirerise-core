-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260903020000_aspiration_signal_registry.sql
-- Phase 3B.5B — Aspiration Signalization (Family #1 Student-Native
-- Intelligence Layer)
--
-- No schema change. This is a data-only seed migration adding exactly 16
-- new rows to intelligence_signal_registry, following the project's own
-- documented convention (core/src/modules/student-onboarding/constants/
-- intelligence.js, "ADDING A SIGNAL" comment block) and the precedent set
-- by 20260902010000_signal_registry_commercial_orientation.sql:
--   1. Add to the appropriate group in constants/intelligence.js.        [done]
--   2. Add to SIGNAL_REGISTRY_METADATA in constants/intelligence.js.     [done]
--   3. Add a migration entry to intelligence_signal_registry seed.       [this file]
--   4. Update signal_relationships if applicable.                       [n/a — no
--      relationship to another signal was identified; Aspiration signals
--      are compatible only with the 'aspiration' domain and deliberately
--      never reinforce or contradict demonstrated-evidence signals]
--
-- PREREQUISITE: 20260903010000_aspiration_domain_enum.sql must have run
-- first — this file references the 'aspiration' intelligence_domain_enum
-- value it adds.
--
-- CONTRACT (Phase 3B.5B.0 — final):
--   • 11 career-interest signals, sourced from student_aspirations.
--     career_interests — stated occupational-field preference only.
--   • 5 career-value signals, sourced from student_aspirations.
--     motivation_driver — stated career-motivation orientation only.
--   • Neither represents aptitude, demonstrated ability, or psychological
--     certainty.
--   • All 16 rows share: primary_domain = 'aspiration',
--     compatible_domains = ARRAY['aspiration'] (never reinforced by other
--     domains), normalization_strategy = 'max_pooling' (presence-based:
--     selected = 1.0, not selected = no contribution — never 0.0),
--     taxonomy_version = 'v1', signal_version = 'v1'.
--   • category = 'meta': these are self-reported/declarative preference
--     statements, unlike every other existing signal category (all
--     derived from demonstrated performance, activity, or cognitive-
--     response evidence). 'meta' was the one pre-existing signal_category_
--     enum value with no current registry rows using it, and was chosen
--     as the closest fit after searching the registry for a more specific
--     existing category and finding none — see constants/intelligence.js
--     for the same rationale recorded alongside the runtime metadata.
--
-- WHY NO SCHEMA CHANGE WAS NEEDED (beyond the enum migration):
--   student_signal_evidence.signal_key and student_signal_vectors both
--   store signal keys as free text (format-checked by regex only, no FK
--   to this registry table — see 20260525000001_cross_domain_intelligence_
--   phase3d.sql, chk_signal_key_format / chk_signal_key_evidence_format).
--   Only the registry table itself needed new rows, plus the domain enum
--   value added in the preceding migration (student_signal_evidence.
--   source_domain and intelligence_signal_registry.primary_domain /
--   compatible_domains ARE typed as intelligence_domain_enum).
-- ─────────────────────────────────────────────────────────────────────────────

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
-- ── Career-interest signals (student_aspirations.career_interests) ─────────
(
  'career_interest_medicine', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Interest: Medicine',
  'Stated occupational-field preference for medicine. Represents self-reported interest only — not aptitude, ability, or demonstrated performance.',
  'v1'
),
(
  'career_interest_engineering', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Interest: Engineering',
  'Stated occupational-field preference for engineering. Represents self-reported interest only — not aptitude, ability, or demonstrated performance.',
  'v1'
),
(
  'career_interest_law', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Interest: Law',
  'Stated occupational-field preference for law. Represents self-reported interest only — not aptitude, ability, or demonstrated performance.',
  'v1'
),
(
  'career_interest_arts_design', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Interest: Arts & Design',
  'Stated occupational-field preference for arts and design. Represents self-reported interest only — not aptitude, ability, or demonstrated performance.',
  'v1'
),
(
  'career_interest_business', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Interest: Business',
  'Stated occupational-field preference for business. Represents self-reported interest only — not aptitude, ability, or demonstrated performance.',
  'v1'
),
(
  'career_interest_science', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Interest: Science',
  'Stated occupational-field preference for science. Represents self-reported interest only — not aptitude, ability, or demonstrated performance.',
  'v1'
),
(
  'career_interest_teaching', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Interest: Teaching',
  'Stated occupational-field preference for teaching. Represents self-reported interest only — not aptitude, ability, or demonstrated performance.',
  'v1'
),
(
  'career_interest_social', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Interest: Social',
  'Stated occupational-field preference for social/community-oriented work. Represents self-reported interest only — not aptitude, ability, or demonstrated performance.',
  'v1'
),
(
  'career_interest_defence', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Interest: Defence',
  'Stated occupational-field preference for defence. Represents self-reported interest only — not aptitude, ability, or demonstrated performance.',
  'v1'
),
(
  'career_interest_sports_fitness', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Interest: Sports & Fitness',
  'Stated occupational-field preference for sports and fitness. Represents self-reported interest only — not aptitude, ability, or demonstrated performance.',
  'v1'
),
(
  'career_interest_undecided', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Interest: Undecided',
  'Student has explicitly indicated no settled occupational-field preference yet. Mutually exclusive with all other career_interest_* signals for the same student (enforced by the aspiration validator).',
  'v1'
),
-- ── Career-value signals (student_aspirations.motivation_driver) ───────────
(
  'career_value_impact', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Value: Impact',
  'Stated career-motivation orientation toward making an impact. Represents self-reported orientation only — not psychological certainty or demonstrated values.',
  'v1'
),
(
  'career_value_financial', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Value: Financial',
  'Stated career-motivation orientation toward financial reward. Represents self-reported orientation only — not psychological certainty or demonstrated values.',
  'v1'
),
(
  'career_value_passion', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Value: Passion',
  'Stated career-motivation orientation toward personal passion. Represents self-reported orientation only — not psychological certainty or demonstrated values.',
  'v1'
),
(
  'career_value_prestige', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Value: Prestige',
  'Stated career-motivation orientation toward prestige. Represents self-reported orientation only — not psychological certainty or demonstrated values.',
  'v1'
),
(
  'career_value_autonomy', 'v1', 'meta', 'aspiration',
  ARRAY['aspiration']::intelligence_domain_enum[], 'max_pooling',
  true, true, true,
  'Career Value: Autonomy',
  'Stated career-motivation orientation toward autonomy. Represents self-reported orientation only — not psychological certainty or demonstrated values.',
  'v1'
)
ON CONFLICT (signal_key, taxonomy_version) DO NOTHING;
