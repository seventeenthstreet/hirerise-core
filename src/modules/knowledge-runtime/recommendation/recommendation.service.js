'use strict';

/**
 * modules/knowledge-runtime/recommendation/recommendation.service.js
 *
 * RecommendationService — deterministic, rule-based candidate generation
 * only (WP-IMP-04). NOT an AI engine, NOT a scoring engine, NOT ranking,
 * NOT explainability — those are explicitly out of scope for this WP and
 * are left for future work packages.
 *
 * Pipeline (Objective 4): Student Context → KnowledgeService → Rule
 * Matching → Recommendation Candidates → Normalized Response.
 *
 * Service boundaries (Objective 5): this service calls ONLY
 * `knowledgeService` and `studentService` — no repository, no direct
 * Supabase/BaseRepository access anywhere in this file. Confirmed by the
 * WP's own suggested file list, which (unlike Knowledge/Student runtime)
 * does not include a `recommendation.repository.js` — this is not an
 * oversight this implementation is filling in; it's consistent with
 * Objective 5's explicit "no direct database access."
 *
 * ============================================================================
 * CAPABILITY BOUNDARY — the central finding of WP-IMP-04, updated by WP-XAI2-04
 * ============================================================================
 * Objective 2/6 list eight candidate groups: career, programme, course,
 * scholarship, skill, institution, futureSkill, occupation. Given
 * `KnowledgeService`'s actual, frozen public surface (confirmed by reading
 * it, not assumed) and `StudentService`'s actual, frozen data
 * availability (also confirmed, see `documents/WP-IMP-03/IMPLEMENTATION_REPORT.md`),
 * WP-IMP-04 found genuine, evidence-based deterministic rules for exactly
 * one of these eight; WP-XAI2-04 adds a second:
 *
 *   - `skillRecommendations` — CAN be built: canonicalize each of the
 *     student's stated skills (`StudentService` → `skills.legacy`, a flat
 *     string array) against the taxonomy via
 *     `knowledgeService.searchKnowledge(skillName, { nodeTypes: ['SKILL'] })`.
 *     Both sides of this rule are confirmed, real data.
 *   - `careerRecommendations` (WP-XAI2-04) — CAN now be built, the same
 *     way: `StudentService` → `career.interests`/`career.goals` are no
 *     longer stubs (see `studentIntelligence.service.js`'s header for the
 *     sourcing), and `KnowledgeService.listDomains()` (new) fills the
 *     enumeration gap this file previously named as the blocker. See
 *     `_matchCareer()` below for the exact rule, and
 *     `documents/WP_XAI2_04/WP_XAI2_04_IMPLEMENTATION_CLARIFICATION_REVIEW.md`
 *     / `WP_XAI2_04_ENTERPRISE_IMPLEMENTATION_REPORT.md` for the evidence
 *     trail.
 *
 * The other six are still NOT implemented with real matching logic, and are
 * NOT faked with placeholder data. Each returns `{ available: false,
 * candidates: [], reason: '...' }` naming the exact missing capability.
 * Why, specifically:
 *
 *   - `occupationRecommendations` would need to enumerate ROLE nodes.
 *     `KnowledgeService` has no "list ROLE nodes" method (only
 *     `listDomains()`, added for `career`, was in approved scope this WP —
 *     see the Enterprise Implementation ADR's explicit exclusion of
 *     `occupation` from this WP). Inventing an equivalent for ROLE without
 *     that same scoped decision would be architecture invention, not
 *     matching a rule.
 *   - `futureSkillRecommendations` would need a skill-adjacency or
 *     skill-to-role graph. Confirmed absent: `cms_skills` has no
 *     domain/role linkage column at all (checked directly against
 *     `adminCmsSkills.repository.js` during WP-IMP-04), and no skill-to-skill
 *     relationship exists anywhere in the knowledge schema.
 *   - `programmeRecommendations` / `courseRecommendations` /
 *     `scholarshipRecommendations` / `institutionRecommendations` reference
 *     data domains (`modules/qualification`, `modules/school`,
 *     `modules/university`, `modules/employer`) that `KnowledgeService`
 *     does not expose at all — `KnowledgeService`'s `NODE_TYPE` enum is
 *     exactly `DOMAIN | ROLE | SKILL | SKILL_CLUSTER`, nothing else.
 *     Reaching into those modules directly would violate Objective 5
 *     ("must NEVER bypass either runtime service, no direct database
 *     access").
 *
 * This is not a gap this implementation could have closed without either
 * fabricating a rule or bypassing the runtime-service boundary — both
 * explicitly prohibited. The remaining six placeholder groups are
 * structured and ready: the moment `KnowledgeService` gains the relevant
 * enumeration capability, filling in the corresponding rule is additive,
 * not a redesign of this service — exactly what happened for `career` in
 * this WP.
 * See `documents/WP-IMP-04/IMPLEMENTATION_REPORT.md` for the original
 * writeup and `documents/WP_XAI2_04/WP_XAI2_04_ENTERPRISE_IMPLEMENTATION_REPORT.md`
 * for this WP's addition.
 * ============================================================================
 */

