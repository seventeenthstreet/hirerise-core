'use strict';

/**
 * modules/knowledge-runtime/student/studentIntelligence.service.js
 *
 * StudentService — the SIM-layer runtime view of a student
 * (RUNTIME_CLASS_REFERENCE.md §2). Produces intelligence COMPUTED FROM
 * onboarding/academic data; does not own CRUD for any of it. That remains
 * with `education-intelligence` and `student-onboarding` (Objective 3).
 *
 * ARCHITECTURE NOTE — location and naming (Objective 10 compliance):
 * WP-IMP-03's own text suggests `modules/student-context/*`. This
 * implementation instead follows the ALREADY-FROZEN
 * `RUNTIME_CLASS_REFERENCE.md` §2 contract, which places this service at
 * `modules/knowledge-runtime/student/studentIntelligence.service.js` as
 * `StudentService`, alongside `KnowledgeService`, sharing the same
 * `knowledge-runtime.module.js` composition root (`getStudentService()`,
 * already anticipated in that file's `_setServiceForTesting` shape). Per
 * WP-IMP-03's own instruction ("Do NOT redesign Knowledge Runtime... follow
 * all previously frozen contracts"), the frozen location/name wins over the
 * new WP's "suggested" (explicitly non-binding) structure. See
 * `documents/WP-IMP-03/IMPLEMENTATION_REPORT.md` for the full reasoning.
 *
 * ARCHITECTURE NOTE — ReferenceDataService / ValidationService (Objective 4):
 * WP-IMP-03 asks this service to integrate with `ReferenceDataService` and
 * `ValidationService`. Neither exists anywhere in this codebase.
 * `ReferenceDataService` does not appear in any frozen document either —
 * there is no contract to implement against, and inventing one here would
 * be exactly the kind of architecture invention this WP prohibits.
 * `ValidationService` DOES have a frozen contract
 * (`RUNTIME_CLASS_REFERENCE.md` §5), but that contract explicitly lists
 * `StudentService` as neither a consumer nor a dependency of it —
 * `ValidationService` is consumed by `RecommendationService` and
 * `ExplainabilityService` only. It also isn't constructible yet: the fixed
 * composition order is `Knowledge → Student → Validation → ...`, i.e.
 * `ValidationService` is built AFTER `StudentService`. Wiring a dependency
 * on a not-yet-constructible service would be fabricating both the
 * dependency and its availability. Neither integration is implemented here
 * — both are flagged, not silently skipped.
 *
 * What IS wired in, per Objective 2/3 ("compose, don't own", "reuse
 * existing repositories"):
 *   - `knowledgeService` — the real KnowledgeService (WP-IMP-02), read-only
 *   - `educationStudentRepository` — existing
 *     `education-intelligence/repositories/student.repository.js` (reused
 *     verbatim, per the frozen contract)
 *   - `educationProfileService` — existing
 *     `student-onboarding/services/education.service.js#getEducationProfile`
 *     (reused read-only; an intentional, evidence-backed addition beyond
 *     the frozen constructor's minimum list — see implementation report)
 *   - `studentIntelligenceRepository` — new, reads/writes
 *     `intelligence_entity_snapshots` (see that file's header for the
 *     documented BaseRepository/schema mismatch)
 *
 * What is NOT wired in (confirmed absent or unconfirmed during repository
 * inspection, not guessed at): stream, subjects, current semester/year,
 * FYUGP status, structured skills beyond the legacy `edu_students.skills`
 * array, experience, preferences, resume signals, and qualifications. Each
 * is represented in the returned context shape with `available: false` and
 * a `note` naming what would need to be confirmed to wire it in — never
 * silently omitted, never guessed.
 *
 * WP-XAI2-04 ADDITION — `career.interests` / `career.goals`:
 * `documents/WP_XAI2_04/WP_XAI2_04_IMPLEMENTATION_CLARIFICATION_REVIEW.md`
 * found this data was never actually missing — it exists, stated (not
 * inferred), under four different names across four tables. Two are wired
 * in here (read-only, additive, no schema change), per that review's
 * approved strategy; the other two are deliberately left out:
 *   - WIRED — `career.interests`: `student_career_profiles.interests`
 *     (+ `.career_curiosities`, surfaced as a `curiosities` sub-field),
 *     student-onboarding track, via the new
 *     `student-onboarding/services/careerProfile.service.js#getCareerProfile`
 *     (mirrors `educationProfileService`'s existing reuse pattern exactly).
 *   - WIRED — `career.goals`: `users.career_goal` (single text) and
 *     `user_profiles.data.career_goals` (jsonb array, written by the
 *     `complete_professional_onboarding` RPC), professional-onboarding
 *     track, via the new
 *     `repositories/professionalCareerProfile.repository.js#getProfessionalCareerProfile`.
 *     Precedence (the one explicit reconciliation decision the
 *     clarification review flagged as needed): the structured
 *     `career_goals` array wins when non-empty; the single `career_goal`
 *     text is used as a one-element array otherwise. A user with legacy
 *     data in both tracks is not expected in practice (`users.user_type`
 *     is `student` XOR `professional`), so this is a tie-break, not a
 *     merge policy.
 *   - NOT WIRED — `user_personalization_profile.career_interests`:
 *     behaviorally inferred (not stated), owned by the Personalization
 *     module, which sits outside the frozen architecture list. Blending it
 *     in would recreate the exact ownership ambiguity WP-IMP-03 declined to
 *     create. Left for a future, separately-scoped decision.
 *   - NOT WIRED — `ai-career-advisor`'s own `interests` read path: that
 *     module is not part of the frozen architecture either, and its query
 *     target was not confirmed to be the same physical table as
 *     `student_career_profiles` or `edu_students` during the clarification
 *     review.
 * Both new sources are optional constructor dependencies (default `null`),
 * matching `educationProfileService`'s existing optionality — a missing
 * dependency degrades to the previous `notSourced()` stub rather than
 * throwing, so this is non-breaking for any caller that doesn't pass them.
 */

