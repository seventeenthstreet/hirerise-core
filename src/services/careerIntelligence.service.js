'use strict';

/**
 * @file src/services/careerIntelligence.service.js
 * @description
 * Production-grade career intelligence orchestration service.
 *
 * Optimized for:
 * - deterministic role cache keys
 * - cache-safe orchestration
 * - cleaner async flow
 * - structured logging
 * - stronger null safety
 * - modular override resolution
 */

const resumeScoreService = require('./resumeScore.service');
const salaryService = require('./salary.service');
const careerGraphRepository = require('../repositories/career.repository');
const llmClient = require('../utils/llmClient');
const validator = require('../utils/careerOutput.validator');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const HARDENED_ENTERPRISE_PROMPT_V2 = require('../prompts/careerIntelligence.prompt');

// ─────────────────────────────────────────────────────────────────────────────
// TTL Config
// ─────────────────────────────────────────────────────────────────────────────
const CAREER_INTEL_TTL = 1800; // 30 min
const SALARY_TTL = 3600; // 1 hour
const GRAPH_TTL = 3600; // 1 hour

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function normalizeRoleKey(role) {
  return String(role || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function resolveOverride(value, fallbackFn) {
  return value !== undefined && value !== null
    ? value
    : fallbackFn();
}

async function getCachedOrLoad(key, ttl, loader) {
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const value = await loader();

  if (value !== undefined && value !== null) {
    cache.set(key, value, ttl);
  }

  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main service
// ─────────────────────────────────────────────────────────────────────────────
async function generateCareerIntelligence({
  userId,
  advancedMode = false,
  overrides = {},
}) {
  try {
    const safeUserId = String(userId || '').trim();

    if (!safeUserId) {
      throw new Error('User ID is required');
    }

    // 1) Resume score (user-based)
    const resumeScore = await resolveOverride(
      overrides.resumeScore,
      () => resumeScoreService.calculate(safeUserId)
    );

    if (!resumeScore?.roleFit) {
      throw new Error('Resume score calculation failed');
    }

    const roleKey = normalizeRoleKey(resumeScore.roleFit);

    if (!roleKey) {
      throw new Error('Invalid role generated from resume score');
    }

    // 2) Hot path: full response role cache
    const careerIntelCacheKey =
      `career-intel:${roleKey}:${Boolean(advancedMode)}`;

    const cachedIntel = cache.get(careerIntelCacheKey);
    if (cachedIntel) {
      return {
        ...cachedIntel,
        fromCache: true,
      };
    }

    // 3) Parallel role-based dependencies
    const [salaryBand, careerGraph] = await Promise.all([
      getCachedOrLoad(
        `salary-band:${roleKey}`,
        SALARY_TTL,
        async () =>
          resolveOverride(
            overrides.salaryBand,
            () => salaryService.getAllBandsForRole(resumeScore.roleFit)
          )
      ),
      getCachedOrLoad(
        `career-graph:${roleKey}`,
        GRAPH_TTL,
        async () =>
          resolveOverride(
            overrides.careerGraph,
            () =>
              careerGraphRepository.getNextRoles(
                resumeScore.roleFit
              )
          )
      ),
    ]);

    if (!salaryBand) {
      throw new Error('Salary band not found for role');
    }

    if (!careerGraph) {
      throw new Error('Career graph adjacency not found');
    }

    // 4) Prepare LLM input
    const llmInput = {
      resumeScore,
      salaryBand,
      careerGraph,
      advancedMode: Boolean(advancedMode),
      systemConstraints: {
        currency: 'INR',
        enforceMonotonicProbability: true,
        enforceRiskScale: true,
        enforceNumericSalary: true,
      },
    };

    // 5) LLM generation
    const llmResponse = await resolveOverride(
      overrides.mockLLMResponse,
      () =>
        llmClient.generate({
          systemPrompt: HARDENED_ENTERPRISE_PROMPT_V2,
          input: llmInput,
          temperature: 0.2,
        })
    );

    if (!llmResponse) {
      throw new Error('LLM returned empty response');
    }

    // 6) Enterprise validation
    validator.validateCareerOutput(llmResponse);

    const finalResponse = {
      success: true,
      generatedAt: new Date().toISOString(),
      role: resumeScore.roleFit,
      advancedMode: Boolean(advancedMode),
      data: llmResponse,
    };

    cache.set(
      careerIntelCacheKey,
      finalResponse,
      CAREER_INTEL_TTL
    );

    return finalResponse;
  } catch (error) {
    logger.error(
      '[CareerIntelligenceService] Generation failed',
      {
        user_id: userId || null,
        error: error?.message || 'Unknown generation error',
      }
    );

    return {
      success: false,
      error: {
        message: 'Career intelligence generation failed',
        details: error?.message || 'Unknown error',
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Role-based invalidation
// ─────────────────────────────────────────────────────────────────────────────
function invalidateRoleCache(role) {
  const roleKey = normalizeRoleKey(role);

  if (!roleKey) return;

  cache.del(`salary-band:${roleKey}`);
  cache.del(`career-graph:${roleKey}`);
  cache.del(`career-intel:${roleKey}:false`);
  cache.del(`career-intel:${roleKey}:true`);
}

module.exports = {
  generateCareerIntelligence,
  invalidateRoleCache,
};