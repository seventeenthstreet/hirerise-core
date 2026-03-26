'use strict';

/**
 * modules/career-digital-twin/prompts/twinPrompt.builder.js
 *
 * Builds the system + user messages sent to the AI router when generating
 * narrative insight summaries for a career simulation result.
 *
 * Called by digitalTwin.service.js when `includeNarrative: true` is
 * requested on POST /api/career/simulations.
 *
 * The AI is asked to produce a short (≤ 200 word) paragraph per path
 * explaining why the path suits the user and what the key milestones are.
 * It must return valid JSON matching the NarrativeResponse type below.
 *
 * NarrativeResponse:
 * {
 *   narratives: [
 *     { strategy_id: string, summary: string, key_milestone: string }
 *   ]
 * }
 */

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are a senior career intelligence analyst embedded in a professional career platform.
Your task is to generate concise, motivating narrative summaries for simulated career paths.

Rules:
1. Return ONLY valid JSON — no markdown, no backticks, no preamble.
2. Each summary must be ≤ 180 words and written in second-person ("You will…").
3. Be specific: mention the next role, the main skill to acquire, and the salary uplift.
4. key_milestone: one crisp sentence (≤ 20 words) on the single biggest achievement on this path.
5. Tone: professional, encouraging, and realistic — avoid hype.

Response schema (strict JSON):
{
  "narratives": [
    {
      "strategy_id": "<strategy_id>",
      "summary": "<narrative string ≤ 180 words>",
      "key_milestone": "<single milestone sentence>"
    }
  ]
}
`.trim();

// ─── User message builder ─────────────────────────────────────────────────────

/**
 * buildNarrativeMessages(userProfile, careerPaths)
 *
 * @param {Object}   userProfile   — { role, skills, experience_years, industry }
 * @param {Object[]} careerPaths   — array of simulated path objects from the engine
 * @returns {{ system: string, messages: Array }}  Anthropic SDK-compatible payload
 */
function buildNarrativeMessages(userProfile, careerPaths) {
  const pathSummaries = careerPaths.map(p => ({
    strategy_id:       p.strategy_id,
    strategy_label:    p.strategy_label,
    path:              p.path,
    next_role:         p.next_role,
    salary_projection: p.salary_projection,
    transition_months: p.transition_months,
    skills_required:   p.skills_required,
    risk_level:        p.risk_level,
    growth_score:      p.growth_score,
    total_years:       p.total_years,
  }));

  const userContent = `
User Profile:
  Current Role:       ${userProfile.role || 'Not specified'}
  Industry:           ${userProfile.industry || 'Not specified'}
  Experience (years): ${userProfile.experience_years || 0}
  Current Skills:     ${(userProfile.skills || []).slice(0, 10).join(', ') || 'Not specified'}

Simulated Career Paths (${pathSummaries.length} paths):
${JSON.stringify(pathSummaries, null, 2)}

Generate a narrative summary for each path in the JSON schema specified.
`.trim();

  return {
    system:   SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  };
}

module.exports = { buildNarrativeMessages, SYSTEM_PROMPT };









