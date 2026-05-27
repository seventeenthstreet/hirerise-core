'use strict';

/**
 * src/modules/conversion/coordinators/conversionPipeline.coordinator.js
 *
 * Coordinator — Conversion Pipeline
 *
 * Owns the sequencing and cross-stage wiring for the conversion pipeline:
 *
 *   conversionIntent
 *       ↓
 *   conversionAggregate
 *       ↓
 *   conversionEvent
 *       ↓
 *   conversionNudge
 *
 * Services are atomic stage workers. They do not import each other.
 * Cross-stage calls are injected here via setter methods at module load time.
 *
 * Architecture: CLUSTER 3 from governance remediation spec.
 */

const conversionAggregateService = require('../services/conversionAggregate.service');
const conversionEventService = require('../services/conversionEvent.service');
const conversionIntentService = require('../services/conversionIntent.service');
const conversionNudgeService = require('../services/conversionNudge.service');

// ─────────────────────────────────────────────────────────────────────────────
// Wire providers — runs once at module load (Node.js singleton semantics)
// ─────────────────────────────────────────────────────────────────────────────

// conversionEvent fires aggregate updates → delegate to conversionAggregate
conversionEventService.setAggregateNotifier(
  (userId, eventType) => conversionAggregateService.onEventRecorded(userId, eventType)
);

// conversionIntent reads raw scores → delegate to conversionAggregate
conversionIntentService.setRawScoreProvider(
  (userId) => conversionAggregateService.getRawScores(userId)
);

// conversionNudge reads decayed scores → delegate to conversionIntent
conversionNudgeService.setScoreProvider(
  (userId) => conversionIntentService.getScores(userId)
);

// ─────────────────────────────────────────────────────────────────────────────
// Public coordinator API
// Consumers call the coordinator; never import conversion stage services directly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a conversion event and trigger async aggregate update.
 *
 * @param {string} userId
 * @param {string} eventType
 * @param {Record<string, unknown>} [metadata]
 * @param {string|null} [idempotencyKey]
 * @returns {Promise<{ recorded: boolean, eventId: string|null }>}
 */
async function recordEvent(userId, eventType, metadata, idempotencyKey) {
  return conversionEventService.recordEvent(userId, eventType, metadata, idempotencyKey);
}

/**
 * Get decayed intent scores for a user.
 *
 * @param {string} userId
 * @returns {Promise<{ engagementScore: number, monetizationScore: number, totalIntentScore: number }>}
 */
async function getIntentScores(userId) {
  return conversionIntentService.getScores(userId);
}

/**
 * Get total intent score for a user.
 *
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getTotalIntentScore(userId) {
  return conversionIntentService.getTotalIntentScore(userId);
}

/**
 * Get the recommended nudge for a user.
 *
 * @param {string} userId
 * @returns {Promise<object>}
 */
async function getNudge(userId) {
  return conversionNudgeService.getNudge(userId);
}

/**
 * Get raw (pre-decay) aggregate scores for a user.
 *
 * @param {string} userId
 * @returns {Promise<object>}
 */
async function getRawScores(userId) {
  return conversionAggregateService.getRawScores(userId);
}

module.exports = Object.freeze({
  recordEvent,
  getIntentScores,
  getTotalIntentScore,
  getNudge,
  getRawScores,
});
