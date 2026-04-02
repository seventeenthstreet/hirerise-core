'use strict';

/**
 * src/modules/conversion/services/conversionNudge.service.js
 *
 * Selects the highest-priority nudge based on decayed intent scores.
 *
 * Architecture:
 * - deterministic priority-based rule selection
 * - first matching rule wins
 * - safe rule execution
 * - immutable fallback behavior
 * - analytics-friendly rule metadata
 */

const conversionIntentService = require('./conversionIntent.service');
const logger = require('../utils/conversion.logger');

const FALLBACK_RULE = Object.freeze({
  id: 'fallback_safe',
  recommendedAction: 'show_profile_completion_prompt',
  nudgeMessage:
    'Complete your profile to get matched with top employers.',
});

const NUDGE_RULES = Object.freeze(
  [
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
  ]
    .slice()
    .sort((a, b) => a.priority - b.priority)
);

class ConversionNudgeService {
  /**
   * Returns structured nudge decision.
   *
   * @param {string} userId
   * @returns {Promise<{
   *   intentScore:number,
   *   engagementScore:number,
   *   monetizationScore:number,
   *   recommendedAction:string,
   *   nudgeMessage:string,
   *   ruleId:string
   * }>}
   */
  async getNudge(userId) {
    try {
      if (!userId) {
        throw new Error('userId is required');
      }

      const scores = await conversionIntentService.getScores(userId);

      const {
        totalIntentScore,
        engagementScore,
        monetizationScore,
      } = scores;

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

      logger.debug('ConversionNudgeService.getNudge success', {
        userId,
        ...result,
      });

      return result;
    } catch (error) {
      logger.error('ConversionNudgeService.getNudge failed', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Deterministic priority-based rule selection.
   *
   * @param {{
   *   totalIntentScore:number,
   *   engagementScore:number,
   *   monetizationScore:number
   * }} scores
   */
  _selectRule(scores) {
    for (const rule of NUDGE_RULES) {
      try {
        const matched = Boolean(rule.match(scores));

        if (matched) {
          return rule;
        }
      } catch (error) {
        logger.error(
          'ConversionNudgeService rule evaluation failed',
          {
            ruleId: rule.id,
            error: error.message,
          }
        );
      }
    }

    return FALLBACK_RULE;
  }
}

module.exports = new ConversionNudgeService();