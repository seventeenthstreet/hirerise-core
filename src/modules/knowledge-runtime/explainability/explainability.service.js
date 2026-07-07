'use strict';

/**
 * modules/knowledge-runtime/explainability/explainability.service.js
 *
 * ExplainabilityRuntime — WP-IMP-06 v1, implemented per the approved
 * Stage 1 (Repository Verification) and Stage 2 (Implementation
 * Clarification Review) baseline, consuming the frozen
 * `documents/WP-DIF-01/DECISION_OUTPUT_CONTRACT.md` Objective 9
 * ("Explainability Contract") and `DECISION_RULE_CATALOG.md`.
 *
 * ============================================================================
 * SCOPE
 * ============================================================================
 * This runtime is NOT a decision engine. It never changes a decision — it
 * only explains an already-computed Decision (the frozen output of
 * `decision.service.js` `DecisionEngine.decide()`). It is:
 *   - pure         — no side effects other than logging
 *   - deterministic — same Decision in -> same ExplanationPayload out, always
 *   - synchronous  — `explain()` is not async
 *   - stateless    — no instance state beyond injected `logger`/`config`
 *   - repository-isolated — no repository, no Supabase/BaseRepository
 *     access, no SQL, no API calls, no AI/LLM call of any kind
 *
 * ============================================================================
 * CONSUMER CONTRACT (Decision Output Contract §Objective 8/9)
 * ============================================================================
 * Only the fields named in `CONSUMABLE_DECISION_FIELDS` below are read from
 * the incoming Decision object. `userId` is deliberately never read, even
 * though it is present on the real Decision object (`decision.service.js`
 * `_assemble()`) — see Field Redaction below. Any field not in that list is
 * treated as undefined for the purposes of this runtime, per the approved
 * Clarification Review's "never consume undefined fields" instruction (i.e.
 * this runtime does not reach past the documented contract into
 * implementation-only internals of the Decision object).
 *
 * ============================================================================
 * RULE MAPPING
 * ============================================================================
 * `RULE_LABELS` is a static, version-controlled, immutable-at-runtime
 * Rule ID -> human-readable label table, sourced verbatim from
 * `documents/WP-DIF-01/DECISION_RULE_CATALOG.md`. No dynamic generation, no
 * AI, no configuration download. Unrecognized rule IDs fall back to a fixed
 * `UNKNOWN_RULE_LABEL` string rather than being invented.
 *
 * ============================================================================
 * CONFIDENCE EXPLANATION
 * ============================================================================
 * `confidence` in the ExplanationPayload is a deterministic summary
 * (numeric score pass-through + the already-computed IQF band label from
 * `Decision.confidenceBreakdown.bandLabel`) — it reuses
 * `ValidationService`/`DecisionEngine`'s existing confidence-tier mechanism
 * verbatim. No new confidence algorithm is introduced here.
 *
 * ============================================================================
 * EVIDENCE SUMMARY
 * ============================================================================
 * Only `availability` (boolean) and `count` (integer) are derived from
 * `Decision.evidence`. Raw evidence items and recommendation internals are
 * never exposed.
 *
 * ============================================================================
 * FIELD REDACTION (approved exposure policy)
 * ============================================================================
 * Never exposed by this runtime, in any payload field:
 *   - userId
 *   - raw Rule IDs (only the mapped `label` is exposed — see `_mapFactors`)
 *   - raw Evidence (only `evidenceSummary.available`/`.count`)
 *   - Reasoning Trace (`Decision.reasoningTrace` is never read)
 *   - internal runtime metadata / internal implementation details (only
 *     `ruleSetVersion` and rule-firing counts are surfaced in `metadata`)
 *
 * ============================================================================
 * DETERMINISM
 * ============================================================================
 * `generatedAt` is a pass-through of `Decision.timestamp` — this runtime
 * never calls `Date.now()`/`new Date()` itself, so no runtime timestamp
 * affects explanation content. Given the same Decision object, `explain()`
 * always returns a structurally and value-identical ExplanationPayload.
 * ============================================================================
 */

// Version-controlled, immutable at runtime. Bump only on a new approved
// Clarification Review for this contract.
const SCHEMA_VERSION = 'WP-IMP-06-v1.0';

// Static Rule ID -> label mapping. Source: verbatim from
// documents/WP-DIF-01/DECISION_RULE_CATALOG.md section headers.
const RULE_LABELS = Object.freeze({
  'DR-TYP-01': 'Decision-type eligibility check',
  'DR-FAIR-01': 'Enterprise fairness gate check',
  'DR-INT-01': 'Structural contract integrity check',
  'DR-ESC-01': 'Critical contradiction escalation check',
  'DR-ESC-02': 'Escalation trigger compounding check',
  'DR-SUF-01': 'Evidence sufficiency floor check',
  'DR-SUF-02': 'Profile completeness threshold check',
  'DR-CNF-01': 'Confidence band mapping',
  'DR-PRI-01': 'Recommendation-class priority assignment',
  'DR-PRI-02': 'Grade-level urgency adjustment',
});

const UNKNOWN_RULE_LABEL = 'Unrecognized decision rule';

