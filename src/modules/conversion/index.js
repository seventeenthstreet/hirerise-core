'use strict';

/**
 * src/modules/conversion/index.js
 *
 * Conversion module public interface.
 *
 * Architectural rules:
 * - Consumers MUST import only from this barrel
 * - Internal folder layout remains private
 * - Supports future service replacement without breaking callers
 * - Safe for API, workers, cron jobs, and queue processors
 *
 * Example:
 *   const {
 *     conversionHookMiddleware,
 *     conversionIntentService,
 *   } = require('@/modules/conversion');
 */

/* -------------------------------------------------------------------------- */
/*                               MODULE IMPORTS                               */
/* -------------------------------------------------------------------------- */

const conversionHookMiddleware = require('./middleware/conversionHook.middleware');
const conversionEventService = require('./services/conversionEvent.service');
const conversionAggregateService = require('./services/conversionAggregate.service');
const conversionIntentService = require('./services/conversionIntent.service');
const conversionNudgeService = require('./services/conversionNudge.service');

/* -------------------------------------------------------------------------- */
/*                             CONTRACT VALIDATION                            */
/* -------------------------------------------------------------------------- */

/**
 * Ensures required public exports exist.
 * Helps catch broken refactors during boot.
 *
 * @param {string} name
 * @param {*} value
 */
function assertExport(name, value) {
  if (!value) {
    throw new Error(
      `[ConversionModule] Missing required export: ${name}`
    );
  }
}

assertExport('conversionHookMiddleware', conversionHookMiddleware);
assertExport('conversionEventService', conversionEventService);
assertExport('conversionAggregateService', conversionAggregateService);
assertExport('conversionIntentService', conversionIntentService);
assertExport('conversionNudgeService', conversionNudgeService);

/* -------------------------------------------------------------------------- */
/*                                PUBLIC API                                  */
/* -------------------------------------------------------------------------- */

const ConversionModule = Object.freeze({
  /**
   * Express middleware
   */
  conversionHookMiddleware,

  /**
   * Raw event ingestion
   */
  conversionEventService,

  /**
   * Aggregate state updater
   */
  conversionAggregateService,

  /**
   * Intent scoring + cache layer
   */
  conversionIntentService,

  /**
   * Monetization nudges + targeting rules
   */
  conversionNudgeService,

  /**
   * Public module metadata
   */
  metadata: Object.freeze({
    name: 'conversion',
    version: '2.1.0',
    database: 'supabase',
  }),
});

module.exports = ConversionModule;