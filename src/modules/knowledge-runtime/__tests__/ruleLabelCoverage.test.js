'use strict';

/**
 * modules/knowledge-runtime/__tests__/ruleLabelCoverage.test.js
 *
 * WP-XAI2-01B — Finding 4 (Independent Verification, Observation).
 *
 * Regression protection only — this test does not evaluate or redesign
 * either runtime. It statically reads the `DecisionEngine` source for
 * every `ruleId` it can push into `decisionFactors` (via its internal
 * `_factor('<ruleId>', ...)` helper) and asserts each one is present in
 * `ExplainabilityRuntime.RULE_LABELS`.
 *
 * Why static source inspection rather than executing `DecisionEngine`:
 * exercising every rule branch (DR-TYP-01/DR-FAIR-01/DR-INT-01/DR-ESC-01/
 * DR-ESC-02/DR-SUF-01/DR-SUF-02/DR-CNF-01/DR-PRI-01/DR-PRI-02) end-to-end
 * would require constructing a full set of upstream mocks already covered,
 * branch by branch, in `decision.service.test.js`. Re-deriving that here
 * would duplicate existing coverage rather than add new protection. A
 * direct source read of every `_factor('<ruleId>', ...)` call site is a
 * complete, lower-maintenance enumeration of "every rule ID the Decision
 * Runtime can emit" and fails immediately if a future rule ID is added to
 * `decision.service.js` without a matching `RULE_LABELS` entry — the
 * exact drift this Finding exists to catch.
 */

const fs = require('fs');
const path = require('path');

const { RULE_LABELS } = require('../explainability/explainability.service');

const DECISION_SERVICE_PATH = path.join(__dirname, '..', 'decision', 'decision.service.js');

function extractEmittedRuleIds(source) {
  // Matches: this._factor('DR-XXX-NN', ...
  const pattern = /_factor\(\s*'([A-Z]+-[A-Z]+-\d+)'/g;
  const ids = new Set();
  let match;
  // eslint-disable-next-line no-cond-assign
  while ((match = pattern.exec(source)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

describe('Decision Runtime <-> Explainability Runtime rule label coverage', () => {
  it('finds at least one rule ID in decision.service.js (sanity check that the scan itself works)', () => {
    const source = fs.readFileSync(DECISION_SERVICE_PATH, 'utf8');
    const ruleIds = extractEmittedRuleIds(source);
    expect(ruleIds.size).toBeGreaterThan(0);
  });

  it('has a RULE_LABELS entry for every rule ID DecisionEngine can emit', () => {
    const source = fs.readFileSync(DECISION_SERVICE_PATH, 'utf8');
    const ruleIds = extractEmittedRuleIds(source);

    const missingLabels = [...ruleIds].filter((ruleId) => !(ruleId in RULE_LABELS));

    expect(missingLabels).toEqual([]);
  });
});
