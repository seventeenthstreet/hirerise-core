'use strict';

/**
 * modules/knowledge-runtime/knowledge-runtime.module.js
 *
 * Composition root for the Knowledge Runtime layer (RUNTIME_CLASS_REFERENCE.md
 * "Composition root contract"). Wires together:
 *   - KnowledgeService (implemented, WP-IMP-02)
 *   - StudentService (implemented, WP-IMP-03)
 *   - RecommendationService (implemented, WP-IMP-04)
 *   - KnowledgeRepository, StudentIntelligenceRepository + reused
 *     career/skill/education repositories
 *   - cacheManager.getClient() (core/cache/cache.manager.js — no second
 *     cache implementation introduced, Objective 8)
 *   - Logger (injected)
 *
 * Pattern: lazy singleton per service, matching
 * `intelligence-quality.module.js`. This avoids circular import issues and
 * keeps startup fast.
 *
 * SCOPE NOTE: WP-IMP-02 implemented KnowledgeService, WP-IMP-03 added
 * StudentService, WP-IMP-04 added RecommendationService. This file
 * (WP-IMP-04A) adds ValidationService.
 * `SERVICE_IMPLEMENTATION_PLAN.md`'s documented fixed construction order
 * is `Knowledge -> Student -> Validation -> Recommendation ->
 * Explainability` — WP-IMP-04 built RecommendationService BEFORE
 * ValidationService, out of that documented order (see the prior version
 * of this note, preserved in git history, for why that was safe).
 * WP-IMP-04A's own Objective 5 ("Register ValidationService after
 * RecommendationService") makes that ordering permanent rather than
 * reconciling it — ValidationService is built last, consuming the
 * already-built Knowledge/Student/Recommendation singletons plus IQF
 * (`getQualityService()`, best-effort).
 *
 * This creates one real tension with Objective 6 ("integrate
 * ValidationService into RecommendationService... before
 * RecommendationService returns recommendation candidates"): a
 * `RecommendationService` singleton built before `ValidationService`
 * exists cannot take a *constructed* `ValidationService` as a normal
 * constructor dependency without either reordering construction
 * (contradicting Objective 5) or creating a require-cycle. The
 * reconciliation used here — see `recommendation.service.js`
 * `_runValidationGate` and `validation.service.js`'s header for the full
 * reasoning — is that `getRecommendationService()` below injects a
 * `validationServiceResolver` *function* (`() => getValidationService()`),
 * not an instance. The function is only invoked the first time
 * `generateRecommendationCandidates()` actually runs, by which point this
 * module's own singleton caching means `getRecommendationService()` inside
 * `getValidationService()` simply returns the already-built instance
 * instead of re-entering construction. Build order therefore stays exactly
 * as Objective 5 specifies, and RecommendationService's required
 * constructor dependencies (`knowledgeService`, `studentService`,
 * `logger`) are unchanged — the resolver is an additional, optional
 * parameter. `getExplainabilityService()` remains unimplemented — not
 * stubbed — as before.
 *
 * Usage:
 *   const { getKnowledgeService, getStudentService, getRecommendationService, getValidationService, getDecisionService } = require('./knowledge-runtime.module');
 *   const knowledge = getKnowledgeService();
 *   const student = getStudentService();
 *   const recommendation = getRecommendationService();
 *   const validation = getValidationService();
 *   const decision = getDecisionService();
 *
 * WP-IMP-05 (Decision Engine Runtime, per
 * `documents/WP-DIF-01/WP_IMP05_IMPLEMENTATION_CLARIFICATION.md` §13)
 * registers `getDecisionService()` after `getValidationService()`,
 * extending the fixed construction order to
 * `Knowledge -> Student -> Recommendation -> Validation -> Decision`.
 *
 * WP-IMP-06 (Explainability Runtime, Stage 3 Enterprise Implementation)
 * registers `getExplainabilityService()` after `getDecisionService()`,
 * extending the fixed construction order one final step to
 * `Knowledge -> Student -> Recommendation -> Validation -> Decision ->
 * Explainability`. `ExplainabilityRuntime` takes only `logger`/`config` —
 * it is pure, deterministic, and stateless, and depends on no other
 * runtime service (it consumes an already-computed Decision object passed
 * to `explain()` at call time, not a constructor dependency). It is
 * registered here anyway, matching every sibling service's singleton and
 * DI convention, rather than instantiated ad hoc at the call site.
 *
 * WP-XAI2-04 (Enterprise Implementation — Career Decision Runtime) adds two
 * optional, read-only sources to `getStudentService()`'s construction:
 * `careerProfileService` (student-onboarding track, `student_career_profiles`)
 * and `professionalCareerProfileRepository` (professional-onboarding track,
 * `users.career_goal` + `user_profiles.data.career_goals`). Neither changes
 * `StudentService`'s required dependencies or this file's fixed
 * construction order — both are additive constructor parameters StudentService
 * already accepted as optional (default `null`). See
 * `studentIntelligence.service.js`'s header and
 * `documents/WP_XAI2_04/WP_XAI2_04_IMPLEMENTATION_CLARIFICATION_REVIEW.md`.
 */

