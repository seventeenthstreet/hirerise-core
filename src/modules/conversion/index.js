'use strict';

/**
 * Conversion Module — Public Interface
 *
 * IMPORTANT:
 * - Consumers MUST import only from this file.
 * - Internal paths are private and may change.
 *
 * Example:
 *   const { conversionNudgeService } = require('@/modules/conversion');
 */

const conversionHookMiddleware   = require('./middleware/conversionHook.middleware');
const conversionEventService     = require('./services/conversionEvent.service');
const conversionAggregateService = require('./services/conversionAggregate.service');
const conversionIntentService    = require('./services/conversionIntent.service');
const conversionNudgeService     = require('./services/conversionNudge.service');

const ConversionModule = Object.freeze({

  /**
   * Express middleware
   */
  conversionHookMiddleware,

  /**
   * Raw event recording
   */
  conversionEventService,

  /**
   * Aggregate + scoring update
   */
  conversionAggregateService,

  /**
   * Intent scoring (with decay + cache)
   */
  conversionIntentService,

  /**
   * Rule-based monetization nudging
   */
  conversionNudgeService,

  /**
   * Module metadata (future-safe)
   */
  version: '2.0.0',

});

module.exports = ConversionModule;