const CACHE_KEY_PREFIX = 'recommendation-runtime:';
const CACHE_TTL_BASE_SECONDS = 300;
const CACHE_TTL_JITTER_MAX_SECONDS = 30;

const UNIMPLEMENTED_GROUPS = Object.freeze({
  programme: 'Programme data is not exposed by KnowledgeService (NODE_TYPE is DOMAIN|ROLE|SKILL|SKILL_CLUSTER only); reaching modules/qualification directly would bypass the runtime-service boundary (Objective 5).',
  course: 'Course data is not exposed by KnowledgeService; no confirmed runtime-service path exists to it.',
  scholarship: 'Scholarship data is not exposed by KnowledgeService; no confirmed runtime-service path exists to it.',
  institution: 'Institution data (modules/school, modules/university, modules/employer) is not exposed by KnowledgeService; reaching those modules directly would bypass the runtime-service boundary (Objective 5).',
  futureSkill: 'No skill-adjacency or skill-to-role relationship exists in the knowledge schema (cms_skills has no domain/role linkage column, confirmed during this WP) — there is nothing to deterministically match against.',
  occupation: 'No KnowledgeService method enumerates ROLE nodes without a query term; occupation was explicitly out of scope for WP-XAI2-04 (ADR restricted approved scope to the career decision type only).',
});

class RecommendationService {
  /**
   * @param {object} deps
   * @param {object} deps.knowledgeService — injected KnowledgeService instance
   * @param {object} deps.studentService — injected StudentService instance
   * @param {object} deps.logger
   * @param {object} [deps.cacheClient] — resolved client from cacheManager.getClient()
   * @param {object} [deps.config]
   * @param {() => object} [deps.validationServiceResolver] — WP-IMP-04A
   *   Objective 6. A function returning the ValidationService singleton,
   *   not the instance itself — see this file's `_runValidationGate` and
   *   `knowledge-runtime.module.js`'s header for why. Optional and
   *   best-effort: omitting it (as every pre-WP-IMP-04A caller/test does)
   *   leaves `generateRecommendationCandidates()`'s behavior unchanged.
   */
  constructor({ knowledgeService, studentService, logger, cacheClient = null, config = {}, validationServiceResolver = null }) {
    if (!knowledgeService) {
      throw new Error('[RecommendationService] knowledgeService is required');
    }
    if (!studentService) {
      throw new Error('[RecommendationService] studentService is required');
    }
    if (!logger) {
      throw new Error('[RecommendationService] logger is required');
    }

    this._knowledgeService = knowledgeService;
    this._studentService = studentService;
    this._logger = logger;
    this._cacheClient = cacheClient;
    this._config = config;
    this._validationServiceResolver = validationServiceResolver;

    this._ttlBaseSeconds = config.cacheTtlSeconds ?? CACHE_TTL_BASE_SECONDS;
    this._ttlJitterMaxSeconds = config.cacheTtlJitterSeconds ?? CACHE_TTL_JITTER_MAX_SECONDS;
  }

