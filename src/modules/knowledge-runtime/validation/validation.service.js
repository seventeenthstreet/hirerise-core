'use strict';

/**
 * modules/knowledge-runtime/validation/validation.service.js
 *
 * ValidationService — the mandatory, deterministic quality gate between
 * RecommendationService and any future downstream decision/explainability
 * engine (WP-IMP-04A, the Architecture Review Board's READY WITH CONDITIONS
 * requirement). Every check in this file is a plain structural or
 * threshold rule over data already produced elsewhere. No AI. No LLM. No
 * scoring model — every constant below is a literal threshold, not a
 * learned weight.
 *
 * Service boundaries (Objective 4): this service calls ONLY
 * `knowledgeService`, `studentService`, `recommendationService`, and the
 * Intelligence Quality Framework (`qualityService`, IQF) — no repository,
 * no direct Supabase/BaseRepository access anywhere in this file, matching
 * RecommendationService's own boundary (see that file's header).
 * `qualityService` is accepted but treated as best-effort, not required:
 * IQF has no rows yet for a student who hasn't completed an assessment,
 * and ValidationService's job is to report that gap (via `qualityFlags`),
 * not to fail construction over it.
 *
 * ============================================================================
 * OBJECTIVE 6 — HOW THE RECOMMENDATION -> VALIDATION WIRING ACTUALLY WORKS
 * ============================================================================
 * Objective 6 asks for validation to run "before RecommendationService
 * returns recommendation candidates." Taken literally as a constructor
 * dependency, that's circular: `knowledge-runtime.module.js`'s documented,
 * frozen build order is Knowledge -> Student -> Recommendation ->
 * Validation (Objective 5: "Register ValidationService after
 * RecommendationService"), and this file's own Objective-4 boundary makes
 * ValidationService depend on an already-built RecommendationService.
 * `RecommendationService` cannot also take a *constructed*
 * `ValidationService` at construction time without either building
 * Validation first (contradicting Objective 5) or creating a real
 * require-cycle.
 *
 * The reconciliation used here (see `recommendation.service.js`
 * `_runValidationGate`): `RecommendationService` accepts an optional
 * `validationServiceResolver` — a plain function, not an instance — that
 * `knowledge-runtime.module.js` wires as `() => getValidationService()`.
 * The build order in the module stays exactly as Objective 5 specifies;
 * the resolver is only invoked lazily, the first time
 * `generateRecommendationCandidates()` actually runs, by which point
 * `RecommendationService`'s own singleton already exists, so
 * `getValidationService()` -> `getRecommendationService()` resolves the
 * already-cached instance rather than re-entering construction. No
 * business logic, ranking, or explainability is touched by this — the
 * gate result is attached as an additional `validation` field on the
 * existing response, exactly per Objective 6 ("Only validation").
 * ============================================================================
 */

const CACHE_KEY_PREFIX = 'validation-runtime:';
const CACHE_TTL_BASE_SECONDS = 300;
const CACHE_TTL_JITTER_MAX_SECONDS = 30;

// Deterministic threshold — a student/recommendation pair at or above this
// composite score is considered decision-ready. Literal constant, not a
// learned/tuned value.
const DECISION_READY_SCORE_THRESHOLD = 0.6;

// Weights for the deterministic composite score in validateDecisionReadiness.
// Sum to 1.0 by construction.
const SCORE_WEIGHTS = Object.freeze({
  completeness: 0.4,
  confidence: 0.3,
  candidateStructure: 0.15,
  consistency: 0.15,
});

// Confirmed against KnowledgeService's NODE_TYPE enum (knowledge.service.js
// header) — not guessed.
const KNOWN_NODE_TYPES = Object.freeze(['DOMAIN', 'ROLE', 'SKILL', 'SKILL_CLUSTER']);

