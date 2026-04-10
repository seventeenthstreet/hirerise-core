'use strict';

const benchmarkService = require('./chiBenchmark.service');
const logger = require('../../utils/logger');

/**
 * GET /api/v1/chi-v2/benchmark (or equivalent mount point)
 *
 * Returns the authenticated user's latest CHI benchmark snapshot
 * and their historical percentile trend.
 *
 * Response shape:
 * {
 *   success: true,
 *   data: {
 *     latest: { week_bucket, avg_score, percentile_rank, ... } | null,
 *     trend:  [{ week_bucket, avg_score, percentile_rank, ... }]
 *   }
 * }
 *
 * 204 is returned when no benchmark data exists yet for the user
 * (first-time users who have not completed a CHI assessment).
 */
async function getUserBenchmarkAnalytics(req, res, next) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        errorCode: 'UNAUTHORIZED',
        message: 'Missing authenticated user',
      });
    }

    logger.debug('[chiBenchmark.controller] Fetching benchmark analytics', { userId });

    const { latest, trend } = await benchmarkService.getUserBenchmarkAnalytics(userId);

    // No benchmark data yet — user hasn't completed a CHI assessment
    if (!latest && trend.length === 0) {
      return res.status(204).send();
    }

    return res.status(200).json({
      success: true,
      data: { latest, trend },
    });
  } catch (err) {
    logger.error('[chiBenchmark.controller] getUserBenchmarkAnalytics error', {
      userId: req.user?.id,
      error: err.message,
    });
    return next(err);
  }
}

module.exports = {
  getUserBenchmarkAnalytics,
};