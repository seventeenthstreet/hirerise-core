'use strict';

/**
 * @file src/modules/onboarding/__tests__/onboarding.careerReport.spceOutputDiff.test.js
 *
 * WP-SPCE-03A — Career Report Migration — Output-Diff Verification.
 *
 * Per WP-SPCE-03A's mandated migration strategy ("1. Existing validation ->
 * 2. Parallel SPCE evaluation -> 3. Output comparison -> 4. Migration ->
 * 5. Remove duplicated readiness logic ONLY after outputs are proven
 * identical"), this file is step 3, and was run to green BEFORE
 * onboarding.careerReport.service.js was touched.
 *
 * It does not exercise generateCareerReport() itself (that's
 * onboarding.careerReport.canonicalFallback.test.js and
 * onboarding.careerReport.spceMigration.test.js). Instead it isolates the
 * exact readiness PREDICATE that existed in the pre-migration source —
 * reproduced verbatim below as `legacyReadiness()`, copied from
 * onboarding.careerReport.service.js's git history at the WP-SPCE-02B
 * baseline (the two `if` blocks that guarded the 422s) — and compares its
 * verdict, fixture-by-fixture, against
 * readinessEngine.evaluate('career_report', ...) fed the equivalent
 * canonical-shape profile.
 *
 * `legacyReadiness()` is intentionally NOT imported from the production
 * file: the whole point of an output-diff is an independent
 * re-implementation of the OLD behavior to compare against the NEW
 * mechanism, not a comparison of the new mechanism against itself.
 *
 * Compared for every fixture:
 *   - the readiness verdict (ready / not-ready)
 *   - WHICH of the two legacy error messages would fire when not ready
 *     ("Add education or experience first" vs "Target role required"),
 *     since WP-SPCE-03A requires validation messages to remain identical,
 *     not just the pass/fail outcome
 */

const { evaluate } = require('../../../domain/profileReadiness/readinessEngine');
const { CAPABILITY_IDS } = require('../../../domain/profileReadiness/capabilityRegistry');

/**
 * Verbatim reproduction of the pre-migration readiness predicate from
 * onboarding.careerReport.service.js (WP-SPCE-02B baseline, lines
 * 119-193): given already-merged effectiveEducation/effectiveExperience
 * and already-resolved expectedRoleIds (the role-resolution side effects
 * themselves are out of scope for this diff — they run identically before
 * either legacy or SPCE readiness is ever evaluated), returns which of the
 * two legacy 422s would fire, or null if the legacy code would proceed.
 *
 * @param {Array} effectiveEducation
 * @param {Array} effectiveExperience
 * @param {Array} expectedRoleIds
 * @returns {'EDU_EXP' | 'ROLE' | null}
 */
function legacyReadiness(effectiveEducation, effectiveExperience, expectedRoleIds) {
  if (!effectiveEducation.length && !effectiveExperience.length) {
    return 'EDU_EXP';
  }
  if (!expectedRoleIds.length) {
    return 'ROLE';
  }
  return null;
}

/**
 * New (SPCE) readiness predicate, using the exact mapping the migrated
 * production code uses: effectiveEducation/effectiveExperience/
 * expectedRoleIds folded into a minimal canonical-shape profile object.
 *
 * @param {Array} effectiveEducation
 * @param {Array} effectiveExperience
 * @param {Array} expectedRoleIds
 * @returns {'EDU_EXP' | 'ROLE' | 'UNRECOGNIZED' | null}
 */
function spceReadiness(effectiveEducation, effectiveExperience, expectedRoleIds) {
  const result = evaluate(CAPABILITY_IDS.CAREER_REPORT, {
    education: effectiveEducation,
    experience: effectiveExperience,
    careerGoals: { expectedRoleIds },
  });

  if (result.isReady) return null;

  const eduExpFailed =
    result.missingFields.includes('education') ||
    result.missingFields.includes('experience');
  if (eduExpFailed) return 'EDU_EXP';

  if (result.missingFields.includes('careerGoals.expectedRoleIds')) return 'ROLE';

  return 'UNRECOGNIZED';
}

// A broad combinatorial fixture set: every combination of
// (education, experience, expectedRoleIds) presence/absence, plus the
// _isPresent() edge cases readinessEngine.js itself already treats
// specially (empty array vs non-empty array) — since those are exactly
// the values these three fields can structurally take coming out of the
// pre-migration merge/resolution code (all three are always arrays by
// construction at the point readiness is checked).
const EMPTY = [];
const NON_EMPTY = [{ x: 1 }];
const NON_EMPTY_2 = [{ x: 1 }, { x: 2 }];

const FIXTURES = [
  { label: 'all empty',                          education: EMPTY,      experience: EMPTY,      role: EMPTY },
  { label: 'education only',                     education: NON_EMPTY,  experience: EMPTY,      role: EMPTY },
  { label: 'experience only',                    education: EMPTY,      experience: NON_EMPTY,  role: EMPTY },
  { label: 'education + experience, no role',    education: NON_EMPTY,  experience: NON_EMPTY,  role: EMPTY },
  { label: 'role only',                          education: EMPTY,      experience: EMPTY,      role: NON_EMPTY },
  { label: 'education + role',                   education: NON_EMPTY,  experience: EMPTY,      role: NON_EMPTY },
  { label: 'experience + role',                  education: EMPTY,      experience: NON_EMPTY,  role: NON_EMPTY },
  { label: 'education + experience + role',      education: NON_EMPTY,  experience: NON_EMPTY,  role: NON_EMPTY },
  { label: 'multi-entry education + role',       education: NON_EMPTY_2, experience: EMPTY,     role: NON_EMPTY },
  { label: 'multi-entry role, edu+exp missing',  education: EMPTY,      experience: EMPTY,      role: NON_EMPTY_2 },
  { label: 'multi-entry everything',             education: NON_EMPTY_2, experience: NON_EMPTY_2, role: NON_EMPTY_2 },
];

describe('WP-SPCE-03A output-diff — legacy Career Report readiness vs SPCE evaluate()', () => {
  it.each(FIXTURES)(
    'produces an identical verdict for fixture: $label',
    ({ education, experience, role }) => {
      const legacy = legacyReadiness(education, experience, role);
      const spce = spceReadiness(education, experience, role);

      expect(spce).toBe(legacy);
    }
  );

  it('never produces an UNRECOGNIZED SPCE verdict across the whole fixture set', () => {
    for (const { education, experience, role } of FIXTURES) {
      expect(spceReadiness(education, experience, role)).not.toBe('UNRECOGNIZED');
    }
  });

  it('sanity check: the fixture set actually exercises both legacy branches and the ready case', () => {
    const verdicts = new Set(
      FIXTURES.map(({ education, experience, role }) => legacyReadiness(education, experience, role))
    );
    expect(verdicts).toEqual(new Set(['EDU_EXP', 'ROLE', null]));
  });
});
