'use strict';

/**
 * @file src/services/careerPath.service.js
 * @description
 * Production-grade career path orchestration.
 *
 * Optimized for:
 * - graph-first execution
 * - deterministic next-role ranking
 * - shared role enrichment pipeline
 * - safer error semantics
 * - null-safe salary math
 * - consistent logging
 */

const careerRepo = require('../repositories/career.repository');
const readinessService = require('./readiness.service');
const promotionService = require('./promotion.service');
const timeEstimatorService = require('./timeEstimator.service');
const logger = require('../utils/logger');

let careerGraph = null;

try {
  careerGraph = require('../modules/careerGraph/CareerGraph');
  logger.info('[CareerPathService] CareerGraph loaded');
} catch (err) {
  logger.warn('[CareerPathService] CareerGraph unavailable', {
    error: err?.message || 'Unknown graph load error',
  });
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function createServiceError(statusCode, errorCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

function safeMedian(role) {
  const value = role?.salary?.median;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function calculateGrowth(currentMedian, nextMedian, readiness = 1) {
  const current = Number(currentMedian);
  const next = Number(nextMedian);
  const safeReadiness = Number.isFinite(Number(readiness))
    ? Number(readiness)
    : 1;

  if (!Number.isFinite(current) || !Number.isFinite(next) || current <= 0) {
    return null;
  }

  const rawDelta = next - current;
  const adjustedDelta = Math.round(rawDelta * safeReadiness);
  const growthPercent = (adjustedDelta / current) * 100;

  return {
    raw_salary_delta: rawDelta,
    adjusted_salary_delta: adjustedDelta,
    growth_percent: Number(growthPercent.toFixed(2)),
    readiness_score: safeReadiness,
  };
}

function buildSyntheticRole(node) {
  return {
    required_skills: node?.required_skills || [],
    min_experience_years: node?.min_experience_years || 0,
  };
}

function enrichNextRole({
  currentRole,
  nextRole,
  userProfile,
  transitionMeta = {},
}) {
  let readinessDetails = null;
  let readinessScore = 1;
  let timeEstimate = null;

  if (userProfile) {
    try {
      readinessDetails =
        readinessService.calculateReadiness(
          userProfile,
          nextRole
        ) || null;

      readinessScore =
        readinessDetails?.readiness_score ?? 1;

      timeEstimate =
        timeEstimatorService.estimateTimeToPromotion(
          userProfile,
          nextRole,
          readinessDetails
        ) || null;
    } catch (err) {
      logger.warn('[CareerPathService] Readiness enrichment failed', {
        error: err?.message || 'Unknown readiness error',
      });
    }
  }

  const growth = calculateGrowth(
    safeMedian(currentRole),
    safeMedian(nextRole),
    readinessScore
  );

  const promotionProbability =
    promotionService.calculatePromotionProbability(
      readinessScore
    );

  return {
    role_id: nextRole.role_id,
    title: nextRole.title,
    career_level: nextRole.career_level,
    level_order: nextRole.level_order,
    salary: nextRole.salary || null,
    readiness_details: readinessDetails,
    promotion_probability_percent: promotionProbability,
    time_to_promotion: timeEstimate,
    growth_projection: growth,
    ...transitionMeta,
  };
}

function sortNextRoles(nextRoles) {
  return nextRoles.sort((a, b) => {
    const probA = Number(a.transition_probability || 0);
    const probB = Number(b.transition_probability || 0);

    if (probB !== probA) return probB - probA;

    return Number(a.level_order || 0) - Number(b.level_order || 0);
  });
}

// ─────────────────────────────────────────────────────────────
// Main service
// ─────────────────────────────────────────────────────────────
async function getCareerPath(roleId, userProfile = null) {
  const safeRoleId = String(roleId || '').trim();

  if (!safeRoleId) {
    throw createServiceError(
      400,
      'INVALID_ROLE_ID',
      'roleId is required'
    );
  }

  // ─────────────────────────────────────────────────────────
  // Graph-first engine
  // ─────────────────────────────────────────────────────────
  try {
    const graphNode = careerGraph
      ? careerGraph.getRole(safeRoleId) ||
        careerGraph.resolveRole(safeRoleId)
      : null;

    if (graphNode) {
      const transitions =
        careerGraph.getTransitions(safeRoleId, {
          minProbability: 0.1,
        }) || [];

      const nextRoles = [];

      for (const edge of transitions) {
        const nextNode = careerGraph.getRole(edge.to_role_id);
        if (!nextNode) continue;

        nextRoles.push(
          enrichNextRole({
            currentRole: graphNode,
            nextRole: buildSyntheticRole(nextNode)
              ? nextNode
              : nextNode,
            userProfile,
            transitionMeta: {
              transition_type: edge.transition_type,
              transition_probability: edge.probability,
              years_required: edge.years_required,
            },
          })
        );
      }

      return {
        current_role: {
          role_id: graphNode.role_id,
          title: graphNode.title,
          career_level: graphNode.career_level,
          level_order: graphNode.level_order,
          salary: graphNode.salary || null,
        },
        next_roles: sortNextRoles(nextRoles),
        is_terminal: Boolean(graphNode.is_terminal),
      };
    }
  } catch (err) {
    logger.error('[CareerPathService] Graph engine failed', {
      role_id: safeRoleId,
      error: err?.message || 'Unknown graph error',
    });
  }

  // ─────────────────────────────────────────────────────────
  // Supabase/repository fallback
  // ─────────────────────────────────────────────────────────
  try {
    const currentRole = await careerRepo.getRole(safeRoleId);

    if (!currentRole) {
      throw createServiceError(
        404,
        'ROLE_NOT_FOUND',
        `Role ${safeRoleId} not found`
      );
    }

    const nextRolesRaw =
      (await careerRepo.getNextRoles(safeRoleId)) || [];

    const nextRoles = nextRolesRaw
      .filter(Boolean)
      .map((nextRole) =>
        enrichNextRole({
          currentRole,
          nextRole,
          userProfile,
        })
      );

    return {
      current_role: {
        role_id: currentRole.role_id,
        title: currentRole.title,
        career_level: currentRole.career_level,
        level_order: currentRole.level_order,
        salary: currentRole.salary || null,
      },
      next_roles: sortNextRoles(nextRoles),
      is_terminal: Boolean(currentRole.is_terminal),
    };
  } catch (err) {
    logger.error('[CareerPathService] Fallback failed', {
      role_id: safeRoleId,
      error: err?.message || 'Unknown fallback error',
    });

    throw err;
  }
}

module.exports = {
  getCareerPath,
};