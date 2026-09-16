-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260902010000_signal_registry_commercial_orientation.sql
-- Phase 3B.2 — Academic Signal Derivation (Student-Native Signal Foundation)
--
-- No schema change. This is a data-only seed migration adding exactly one
-- new row to intelligence_signal_registry, following the project's own
-- documented convention (core/src/modules/student-onboarding/constants/
-- intelligence.js, "ADDING A SIGNAL" comment block):
--   1. Add to the appropriate group in constants/intelligence.js.        [done]
--   2. Add to SIGNAL_REGISTRY_METADATA in constants/intelligence.js.     [done]
--   3. Add a migration entry to intelligence_signal_registry seed.       [this file]
--   4. Update signal_relationships if applicable.                       [n/a — no
--      relationship to another signal was identified in this phase]
--
-- WHY THIS SIGNAL:
--   Student v2's real 15-subject academic taxonomy includes economics,
--   commerce, accountancy, and business_studies. The pre-existing 5-key
--   academic signal set (analytical_strength, quantitative_reasoning,
--   language_affinity, scientific_orientation, social_science_interest)
--   had no home for any of these — it was built for an older 5-subject
--   model. The registry and all local signal-key constants were searched
--   for a near-duplicate ("commerce", "business", "economic") before
--   adding this; none existed.
--
-- WHY NO SCHEMA CHANGE WAS NEEDED:
--   student_signal_evidence.signal_key and student_signal_vectors both
--   store signal keys as free text (format-checked by regex only, no FK
--   to this registry table — see 20260525000001_cross_domain_intelligence_
--   phase3d.sql, chk_signal_key_format / chk_signal_key_evidence_format).
--   Only the registry table itself needed the new row.
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
(
  'commercial_orientation',
  'v1',
  'subject_affinity',
  'academic',
  ARRAY['academic']::intelligence_domain_enum[],
  'weighted_average',
  true,
  true,
  true,
  'Commercial Orientation',
  'Academic performance in commerce, business studies, accountancy, and economics, providing a commercial-domain academic signal.',
  'v1'
)
ON CONFLICT (signal_key, taxonomy_version) DO NOTHING;