'use strict';

/**
 * modules/knowledge-runtime/decision/decision.service.js
 *
 * DecisionEngine — WP-IMP-05 v1, implemented per the authoritative
 * baseline in `documents/WP-DIF-01/WP_IMP05_IMPLEMENTATION_CLARIFICATION.md`
 * Section 13 (Final Implementation Baseline). That document reconciles the
 * frozen WP-DIF-01 architecture (`DECISION_INTELLIGENCE_FRAMEWORK.md`,
 * `DECISION_OUTPUT_CONTRACT.md`, `DECISION_RULE_CATALOG.md`,
 * `DECISION_EXECUTION_MODEL.md`, `CONFIDENCE_AND_PRIORITY_FRAMEWORK.md`)
 * with the WP-ARB-01 final decision and the actual, verified repository
 * state. This file does not re-derive that reconciliation — it implements
 * it. Every non-obvious choice below cites the clarification section that
 * settled it.
 *
 * Service boundaries (Mission statement, ARCHITECT_FINAL_RECOMMENDATION.md):
 * this service calls ONLY `knowledgeService`, `studentService`,
 * `recommendationService`, `validationService` — no repository, no direct
 * Supabase/BaseRepository access, no SQL, no AI/LLM call of any kind.
 * `knowledgeService` is accepted as a required constructor dependency per
 * the Mission statement but is not called directly by this v1 — the
 * `skill` decision type's only knowledge lookup already happened inside
 * `RecommendationService._matchSkills()`; DecisionEngine only consumes the
 * result. It is wired in now so a future decision type that needs a direct
 * knowledge lookup does not require a constructor-signature change.
 *
 * ============================================================================
 * SCOPE (Clarification §10 / §13.1, extended by WP-XAI2-04)
 * ============================================================================
 * `skill` (WP-IMP-05) and, as of WP-XAI2-04, `career` are computable
 * decision types. Every other named decision type (programme, course,
 * scholarship, institution, futureSkill, occupation) still returns a
 * deterministic `WITHHELD` Decision via DR-TYP-01, citing
 * RecommendationService's own verbatim `UNIMPLEMENTED_GROUPS` reason
 * string. Placement is not a valid `decisionType` value at all (no
 * architectural source exists — DIF §Obj.2). `career` was explicitly the
 * only new decision type in the WP-XAI2-04 ADR's approved scope —
 * `programme`/`course`/`scholarship`/`institution`/`futureSkill`/
 * `occupation` remain exactly where WP-IMP-05 left them.
 *
 * ============================================================================
 * RULE ORDER (Clarification §6 / §13.4)
 * ============================================================================
 * DR-TYP-01 (priority 0) is evaluated first, before ValidationService is
 * ever invoked, for any decisionType outside the implemented set — per
 * `DECISION_RULE_CATALOG.md`'s own precondition ("evaluated before all
 * other rules... an unimplemented type has no valid candidate data to
 * evaluate against any other rule"). For `skill` decisions,
 * `ValidationService.validateDecisionReadiness()` is ALWAYS invoked first
 * (Mandatory Condition 3), then the rule chain runs in the order fixed by
 * `DECISION_EXECUTION_MODEL.md` §4.9, with DR-FAIR-01 inserted at
 * precedence category 1 per WP-XAI2-01 ADR-05 (immediately after DR-TYP-01,
 * ahead of everything else — a check whose frozen definition is "blocks
 * regardless of other scores" cannot correctly sit at a later tier):
 *   DR-FAIR-01 -> DR-INT-01 -> DR-ESC-01/02 -> DR-SUF-01/02 -> DR-CNF-01 -> DR-PRI-01/02
 *
 * ============================================================================
 * DOCUMENTED DATA GAPS (Clarification §3 C-2/C-7, honestly surfaced, never
 * fabricated — "do not infer, do not estimate")
 * ============================================================================
 * 1. `confidenceBreakdown`'s six named inputs (Evidence Coverage, Signal
 *    Completeness, Signal Consistency, Data Quality, Recommendation
 *    Stability, Profile Completeness) are NOT separately exposed by
 *    `ValidationService.validateDecisionReadiness()` today — only the
 *    aggregate `score` and `confidence` are. All six are therefore `null`
 *    in v1, and their names are listed verbatim in
 *    `metadata.unavailableConfidenceInputs`. Only the band label is
 *    populated.
 * 2. DR-PRI-01 (recommendation-class-derived priority) and DR-PRI-02
 *    (grade-level urgency modifier) cannot fire against real data today:
 *    `RecommendationService`'s skill candidates carry no
 *    PRIMARY/ALTERNATIVE/STRETCH/SAFETY/RISK-FLAGGED class field at all
 *    (confirmed against `recommendation.service.js` `_matchSkills()`), and
 *    `StudentService`'s composed profile carries no grade-level field
 *    (confirmed against `studentIntelligence.service.js` `_composeProfile()`
 *    — `academic.educationLevel` is not a grade level). `priority` is
 *    therefore assigned by a direct, deterministic status->tier mapping
 *    (see `_priorityForStatus`) rather than by class/grade inspection, and
 *    both rules are recorded as `evaluated: false` in `decisionFactors`
 *    with a `note` explaining why. This is a data-availability gap, not a
 *    reinterpretation of the rule.
 * 3. DR-ESC-02 (escalation trigger compounding, i.e. severity-level
 *    escalation) has no severity-level concept anywhere in
 *    `ValidationService`'s real `qualityFlags` output — only the presence
 *    or absence of a `CLUSTER_DRIFT_*` flag exists, which is exactly
 *    DR-ESC-01's own literal precondition. DR-ESC-02 is therefore recorded
 *    as `evaluated: false` (nothing to compound); DR-ESC-01 is evaluated
 *    directly against `qualityFlags`.
 * 4. DR-FAIR-01 (WP-XAI2-01, Enterprise Fairness Gate, Phase 1): no
 *    demographic attribute data exists anywhere in the repository
 *    (Repository Verification §6). Per ADR-04, no demographic proxy is
 *    inferred from unrelated fields to make this appear evaluated. Recorded
 *    as `evaluated: false` with an explanatory note, at precedence
 *    category 1 (ADR-05) — same honest-disclosure pattern as gap 2 above.
 *    Full demographic-comparison evaluation is a future Phase 2, contingent
 *    on a separate, non-architectural data-sourcing decision and its own
 *    ADR — not implemented here.
 * ============================================================================
 */

