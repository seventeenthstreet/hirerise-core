'use strict';

const benchmarkRepo = require('./repositories/chiBenchmark.repository');
const logger = require('../../utils/logger');

/**
 * Fetch the latest benchmark snapshot and historical trend for a user.
 *
 * Both queries run in parallel. If either fails the error propagates to the
 * caller — the Express error handler in server.js will catch it via next(err).
 *
 * @param {string} userId — Supabase user UUID
 * @returns {{ latest: object|null, trend: object[] }}
 */
async function getUserBenchmarkAnalytics(userId) {
  if (!userId) {
    throw new Error('getUserBenchmarkAnalytics: userId is required');
  }

  try {
    const [latest, trend] = await Promise.all([
      benchmarkRepo.getLatestBenchmarkByUser(userId),
      benchmarkRepo.getBenchmarkTrend(userId),
    ]);

    return { latest, trend };
  } catch (err) {
    logger.error('[chiBenchmark.service] getUserBenchmarkAnalytics failed', {
      userId,
      error: err.message,
    });
    throw err;
  }
}

module.exports = {
  getUserBenchmarkAnalytics,
};