const logger = require('../../utils/logger');
const cacheManager = require('../../core/cache/cache.manager');
const KnowledgeService = require('./knowledge/knowledge.service');
const { KnowledgeRepository } = require('./knowledge/knowledge.repository');
const StudentService = require('./student/studentIntelligence.service');
const { StudentIntelligenceRepository } = require('./student/studentIntelligence.repository');
const RecommendationService = require('./recommendation/recommendation.service');
const ValidationService = require('./validation/validation.service');
const DecisionEngine = require('./decision/decision.service');
const ExplainabilityRuntime = require('./explainability/explainability.service');
const { getQualityService } = require('../intelligence-quality/intelligence-quality.module');

// Existing repositories, reused verbatim — not wrapped (Objective 3 / 7).
const careerRepository = require('../../repositories/career.repository');
const SkillRepositoryClass = require('../../repositories/skillRepository');
const educationStudentRepository = require('../education-intelligence/repositories/student.repository');
const educationProfileService = require('../student-onboarding/services/education.service');
const careerProfileService = require('../student-onboarding/services/careerProfile.service');
const professionalCareerProfileRepository = require('../../repositories/professionalCareerProfile.repository');

// ─────────────────────────────────────────────────────────────
// SINGLETONS
// ─────────────────────────────────────────────────────────────

/** @type {KnowledgeService | null} */
let _knowledgeServiceInstance = null;

/**
 * Returns the singleton KnowledgeService instance. Created once; reused on
 * subsequent calls.
 *
 * @returns {KnowledgeService}
 */
function getKnowledgeService() {
  if (_knowledgeServiceInstance) return _knowledgeServiceInstance;

  let cacheClient = null;
  try {
    cacheClient = cacheManager.getClient();
  } catch (error) {
    // Cache is best-effort for KnowledgeService (cache-first, not
    // cache-required) — a resolution failure here must not block service
    // construction. KnowledgeService's own cache helpers additionally
    // no-op safely when `cacheClient` is null.
    logger.warn('[KnowledgeRuntimeModule] cacheManager.getClient() failed at construction', {
      error: error.message,
    });
  }

  _knowledgeServiceInstance = new KnowledgeService({
    knowledgeRepository: new KnowledgeRepository(),
    careerRepository,
    skillRepository: new SkillRepositoryClass(),
    cacheClient,
    logger,
    config: {},
  });

  return _knowledgeServiceInstance;
}

/** @type {StudentService | null} */
let _studentServiceInstance = null;

/**
 * Returns the singleton StudentService instance. Created once; reused on
 * subsequent calls. Constructs `getKnowledgeService()` first if it hasn't
 * been built yet, respecting the fixed `Knowledge -> Student` order.
 *
 * @returns {StudentService}
 */
function getStudentService() {
  if (_studentServiceInstance) return _studentServiceInstance;

  const knowledgeService = getKnowledgeService();

  let cacheClient = null;
  try {
    cacheClient = cacheManager.getClient();
  } catch (error) {
    logger.warn('[KnowledgeRuntimeModule] cacheManager.getClient() failed at construction (student)', {
      error: error.message,
    });
  }

  _studentServiceInstance = new StudentService({
    studentIntelligenceRepository: new StudentIntelligenceRepository(),
    educationStudentRepository,
    educationProfileService,
    careerProfileService,
    professionalCareerProfileRepository,
    knowledgeService,
    cacheClient,
    logger,
    config: {},
  });

  return _studentServiceInstance;
}

/** @type {RecommendationService | null} */
let _recommendationServiceInstance = null;

/**
 * Returns the singleton RecommendationService instance. Created once;
 * reused on subsequent calls. Constructs `getKnowledgeService()` and
 * `getStudentService()` first if they haven't been built yet — this
 * service consumes both, per Objective 5, and nothing else.
 *
 * @returns {RecommendationService}
 */
function getRecommendationService() {
  if (_recommendationServiceInstance) return _recommendationServiceInstance;

  const knowledgeService = getKnowledgeService();
  const studentService = getStudentService();

  let cacheClient = null;
  try {
    cacheClient = cacheManager.getClient();
  } catch (error) {
    logger.warn('[KnowledgeRuntimeModule] cacheManager.getClient() failed at construction (recommendation)', {
      error: error.message,
    });
  }

  _recommendationServiceInstance = new RecommendationService({
    knowledgeService,
    studentService,
    cacheClient,
    logger,
    config: {},
    // WP-IMP-04A Objective 6 — a resolver function, not an instance. See
    // the module header and `validation.service.js` header for why this
    // avoids both a require-cycle and reordering Objective 5's build
    // sequence. Only invoked lazily, inside
    // `generateRecommendationCandidates()`, never at construction.
    validationServiceResolver: () => getValidationService(),
  });

  return _recommendationServiceInstance;
}

/** @type {ValidationService | null} */
let _validationServiceInstance = null;