// Confirmed against RecommendationService.generateRecommendationCandidates's
// actual, frozen response shape (recommendation.service.js) — not guessed.
const KNOWN_RECOMMENDATION_GROUPS = Object.freeze([
  'skillRecommendations',
  'careerRecommendations',
  'programmeRecommendations',
  'courseRecommendations',
  'scholarshipRecommendations',
  'institutionRecommendations',
  'futureSkillRecommendations',
  'occupationRecommendations',
]);

// The group RecommendationService implemented first (WP-IMP-04). Candidates
// in every group with no registered VALIDATION_STRATEGIES entry (below) are,
// by RecommendationService's own contract, always
// `{ available: false, candidates: [] }` — validated structurally like any
// other group (MISSING_GROUP / GROUP_MISSING_AVAILABLE_FLAG / etc., all
// unchanged), but never deep-validated per-candidate.
const IMPLEMENTED_GROUP = 'skillRecommendations';

// ============================================================================
// WP-XAI2-05 — ENTERPRISE DECISION VALIDATION RUNTIME
// ============================================================================
// Decision-type-aware validator registry. `validateRecommendationCandidates`
// and `validateConsistency` dispatch through this instead of hard-coding
// `skillRecommendations`/`skills.legacy` — the Skill entry below is the
// pre-existing WP-IMP-04A logic, moved here byte-for-byte and unchanged, so
// every existing call site (which passes no `decisionType` and therefore
// gets the `skill` default) sees identical behavior. `career` is new
// (WP-XAI2-04's decision type had no validator entry of its own before this
// WP — DecisionEngine's `_decideImplementedType` called the exact same
// skill-shaped checks for `career`, which is the gap this WP closes).
//
// Adding a future Decision Runtime type requires exactly one new entry here
// — no change to the dispatch code in either method, no new pipeline layer.
// A `decisionType` with no entry here (i.e. every decision type
// DecisionEngine has not yet implemented) simply skips deep-candidate and
// consistency validation; the generic per-group structural checks in
// `validateRecommendationCandidates` still run for it regardless.
const VALIDATION_STRATEGIES = Object.freeze({
  skill: Object.freeze({
    groupKey: IMPLEMENTED_GROUP,
    // Confirmed against RecommendationService._matchSkills(): every skill
    // candidate carries all four keys, `matchedFrom` always a non-empty
    // string (the student's own stated skill) — never null in practice.
    candidateRequiredKeys: Object.freeze(['canonicalId', 'name', 'nodeType', 'matchedFrom']),
    candidateErrorPrefix: 'SKILL_CANDIDATE_INCOMPLETE',
    consistencyWarningPrefix: 'SKILL_MATCH_SOURCE_MISMATCH',
    collectSourceTerms: (studentContext) =>
      Array.isArray(studentContext?.skills?.legacy)
        ? studentContext.skills.legacy.map((s) => String(s).trim().toLowerCase())
        : [],
  }),
  career: Object.freeze({
    groupKey: 'careerRecommendations',
    // Confirmed against RecommendationService._matchCareer(): `matchedFrom`
    // is legitimately `null` when the student stated no career interest or
    // goal and `_matchCareer()` fell back to the full, unranked
    // `knowledgeService.listDomains()` list — that is documented, correct
    // behavior, not an incomplete candidate, so `matchedFrom` is deliberately
    // excluded from the required-keys check (unlike skill's, above).
    candidateRequiredKeys: Object.freeze(['canonicalId', 'name', 'nodeType']),
    candidateErrorPrefix: 'CAREER_CANDIDATE_INCOMPLETE',
    consistencyWarningPrefix: 'CAREER_MATCH_SOURCE_MISMATCH',
    // Confirmed against RecommendationService._matchCareer() /
    // _collectCareerTerms(): matchedFrom, when non-null, is one of the
    // student's own stated career.interests.value / career.goals.value terms.
    collectSourceTerms: (studentContext) => {
      const terms = [];
      const addValue = (value) => {
        if (typeof value === 'string' && value.trim()) {
          terms.push(value.trim().toLowerCase());
        } else if (value && typeof value === 'object' && typeof value.title === 'string' && value.title.trim()) {
          terms.push(value.title.trim().toLowerCase());
        }
      };
      addValue(studentContext?.career?.interests?.value);
      addValue(studentContext?.career?.goals?.value);
      return terms;
    },
  }),
});