const CACHE_KEY_PREFIX = 'student-runtime:';
const PROFILE_CACHE_TTL_BASE_SECONDS = 300;
const PROFILE_CACHE_TTL_JITTER_MAX_SECONDS = 30;

class StudentService {
  /**
   * @param {object} deps
   * @param {import('./studentIntelligence.repository').StudentIntelligenceRepository} deps.studentIntelligenceRepository
   * @param {object} deps.educationStudentRepository — existing education-intelligence/repositories/student.repository.js (function-object, reused verbatim)
   * @param {object} deps.knowledgeService — injected KnowledgeService instance
   * @param {object} deps.logger
   * @param {object} [deps.analyticsAdapter] — accepted per frozen contract; not called anywhere in this WP (no specified emission points — see file header)
   * @param {object} [deps.educationProfileService] — student-onboarding/services/education.service.js, reused read-only
   * @param {object} [deps.careerProfileService] — WP-XAI2-04: student-onboarding/services/careerProfile.service.js, reused read-only
   * @param {object} [deps.professionalCareerProfileRepository] — WP-XAI2-04: repositories/professionalCareerProfile.repository.js, reused read-only
   * @param {object} [deps.cacheClient] — resolved client from cacheManager.getClient()
   * @param {object} [deps.config]
   */
  constructor({
    studentIntelligenceRepository,
    educationStudentRepository,
    knowledgeService,
    logger,
    analyticsAdapter = null,
    educationProfileService = null,
    careerProfileService = null,
    professionalCareerProfileRepository = null,
    cacheClient = null,
    config = {},
  }) {
    if (!studentIntelligenceRepository) {
      throw new Error('[StudentService] studentIntelligenceRepository is required');
    }
    if (!educationStudentRepository) {
      throw new Error('[StudentService] educationStudentRepository is required');
    }
    if (!logger) {
      throw new Error('[StudentService] logger is required');
    }

    this._studentIntelligenceRepository = studentIntelligenceRepository;
    this._educationStudentRepository = educationStudentRepository;
    this._knowledgeService = knowledgeService ?? null;
    this._logger = logger;
    this._analyticsAdapter = analyticsAdapter;
    this._educationProfileService = educationProfileService;
    this._careerProfileService = careerProfileService;
    this._professionalCareerProfileRepository = professionalCareerProfileRepository;
    this._cacheClient = cacheClient;
    this._config = config;

    this._ttlBaseSeconds = config.profileCacheTtlSeconds ?? PROFILE_CACHE_TTL_BASE_SECONDS;
    this._ttlJitterMaxSeconds = config.profileCacheTtlJitterSeconds ?? PROFILE_CACHE_TTL_JITTER_MAX_SECONDS;
  }