/**
 * Returns the singleton ValidationService instance. Created once; reused
 * on subsequent calls. Constructs `getKnowledgeService()`,
 * `getStudentService()`, and `getRecommendationService()` first if they
 * haven't been built yet — per Objective 5, ValidationService is
 * registered, and therefore built, after RecommendationService.
 *
 * IQF's `getQualityService()` is resolved best-effort: a failure there
 * must not block ValidationService construction, matching how
 * `cacheManager.getClient()` is already treated in this file.
 *
 * @returns {ValidationService}
 */
function getValidationService() {
  if (_validationServiceInstance) return _validationServiceInstance;

  const knowledgeService = getKnowledgeService();
  const studentService = getStudentService();
  const recommendationService = getRecommendationService();

  let qualityService = null;
  try {
    qualityService = getQualityService();
  } catch (error) {
    logger.warn('[KnowledgeRuntimeModule] getQualityService() failed at construction (validation) — IQF is best-effort for ValidationService', {
      error: error.message,
    });
  }

  let cacheClient = null;
  try {
    cacheClient = cacheManager.getClient();
  } catch (error) {
    logger.warn('[KnowledgeRuntimeModule] cacheManager.getClient() failed at construction (validation)', {
      error: error.message,
    });
  }

  _validationServiceInstance = new ValidationService({
    knowledgeService,
    studentService,
    recommendationService,
    qualityService,
    cacheClient,
    logger,
    config: {},
  });

  return _validationServiceInstance;
}

/** @type {DecisionEngine | null} */
let _decisionServiceInstance = null;

/**
 * Returns the singleton DecisionEngine instance. Created once; reused on
 * subsequent calls. Constructs `getKnowledgeService()`, `getStudentService()`,
 * `getRecommendationService()`, and `getValidationService()` first if they
 * haven't been built yet — WP-IMP-05's own Mission statement requires all
 * four as constructor dependencies, and this getter is registered strictly
 * after `getValidationService()`, extending the fixed construction order to
 * `Knowledge -> Student -> Recommendation -> Validation -> Decision`
 * (`WP_IMP05_IMPLEMENTATION_GUIDE.md` §3).
 *
 * @returns {DecisionEngine}
 */
function getDecisionService() {
  if (_decisionServiceInstance) return _decisionServiceInstance;

  const knowledgeService = getKnowledgeService();
  const studentService = getStudentService();
  const recommendationService = getRecommendationService();
  const validationService = getValidationService();

  let cacheClient = null;
  try {
    cacheClient = cacheManager.getClient();
  } catch (error) {
    logger.warn('[KnowledgeRuntimeModule] cacheManager.getClient() failed at construction (decision)', {
      error: error.message,
    });
  }

  _decisionServiceInstance = new DecisionEngine({
    knowledgeService,
    studentService,
    recommendationService,
    validationService,
    cacheClient,
    logger,
    config: {},
  });

  return _decisionServiceInstance;
}

/** @type {ExplainabilityRuntime | null} */
let _explainabilityServiceInstance = null;

/**
 * Returns the singleton ExplainabilityRuntime instance. Created once;
 * reused on subsequent calls. Takes no runtime-service dependencies
 * (`logger`/`config` only) — registered after `getDecisionService()`
 * purely to fix the composition-root construction order at
 * `Knowledge -> Student -> Recommendation -> Validation -> Decision ->
 * Explainability`, matching every sibling getter's placement convention.
 *
 * @returns {ExplainabilityRuntime}
 */
function getExplainabilityService() {
  if (_explainabilityServiceInstance) return _explainabilityServiceInstance;

  _explainabilityServiceInstance = new ExplainabilityRuntime({
    logger,
    config: {},
  });

  return _explainabilityServiceInstance;
}

/**
 * Test-injection point, matching `_setQualityServiceForTesting()`. Keyed by
 * service name so the same function signature covers all six services
 * without a breaking change.
 *
 * @param {'knowledge'|'student'|'recommendation'|'validation'|'decision'|'explainability'} name
 * @param {object} mockInstance
 */
function _setServiceForTesting(name, mockInstance) {
  switch (name) {
    case 'knowledge':
      _knowledgeServiceInstance = mockInstance;
      break;
    case 'student':
      _studentServiceInstance = mockInstance;
      break;
    case 'recommendation':
      _recommendationServiceInstance = mockInstance;
      break;
    case 'validation':
      _validationServiceInstance = mockInstance;
      break;
    case 'decision':
      _decisionServiceInstance = mockInstance;
      break;
    case 'explainability':
      _explainabilityServiceInstance = mockInstance;
      break;
    default:
      throw new Error(
        `[KnowledgeRuntimeModule] _setServiceForTesting: unknown or not-yet-implemented service "${name}"`
      );
  }
}

module.exports = {
  getKnowledgeService,
  getStudentService,
  getRecommendationService,
  getValidationService,
  getDecisionService,
  getExplainabilityService,
  _setServiceForTesting,
};