// Default decisionType for every method below — preserves the exact
// pre-WP-XAI2-05 signature/behavior for every existing caller that passes
// none (ValidationController's `/me` route, the pre-existing test suite).
const DEFAULT_DECISION_TYPE = 'skill';

// Completeness dimensions confirmed present on the composed student profile
// (studentIntelligence.service.js `_composeProfile` / WP-IMP-03
// IMPLEMENTATION_REPORT.md) — every other field on that profile is itself
// `{ available: false, ... }` ("not sourced"), so scoring against them here
// would just be re-deriving `validateStudentContext`'s missingData, not an
// independent completeness signal.
const COMPLETENESS_DIMENSIONS = Object.freeze([
  { key: 'personal', check: (ctx) => Boolean(ctx?.personal?.available) },
  { key: 'academic', check: (ctx) => Boolean(ctx?.academic?.available) },
  { key: 'skills', check: (ctx) => Array.isArray(ctx?.skills?.legacy) && ctx.skills.legacy.length > 0 },
  { key: 'readiness', check: (ctx) => Boolean(ctx?.readiness?.available) },
]);

// WP-XAI2-01 / ADR-01, ADR-04 (documents/xai2 phase/WP_XAI2_01A_...ADR_REVIEW.md).
// Phase 1 of the phased fairness definition: no demographic attribute data
// exists anywhere in the repository (Repository Verification §6), so the
// gate is honestly recorded as `evaluated: false` rather than fabricating
// or inferring a demographic proxy from unrelated fields (ADR-04 explicitly
// prohibits this). This note is the single source of truth for that
// disclosure; DecisionEngine's DR-FAIR-01 factor quotes it verbatim rather
// than re-deriving it.
const FAIRNESS_NOT_EVALUATED_NOTE =
  'Fairness cannot currently be evaluated: no demographic attribute data exists anywhere in the repository (Phase 1 of the phased fairness definition, ADR-01). No demographic proxy has been inferred from unrelated fields (ADR-04). Full demographic-comparison evaluation is deferred to a future Phase 2, contingent on a separate data-sourcing decision.';

class ValidationService {
  /**
   * @param {object} deps
   * @param {object} deps.knowledgeService — injected KnowledgeService instance
   * @param {object} deps.studentService — injected StudentService instance
   * @param {object} deps.recommendationService — injected RecommendationService instance
   * @param {object} [deps.qualityService] — injected IntelligenceQualityService (IQF) instance; best-effort, may be null
   * @param {object} deps.logger
   * @param {object} [deps.cacheClient] — resolved client from cacheManager.getClient()
   * @param {object} [deps.config]
   */
  constructor({
    knowledgeService,
    studentService,
    recommendationService,
    qualityService = null,
    logger,
    cacheClient = null,
    config = {},
  }) {
    if (!knowledgeService) {
      throw new Error('[ValidationService] knowledgeService is required');
    }
    if (!studentService) {
      throw new Error('[ValidationService] studentService is required');
    }
    if (!recommendationService) {
      throw new Error('[ValidationService] recommendationService is required');
    }
    if (!logger) {
      throw new Error('[ValidationService] logger is required');
    }

    this._knowledgeService = knowledgeService;
    this._studentService = studentService;
    this._recommendationService = recommendationService;
    this._qualityService = qualityService;
    this._logger = logger;
    this._cacheClient = cacheClient;
    this._config = config;

    this._ttlBaseSeconds = config.cacheTtlSeconds ?? CACHE_TTL_BASE_SECONDS;
    this._ttlJitterMaxSeconds = config.cacheTtlJitterSeconds ?? CACHE_TTL_JITTER_MAX_SECONDS;
  }

