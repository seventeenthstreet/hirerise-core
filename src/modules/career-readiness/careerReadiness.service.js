"use strict";

const crypto = require("crypto");

const DeterministicEngine = require("./deterministic.engine");
const AIEngine = require("./ai.engine");
const ScoringAggregator = require("./scoring.aggregator");
const { validateCandidateProfile } = require("./careerReadiness.validator");

const logger = require("../../utils/logger");
const cache = require("../../utils/cache");
const { SCORING_VERSION } = require("../../config/careerReadiness.weights");

const DETERMINISTIC_CACHE_TTL = 60 * 10; // 10 minutes

class CareerReadinessService {
  constructor({
    salaryService,
    skillIntelligenceService,
    resumeScoreService,
    careerRoleGraph,
    scoreRepository = null,
  }) {
    if (!salaryService) {
      throw new Error("[CareerReadinessService] Missing salaryService");
    }

    if (!skillIntelligenceService) {
      throw new Error(
        "[CareerReadinessService] Missing skillIntelligenceService"
      );
    }

    if (!resumeScoreService) {
      throw new Error("[CareerReadinessService] Missing resumeScoreService");
    }

    this.deterministicEngine = new DeterministicEngine({
      salaryService,
      skillIntelligenceService,
      resumeScoreService,
      careerRoleGraph: careerRoleGraph ?? {},
    });

    this.aiEngine = new AIEngine();
    this.aggregator = new ScoringAggregator();
    this.scoreRepository = scoreRepository;
  }

  /**
   * Main orchestration entrypoint
   */
  async computeReadiness(rawProfile, resumeData) {
    // 1) Validate and normalize input
    const profile = validateCandidateProfile(rawProfile);

    // 2) Build stable deterministic hash snapshot
    const deterministicInputSnapshot =
      this._buildDeterministicSnapshot(profile);

    const detInputHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(deterministicInputSnapshot))
      .digest("hex");

    const cacheKey = `crs:det:${detInputHash}`;

    let deterministicResult = null;

    // 3) Best-effort distributed cache read
    try {
      deterministicResult = await cache.get(cacheKey);
    } catch (cacheErr) {
      logger.warn("[CRS] Cache read failed — bypassing cache", {
        error: cacheErr?.message ?? "Unknown cache read error",
        candidateId: profile.candidateId,
      });
    }

    // 4) Deterministic scoring layer
    if (!deterministicResult) {
      logger.info("[CRS] Computing deterministic layer", {
        candidateId: profile.candidateId,
      });

      deterministicResult = await this.deterministicEngine.compute(
        profile,
        resumeData
      );

      // Best-effort cache write
      try {
        await cache.set(
          cacheKey,
          deterministicResult,
          DETERMINISTIC_CACHE_TTL
        );
      } catch (cacheErr) {
        logger.warn("[CRS] Cache write failed", {
          error: cacheErr?.message ?? "Unknown cache write error",
          candidateId: profile.candidateId,
        });
      }
    } else {
      logger.info("[CRS] Deterministic cache hit", {
        candidateId: profile.candidateId,
      });
    }

    // 5) AI enrichment layer
    logger.info("[CRS] Invoking AI layer", {
      candidateId: profile.candidateId,
    });

    const aiResult = await this.aiEngine.evaluate(
      profile,
      deterministicResult?.meta?.roleMetadata ?? {},
      deterministicResult?.meta ?? {}
    );

    if (!aiResult.success) {
      logger.warn("[CRS] AI layer degraded — fallback applied", {
        candidateId: profile.candidateId,
      });
    }

    // 6) Final score aggregation
    const finalResult = this.aggregator.aggregate(
      deterministicResult,
      aiResult,
      profile
    );

    // 7) Persist Supabase analytics score history
    await this._persistScore(profile, finalResult, aiResult);

    return finalResult;
  }

  /**
   * Stable deterministic snapshot for cache hashing
   */
  _buildDeterministicSnapshot(profile) {
    return {
      candidateId: profile?.candidateId ?? null,
      targetRoleId: profile?.targetRoleId ?? null,
      skills: [...(profile?.skills ?? [])].sort(),
      totalYearsExperience: profile?.totalYearsExperience ?? 0,
      certifications: [...(profile?.certifications ?? [])].sort(),
      highestEducation: profile?.highestEducation ?? null,
      scoringVersion: SCORING_VERSION,
    };
  }

  /**
   * Persist into live Supabase analytics schema
   * Table: career_readiness_scores
   */
  async _persistScore(profile, finalResult, aiResult) {
    if (!this.scoreRepository?.saveScore) {
      logger.info("[CRS] Score persistence skipped — repository unavailable", {
        candidateId: profile?.candidateId ?? null,
      });
      return;
    }

    try {
      await this.scoreRepository.saveScore({
        candidate_id: profile.candidateId,
        role_id: profile.targetRoleId,
        overall_score: Number(
          finalResult?.career_readiness_score ?? 0
        ).toFixed(2),
        breakdown: finalResult,
        scored_at: new Date().toISOString(),
      });
    } catch (persistErr) {
      logger.error("[CRS] Score persistence failed", {
        error: persistErr?.message ?? "Unknown persistence error",
        candidateId: profile?.candidateId ?? null,
      });
    }
  }
}

module.exports = CareerReadinessService;