  /**
   * The canonical entry point — Objective 4's full pipeline. Cache-first.
   *
   * @param {string} userId
   * @param {{ groups?: string[] }} [options] — restrict to a subset of the
   *   normalized response's groups; defaults to all groups.
   * @returns {Promise<object>}
   */
  async generateRecommendationCandidates(userId, { groups = null } = {}) {
    const cacheKey = this._cacheKey(userId, groups);

    const cached = await this._getCached(cacheKey);
    if (cached !== null) {
      this._logger.info('[KnowledgeRuntime.Recommendation] generateRecommendationCandidates cache hit', { userId });
      return cached;
    }

    const studentContext = await this._studentService.getStudentIntelligenceProfile(userId);

    const wants = (group) => !groups || groups.includes(group);

    const response = {
      userId,
      skillRecommendations: wants('skill')
        ? await this._matchSkills(studentContext)
        : this._skipped(),
      careerRecommendations: wants('career')
        ? await this._matchCareer(studentContext)
        : this._skipped(),
      programmeRecommendations: wants('programme') ? this._unimplemented('programme') : this._skipped(),
      courseRecommendations: wants('course') ? this._unimplemented('course') : this._skipped(),
      scholarshipRecommendations: wants('scholarship') ? this._unimplemented('scholarship') : this._skipped(),
      institutionRecommendations: wants('institution') ? this._unimplemented('institution') : this._skipped(),
      futureSkillRecommendations: wants('futureSkill') ? this._unimplemented('futureSkill') : this._skipped(),
      occupationRecommendations: wants('occupation') ? this._unimplemented('occupation') : this._skipped(),
      meta: {
        generatedAt: new Date().toISOString(),
        pipeline: 'deterministic-rule-matching-v1',
      },
    };

    // WP-IMP-04A Objective 6 — attach ValidationService's quality-gate
    // result. Best-effort and purely additive: no ranking, filtering, or
    // business logic above this line is touched, and a missing resolver or
    // a failed check must never block candidate generation (see this
    // file's constructor doc and `validation.service.js`'s header for why
    // this is a resolver function rather than a constructor-injected
    // instance).
    response.validation = this._runValidationGate(response);

    Object.freeze(response);

    await this._setCached(cacheKey, response);

    return response;
  }

