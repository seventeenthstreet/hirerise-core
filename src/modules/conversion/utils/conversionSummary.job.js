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
 *  - Supabase cost efficiency
 *  - Cross-table queries
 *
 * NOTE: The original Firestore collectionGroup('events') query counted events
 * across all user sub-collections. In Supabase, all events are stored in a
 * single flat `events` table with an eventType column and a timestamp column.
 * The count is performed via a filtered select with head:true (count only).
 */
const supabase = require('../../../config/supabase');
const {
  ENGAGEMENT_WEIGHTS,
  MONETIZATION_WEIGHTS
} = require('./eventWeights.config');
const logger = require('./conversion.logger');

/**
 * Returns UTC start and end timestamps for a given date.
 */
function _getUTCDateRange(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
  return { start, end };
}

/**
 * Counts events of a specific type within a date range using Supabase.
 * Uses count estimation via { count: 'exact', head: true } for efficiency.
 */
async function _countEventsForType(eventType, start, end) {
  const { count, error } = await supabase
    .from('events')
    .select('*', { count: 'exact', head: true })
    .eq('eventType', eventType)
    .gte('timestamp', start.toISOString())
    .lte('timestamp', end.toISOString());

  if (error) throw error;
  return count ?? 0;
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
    ...Object.keys(MONETIZATION_WEIGHTS)
  ];
  const summary = {};

  try {
    const results = await Promise.all(
      allEventTypes.map(async eventType => {
        try {
          const count = await _countEventsForType(eventType, start, end);
          return { eventType, count };
        } catch (err) {
          logger.error('conversionSummaryJob: count failed', {
            eventType,
            error: err.message
          });
          return { eventType, count: -1 };
        }
      })
    );

    for (const { eventType, count } of results) {
      summary[eventType] = count;
    }

    const { error: upsertError } = await supabase
      .from('conversion_summaries')
      .upsert({
        id: dateKey,
        date: dateKey,
        counts: summary,
        generatedAt: new Date().toISOString()
      });

    if (upsertError) throw upsertError;

    logger.info('conversionSummaryJob: complete', {
      dateKey,
      totalEventTypes: allEventTypes.length
    });
  } catch (err) {
    logger.error('conversionSummaryJob: fatal failure', {
      error: err.message
    });
    throw err;
  }
}

module.exports = {
  runNightlySummaryJob
};