const crypto = require('crypto');
const { decisionTypeRegistry } = require('./decisionTypeRegistry');

// ─────────────────────────────────────────────────────────────
// FROZEN CONSTANTS — inlined per Clarification §3 (C-5): no separate
// constants/enums/errors files exist anywhere in this module family
// (knowledge/student/recommendation/validation are each exactly four
// files), so none are introduced here either.
// ─────────────────────────────────────────────────────────────

const RULE_SET_VERSION = 'WP-DIF-01-v1.0';

const IMPLEMENTED_DECISION_TYPE = 'skill';

// WP-XAI2-04 — the ADR ratified `career` as the second computable decision
// type. `IMPLEMENTED_DECISION_TYPE` (singular) is kept, unchanged, for
// backward compatibility with any existing consumer of that exact export
// (confirmed: only this file's own dispatch gate and
// `decision.service.test.js`'s own `nonSkillTypes` computation reference
// it) — DR-TYP-01's actual gate now checks membership in the plural
// `IMPLEMENTED_DECISION_TYPES` below instead of equality to the singular
// constant, per the Enterprise Implementation ADR's "existing Decision
// Runtime dispatch mechanism, extended, not redesigned" instruction: the
// same rule chain, same finalizers, same DR-TYP-01/DR-FAIR-01/... order run
// for both types (see `_decideImplementedType`, generalized from the
// original `_decideSkill` by parameterizing the two places it referenced
// `skill` literally — the recommendation-group lookup and its response
// key). No new architectural layer, no new rule, no change to the frozen
// rule order.
//
// WP-XAI2-06: membership is now sourced from `decisionTypeRegistry`
// (`./decisionTypeRegistry.js`) instead of a hardcoded array literal, so a
// future decision type can be registered without editing this gate.
// `IMPLEMENTED_DECISION_TYPES` keeps its exact prior shape (a frozen array
// supporting `.includes()`) for the existing test suite and any other
// consumer — it is a snapshot of the registry's contents, taken once at
// module load, not the registry object itself.
const IMPLEMENTED_DECISION_TYPES = decisionTypeRegistry.list();

