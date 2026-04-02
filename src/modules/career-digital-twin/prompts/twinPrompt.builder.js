'use strict';

/**
 * modules/career-digital-twin/prompts/twinPrompt.builder.js
 *
 * Builds AI-router compatible narrative prompts for career simulation results.
 *
 * Used when includeNarrative=true in the Career Digital Twin service.
 *
 * Output contract:
 * {
 *   narratives: [
 *     {
 *       strategy_id: string,
 *       summary: string,
 *       key_milestone: string
 *     }
 *   ]
 * }
 */

const MAX_SKILLS = 10;
const MAX_PATHS = 5;

const SYSTEM_PROMPT = `
You are a senior career intelligence analyst embedded in a professional career platform.
Your task is to generate concise, motivating narrative summaries for simulated career paths.

Rules:
1. Return ONLY valid JSON.
2. No markdown, no code blocks, no explanations.
3. Each summary must be <= 180 words.
4. Write in second-person voice ("You will...").
5. Mention:
   - next role
   - most important skill gap
   - realistic salary uplift
6. key_milestone must be one sentence <= 20 words.
7. Tone must be professional, encouraging, and realistic.
8. Never invent fields outside the schema.

Strict JSON schema:
{
  "narratives": [
    {
      "strategy_id": "string",
      "summary": "string",
      "key_milestone": "string"
    }
  ]
}
`.trim();

/**
 * Normalize user profile for prompt safety.
 */
function normalizeUserProfile(userProfile = {}) {
  return {
    role:
      typeof userProfile.role === 'string' && userProfile.role.trim()
        ? userProfile.role.trim()
        : 'Not specified',

    industry:
      typeof userProfile.industry === 'string' &&
      userProfile.industry.trim()
        ? userProfile.industry.trim()
        : 'Not specified',

    experience_years: Number.isFinite(
      Number(userProfile.experience_years)
    )
      ? Number(userProfile.experience_years)
      : 0,

    skills: Array.isArray(userProfile.skills)
      ? userProfile.skills
          .filter((skill) => typeof skill === 'string' && skill.trim())
          .map((skill) => skill.trim())
          .slice(0, MAX_SKILLS)
      : [],
  };
}

/**
 * Normalize career paths before JSON serialization.
 */
function normalizeCareerPaths(careerPaths = []) {
  if (!Array.isArray(careerPaths)) {
    return [];
  }

  return careerPaths.slice(0, MAX_PATHS).map((path) => ({
    strategy_id: path?.strategy_id ?? null,
    strategy_label: path?.strategy_label ?? null,
    path: path?.path ?? null,
    next_role: path?.next_role ?? null,
    salary_projection: path?.salary_projection ?? null,
    transition_months: path?.transition_months ?? null,
    skills_required: Array.isArray(path?.skills_required)
      ? path.skills_required.slice(0, MAX_SKILLS)
      : [],
    risk_level: path?.risk_level ?? null,
    growth_score: path?.growth_score ?? null,
    total_years: path?.total_years ?? null,
  }));
}

/**
 * Build narrative AI messages.
 *
 * @param {Object} userProfile
 * @param {Array} careerPaths
 * @returns {{ system: string, messages: Array }}
 */
function buildNarrativeMessages(userProfile, careerPaths) {
  const safeProfile = normalizeUserProfile(userProfile);
  const safePaths = normalizeCareerPaths(careerPaths);

  const userContent = `
User Profile:
- Current Role: ${safeProfile.role}
- Industry: ${safeProfile.industry}
- Experience (years): ${safeProfile.experience_years}
- Current Skills: ${
    safeProfile.skills.length > 0
      ? safeProfile.skills.join(', ')
      : 'Not specified'
  }

Simulated Career Paths (${safePaths.length}):
${JSON.stringify(safePaths, null, 2)}

Generate one narrative per path using the strict JSON schema.
`.trim();

  return {
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: userContent,
      },
    ],
  };
}

module.exports = {
  SYSTEM_PROMPT,
  buildNarrativeMessages,
};