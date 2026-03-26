'use strict';

/**
 * conversionNudge.service.js
 *
 * Selects the most appropriate nudge based on decayed intent scores.
 *
 * - Rules evaluated top-to-bottom (priority order)
 * - First match wins
 * - Rule metadata returned for analytics / A/B testing
 */

const conversionIntentService = require('./conversionIntent.service');
const logger = require('../utils/conversion.logger');

/**
 * Rule schema:
 * {
 *   id: string,
 *   priority: number,
 *   match: function(scores) => boolean,
 *   recommendedAction: string,
 *   nudgeMessage: string
 * }
 */

const NUDGE_RULES = Object.freeze([
  {
    id: 'high_monetization_discount',
    priority: 1,
    match: ({ monetizationScore }) => monetizationScore >= 70,
    recommendedAction: 'show_discount_offer',
    nudgeMessage:
      'Unlock HireRise Premium at a special rate — limited-time offer for active users like you.',
  },
  {
    id: 'engaged_preview_push',
    priority: 2,
    match: ({ engagementScore, monetizationScore }) =>
      engagementScore >= 55 && monetizationScore < 40,
    recommendedAction: 'show_premium_feature_preview',
    nudgeMessage:
      'You are getting great results — see what HireRise Premium can unlock for your career.',
  },
  {
    id: 'high_total_intent_offer',
    priority: 3,
    match: ({ totalIntentScore }) => totalIntentScore >= 70,
    recommendedAction: 'show_premium_offer',
    nudgeMessage:
      'You are close to unlocking your full career potential. Upgrade to HireRise Premium today.',
  },
  {
    id: 'medium_intent_skill_prompt',
    priority: 4,
    match: ({ totalIntentScore }) => totalIntentScore >= 40,
    recommendedAction: 'show_skill_upgrade_prompt',
    nudgeMessage:
      'Candidates with top skills receive 3× more interview calls. Start a skill assessment now.',
  },
  {
    id: 'default_profile_completion',
    priority: 99,
    match: () => true,
    recommendedAction: 'show_profile_completion_prompt',
    nudgeMessage:
      'Complete your profile to get matched with top employers. It takes under 2 minutes.',
  },
]);

class ConversionNudgeService {

  /**
   * Returns structured nudge decision.
   *
   * @param {string} userId
   * @returns {Promise<{
   *   intentScore: number,
   *   engagementScore: number,
   *   monetizationScore: number,
   *   recommendedAction: string,
   *   nudgeMessage: string,
   *   ruleId: string
   * }>}
   */
  async getNudge(userId) {

    const scores = await conversionIntentService.getScores(userId);

    const { totalIntentScore, engagementScore, monetizationScore } = scores;

    const rule = this._selectRule({
      totalIntentScore,
      engagementScore,
      monetizationScore,
    });

    const result = {
      intentScore: totalIntentScore,
      engagementScore,
      monetizationScore,
      recommendedAction: rule.recommendedAction,
      nudgeMessage: rule.nudgeMessage,
      ruleId: rule.id,
    };

    // Use debug level to avoid high log noise in production
    logger.debug('ConversionNudgeService.getNudge', {
      userId,
      ...result,
    });

    return result;
  }

  /**
   * Rule selection logic.
   */
  _selectRule(scores) {

    for (const rule of NUDGE_RULES) {
      try {
        if (rule.match(scores)) {
          return rule;
        }
      } catch (err) {
        logger.error('ConversionNudgeService rule evaluation failed', {
          ruleId: rule.id,
          error: err.message,
        });
      }
    }

    // Safety fallback (should never hit due to catch-all rule)
    return {
      id: 'fallback_safe',
      recommendedAction: 'show_profile_completion_prompt',
      nudgeMessage:
        'Complete your profile to get matched with top employers.',
    };
  }
}

module.exports = new ConversionNudgeService();