  // ─────────────────────────────────────────────────────────
  // PUBLIC API — RUNTIME_CLASS_REFERENCE.md §2 (frozen contract)
  // ─────────────────────────────────────────────────────────

  /**
   * Assemble the current SIM profile for a student, cache-first.
   *
   * @param {string} userId
   * @returns {Promise<object>}
   */
  async getStudentIntelligenceProfile(userId) {
    const cacheKey = this._profileCacheKey(userId);

    const cached = await this._getCached(cacheKey);
    if (cached !== null) {
      this._logger.info('[KnowledgeRuntime.Student] getStudentIntelligenceProfile cache hit', { userId });
      return cached;
    }

    const profile = await this._composeProfile(userId);

    await this._setCached(cacheKey, profile);

    return profile;
  }

  /**
   * Recompute is NOT performed here — per the frozen contract,
   * `education.orchestrator.js` is not called directly; StudentService
   * listens for the orchestrator's completion rather than re-triggering
   * analysis. By the time this is invoked (as an event handler, or a
   * manual "refresh my context" action), the orchestrator has already
   * written a new `intelligence_entity_snapshots` row if one was due. This
   * method's actual job is: invalidate the cached profile and re-read.
   *
   * @param {string} userId
   * @returns {Promise<object>}
   */
  async refreshFromOnboarding(userId) {
    await this._deleteCached(this._profileCacheKey(userId));
    this._logger.info('[KnowledgeRuntime.Student] refreshFromOnboarding — cache invalidated, re-reading', { userId });
    return this.getStudentIntelligenceProfile(userId);
  }

  /**
   * The single scalar readiness/maturity signal SIM exposes to
   * Recommendation/CHI. Sourced from the latest snapshot's
   * `composite_confidence` — returns `null` (not 0, to avoid implying "zero
   * readiness") when no snapshot exists yet for this student.
   *
   * @param {string} userId
   * @returns {Promise<number|null>}
   */
  async getReadinessScore(userId) {
    const snapshot = await this._studentIntelligenceRepository.findLatestSnapshot(userId);
    return snapshot ? snapshot.compositeConfidence : null;
  }

  /**
   * The structured vector RecommendationService consumes — the latest
   * snapshot's `signal_state` + `domain_state`, verbatim. This service does
   * not transform or reinterpret them; that's RecommendationService's job.
   *
   * @param {string} userId
   * @returns {Promise<{signalState: object, domainState: object}|null>}
   */
  async getProfileVector(userId) {
    const snapshot = await this._studentIntelligenceRepository.findLatestSnapshot(userId);
    if (!snapshot) return null;

    return {
      signalState: snapshot.signalState,
      domainState: snapshot.domainState,
    };
  }

  // ─────────────────────────────────────────────────────────
  // PUBLIC API — WP-IMP-03 Objective 5 request contract
  // Each is a slice over the same composed profile — one fetch, multiple
  // views, per Objective 2 ("compose context rather than own it").
  // ─────────────────────────────────────────────────────────

  async getStudentSnapshot(userId) {
    return this.getStudentIntelligenceProfile(userId);
  }

  async getAcademicSnapshot(userId) {
    const { userId: id, academic, meta } = await this.getStudentIntelligenceProfile(userId);
    return { userId: id, academic, meta };
  }

