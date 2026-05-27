'use strict';

/**
 * src/modules/labor-market-intelligence/coordinators/marketIntelligence.coordinator.js
 *
 * Coordinator — Labor Market Intelligence
 *
 * Owns:
 *   - trend retrieval
 *   - trend shaping
 *   - trend aggregation
 *   - trend access policy
 *   - internal pipeline sequencing: jobCollector → demandAnalysis → skillExtraction → marketTrend
 *
 * Consumers request:
 *   await marketIntelligenceCoordinator.get(...)
 *
 * Services below this coordinator are atomic stage workers.
 * They do not import each other — sequencing lives here.
 *
 * Architecture: CLUSTER 1 + CLUSTER 2 from governance remediation spec.
 */

const logger = require('../../../utils/logger');

const jobCollector = require('../collectors/jobCollector.service');
const demandAnalysis = require('../processors/demandAnalysis.service');
const marketTrend = require('../services/marketTrend.service');

// ─────────────────────────────────────────────────────────────────────────────
// Wire demand providers into marketTrend — runs once at module load.
// marketTrend.service does not import demandAnalysis directly; coordinator owns
// the cross-service dependency.
// ─────────────────────────────────────────────────────────────────────────────

marketTrend.setDemandProviders({
  loadSkillDemand: () => demandAnalysis.loadSkillDemand(),
  loadCareerScores: () => demandAnalysis.loadCareerScores(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal sequencing — Cluster 2
// Pipeline: jobCollector → demandAnalysis → (skillExtraction is internal to
// demandAnalysis via coordinator-owned sequencing) → marketTrend cache invalidation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a full LMI refresh cycle.
 * Owns sequencing; delegates atomically to each stage.
 *
 * @param {{ batchSize?: number }} options
 * @returns {Promise<object>}
 */
async function runRefresh({ batchSize = 50 } = {}) {
  logger.info({ batchSize }, '[MarketIntelligenceCoordinator] Starting LMI refresh');

  const collectResult = await jobCollector.collect({ batchSize });
  const analysisResult = await demandAnalysis.runFullAnalysis();

  marketTrend.invalidateCache();

  const result = { ...collectResult, ...analysisResult };

  logger.info(result, '[MarketIntelligenceCoordinator] Refresh complete');

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read access — Cluster 1
// All consumer domains call these methods; never import marketTrend directly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<Array>}
 */
async function getCareerTrends() {
  return marketTrend.getCareerTrends();
}

/**
 * @param {number} [limit]
 * @returns {Promise<Array>}
 */
async function getSkillDemand(limit) {
  return marketTrend.getSkillDemand(limit);
}

/**
 * @returns {Promise<Array>}
 */
async function getSalaryBenchmarks() {
  return marketTrend.getSalaryBenchmarks();
}

/**
 * @returns {Promise<object>}
 */
async function getCareerScoresMap() {
  return marketTrend.getCareerScoresMap();
}

module.exports = Object.freeze({
  runRefresh,
  getCareerTrends,
  getSkillDemand,
  getSalaryBenchmarks,
  getCareerScoresMap,
});

