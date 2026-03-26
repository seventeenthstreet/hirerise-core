// src/services/careerIntelligence.service.js

const resumeScoreService = require("./resumeScore.service");
const salaryService = require("./salary.service");
const careerGraphRepository = require("../repositories/career.repository");
const llmClient = require("../utils/llmClient");
const validator = require("../utils/careerOutput.validator");
const cache = require("../utils/cache");

const HARDENED_ENTERPRISE_PROMPT_V2 = require("../prompts/careerIntelligence.prompt");

// TTL Config
const CAREER_INTEL_TTL = 1800; // 30 minutes
const SALARY_TTL = 3600;       // 1 hour
const GRAPH_TTL = 3600;        // 1 hour

async function generateCareerIntelligence({
  userId,
  advancedMode = false,
  overrides = {}
}) {
  try {
    if (!userId) throw new Error("User ID is required");

    /**
     * -------------------------------------------------
     * 1️⃣ Resume Score (USER-BASED)
     * -------------------------------------------------
     */
    const resumeScore = overrides.resumeScore
      ? overrides.resumeScore
      : await resumeScoreService.calculate(userId);

    if (!resumeScore || !resumeScore.roleFit) {
      throw new Error("Resume score calculation failed");
    }

    const roleKey = resumeScore.roleFit.toLowerCase().replace(/\s+/g, "-");

    /**
     * -------------------------------------------------
     * 🧠 ROLE-BASED CAREER INTEL CACHE
     * -------------------------------------------------
     */
    const careerIntelCacheKey = `career-intel:${roleKey}:${advancedMode}`;

    const cachedIntel = cache.get(careerIntelCacheKey);
    if (cachedIntel) {
      return {
        ...cachedIntel,
        fromCache: true,
      };
    }

    /**
     * -------------------------------------------------
     * 2️⃣ Salary Band (ROLE-BASED CACHE)
     * -------------------------------------------------
     */
    const salaryCacheKey = `salary-band:${roleKey}`;

    let salaryBand = cache.get(salaryCacheKey);

    if (!salaryBand) {
      salaryBand = overrides.salaryBand
        ? overrides.salaryBand
        : await salaryService.getAllBandsForRole(resumeScore.roleFit);

      if (!salaryBand) {
        throw new Error("Salary band not found for role");
      }

      cache.set(salaryCacheKey, salaryBand, SALARY_TTL);
    }

    /**
     * -------------------------------------------------
     * 3️⃣ Career Graph (ROLE-BASED CACHE)
     * -------------------------------------------------
     */
    const graphCacheKey = `career-graph:${roleKey}`;

    let careerGraph = cache.get(graphCacheKey);

    if (!careerGraph) {
      careerGraph = overrides.careerGraph
        ? overrides.careerGraph
        : await careerGraphRepository.getNextRoles(resumeScore.roleFit);

      if (!careerGraph) {
        throw new Error("Career graph adjacency not found");
      }

      cache.set(graphCacheKey, careerGraph, GRAPH_TTL);
    }

    /**
     * -------------------------------------------------
     * 4️⃣ Prepare LLM Input
     * -------------------------------------------------
     */
    const llmInput = {
      resumeScore,
      salaryBand,
      careerGraph,
      advancedMode,
      systemConstraints: {
        currency: "INR",
        enforceMonotonicProbability: true,
        enforceRiskScale: true,
        enforceNumericSalary: true,
      },
    };

    /**
     * -------------------------------------------------
     * 5️⃣ LLM Generation
     * -------------------------------------------------
     */
    const llmResponse = overrides.mockLLMResponse
      ? overrides.mockLLMResponse
      : await llmClient.generate({
          systemPrompt: HARDENED_ENTERPRISE_PROMPT_V2,
          input: llmInput,
          temperature: 0.2,
        });

    if (!llmResponse) {
      throw new Error("LLM returned empty response");
    }

    /**
     * -------------------------------------------------
     * 6️⃣ Enterprise Validation
     * -------------------------------------------------
     */
    validator.validateCareerOutput(llmResponse);

    const finalResponse = {
      success: true,
      generatedAt: new Date().toISOString(),
      role: resumeScore.roleFit,
      advancedMode,
      data: llmResponse,
    };

    /**
     * -------------------------------------------------
     * 💾 Store Career Intelligence ROLE-BASED
     * -------------------------------------------------
     */
    cache.set(careerIntelCacheKey, finalResponse, CAREER_INTEL_TTL);

    return finalResponse;

  } catch (error) {
    console.error("Career Intelligence Generation Failed:", error);

    return {
      success: false,
      error: {
        message: "Career intelligence generation failed",
        details: error.message,
      },
    };
  }
}

/**
 * -------------------------------------------------
 * 🗑 Role-Based Invalidation
 * -------------------------------------------------
 */
function invalidateRoleCache(role) {
  const roleKey = role.toLowerCase().replace(/\s+/g, "-");

  cache.del(`salary-band:${roleKey}`);
  cache.del(`career-graph:${roleKey}`);
  cache.del(`career-intel:${roleKey}:false`);
  cache.del(`career-intel:${roleKey}:true`);
}

module.exports = {
  generateCareerIntelligence,
  invalidateRoleCache,
};