  // ─────────────────────────────────────────────────────────
  // OBJECTIVE 7 ENTRY POINT — orchestrates every check below, cache-first
  // (Objective 8), same cache manager / naming convention as
  // Knowledge/Student/Recommendation.
  // ─────────────────────────────────────────────────────────

  /**
   * Full decision-readiness gate for a single student. This is what
   * `GET /api/v1/validation/me` calls.
   *
   * @param {string} userId
   * @param {string} [decisionType='skill'] — WP-XAI2-05: which Decision
   *   Runtime domain to validate against (see `VALIDATION_STRATEGIES`).
   *   Defaults to `'skill'`, so every pre-existing caller (ValidationController's
   *   `/me` route; any code written before this WP) is byte-for-byte
   *   unaffected. `'career'` is the only other currently-registered value;
   *   any other decisionType still runs every generic structural check, just
   *   without a decision-type-specific deep-candidate/consistency pass.
   * @returns {Promise<object>} the standard ValidationResult (Objective 3)
   */
  async validateDecisionReadiness(userId, decisionType = DEFAULT_DECISION_TYPE) {
    const cacheKey = this._cacheKey(userId, decisionType);

    const cached = await this._getCached(cacheKey);
    if (cached !== null) {
      this._logger.info('[KnowledgeRuntime.Validation] validateDecisionReadiness cache hit', { userId, decisionType });
      return cached;
    }

    const [studentContext, candidatesResponse, qualityReport] = await Promise.all([
      this._studentService.getStudentIntelligenceProfile(userId),
      this._recommendationService.generateRecommendationCandidates(userId),
      this._safeQualityReport(userId),
    ]);

    const contextResult = this.validateStudentContext(studentContext);
    const completenessResult = this.validateCompleteness(studentContext);
    const confidenceResult = this.validateConfidence(studentContext?.readiness?.compositeConfidence ?? null);
    const candidatesResult = this.validateRecommendationCandidates(candidatesResponse, decisionType);
    const consistencyResult = this.validateConsistency(candidatesResponse, studentContext, decisionType);

    const errors = [
      ...contextResult.errors,
      ...candidatesResult.errors,
      ...consistencyResult.errors,
    ];

    const warnings = [
      ...contextResult.warnings,
      ...confidenceResult.warnings,
      ...candidatesResult.warnings,
      ...consistencyResult.warnings,
    ];

    const missingData = [
      ...contextResult.missingData,
      ...completenessResult.missingData,
    ];

    const qualityFlags = [
      ...completenessResult.qualityFlags,
      ...this._qualityFlagsFromReport(qualityReport),
    ];

    const score = this._computeScore({
      completenessScore: completenessResult.score,
      confidenceResult,
      candidatesResult,
      consistencyResult,
    });

    // WP-XAI2-01 (ADR-05): evaluated alongside the other checks in this
    // gate; does not participate in `score`/`valid` since Phase 1 never
    // fires (nothing to gate on yet — see validateFairness below).
    const fairnessResult = this.validateFairness();

    const result = Object.freeze({
      userId,
      valid: errors.length === 0 && score >= DECISION_READY_SCORE_THRESHOLD,
      score,
      confidence: confidenceResult.confidence,
      warnings,
      errors,
      missingData,
      qualityFlags,
      fairness: fairnessResult,
      recommendations: this._buildRecommendations({ missingData, qualityFlags, errors }),
      meta: {
        generatedAt: new Date().toISOString(),
        scoreWeights: SCORE_WEIGHTS,
        decisionReadyThreshold: DECISION_READY_SCORE_THRESHOLD,
        // WP-XAI2-05 — additive field only; every pre-existing key above is
        // unchanged, so any consumer doing a subset/objectContaining check
        // (as the existing test suite does) is unaffected.
        decisionType,
      },
    });

    await this._setCached(cacheKey, result);

    return result;
  }

  // ─────────────────────────────────────────────────────────
  // OBJECTIVE 1 — individual, independently callable checks.
  // All synchronous / pure except the orchestrator above — no I/O, so each
  // is directly unit-testable without mocking a repository (Objective 9).
  // ─────────────────────────────────────────────────────────

