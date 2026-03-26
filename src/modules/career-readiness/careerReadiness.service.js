const crypto = require("crypto");
const DeterministicEngine = require("./deterministic.engine");
const AIEngine = require("./ai.engine");
const ScoringAggregator = require("./scoring.aggregator");
const { validateCandidateProfile } = require("./careerReadiness.validator");
const logger = require("../../utils/logger");
const cache = require("../../utils/cache"); // Redis or distributed cache
const { SCORING_VERSION } = require("../../config/careerReadiness.weights");

const DETERMINISTIC_CACHE_TTL = 60 * 10; // 10 minutes

class CareerReadinessService {
  constructor({
    salaryService,
    skillIntelligenceService,
    resumeScoreService,
    careerRoleGraph,
    scoreRepository,
  }) {
    this.deterministicEngine = new DeterministicEngine({
      salaryService,
      skillIntelligenceService,
      resumeScoreService,
      careerRoleGraph,
    });

    this.aiEngine = new AIEngine();
    this.aggregator = new ScoringAggregator();
    this.scoreRepository = scoreRepository;
  }

  /**
   * Main Orchestrator
   */
  async computeReadiness(rawProfile, resumeData) {
    // 1️⃣ Validate input
    const profile = validateCandidateProfile(rawProfile);

    // 2️⃣ Build deterministic input snapshot for hashing
    const deterministicInputSnapshot = {
      candidateId: profile.candidateId,
      targetRoleId: profile.targetRoleId,
      skills: [...profile.skills].sort(),
      totalYearsExperience: profile.totalYearsExperience,
      certifications: [...profile.certifications].sort(),
      highestEducation: profile.highestEducation,
      scoringVersion: SCORING_VERSION,
    };

    const detInputHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(deterministicInputSnapshot))
      .digest("hex");

    const cacheKey = `crs:det:${detInputHash}`;

    let deterministicResult = await cache.get(cacheKey);

    // 3️⃣ Deterministic Layer (Cached)
    if (!deterministicResult) {
      logger.info("[CRS] Computing deterministic layer", {
        candidateId: profile.candidateId,
      });

      deterministicResult = await this.deterministicEngine.compute(
        profile,
        resumeData
      );

      await cache.set(cacheKey, deterministicResult, DETERMINISTIC_CACHE_TTL);
    } else {
      logger.info("[CRS] Deterministic cache hit", {
        candidateId: profile.candidateId,
      });
    }

    // 4️⃣ AI Layer (Never Cached — Always Fresh)
    logger.info("[CRS] Invoking AI layer", {
      candidateId: profile.candidateId,
    });

    const aiResult = await this.aiEngine.evaluate(
      profile,
      deterministicResult.meta.roleMetadata,
      deterministicResult.meta
    );

    if (!aiResult.success) {
      logger.warn("[CRS] AI layer degraded — fallback applied", {
        candidateId: profile.candidateId,
      });
    }

    // 5️⃣ Aggregate Final Score
    const finalResult = this.aggregator.aggregate(
      deterministicResult,
      aiResult,
      profile
    );

    // 6️⃣ Persist for Trend & Historical Intelligence
    await this.scoreRepository.saveScore({
      candidateId: profile.candidateId,
      targetRoleId: profile.targetRoleId,
      score: finalResult.career_readiness_score,
      breakdown: finalResult,
      scoringVersion: SCORING_VERSION,
      aiDegraded: !aiResult.success,
      computedAt: new Date().toISOString(),
    });

    return finalResult;
  }
}

module.exports = CareerReadinessService;