// Static status -> headline template. No AI, no dynamic generation, no
// conversational phrasing — a short, deterministic label per status only.
const STATUS_HEADLINES = Object.freeze({
  DECISION_READY: 'Decision is ready for release.',
  PROVISIONAL: 'Decision is provisional, pending additional evidence.',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence to reach a decision.',
  ESCALATION_REQUIRED: 'Decision requires escalation to a counsellor.',
  WITHHELD: 'Decision has been withheld.',
});

const UNKNOWN_STATUS_HEADLINE = 'Decision status is unrecognized.';

// The only Decision Output Contract fields this runtime consumes.
// `userId` is intentionally absent — see module header, Field Redaction.
const CONSUMABLE_DECISION_FIELDS = Object.freeze([
  'decisionId',
  'timestamp',
  'decisionType',
  'status',
  'confidence',
  'confidenceBreakdown',
  'evidence',
  'decisionFactors',
  'metadata',
]);

class ExplainabilityRuntime {
  /**
   * @param {object} deps
   * @param {object} deps.logger — reused existing logging infrastructure; required, matching sibling services' constructor guard convention
   * @param {object} [deps.config]
   */
  constructor({ logger, config = {} } = {}) {
    if (!logger) {
      throw new Error('[ExplainabilityRuntime] logger is required');
    }

    this._logger = logger;
    this._config = config;
  }

  // ─────────────────────────────────────────────────────────
  // PUBLIC ENTRY POINT
  // ─────────────────────────────────────────────────────────

  /**
   * Produces the ExplanationPayload for an already-computed Decision.
   * Pure, deterministic, synchronous — no repository/DB/API/AI access.
   *
   * @param {object} decision — a Decision object produced by `DecisionEngine.decide()`
   * @returns {object} a frozen ExplanationPayload
   */
  explain(decision) {
    if (!decision || typeof decision !== 'object') {
      throw new Error('[ExplainabilityRuntime] decision is required and must be an object');
    }

    const decisionId = decision.decisionId ?? null;
    const timestamp = decision.timestamp ?? null;
    const decisionType = decision.decisionType ?? null;
    const status = decision.status ?? null;
    const confidence = decision.confidence;
    const confidenceBreakdown = decision.confidenceBreakdown;
    const evidence = decision.evidence;
    const decisionFactors = decision.decisionFactors;
    const metadata = decision.metadata;

    const payload = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      decisionId,
      decisionType,
      generatedAt: timestamp,
      status,
      headline: this._headlineForStatus(status),
      confidence: this._confidenceSummary(confidence, confidenceBreakdown),
      factors: this._mapFactors(decisionFactors),
      evidenceSummary: this._evidenceSummary(evidence),
      metadata: this._metadataSummary(metadata, decisionFactors),
    });

    this._logger.info('[KnowledgeRuntime.Explainability] Explanation Generated', {
      decisionId: payload.decisionId,
      decisionType: payload.decisionType,
      status: payload.status,
    });

    return payload;
  }

  // ─────────────────────────────────────────────────────────
  // HELPERS — each pure, deterministic, private
  // ─────────────────────────────────────────────────────────

  /** @private */
  _headlineForStatus(status) {
    return STATUS_HEADLINES[status] ?? UNKNOWN_STATUS_HEADLINE;
  }

  /** @private */
  _confidenceSummary(confidence, confidenceBreakdown) {
    return Object.freeze({
      score: typeof confidence === 'number' ? confidence : null,
      band: confidenceBreakdown?.bandLabel ?? null,
    });
  }

  /**
   * Maps `decisionFactors[].ruleId` to its static label. The raw `ruleId`
   * is never included in the returned entry — only `label` — per the
   * approved Field Redaction policy (never expose raw Rule IDs).
   * @private
   */
  _mapFactors(decisionFactors) {
    if (!Array.isArray(decisionFactors)) return Object.freeze([]);

    return Object.freeze(
      decisionFactors.map((factor) =>
        Object.freeze({
          label: RULE_LABELS[factor?.ruleId] ?? UNKNOWN_RULE_LABEL,
          evaluated: Boolean(factor?.evaluated),
          fired: Boolean(factor?.fired),
          outcome: factor?.outcome ?? null,
        })
      )
    );
  }

  /**
   * Only availability + count. Never the raw evidence array itself.
   * @private
   */
  _evidenceSummary(evidence) {
    const list = Array.isArray(evidence) ? evidence : [];
    return Object.freeze({ available: list.length > 0, count: list.length });
  }

  /**
   * Non-internal, non-identifying aggregate metadata only.
   * @private
   */
  _metadataSummary(metadata, decisionFactors) {
    const factors = Array.isArray(decisionFactors) ? decisionFactors : [];
    return Object.freeze({
      ruleSetVersion: metadata?.ruleSetVersion ?? null,
      factorCount: factors.length,
      firedFactorCount: factors.filter((factor) => factor?.fired === true).length,
    });
  }
}

module.exports = ExplainabilityRuntime;
module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
module.exports.RULE_LABELS = RULE_LABELS;
module.exports.UNKNOWN_RULE_LABEL = UNKNOWN_RULE_LABEL;
module.exports.CONSUMABLE_DECISION_FIELDS = CONSUMABLE_DECISION_FIELDS;