  /**
   * Structural + completeness checks over a StudentService profile
   * (`getStudentIntelligenceProfile()` shape).
   *
   * @param {object} studentContext
   * @returns {{valid: boolean, errors: string[], warnings: string[], missingData: object[]}}
   */
  validateStudentContext(studentContext) {
    const errors = [];
    const warnings = [];
    const missingData = [];

    if (!studentContext || typeof studentContext !== 'object') {
      errors.push('STUDENT_CONTEXT_MISSING');
      return { valid: false, errors, warnings, missingData };
    }

    if (!studentContext.userId) {
      errors.push('STUDENT_CONTEXT_MISSING_USER_ID');
    }

    for (const field of this._notSourcedFields(studentContext)) {
      missingData.push(field);
      warnings.push(`NOT_SOURCED:${field.path}`);
    }

    return { valid: errors.length === 0, errors, warnings, missingData };
  }

  /**
   * Profile completeness score across the dimensions confirmed real by
   * WP-IMP-03 (see `COMPLETENESS_DIMENSIONS` above). Deliberately narrower
   * than every field on the profile — see that constant's comment.
   *
   * @param {object} studentContext
   * @returns {{score: number, missingData: object[], qualityFlags: string[]}}
   */
  validateCompleteness(studentContext) {
    const missingData = [];
    let availableCount = 0;

    for (const dimension of COMPLETENESS_DIMENSIONS) {
      const isAvailable = dimension.check(studentContext);
      if (isAvailable) {
        availableCount += 1;
      } else {
        missingData.push({ path: dimension.key, note: 'Not available on the composed student profile.' });
      }
    }

    const score = Number((availableCount / COMPLETENESS_DIMENSIONS.length).toFixed(3));

    return {
      score,
      missingData,
      qualityFlags: score < 0.5 ? ['LOW_STUDENT_PROFILE_COMPLETENESS'] : [],
    };
  }

  /**
   * WP-XAI2-01 Enterprise Fairness Gate — Phase 1 (ADR-01 through ADR-05).
   *
   * `INTELLIGENCE_QUALITY_FRAMEWORK.md` §4.11 defines fairness as a
   * demographic-attribute comparison, but no demographic attribute exists
   * anywhere in the repository (Repository Verification §6). Per ADR-04,
   * this method MUST NOT fabricate or infer a demographic proxy from
   * unrelated fields (e.g. `academic.schoolType`, `personal.name`) to make
   * this appear evaluated when it is not. Phase 1's only job is to report
   * that honestly, structurally, at the correct precedence — the same
   * `evaluated: false` + `note` pattern this file already uses for
   * DR-PRI-01/DR-PRI-02 in `decision.service.js`.
   *
   * Takes no arguments in Phase 1: there is no per-student data to
   * evaluate against yet. A future Phase 2 (a new ADR, contingent on a
   * separate, non-architectural data-sourcing decision) would give this
   * method a real signature and a real evaluation.
   *
   * @returns {{evaluated: boolean, fired: boolean, note: string}}
   */
  validateFairness() {
    return { evaluated: false, fired: false, note: FAIRNESS_NOT_EVALUATED_NOTE };
  }

  /**
   * Range/presence check for a single confidence value — e.g. StudentService's
   * `readiness.compositeConfidence`. Does not compute a confidence score
   * itself (that remains SIM/IQF's job); only validates the one it's given.
   *
   * @param {number|null|undefined} confidenceValue
   * @returns {{valid: boolean, confidence: number|null, warnings: string[], errors: string[]}}
   */
  validateConfidence(confidenceValue) {
    const warnings = [];
    const errors = [];

    if (confidenceValue === null || confidenceValue === undefined) {
      warnings.push('CONFIDENCE_UNAVAILABLE');
      return { valid: false, confidence: null, warnings, errors };
    }

    if (typeof confidenceValue !== 'number' || Number.isNaN(confidenceValue)) {
      errors.push('CONFIDENCE_NOT_NUMERIC');
      return { valid: false, confidence: null, warnings, errors };
    }

    if (confidenceValue < 0 || confidenceValue > 1) {
      errors.push('CONFIDENCE_OUT_OF_RANGE');
      return { valid: false, confidence: confidenceValue, warnings, errors };
    }

    return { valid: true, confidence: confidenceValue, warnings, errors };
  }

