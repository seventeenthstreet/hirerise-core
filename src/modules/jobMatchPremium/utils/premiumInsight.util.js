'use strict';

/**

* src/modules/jobMatchPremium/utils/premiumInsight.util.js
*
* Engine 7 — Premium Insight Utility
*
* Deterministically generates up to three actionable,
* PII-safe premium insights from structured analysis signals.
*
* Characteristics:
* * Pure and stateless
* * No database access
* * No external service calls
* * No AI calls
* * No side effects
* * PII safe
    */

const MAX_INSIGHTS = 3;
const DEFAULT_LEARNING_WEEKS = 4;
const MAX_ESTIMATED_SCORE_GAIN = 15;
const EXPERIENCE_SCORE_MAX = 25;
const MARKET_DEMAND_THRESHOLD = 60;

/**

* Builds a high-priority skill-gap insight.
*
* @param {object} skillGap
* @returns {object|null}
  */
  function insightTopSkillGap(skillGap = {}) {
  const missingSkills = Array.isArray(skillGap.missingSkills)
  ? skillGap.missingSkills
  : [];

const topSkill = missingSkills
.filter(
(skill) =>
skill &&
skill.priority === 'high_priority'
)
.sort(
(a, b) =>
Number(b?.demand_score ?? 0) -
Number(a?.demand_score ?? 0)
)[0];

if (!topSkill) {
return null;
}

const weeks =
Number(topSkill.estimatedWeeksToLearn) ||
DEFAULT_LEARNING_WEEKS;

const scoreBoost = Math.min(
MAX_ESTIMATED_SCORE_GAIN,
Math.round(
Number(topSkill.importance_weight ?? 0.5) * 20
)
);

return {
type: 'skill_gap',
title: 'Close your highest-priority skill gap',
description:
`Developing ${topSkill.skill_name} ` +
`(estimated ${weeks} weeks) ` +
`could increase your match score ` +
`by approximately ${scoreBoost} points.`,
priority: 1,
meta: {
skillName: topSkill.skill_name,
estimatedWeeks: weeks,
estimatedScoreGain: scoreBoost,
},
};
}

/**

* Builds a market-demand insight.
*
* @param {object} breakdown
* @param {string|null} targetRole
* @returns {object|null}
  */
  function insightMarketDemand(
  breakdown = {},
  targetRole = null
  ) {
  const demand = Number(
  breakdown.marketDemand ?? NaN
  );

if (
Number.isNaN(demand) ||
demand >= MARKET_DEMAND_THRESHOLD
) {
return null;
}

const roleText = targetRole
? `for ${targetRole} `
: '';

return {
type: 'market_signal',
title: 'Consider adjacent high-demand roles',
description:
`Current market demand ${roleText}` +
`is moderate to low (${Math.round(demand)}/100). ` +
`Exploring adjacent roles with higher demand ` +
`could improve your hiring velocity.`,
priority: 2,
meta: {
demandScore: Math.round(demand),
targetRole,
},
};
}

/**

* Builds an experience-gap insight.
*
* @param {object} breakdown
* @param {string} careerLevel
* @returns {object|null}
  */
  function insightExperienceGap(
  breakdown = {},
  careerLevel = 'mid'
  ) {
  const experienceScore = Number(
  breakdown.experience ?? 0
  );

const scaledPercent = Math.round(
(experienceScore / EXPERIENCE_SCORE_MAX) * 100
);

if (scaledPercent >= 60) {
return null;
}

return {
type: 'experience_gap',
title: 'Build role-relevant experience',
description:
`Your experience level (${careerLevel}) ` +
`is below the typical threshold for this role. ` +
`Contract work, freelance projects, ` +
`or portfolio contributions can bridge ` +
`this gap faster than traditional employment.`,
priority: 3,
meta: {
careerLevel,
experienceScorePercent: scaledPercent,
},
};
}

/**

* Generates up to three actionable premium insights.
*
* @param {object} params
* @param {object} params.breakdown
* @param {object} params.skillGap
* @param {string} [params.careerLevel='mid']
* @param {string|null} [params.targetRole=null]
*
* @returns {{ insights: Array<object> }}
  */
  function generatePremiumInsights({
  breakdown = {},
  skillGap = {},
  careerLevel = 'mid',
  targetRole = null,
  } = {}) {
  const candidates = [
  insightTopSkillGap(skillGap),
  insightMarketDemand(
  breakdown,
  targetRole
  ),
  insightExperienceGap(
  breakdown,
  careerLevel
  ),
  ].filter(Boolean);

const insights = candidates
.sort(
(a, b) => a.priority - b.priority
)
.slice(0, MAX_INSIGHTS);

return {
insights,
};
}

module.exports = {
generatePremiumInsights,
};