// Matches recommendation.validator.js's VALID_GROUPS exactly — the full
// eight-type vocabulary from DECISION_INTELLIGENCE_FRAMEWORK.md §Objective 2
// (Placement excluded — no architectural source).
const KNOWN_DECISION_TYPES = Object.freeze([
  'career',
  'programme',
  'course',
  'scholarship',
  'skill',
  'institution',
  'futureSkill',
  'occupation',
]);

const DECISION_STATUS = Object.freeze({
  DECISION_READY: 'DECISION_READY',
  PROVISIONAL: 'PROVISIONAL',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  ESCALATION_REQUIRED: 'ESCALATION_REQUIRED',
  WITHHELD: 'WITHHELD',
});

const PRIORITY = Object.freeze({
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
  P4: 'P4',
});

// CONFIDENCE_AND_PRIORITY_FRAMEWORK.md §Objective 6 — IQF band boundaries,
// on the 0-100 scale the composite `ValidationResult.score` (0-1) is
// mapped onto.
const CONFIDENCE_BANDS = Object.freeze([
  { label: 'Very High', min: 85, max: 100 },
  { label: 'High', min: 70, max: 84 },
  { label: 'Medium', min: 50, max: 69 },
  { label: 'Low', min: 30, max: 49 },
  { label: 'Very Low', min: 0, max: 29 },
]);

// DECISION_OUTPUT_CONTRACT.md §Objective 8 `confidenceBreakdown` — the six
// named weighted inputs. None are separately exposed by ValidationService
// today (see module header, gap 1); listed here only as the canonical set
// of names to report as unavailable.
const CONFIDENCE_BREAKDOWN_INPUTS = Object.freeze([
  'evidenceCoverage',
  'signalCompleteness',
  'signalConsistency',
  'dataQuality',
  'recommendationStability',
  'profileCompleteness',
]);

class DecisionEngine {
  /**
   * @param {object} deps
   * @param {object} deps.knowledgeService — injected KnowledgeService instance (required by Mission statement; not called directly in v1 — see module header)
   * @param {object} deps.studentService — injected StudentService instance
   * @param {object} deps.recommendationService — injected RecommendationService instance
   * @param {object} deps.validationService — injected ValidationService instance
   * @param {object} deps.logger
   * @param {object} [deps.cacheClient] — resolved client from cacheManager.getClient() (reserved; DecisionEngine does not itself cache in v1 — see `_getCached`/`_setCached` no-ops below, kept only for constructor-shape parity with its siblings)
   * @param {object} [deps.config]
   */
  constructor({
    knowledgeService,
    studentService,
    recommendationService,
    validationService,
    logger,
    cacheClient = null,
    config = {},
  }) {
    if (!knowledgeService) {
      throw new Error('[DecisionEngine] knowledgeService is required');
    }
    if (!studentService) {
      throw new Error('[DecisionEngine] studentService is required');
    }
    if (!recommendationService) {
      throw new Error('[DecisionEngine] recommendationService is required');
    }
    if (!validationService) {
      throw new Error('[DecisionEngine] validationService is required');
    }
    if (!logger) {
      throw new Error('[DecisionEngine] logger is required');
    }

    this._knowledgeService = knowledgeService;
    this._studentService = studentService;
    this._recommendationService = recommendationService;
    this._validationService = validationService;
    this._logger = logger;
    this._cacheClient = cacheClient;
    this._config = config;
  }

  // ─────────────────────────────────────────────────────────
  // PUBLIC ENTRY POINT
  // ─────────────────────────────────────────────────────────