  /**
   * Structural check over a KnowledgeService `searchKnowledge()` result
   * (array of `{ node, nodeType }`).
   *
   * @param {Array<object>} searchResults
   * @returns {{valid: boolean, errors: string[], warnings: string[]}}
   */
  validateKnowledgeResponse(searchResults) {
    const errors = [];
    const warnings = [];

    if (!Array.isArray(searchResults)) {
      errors.push('KNOWLEDGE_RESPONSE_NOT_ARRAY');
      return { valid: false, errors, warnings };
    }

    searchResults.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        errors.push(`KNOWLEDGE_RESPONSE_ENTRY_INVALID:${index}`);
        return;
      }
      if (!entry.node?.id || !entry.node?.name) {
        errors.push(`KNOWLEDGE_RESPONSE_NODE_INCOMPLETE:${index}`);
      }
      if (!KNOWN_NODE_TYPES.includes(entry.nodeType)) {
        warnings.push(`KNOWLEDGE_RESPONSE_UNKNOWN_NODE_TYPE:${index}:${entry.nodeType}`);
      }
    });

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Structural check over a RecommendationService
   * `generateRecommendationCandidates()` result. Verifies contract
   * integrity (every documented group present, `available`/`candidates`/
   * `reason` used consistently) — does not re-judge whether a candidate is
   * a *good* recommendation, only whether the response honors its own
   * documented shape.
   *
   * @param {object} candidatesResponse
   * @param {string} [decisionType='skill'] — WP-XAI2-05: selects which
   *   `VALIDATION_STRATEGIES` entry (if any) performs the deep per-candidate
   *   check below. The per-group structural checks that follow are
   *   unconditional and run identically regardless of decisionType.
   * @returns {{valid: boolean, errors: string[], warnings: string[], missingData: object[]}}
   */
  validateRecommendationCandidates(candidatesResponse, decisionType = DEFAULT_DECISION_TYPE) {
    const errors = [];
    const warnings = [];
    const missingData = [];

    if (!candidatesResponse || typeof candidatesResponse !== 'object') {
      errors.push('RECOMMENDATION_RESPONSE_MISSING');
      return { valid: false, errors, warnings, missingData };
    }

    if (!candidatesResponse.userId) {
      errors.push('RECOMMENDATION_RESPONSE_MISSING_USER_ID');
    }

    const strategy = VALIDATION_STRATEGIES[decisionType] ?? null;

    for (const group of KNOWN_RECOMMENDATION_GROUPS) {
      const entry = candidatesResponse[group];

      if (!entry || typeof entry !== 'object') {
        errors.push(`MISSING_GROUP:${group}`);
        missingData.push({ path: group, note: 'Group absent from RecommendationService response.' });
        continue;
      }

      if (typeof entry.available !== 'boolean') {
        errors.push(`GROUP_MISSING_AVAILABLE_FLAG:${group}`);
        continue;
      }

      if (!Array.isArray(entry.candidates)) {
        errors.push(`GROUP_CANDIDATES_NOT_ARRAY:${group}`);
        continue;
      }

      if (entry.available === false && typeof entry.reason !== 'string') {
        warnings.push(`GROUP_UNAVAILABLE_MISSING_REASON:${group}`);
      }

      if (strategy && group === strategy.groupKey && entry.available) {
        entry.candidates.forEach((candidate, index) => {
          const missingKeys = strategy.candidateRequiredKeys.filter((key) => !candidate || !candidate[key]);
          if (missingKeys.length > 0) {
            errors.push(`${strategy.candidateErrorPrefix}:${index}:${missingKeys.join(',')}`);
          }
        });
      }
    }

    return { valid: errors.length === 0, errors, warnings, missingData };
  }

  /**
   * Cross-checks between a RecommendationService response and the
   * StudentService context it was generated from — contract integrity
   * (Objective 2), not a re-scoring of either.
   *
   * @param {object} candidatesResponse
   * @param {object} studentContext
   * @param {string} [decisionType='skill'] — WP-XAI2-05: selects which
   *   `VALIDATION_STRATEGIES` entry (if any) supplies the candidate group
   *   and the source-of-truth terms for the matchedFrom cross-check below.
   *   The userId cross-check above is unconditional and unaffected.
   * @returns {{valid: boolean, errors: string[], warnings: string[]}}
   */
  validateConsistency(candidatesResponse, studentContext, decisionType = DEFAULT_DECISION_TYPE) {
    const errors = [];
    const warnings = [];

    if (!candidatesResponse || !studentContext) {
      // Nothing to cross-check without both sides — already reported by
      // validateStudentContext / validateRecommendationCandidates.
      return { valid: true, errors, warnings };
    }

    if (
      candidatesResponse.userId &&
      studentContext.userId &&
      candidatesResponse.userId !== studentContext.userId
    ) {
      errors.push('USER_ID_MISMATCH');
    }

    const strategy = VALIDATION_STRATEGIES[decisionType] ?? null;

    if (strategy) {
      const sourceTerms = strategy.collectSourceTerms(studentContext);
      const candidates = candidatesResponse?.[strategy.groupKey]?.candidates;

      if (Array.isArray(candidates)) {
        candidates.forEach((candidate, index) => {
          const matchedFrom = candidate?.matchedFrom ? String(candidate.matchedFrom).trim().toLowerCase() : null;
          if (matchedFrom && !sourceTerms.includes(matchedFrom)) {
            warnings.push(`${strategy.consistencyWarningPrefix}:${index}`);
          }
        });
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // ─────────────────────────────────────────────────────────
  // PRIVATE — SCORING / RECOMMENDATIONS
  // ─────────────────────────────────────────────────────────

  _computeScore({ completenessScore, confidenceResult, candidatesResult, consistencyResult }) {
    const confidenceComponent = confidenceResult.valid ? 1 : 0;
    const candidateStructureComponent = candidatesResult.valid ? 1 : 0;
    const consistencyComponent =
      consistencyResult.errors.length > 0 ? 0 : consistencyResult.warnings.length > 0 ? 0.5 : 1;

    const raw =
      completenessScore * SCORE_WEIGHTS.completeness +
      confidenceComponent * SCORE_WEIGHTS.confidence +
      candidateStructureComponent * SCORE_WEIGHTS.candidateStructure +
      consistencyComponent * SCORE_WEIGHTS.consistency;

    return Number(Math.min(1, Math.max(0, raw)).toFixed(3));
  }

  _buildRecommendations({ missingData, qualityFlags, errors }) {
    const recommendations = [];

    if (errors.length > 0) {
      recommendations.push('Resolve the reported contract errors before invoking the Decision Engine.');
    }
    if (missingData.some((m) => m.path === 'academic')) {
      recommendations.push('Collect academic profile data before triggering the Decision Engine.');
    }
    if (missingData.some((m) => m.path === 'skills')) {
      recommendations.push('Prompt the student to add at least one skill before generating recommendations.');
    }
    if (missingData.some((m) => m.path === 'readiness')) {
      recommendations.push('No SIM readiness snapshot exists yet — wait for onboarding/assessment completion.');
    }
    if (qualityFlags.includes('LOW_STUDENT_PROFILE_COMPLETENESS')) {
      recommendations.push('Overall profile completeness is below 50% — treat any downstream decision as provisional.');
    }
    if (qualityFlags.some((f) => f.startsWith('CLUSTER_DRIFT'))) {
      recommendations.push('A significant cluster drift was detected since the last assessment — consider re-running SIM before deciding.');
    }

    return recommendations;
  }

  _notSourcedFields(studentContext, prefix = '') {
    const found = [];

    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return;

      if (node.available === false && 'note' in node) {
        found.push({ path, note: node.note });
        return;
      }

      for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          walk(value, path ? `${path}.${key}` : key);
        }
      }
    };

    walk(studentContext, prefix);
    return found;
  }

  async _safeQualityReport(userId) {
    if (!this._qualityService) return null;

    try {
      return await this._qualityService.getQualityReport(userId);
    } catch (error) {
      this._logger.warn('[KnowledgeRuntime.Validation] IQF getQualityReport failed, continuing without it', {
        userId,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Flags derived from IQF's own confirmed field names
   * (`intelligence-quality.repositories.js` row mappers) — `coverageLevel`
   * and `driftLevel`/`clusterSwapped` are read verbatim, never
   * reinterpreted or re-scored here.
   */
  _qualityFlagsFromReport(qualityReport) {
    if (!qualityReport) return ['IQF_QUALITY_REPORT_UNAVAILABLE'];

    const flags = [];

    if (qualityReport.coverage?.coverageLevel === 'low') {
      flags.push('LOW_SIGNAL_COVERAGE');
    }
    if (qualityReport.drift?.clusterSwapped === true) {
      flags.push('CLUSTER_DRIFT_PRIMARY_CLUSTER_SWAPPED');
    } else if (qualityReport.drift?.driftLevel === 'high') {
      flags.push('CLUSTER_DRIFT_HIGH');
    }

    return flags;
  }

  // ─────────────────────────────────────────────────────────
  // CACHE HELPERS (Objective 8) — verbatim pattern from
  // recommendation.service.js; no second cache implementation.
  // ─────────────────────────────────────────────────────────

  _resolveRawClient() {
    const client = this._cacheClient;
    if (!client) return null;

    return client?.client?.get
      ? client.client
      : client?.get
      ? client
      : null;
  }

  async _getCached(key) {
    const redis = this._resolveRawClient();
    if (!redis) return null;

    try {
      const raw = await redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (error) {
      this._logger.warn('[KnowledgeRuntime.Validation] Cache read failed', { key, error: error.message });
      return null;
    }
  }

  async _setCached(key, value) {
    const redis = this._resolveRawClient();
    if (!redis) return;

    try {
      const ttl = this._ttlBaseSeconds + Math.floor(Math.random() * this._ttlJitterMaxSeconds);
      await redis.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (error) {
      this._logger.warn('[KnowledgeRuntime.Validation] Cache write failed', { key, error: error.message });
    }
  }

  /**
   * WP-XAI2-05: `skill` (the default) keeps the exact pre-existing cache
   * key format — no forced cold-cache on deploy for existing traffic. Any
   * other decisionType (currently only `career`) gets its own namespaced
   * key, so a skill and a career ValidationResult for the same user can
   * never collide in the cache (they were never namespaced apart before
   * this WP because `career` never reached this cache key at all).
   */
  _cacheKey(userId, decisionType = DEFAULT_DECISION_TYPE) {
    if (decisionType === DEFAULT_DECISION_TYPE) {
      return `${CACHE_KEY_PREFIX}decision-readiness:${userId}`;
    }
    return `${CACHE_KEY_PREFIX}decision-readiness:${decisionType}:${userId}`;
  }
}

module.exports = ValidationService;
// WP-XAI2-05 — same convention as decision.service.js exporting
// KNOWN_DECISION_TYPES/IMPLEMENTED_DECISION_TYPES: exposes the registry so a
// future work package can inspect which decision types this runtime already
// validates deeply, without needing to import validation.service.js's
// private internals.
module.exports.VALIDATION_STRATEGIES = VALIDATION_STRATEGIES;
module.exports.SUPPORTED_DECISION_TYPES = Object.freeze(Object.keys(VALIDATION_STRATEGIES));