  async getCareerSnapshot(userId) {
    const { userId: id, career, meta } = await this.getStudentIntelligenceProfile(userId);
    return { userId: id, career, meta };
  }

  async getSkillSnapshot(userId) {
    const { userId: id, skills, meta } = await this.getStudentIntelligenceProfile(userId);
    return { userId: id, skills, meta };
  }

  /**
   * "Future Snapshot" — the forward-looking slice: stated goals (where
   * available) plus the readiness trend. Not a prediction — this WP
   * explicitly excludes recommendation logic (Objective 5).
   */
  async getFutureSnapshot(userId) {
    const { userId: id, career, readiness, meta } = await this.getStudentIntelligenceProfile(userId);
    return { userId: id, goals: career.goals, readiness, meta };
  }

  async getReadinessSnapshot(userId) {
    const { userId: id, readiness, meta } = await this.getStudentIntelligenceProfile(userId);
    return { userId: id, readiness, meta };
  }

  // ─────────────────────────────────────────────────────────
  // COMPOSITION
  // ─────────────────────────────────────────────────────────

  async _composeProfile(userId) {
    const [educationStudent, educationProfile, latestSnapshot, careerProfile, professionalCareerProfile] = await Promise.all([
      this._safeCall(() => this._educationStudentRepository.getStudent(userId), 'getStudent'),
      this._educationProfileService
        ? this._safeCall(() => this._educationProfileService.getEducationProfile(userId), 'getEducationProfile')
        : Promise.resolve(null),
      this._safeCall(() => this._studentIntelligenceRepository.findLatestSnapshot(userId), 'findLatestSnapshot'),
      this._careerProfileService
        ? this._safeCall(() => this._careerProfileService.getCareerProfile(userId), 'getCareerProfile')
        : Promise.resolve(null),
      this._professionalCareerProfileRepository
        ? this._safeCall(() => this._professionalCareerProfileRepository.getProfessionalCareerProfile(userId), 'getProfessionalCareerProfile')
        : Promise.resolve(null),
    ]);

    const notSourced = (note) => ({ available: false, value: null, note });

    return Object.freeze({
      userId,
      personal: {
        available: Boolean(educationStudent),
        name: educationStudent?.name ?? null,
        source: 'education-intelligence/repositories/student.repository.js#getStudent (edu_students)',
      },
      academic: {
        // Legacy, thin fields — confirmed present on edu_students.
        educationLevelLegacy: educationStudent?.educationLevel ?? null,
        // Richer school-level profile — confirmed present on student_education_profiles.
        educationLevel: educationProfile?.education_level ?? null,
        boardType: educationProfile?.board_type ?? null,
        schoolType: educationProfile?.school_type ?? null,
        available: Boolean(educationStudent || educationProfile),
        // Not wired in this WP — see class header.
        stream: notSourced('No confirmed owner found for "stream" during repository inspection for WP-IMP-03.'),
        subjects: notSourced('student_academic_subjects (student-onboarding/repositories/academic.repository.js) was located but not wired into this composition — needs confirmation of shape before reuse.'),
        currentSemesterOrYear: notSourced('No confirmed owner found for higher-education semester/year tracking during repository inspection for WP-IMP-03.'),
        fyugpStatus: notSourced('No confirmed owner found for FYUGP status during repository inspection for WP-IMP-03.'),
        qualifications: notSourced('modules/qualification/qualification.service.js provides a reference lookup (listActiveQualifications/getQualificationById) but no confirmed link from a student record to a qualification id was found.'),
      },
      career: this._composeCareer(careerProfile, professionalCareerProfile),
      skills: {
        // Confirmed present: edu_students.skills (flat text array).
        legacy: educationStudent?.skills ?? [],
        structured: notSourced('No confirmed structured skills source (with proficiency/evidence) was found beyond the legacy edu_students.skills array.'),
      },
      experience: notSourced('No confirmed owner found for work/internship experience during repository inspection for WP-IMP-03.'),
      preferences: notSourced('No confirmed owner found for stated preferences during repository inspection for WP-IMP-03.'),
      resumeSignals: notSourced('modules/resumeScore and modules/resumeGrowth exist and were identified as likely owners, but were not read in enough depth during this WP to confirm a safe read-only integration point.'),
      readiness: {
        available: Boolean(latestSnapshot),
        compositeConfidence: latestSnapshot?.compositeConfidence ?? null,
        confidenceTier: latestSnapshot?.confidenceTier ?? null,
        dataCompleteness: latestSnapshot?.dataCompleteness ?? null,
        activeSignalCount: latestSnapshot?.activeSignalCount ?? null,
        domainsIncluded: latestSnapshot?.domainsIncluded ?? [],
        snapshotAt: latestSnapshot?.snapshotAt ?? null,
        source: 'intelligence_entity_snapshots (latest by snapshot_sequence)',
      },
      meta: {
        generatedAt: new Date().toISOString(),
      },
    });
  }

