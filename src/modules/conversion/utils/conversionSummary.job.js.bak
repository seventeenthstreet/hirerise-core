'use strict';

/**
 * conversionSummary.job.js
 *
 * Nightly analytics aggregation job.
 *
 * Designed for:
 *  - Cloud Scheduler
 *  - node-cron
 *  - Queue worker
 *
 * Optimized for:
 *  - Large event volumes
 *  - Firestore cost efficiency
 *  - Collection group queries
 *
 * REQUIRED INDEX:
 *  collectionGroup: events
 *  fields:
 *    - eventType ASC
 *    - timestamp ASC
 */

const { db, FieldValue } = require('../../../config/supabase');
const {
  ENGAGEMENT_WEIGHTS,
  MONETIZATION_WEIGHTS,
} = require('./eventWeights.config');
const logger = require('./conversion.logger');

/**
 * Returns UTC start and end timestamps for a given date.
 */
function _getUTCDateRange(date) {
  const start = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0, 0, 0, 0
  ));

  const end = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    23, 59, 59, 999
  ));

  return { start, end };
}

/**
 * Uses Firestore count() aggregation if available.
 */
async function _countEventsForType(db, eventType, start, end) {
  const baseQuery = db
    .collectionGroup('events')
    .where('eventType', '==', eventType)
    .where('timestamp', '>=', start)
    .where('timestamp', '<=', end);

  // Prefer aggregation query (Firestore v6+)
  if (typeof baseQuery.count === 'function') {
    const snapshot = await baseQuery.count().get();
    return snapshot.data().count;
  }

  // Fallback (less efficient but safe)
  const snapshot = await baseQuery.get();
  return snapshot.size;
}

/**
 * Main nightly job runner.
 */
async function runNightlySummaryJob() {
  logger.info('conversionSummaryJob: starting');

  

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const dateKey = yesterday.toISOString().slice(0, 10);
  const { start, end } = _getUTCDateRange(yesterday);

  const allEventTypes = [
    ...Object.keys(ENGAGEMENT_WEIGHTS),
    ...Object.keys(MONETIZATION_WEIGHTS),
  ];

  const summary = {};

  try {
    const results = await Promise.all(
      allEventTypes.map(async (eventType) => {
        try {
          const count = await _countEventsForType(db, eventType, start, end);
          return { eventType, count };
        } catch (err) {
          logger.error('conversionSummaryJob: count failed', {
            eventType,
            error: err.message,
          });
          return { eventType, count: -1 };
        }
      })
    );

    for (const { eventType, count } of results) {
      summary[eventType] = count;
    }

    await db
      .collection('conversion_summaries')
      .doc(dateKey)
      .set({
        date: dateKey,
        counts: summary,
        generatedAt: FieldValue.serverTimestamp(),
      });

    logger.info('conversionSummaryJob: complete', {
      dateKey,
      totalEventTypes: allEventTypes.length,
    });
  } catch (err) {
    logger.error('conversionSummaryJob: fatal failure', {
      error: err.message,
    });
    throw err;
  }
}

module.exports = { runNightlySummaryJob };