  /**
   * The canonical entry point. Computes exactly one Decision for
   * `(userId, decisionType)`, per DECISION_OUTPUT_CONTRACT.md §Objective 8.
   *
   * @param {string} userId
   * @param {string} decisionType — one of KNOWN_DECISION_TYPES
   * @returns {Promise<object>} a frozen Decision object
   */
  async decide(userId, decisionType) {
    const decisionId = this._generateDecisionId(userId, decisionType);
    const timestamp = new Date().toISOString();

    this._logger.info('[KnowledgeRuntime.Decision] Decision Started', {
      decisionId,
      userId,
      decisionType,
    });

    try {
      // ── DR-TYP-01 (priority 0) — evaluated before ValidationService is
      // ever called, per DECISION_RULE_CATALOG.md and Clarification §6.
      // WP-XAI2-04: gate now checks membership in IMPLEMENTED_DECISION_TYPES
      // (`skill`, `career`) rather than equality to the original singular
      // constant — same rule, extended set.
      if (!IMPLEMENTED_DECISION_TYPES.includes(decisionType)) {
        return await this._decideUnimplementedType({ decisionId, timestamp, userId, decisionType });
      }

      return await this._decideImplementedType({ decisionId, timestamp, userId, decisionType });
    } catch (error) {
      this._logger.error('[KnowledgeRuntime.Decision] Decision Failed', {
        decisionId,
        userId,
        decisionType,
        error: error.message,
      });
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────
  // DR-TYP-01 — IMPLEMENTED-GROUP GATE
  // ─────────────────────────────────────────────────────────

  /**
   * DR-TYP-01: for any decisionType outside the implemented set, return a
   * deterministic WITHHELD Decision naming the specific unimplemented
   * capability, without ever invoking ValidationService. The verbatim
   * reason string is read from RecommendationService's own public
   * response (its `UNIMPLEMENTED_GROUPS` map is not exported, so this
   * consumes the already-produced `.reason` field on the relevant group
   * instead of reaching into RecommendationService internals — consistent
   * with "consume only the public interface").
   *
   * @private
   */
  async _decideUnimplementedType({ decisionId, timestamp, userId, decisionType }) {
    const groupKey = `${decisionType}Recommendations`;

    let reason = `RecommendationService does not implement the "${decisionType}" candidate group.`;
    try {
      const candidatesResponse = await this._recommendationService.generateRecommendationCandidates(userId, {
        groups: [decisionType],
      });
      const group = candidatesResponse?.[groupKey];
      if (group && typeof group.reason === 'string') {
        reason = group.reason;
      }
    } catch (error) {
      this._logger.warn('[KnowledgeRuntime.Decision] Failed to resolve upstream UNIMPLEMENTED_GROUPS reason, using generic message', {
        decisionId,
        userId,
        decisionType,
        error: error.message,
      });
    }

    const decisionFactors = [
      this._factor('DR-TYP-01', {
        evaluated: true,
        fired: true,
        outcome: DECISION_STATUS.WITHHELD,
        detail: reason,
      }),
    ];

    this._logger.info('[KnowledgeRuntime.Decision] Decision Withheld', {
      decisionId,
      userId,
      decisionType,
      rule: 'DR-TYP-01',
      reason,
    });

    const decision = this._assemble({
      decisionId,
      timestamp,
      userId,
      decisionType,
      status: DECISION_STATUS.WITHHELD,
      confidence: null,
      qualityScore: null,
      priority: null,
      recommendedActions: [
        'This decision type is not yet implemented by RecommendationService. See metadata.reason for the specific gap.',
      ],
      evidence: [],
      reasoningTraceRefs: null,
      confidenceBreakdown: this._emptyConfidenceBreakdown(),
      decisionFactors,
      extraMetadata: { reason },
    });

    this._logger.info('[KnowledgeRuntime.Decision] Decision Completed', { decisionId, userId, decisionType, status: decision.status });

    return decision;
  }

  // ─────────────────────────────────────────────────────────
  // IMPLEMENTED DECISION TYPE PATH — shared by `skill` and (WP-XAI2-04)
  // `career`. Originally `_decideSkill`; generalized by parameterizing the
  // two places that referenced `skill` literally (the recommendation-group
  // request and its response key) — everything else, including the rule
  // order and every finalizer, is untouched.
  // ─────────────────────────────────────────────────────────

  /**
   * @private
   */
  async _decideImplementedType({ decisionId, timestamp, userId, decisionType }) {
    const decisionFactors = [
      this._factor('DR-TYP-01', {
        evaluated: true,
        fired: false,
        outcome: 'PASSED — decisionType is the implemented group',
      }),
    ];

    // ValidationService MUST ALWAYS execute first for the implemented type
    // (Mandatory Condition 3, Clarification §6). WP-XAI2-05: `decisionType`
    // is now threaded through so ValidationService runs its decision-type-
    // aware deep-candidate/consistency checks (`careerRecommendations` +
    // career.interests/goals for `career`) instead of always reusing the
    // `skillRecommendations`-shaped checks it ran for every decision type
    // before this WP. `ValidationService.validateDecisionReadiness()`
    // defaults its second parameter to `'skill'`, so this is additive, not a
    // signature change for any other caller.
    const validationResult = await this._validationService.validateDecisionReadiness(userId, decisionType);

    this._logger.info('[KnowledgeRuntime.Decision] Validation Completed', {
      decisionId,
      userId,
      decisionType,
      valid: validationResult.valid,
      score: validationResult.score,
    });

    // ── DR-FAIR-01 — Enterprise Fairness Gate, Phase 1 (precedence
    // category 1, ADR-05) — evaluated immediately after DR-TYP-01
    // (category 0) and ahead of every other rule below. Never fires in
    // Phase 1 (ADR-01/ADR-04: no demographic data exists, none is
    // fabricated), so it never withholds or otherwise changes `status`;
    // it exists to make the gate's real, honest state structurally
    // visible instead of the previous bare `fairnessGatePending: true`
    // metadata literal.
    decisionFactors.push(
      this._factor('DR-FAIR-01', {
        evaluated: validationResult.fairness.evaluated,
        fired: validationResult.fairness.fired,
        note: validationResult.fairness.note,
      })
    );

    // ── DR-INT-01 — Structural Contract Gate (priority 1) ──────────────
    if (validationResult.errors.length > 0) {
      decisionFactors.push(
        this._factor('DR-INT-01', {
          evaluated: true,
          fired: true,
          outcome: DECISION_STATUS.WITHHELD,
          detail: `Structural contract errors reported by ValidationService: ${validationResult.errors.join(', ')}`,
        })
      );

      return this._finalizeWithheldFromValidation({
        decisionId,
        timestamp,
        userId,
        decisionType,
        validationResult,
        decisionFactors,
        rule: 'DR-INT-01',
      });
    }
    decisionFactors.push(this._factor('DR-INT-01', { evaluated: true, fired: false, outcome: 'PASSED — no structural errors' }));

    // ── DR-ESC-01 — Critical Contradiction Escalation (priority 2) ─────
    // DR-ESC-02 (severity compounding) cannot fire — see module header
    // gap 3; recorded as not evaluated.
    decisionFactors.push(
      this._factor('DR-ESC-02', {
        evaluated: false,
        fired: false,
        note: 'No contradiction-severity concept exists in ValidationService.qualityFlags today; nothing to compound.',
      })
    );

    const hasClusterDrift = validationResult.qualityFlags.some((flag) => flag.startsWith('CLUSTER_DRIFT'));
    if (hasClusterDrift) {
      decisionFactors.push(
        this._factor('DR-ESC-01', {
          evaluated: true,
          fired: true,
          outcome: DECISION_STATUS.ESCALATION_REQUIRED,
          detail: `Escalation-triggering quality flag(s): ${validationResult.qualityFlags.filter((f) => f.startsWith('CLUSTER_DRIFT')).join(', ')}`,
        })
      );

      const decision = this._assemble({
        decisionId,
        timestamp,
        userId,
        decisionType,
        status: DECISION_STATUS.ESCALATION_REQUIRED,
        confidence: validationResult.confidence,
        qualityScore: validationResult.score,
        priority: PRIORITY.P0,
        recommendedActions: [...validationResult.recommendations, 'Mandatory counsellor review required before release.'],
        evidence: [],
        reasoningTraceRefs: this._reasoningTraceRefs(userId, validationResult, null),
        confidenceBreakdown: this._confidenceBreakdown(validationResult.score),
        decisionFactors,
        extraMetadata: { counsellorActionRequired: true },
      });

      this._logger.info('[KnowledgeRuntime.Decision] Decision Completed', { decisionId, userId, decisionType, status: decision.status });
      return decision;
    }
    decisionFactors.push(this._factor('DR-ESC-01', { evaluated: true, fired: false, outcome: 'PASSED — no CLUSTER_DRIFT flag present' }));

    // ── Fetch candidates for the evidence/floor checks below. Group key is
    // derived from decisionType (e.g. 'skill' -> 'skillRecommendations',
    // 'career' -> 'careerRecommendations') — the same convention
    // RecommendationService's own response and `_decideUnimplementedType`
    // above already use.
    const groupKey = `${decisionType}Recommendations`;
    const candidatesResponse = await this._recommendationService.generateRecommendationCandidates(userId, {
      groups: [decisionType],
    });

    this._logger.info('[KnowledgeRuntime.Decision] Recommendation Completed', {
      decisionId,
      userId,
      decisionType,
      available: candidatesResponse?.[groupKey]?.available,
      candidateCount: candidatesResponse?.[groupKey]?.candidates?.length ?? 0,
    });

    const candidateGroup = candidatesResponse?.[groupKey] ?? { available: false, candidates: [] };
    const candidates = Array.isArray(candidateGroup.candidates) ? candidateGroup.candidates : [];

    // ── DR-SUF-01 — Evidence Floor Gate (priority 3) ────────────────────
    // No recommendation-class field exists on candidates (see module
    // header gap 2), so the floor is approximated by "available and
    // non-empty" — the closest real signal to "a class was assigned
    // upstream" that RecommendationService's actual contract exposes.
    const evidenceFloorCleared = Boolean(candidateGroup.available) && candidates.length > 0;

    if (!evidenceFloorCleared) {
      decisionFactors.push(
        this._factor('DR-SUF-01', {
          evaluated: true,
          fired: true,
          outcome: DECISION_STATUS.INSUFFICIENT_EVIDENCE,
          detail: `No ${decisionType} candidates were returned — the Evidence Sufficiency Floor was not cleared.`,
        })
      );

      const decision = this._finalizeInsufficientEvidence({
        decisionId,
        timestamp,
        userId,
        decisionType,
        validationResult,
        candidates,
        decisionFactors,
      });
      return decision;
    }
    decisionFactors.push(this._factor('DR-SUF-01', { evaluated: true, fired: false, outcome: `PASSED — ${decisionType} candidates present` }));

    // ── DR-SUF-02 — Profile Completeness Threshold (priority 4) ─────────
    // Informational only — never changes status, per its own contract.
    const lowCompleteness = validationResult.qualityFlags.includes('LOW_STUDENT_PROFILE_COMPLETENESS');
    decisionFactors.push(
      this._factor('DR-SUF-02', {
        evaluated: true,
        fired: lowCompleteness,
        outcome: lowCompleteness ? 'LOW_STUDENT_PROFILE_COMPLETENESS carried as a caveat' : 'PASSED — profile completeness at or above threshold',
      })
    );

    // ── DR-CNF-01 — IQF Band Mapping (priority 5) ───────────────────────
    const band = this._confidenceBand(validationResult.score);

    // Very Low band also resolves to INSUFFICIENT_EVIDENCE per
    // DECISION_INTELLIGENCE_FRAMEWORK.md §1.3's OR condition, defensively
    // enforced here even though DR-CNF-01's own text assumes DR-SUF-01
    // already excludes it (see Clarification's residual-ambiguity note).
    if (band.label === 'Very Low') {
      decisionFactors.push(
        this._factor('DR-CNF-01', {
          evaluated: true,
          fired: true,
          outcome: DECISION_STATUS.INSUFFICIENT_EVIDENCE,
          detail: `Composite score maps to the Very Low confidence band (${band.label}).`,
        })
      );

      return this._finalizeInsufficientEvidence({
        decisionId,
        timestamp,
        userId,
        decisionType,
        validationResult,
        candidates,
        decisionFactors,
      });
    }

    let status;
    if (band.label === 'Low') {
      status = DECISION_STATUS.PROVISIONAL;
    } else if (validationResult.valid) {
      // Medium/High/Very High AND the 0.6 composite threshold is cleared.
      status = DECISION_STATUS.DECISION_READY;
    } else {
      // Residual edge case: band is Medium (score in [0.50, 0.60)) but the
      // stricter 0.6 DECISION_READY_SCORE_THRESHOLD is not cleared.
      // DECISION_OUTPUT_CONTRACT/§1.3 does not name this exact boundary;
      // resolved conservatively toward PROVISIONAL rather than fabricating
      // a DECISION_READY the threshold itself says isn't earned yet.
      status = DECISION_STATUS.PROVISIONAL;
    }

    decisionFactors.push(
      this._factor('DR-CNF-01', {
        evaluated: true,
        fired: true,
        outcome: status,
        detail: `Composite score ${validationResult.score} maps to the ${band.label} confidence band (validationResult.valid=${validationResult.valid}).`,
      })
    );

    // ── DR-PRI-01 / DR-PRI-02 — Priority (priority 6 / 7) ───────────────
    // Cannot fire against real data — see module header gap 2. Priority is
    // assigned by direct status->tier mapping instead.
    decisionFactors.push(
      this._factor('DR-PRI-01', {
        evaluated: false,
        fired: false,
        note: `No recommendation-class field exists on RecommendationService ${decisionType} candidates; priority assigned by status->tier mapping instead.`,
      })
    );
    decisionFactors.push(
      this._factor('DR-PRI-02', {
        evaluated: false,
        fired: false,
        note: 'No grade-level field exists on the composed StudentService profile; elevation cannot be evaluated.',
      })
    );

    const priority = this._priorityForStatus(status);

    const decision = this._assemble({
      decisionId,
      timestamp,
      userId,
      decisionType,
      status,
      confidence: validationResult.confidence,
      qualityScore: validationResult.score,
      priority,
      recommendedActions: validationResult.recommendations,
      evidence: candidates,
      reasoningTraceRefs: this._reasoningTraceRefs(userId, validationResult, candidatesResponse),
      confidenceBreakdown: this._confidenceBreakdown(validationResult.score),
      decisionFactors,
      // WP-XAI2-01 / ADR-01: the previous undifferentiated
      // `fairnessGatePending: true` literal is replaced by the structured
      // DR-FAIR-01 entry in `decisionFactors` above (evaluated/fired/note),
      // consistent with how DR-PRI-01/DR-PRI-02 already disclose their own
      // data gaps. No extra metadata is needed here.
      extraMetadata: {},
    });

    this._logger.info('[KnowledgeRuntime.Decision] Decision Completed', { decisionId, userId, decisionType, status: decision.status });

    return decision;
  }

  // ─────────────────────────────────────────────────────────
  // SHARED FINALIZERS
  // ─────────────────────────────────────────────────────────

  /** @private */
  _finalizeWithheldFromValidation({ decisionId, timestamp, userId, decisionType, validationResult, decisionFactors, rule }) {
    this._logger.info('[KnowledgeRuntime.Decision] Decision Withheld', {
      decisionId,
      userId,
      decisionType,
      rule,
      errors: validationResult.errors,
    });

    const decision = this._assemble({
      decisionId,
      timestamp,
      userId,
      decisionType,
      status: DECISION_STATUS.WITHHELD,
      confidence: validationResult.confidence,
      qualityScore: validationResult.score,
      priority: null,
      recommendedActions: validationResult.recommendations,
      evidence: [],
      reasoningTraceRefs: this._reasoningTraceRefs(userId, validationResult, null),
      confidenceBreakdown: this._confidenceBreakdown(validationResult.score),
      decisionFactors,
      extraMetadata: { reason: 'ValidationService reported structural contract errors.' },
    });

    this._logger.info('[KnowledgeRuntime.Decision] Decision Completed', { decisionId, userId, decisionType, status: decision.status });
    return decision;
  }

  /** @private */
  _finalizeInsufficientEvidence({ decisionId, timestamp, userId, decisionType, validationResult, candidates, decisionFactors }) {
    this._logger.info('[KnowledgeRuntime.Decision] Decision Withheld', {
      decisionId,
      userId,
      decisionType,
      rule: 'DR-SUF-01/DR-CNF-01',
      status: DECISION_STATUS.INSUFFICIENT_EVIDENCE,
    });

    const decision = this._assemble({
      decisionId,
      timestamp,
      userId,
      decisionType,
      status: DECISION_STATUS.INSUFFICIENT_EVIDENCE,
      confidence: validationResult.confidence,
      qualityScore: validationResult.score,
      priority: PRIORITY.P4,
      recommendedActions: validationResult.recommendations,
      evidence: candidates,
      reasoningTraceRefs: this._reasoningTraceRefs(userId, validationResult, null),
      confidenceBreakdown: this._confidenceBreakdown(validationResult.score),
      decisionFactors,
      extraMetadata: {},
    });

    this._logger.info('[KnowledgeRuntime.Decision] Decision Completed', { decisionId, userId, decisionType, status: decision.status });
    return decision;
  }

  // ─────────────────────────────────────────────────────────
  // ASSEMBLY — DECISION_OUTPUT_CONTRACT.md §Objective 8, field-for-field
  // ─────────────────────────────────────────────────────────

  /** @private */
  _assemble({
    decisionId,
    timestamp,
    userId,
    decisionType,
    status,
    confidence,
    qualityScore,
    priority,
    recommendedActions,
    evidence,
    reasoningTraceRefs,
    confidenceBreakdown,
    decisionFactors,
    extraMetadata,
  }) {
    return Object.freeze({
      decisionId,
      timestamp,
      userId,
      decisionType,
      status,
      confidence,
      qualityScore,
      priority,
      recommendedActions,
      evidence,
      reasoningTrace: reasoningTraceRefs,
      confidenceBreakdown,
      decisionFactors,
      metadata: Object.freeze({
        hkpSnapshotVersion: null,
        ruleSetVersion: RULE_SET_VERSION,
        knowledgeVersion: null,
        ...extraMetadata,
      }),
    });
  }

  // ─────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────

  /** @private */
  _factor(ruleId, { evaluated, fired, outcome = null, detail = null, note = null }) {
    return Object.freeze({ ruleId, evaluated, fired, outcome, detail, note });
  }

  /** @private */
  _confidenceBand(score) {
    const pointsOn100 = Math.round(Number(score ?? 0) * 100);
    return CONFIDENCE_BANDS.find((band) => pointsOn100 >= band.min && pointsOn100 <= band.max) ?? CONFIDENCE_BANDS[CONFIDENCE_BANDS.length - 1];
  }

  /** @private */
  _confidenceBreakdown(score) {
    const band = this._confidenceBand(score);
    const inputs = {};
    for (const inputName of CONFIDENCE_BREAKDOWN_INPUTS) {
      inputs[inputName] = null;
    }
    return Object.freeze({ bandLabel: band.label, inputs: Object.freeze(inputs) });
  }

  /** @private */
  _emptyConfidenceBreakdown() {
    const inputs = {};
    for (const inputName of CONFIDENCE_BREAKDOWN_INPUTS) {
      inputs[inputName] = null;
    }
    return Object.freeze({ bandLabel: null, inputs: Object.freeze(inputs) });
  }

  /** @private */
  _priorityForStatus(status) {
    switch (status) {
      case DECISION_STATUS.ESCALATION_REQUIRED:
        return PRIORITY.P0;
      case DECISION_STATUS.DECISION_READY:
        // No RISK-FLAGGED/grade-11-12 signal is available to elevate to
        // P1 (see module header gap 2) — every DECISION_READY skill
        // decision is Standard tier in v1.
        return PRIORITY.P2;
      case DECISION_STATUS.PROVISIONAL:
        return PRIORITY.P3;
      case DECISION_STATUS.INSUFFICIENT_EVIDENCE:
        return PRIORITY.P4;
      default:
        return null;
    }
  }

  /** @private */
  _reasoningTraceRefs(userId, validationResult, candidatesResponse) {
    return Object.freeze({
      validationResultRef: `${userId}:${validationResult?.meta?.generatedAt ?? 'unknown'}`,
      recommendationResponseRef: candidatesResponse ? `${userId}:${candidatesResponse?.meta?.generatedAt ?? 'unknown'}` : null,
    });
  }

  /** @private */
  _generateDecisionId(userId, decisionType) {
    const ts = Date.now();
    const hash = crypto
      .createHash('sha256')
      .update(`${userId}:${decisionType}:${ts}:${crypto.randomBytes(8).toString('hex')}`)
      .digest('hex')
      .slice(0, 12);
    return `DEC-${ts}-${hash}`;
  }
}

module.exports = DecisionEngine;
module.exports.DECISION_STATUS = DECISION_STATUS;
module.exports.PRIORITY = PRIORITY;
module.exports.KNOWN_DECISION_TYPES = KNOWN_DECISION_TYPES;
module.exports.IMPLEMENTED_DECISION_TYPE = IMPLEMENTED_DECISION_TYPE;
module.exports.IMPLEMENTED_DECISION_TYPES = IMPLEMENTED_DECISION_TYPES;
// WP-XAI2-06: the live registry, for any future WP that needs to register
// a new computable decisionType without editing this file's dispatch gate.
// Not consumed anywhere in this WP's own dispatch path beyond the
// module-load-time `.list()` snapshot above.
module.exports.decisionTypeRegistry = decisionTypeRegistry;