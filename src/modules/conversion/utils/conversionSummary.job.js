'use strict';

/**
 * src/modules/conversion/utils/conversionSummary.job.js
 *
 * Nightly analytics aggregation job.
 *
 * Optimized for live production indexes:
 * - partial dedupe index already active
 * - composite summary index verified
 * - index-only count scans per event type
 * - Promise.all parallel execution
 * - near-zero Supabase cost
 */

const { supabase } = require('../../../config/supabase');
const {
  ENGAGEMENT_WEIGHTS,
  MONETIZATION_WEIGHTS,
} = require('./eventWeights.config');
const logger = require('./conversion.logger');

const EVENTS_TABLE = 'conversion_events';
const SUMMARY_TABLE = 'conversion_summaries';

/**
 * Returns UTC start/end range for a given day.
 *
 * @param {Date} date
 */
function getUTCDateRange(date) {
  const start = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );

  const end = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      23,
      59,
      59,
      999
    )
  );

  return { start, end };
}

/**
 * Fast index-only count per event type.
 *
 * @param {string} eventType
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<number>}
 */
async function countEventsForType(eventType, start, end) {
  const { count, error } = await supabase
    .from(EVENTS_TABLE)
    .select('*', { count: 'exact', head: true })
    .eq('event_type', eventType)
    .gte('timestamp', start.toISOString())
    .lte('timestamp', end.toISOString());

  if (error) {
    throw error;
  }

  return count ?? 0;
}

/**
 * Main nightly analytics summary job.
 */
async function runNightlySummaryJob() {
  logger.info('conversionSummaryJob starting');

  const targetDate = new Date();
  targetDate.setUTCDate(targetDate.getUTCDate() - 1);

  const dateKey = targetDate.toISOString().slice(0, 10);
  const { start, end } = getUTCDateRange(targetDate);

  const allEventTypes = [
    ...Object.keys(ENGAGEMENT_WEIGHTS),
    ...Object.keys(MONETIZATION_WEIGHTS),
  ];

  const summary = {};

  try {
    const results = await Promise.all(
      allEventTypes.map(async (eventType) => {
        try {
          const count = await countEventsForType(
            eventType,
            start,
            end
          );

          return { eventType, count };
        } catch (error) {
          logger.error(
            'conversionSummaryJob event count failed',
            {
              eventType,
              error: error.message,
            }
          );

          return { eventType, count: -1 };
        }
      })
    );

    for (const { eventType, count } of results) {
      summary[eventType] = count;
    }

    const { error } = await supabase
      .from(SUMMARY_TABLE)
      .upsert({
        id: dateKey,
        date: dateKey,
        counts: summary,
        generated_at: new Date().toISOString(),
      });

    if (error) {
      throw error;
    }

    logger.info('conversionSummaryJob complete', {
      dateKey,
      totalTrackedTypes: allEventTypes.length,
    });
  } catch (error) {
    logger.error('conversionSummaryJob fatal failure', {
      dateKey,
      error: error.message,
    });

    throw error;
  }
}

module.exports = Object.freeze({
  runNightlySummaryJob,
});