  /**
   * @param {object} response — the not-yet-frozen candidate response
   * @returns {object|null} the ValidationResult, or null if no
   *   ValidationService is available / the check itself failed
   */
  _runValidationGate(response) {
    if (!this._validationServiceResolver) return null;

    try {
      const validationService = this._validationServiceResolver();
      if (!validationService || typeof validationService.validateRecommendationCandidates !== 'function') {
        return null;
      }
      return validationService.validateRecommendationCandidates(response);
    } catch (error) {
      this._logger.warn('[KnowledgeRuntime.Recommendation] ValidationService quality-gate check failed, returning unvalidated response', {
        error: error.message,
      });
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────
  // RULE MATCHING (Objective 3) — the one implemented rule
  // ─────────────────────────────────────────────────────────

  /**
   * Rule: for each of the student's stated skills, canonicalize against the
   * taxonomy. No scoring, no ranking (results kept in the order
   * `knowledgeService.searchKnowledge` returns them — its own internal
   * order, not a relevance judgement made here), no filtering beyond
   * exact-name matching and deduplication by canonical node id.
   *
   * @param {object} studentContext — result of getStudentIntelligenceProfile()
   * @returns {Promise<{available: true, candidates: object[]}>}
   */
  async _matchSkills(studentContext) {
    const rawSkills = Array.isArray(studentContext?.skills?.legacy)
      ? studentContext.skills.legacy.filter((s) => typeof s === 'string' && s.trim())
      : [];

    if (rawSkills.length === 0) {
      return { available: true, candidates: [] };
    }

    const seen = new Set();
    const candidates = [];

    for (const rawSkill of rawSkills) {
      let matches;
      try {
        matches = await this._knowledgeService.searchKnowledge(rawSkill, { nodeTypes: ['SKILL'] });
      } catch (error) {
        this._logger.warn('[KnowledgeRuntime.Recommendation] skill match failed, skipping', {
          rawSkill,
          error: error.message,
        });
        continue;
      }

      for (const match of matches) {
        const nodeId = match?.node?.id;
        if (!nodeId || seen.has(nodeId)) continue;
        seen.add(nodeId);
        candidates.push({
          canonicalId: nodeId,
          name: match.node.name,
          nodeType: match.nodeType,
          matchedFrom: rawSkill,
        });
      }
    }

    return { available: true, candidates };
  }

  /**
   * WP-XAI2-04 — Rule: canonicalize the student's stated career interests
   * and goals (`StudentService` → `career.interests.value` /
   * `career.goals.value`, both confirmed-real per the clarification
   * review) against DOMAIN nodes via
   * `knowledgeService.searchKnowledge(term, { nodeTypes: ['DOMAIN'] })` —
   * the exact same shape of rule as `_matchSkills()`, just against a
   * different node type and a different StudentService field.
   *
   * If the student has stated no career interests or goals at all (a
   * sparse profile, not a missing capability), this does NOT invent a
   * query term — that would be fabricating a rule. Instead it falls back
   * to `knowledgeService.listDomains()`, returning the full, unranked
   * domain list so the response is still useful without pretending to
   * have matched anything. This fallback is the reason `listDomains()`
   * was added in this WP; see this file's header and
   * `knowledge.service.js`'s `listDomains()` doc.
   *
   * @param {object} studentContext — result of getStudentIntelligenceProfile()
   * @returns {Promise<{available: true, candidates: object[]}>}
   */
  async _matchCareer(studentContext) {
    const terms = this._collectCareerTerms(studentContext);

    if (terms.length === 0) {
      let domains;
      try {
        domains = await this._knowledgeService.listDomains();
      } catch (error) {
        this._logger.warn('[KnowledgeRuntime.Recommendation] listDomains() fallback failed', {
          error: error.message,
        });
        return { available: false, candidates: [], reason: 'listDomains() failed; see logs.' };
      }

      return {
        available: true,
        candidates: domains.map((node) => ({
          canonicalId: node.id,
          name: node.name,
          nodeType: 'DOMAIN',
          matchedFrom: null,
          matchStrategy: 'no-stated-career-interests-or-goals-full-domain-list',
        })),
      };
    }

    const seen = new Set();
    const candidates = [];

    for (const term of terms) {
      let matches;
      try {
        matches = await this._knowledgeService.searchKnowledge(term, { nodeTypes: ['DOMAIN'] });
      } catch (error) {
        this._logger.warn('[KnowledgeRuntime.Recommendation] career term match failed, skipping', {
          term,
          error: error.message,
        });
        continue;
      }

      for (const match of matches) {
        const nodeId = match?.node?.id;
        if (!nodeId || seen.has(nodeId)) continue;
        seen.add(nodeId);
        candidates.push({
          canonicalId: nodeId,
          name: match.node.name,
          nodeType: match.nodeType,
          matchedFrom: term,
          matchStrategy: 'stated-career-interest-or-goal-name-match',
        });
      }
    }

    return { available: true, candidates };
  }

  /**
   * Flattens `career.interests.value` and `career.goals.value` into a
   * deduplicated list of plain-string search terms. `career.goals.value`
   * may contain either strings (the `users.career_goal` single-text
   * fallback) or, per the professional-onboarding RPC's jsonb shape,
   * objects — this tolerates both without assuming a specific object
   * shape beyond an optional `.title` string, since the RPC's own jsonb
   * payload shape was not further specified anywhere in the repository.
   *
   * @private
   * @param {object} studentContext
   * @returns {string[]}
   */
  _collectCareerTerms(studentContext) {
    const terms = [];

    const addValue = (value) => {
      if (typeof value === 'string' && value.trim()) {
        terms.push(value.trim());
      } else if (value && typeof value === 'object' && typeof value.title === 'string' && value.title.trim()) {
        terms.push(value.title.trim());
      }
    };

    const interests = studentContext?.career?.interests;
    if (interests?.available && Array.isArray(interests.value)) {
      interests.value.forEach(addValue);
    }

    const goals = studentContext?.career?.goals;
    if (goals?.available && Array.isArray(goals.value)) {
      goals.value.forEach(addValue);
    }

    return [...new Set(terms)];
  }

  _unimplemented(group) {
    return { available: false, candidates: [], reason: UNIMPLEMENTED_GROUPS[group] };
  }

  _skipped() {
    return { available: false, candidates: [], reason: 'Not requested (excluded by the `groups` filter).' };
  }

  // ─────────────────────────────────────────────────────────
  // CACHE HELPERS — same pattern as KnowledgeService/StudentService.
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
      this._logger.warn('[KnowledgeRuntime.Recommendation] Cache read failed', { key, error: error.message });
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
      this._logger.warn('[KnowledgeRuntime.Recommendation] Cache write failed', { key, error: error.message });
    }
  }

  _cacheKey(userId, groups) {
    const groupsPart = groups ? [...groups].sort().join(',') : 'all';
    return `${CACHE_KEY_PREFIX}candidates:${userId}:${groupsPart}`;
  }
}

module.exports = RecommendationService;
