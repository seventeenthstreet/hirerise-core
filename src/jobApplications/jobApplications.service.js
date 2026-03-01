'use strict';

/**
 * jobApplications.service.js
 *
 * Business logic layer for job application tracking.
 * Repository handles all Firestore operations.
 * This service handles:
 *   - Free tier cap enforcement (max 8 applications)
 *   - Tier-based feature differentiation
 *   - Orchestration between repository calls
 *
 * No Firestore operations here — all data access via repository.
 */

const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger                   = require('../../utils/logger');
const repo                     = require('./repository/jobApplications.repository');

// ─── Constants ────────────────────────────────────────────────────────────────

const FREE_TIER_MAX_APPLICATIONS = 8;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isPaidTier(tier) {
  return ['pro', 'premium', 'enterprise'].includes(tier ?? 'free');
}

// ─── Service methods ──────────────────────────────────────────────────────────

/**
 * addApplication(userId, tier, payload)
 *
 * Enforces free tier cap before creating.
 * Returns the new application ID.
 */
async function addApplication(userId, tier, payload) {
  // Free tier cap check
  if (!isPaidTier(tier)) {
    const count = await repo.countByUser(userId);
    if (count >= FREE_TIER_MAX_APPLICATIONS) {
      throw new AppError(
        `Free plan allows a maximum of ${FREE_TIER_MAX_APPLICATIONS} tracked applications. Upgrade to Pro for unlimited tracking.`,
        403,
        {
          currentCount: count,
          limit:        FREE_TIER_MAX_APPLICATIONS,
          upgradeUrl:   process.env.UPGRADE_URL ?? '/pricing',
        },
        ErrorCodes.FORBIDDEN
      );
    }
  }

  const id = await repo.create(userId, payload);

  logger.debug('[JobAppService] Application added', { userId, id, tier });
  return { id };
}

/**
 * getApplications(userId, tier, queryParams)
 *
 * Free and pro users both get listing.
 * Pro users get full pagination — free users are naturally limited by cap.
 */
async function getApplications(userId, tier, { limit, cursor, status } = {}) {
  const result = await repo.listByUser(userId, { limit, cursor, status });

  logger.debug('[JobAppService] Listed applications', {
    userId, count: result.applications.length, hasMore: result.hasMore,
  });

  return result;
}

/**
 * updateApplication(applicationId, userId, updates)
 *
 * Available to both free and pro.
 * Repository enforces ownership (IDOR guard).
 */
async function updateApplication(applicationId, userId, updates) {
  const updated = await repo.update(applicationId, userId, updates);

  logger.debug('[JobAppService] Application updated', { applicationId, userId });
  return updated;
}

/**
 * deleteApplication(applicationId, userId)
 *
 * Available to both free and pro.
 * Repository enforces ownership.
 */
async function deleteApplication(applicationId, userId) {
  await repo.remove(applicationId, userId);

  logger.debug('[JobAppService] Application deleted', { applicationId, userId });
  return { deleted: true };
}

module.exports = {
  addApplication,
  getApplications,
  updateApplication,
  deleteApplication,
  FREE_TIER_MAX_APPLICATIONS,
};