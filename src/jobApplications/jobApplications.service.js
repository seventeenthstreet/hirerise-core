'use strict';

/**
 * jobApplications.service.js (PRODUCTION READY)
 *
 * Responsibilities:
 * - Enforce business rules (tier limits)
 * - Orchestrate repository calls
 * - Provide clean return contracts
 * - Prepare for caching / analytics hooks
 */

const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const repo = require('./repository/jobApplications.repository');

// ─────────────────────────────────────────────
// 🔹 CONSTANTS
// ─────────────────────────────────────────────

const FREE_TIER_MAX_APPLICATIONS = 8;

const PAID_TIERS = new Set(['pro', 'premium', 'enterprise']);

// ─────────────────────────────────────────────
// 🔹 HELPERS
// ─────────────────────────────────────────────

function normalizeTier(tier) {
  return (tier || 'free').toLowerCase();
}

function isPaidTier(tier) {
  return PAID_TIERS.has(normalizeTier(tier));
}

// ─────────────────────────────────────────────
// 🔹 CREATE
// ─────────────────────────────────────────────

async function addApplication(userId, tier, payload) {
  const normalizedTier = normalizeTier(tier);

  // 🔥 Free tier cap enforcement
  if (!isPaidTier(normalizedTier)) {
    const count = await repo.countByUser(userId);

    if (count >= FREE_TIER_MAX_APPLICATIONS) {
      throw new AppError(
        `Free plan allows a maximum of ${FREE_TIER_MAX_APPLICATIONS} tracked applications. Upgrade to Pro for unlimited tracking.`,
        403,
        {
          currentCount: count,
          limit: FREE_TIER_MAX_APPLICATIONS,
          upgradeUrl: process.env.UPGRADE_URL ?? '/pricing',
        },
        ErrorCodes.FORBIDDEN
      );
    }
  }

  const id = await repo.create(userId, payload);

  logger.debug('[JobAppService] Created', {
    userId,
    id,
    tier: normalizedTier,
  });

  return { id };
}

// ─────────────────────────────────────────────
// 🔹 LIST
// ─────────────────────────────────────────────

async function getApplications(userId, tier, params = {}) {
  const normalizedTier = normalizeTier(tier);

  const limit = params.limit ?? 20;
  const cursor = params.cursor ?? null;
  const status = params.status ?? null;

  const result = await repo.listByUser(userId, {
    limit,
    cursor,
    status,
  });

  logger.debug('[JobAppService] Listed', {
    userId,
    count: result.applications.length,
    hasMore: result.hasMore,
    tier: normalizedTier,
  });

  return result;
}

// ─────────────────────────────────────────────
// 🔹 UPDATE
// ─────────────────────────────────────────────

async function updateApplication(applicationId, userId, updates) {
  const updated = await repo.update(applicationId, userId, updates);

  logger.debug('[JobAppService] Updated', {
    applicationId,
    userId,
  });

  return updated;
}

// ─────────────────────────────────────────────
// 🔹 DELETE
// ─────────────────────────────────────────────

async function deleteApplication(applicationId, userId) {
  await repo.remove(applicationId, userId);

  logger.debug('[JobAppService] Deleted', {
    applicationId,
    userId,
  });

  return { deleted: true };
}

// ─────────────────────────────────────────────
// 🔹 EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  addApplication,
  getApplications,
  updateApplication,
  deleteApplication,
  FREE_TIER_MAX_APPLICATIONS,
};