  async _safeCall(fn, label) {
    try {
      return await fn();
    } catch (error) {
      this._logger.warn('[KnowledgeRuntime.Student] composition source failed, continuing without it', {
        source: label,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * WP-XAI2-04 — compose `career.interests`/`career.goals` from the two
   * confirmed, stated (not inferred) sources. See the class header for the
   * full sourcing rationale and the precedence rule applied below.
   *
   * @private
   * @param {{interests: string[], careerCuriosities: string[]}|null} careerProfile — student-onboarding track
   * @param {{careerGoal: string|null, careerGoals: array}|null} professionalCareerProfile — professional-onboarding track
   */
  _composeCareer(careerProfile, professionalCareerProfile) {
    const notSourced = (note) => ({ available: false, value: null, note });

    const interests = careerProfile
      ? {
          available: true,
          value: careerProfile.interests,
          curiosities: careerProfile.careerCuriosities,
          source: 'student_career_profiles.interests/career_curiosities (student-onboarding track)',
        }
      : notSourced(
          'No student_career_profiles row found for this user (student-onboarding track). ' +
            'See documents/WP_XAI2_04/WP_XAI2_04_IMPLEMENTATION_CLARIFICATION_REVIEW.md §6-9.'
        );

    let goals;
    if (professionalCareerProfile?.careerGoals?.length) {
      // Structured, multi-goal source wins when non-empty (WP-XAI2-04
      // precedence decision — see class header).
      goals = {
        available: true,
        value: professionalCareerProfile.careerGoals,
        source: 'user_profiles.data.career_goals (professional-onboarding track, complete_professional_onboarding RPC)',
      };
    } else if (professionalCareerProfile?.careerGoal) {
      goals = {
        available: true,
        value: [professionalCareerProfile.careerGoal],
        source: 'users.career_goal (professional-onboarding track, single free-text field)',
      };
    } else {
      goals = notSourced(
        'No users.career_goal or user_profiles.data.career_goals found for this user (professional-onboarding track). ' +
          'See documents/WP_XAI2_04/WP_XAI2_04_IMPLEMENTATION_CLARIFICATION_REVIEW.md §6-9.'
      );
    }

    return { interests, goals };
  }

  // ─────────────────────────────────────────────────────────
  // CACHE HELPERS — identical pattern to KnowledgeService (WP-IMP-02),
  // itself reused from dashboard.service.js. No new caching framework.
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
      this._logger.warn('[KnowledgeRuntime.Student] Cache read failed', { key, error: error.message });
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
      this._logger.warn('[KnowledgeRuntime.Student] Cache write failed', { key, error: error.message });
    }
  }

  async _deleteCached(key) {
    const redis = this._resolveRawClient();
    if (!redis) return;

    try {
      await redis.del(key);
    } catch (error) {
      this._logger.warn('[KnowledgeRuntime.Student] Cache invalidation failed', { key, error: error.message });
    }
  }

  _profileCacheKey(userId) {
    return `${CACHE_KEY_PREFIX}profile:${userId}`;
  }
}

module.exports = StudentService;
