'use strict';

/**
 * src/modules/career-copilot/agents/careerAdvisorAgent.js
 *
 * Final synthesis agent for Career Copilot.
 * Combines outputs from all specialist agents into a grounded,
 * provider-safe recommendation using the shared Anthropic router.
 */

const BaseAgent = require('./baseAgent');
const anthropic = require('../../../config/anthropic.client');
const logger = require('../../../utils/logger');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS = Number(process.env.CAREER_ADVISOR_MAX_TOKENS || 512);
const TEMPERATURE = 0.3;

class CareerAdvisorAgent extends BaseAgent {
  get agentName() {
    return 'CareerAdvisorAgent';
  }

  get cachePrefix() {
    return 'agent:advisor';
  }

  /**
   * @param {string} userId
   * @param {object} context
   * @returns {Promise<object>}
   */
  async run(userId, context = {}) {
    const {
      userQuery = null,
      agentOutputs = {},
      userProfile = {},
    } = context ?? {};

    const normalizedOutputs = this._normalizeAgentOutputs(agentOutputs);
    const { skill, jobs, market, risk, radar } = normalizedOutputs;

    const systemPrompt = this._buildSystemPrompt(
      normalizedOutputs,
      userProfile
    );

    const userMessage = this._buildUserMessage(userQuery);

    let aiRecommendation;

    try {
      aiRecommendation = await this._generateLLMRecommendation({
        systemPrompt,
        userMessage,
      });
    } catch (err) {
      logger.error('[CareerAdvisorAgent] LLM call failed', {
        userId,
        error: err instanceof Error ? err.message : 'Unknown LLM error',
      });

      aiRecommendation = this._buildFallbackRecommendation(normalizedOutputs);
    }

    const structuredOutput = this._buildStructuredOutput(
      normalizedOutputs,
      aiRecommendation
    );

    const dataSources = Object.entries(normalizedOutputs)
      .filter(([, value]) => value != null)
      .map(([key]) => key);

    return {
      ai_recommendation: aiRecommendation,
      structured_output: structuredOutput,
      data_sources: dataSources,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Internal orchestration
  // ────────────────────────────────────────────────────────────────────────────

  async _generateLLMRecommendation({ systemPrompt, userMessage }) {
    const completion = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userMessage,
        },
      ],
    });

    return this._extractTextContent(completion);
  }

  _extractTextContent(completion) {
    const blocks = Array.isArray(completion?.content)
      ? completion.content
      : [];

    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim();

    if (!text) {
      throw new Error('LLM returned empty text content');
    }

    return text;
  }

  _normalizeAgentOutputs(agentOutputs = {}) {
    return {
      skill: agentOutputs?.skill ?? null,
      jobs: agentOutputs?.jobs ?? null,
      market: agentOutputs?.market ?? null,
      risk: agentOutputs?.risk ?? null,
      radar: agentOutputs?.radar ?? null,
    };
  }

  _buildUserMessage(userQuery) {
    if (typeof userQuery === 'string' && userQuery.trim()) {
      return [
        `User question: "${userQuery.trim()}"`,
        '',
        'Respond using only the grounded structured data.',
        'Be specific and end with one clear action step.',
      ].join('\n');
    }

    return [
      'Provide a grounded career recommendation.',
      'Use only the supplied structured data.',
      'End with one clear action step.',
    ].join('\n');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Prompt engineering
  // ────────────────────────────────────────────────────────────────────────────

  _buildSystemPrompt({ skill, jobs, market, risk, radar }, userProfile = {}) {
    const sections = [
      [
        'You are HireRise Career Advisor AI.',
        'Rules:',
        '1. Use only supplied structured agent data.',
        '2. Never invent salary figures.',
        '3. Never speculate beyond available evidence.',
        '4. Mention missing data explicitly.',
        '5. Keep response concise: 3–4 sentences + 1 action step.',
      ].join('\n'),
    ];

    const profileSkills = Array.isArray(userProfile?.skills)
      ? userProfile.skills.slice(0, 8)
      : [];

    if (userProfile?.target_role || profileSkills.length) {
      sections.push(
        [
          '## User Profile',
          `Target Role: ${userProfile.target_role || 'Not specified'}`,
          `Current Skills: ${profileSkills.join(', ') || 'None on file'}`,
          `Experience: ${Number(userProfile?.years_experience || 0)} years`,
        ].join('\n')
      );
    }

    if (skill) {
      const gaps = (skill?.missing_high_demand || [])
        .slice(0, 5)
        .map((item) =>
          typeof item === 'string'
            ? item
            : `${item?.name || 'Unknown'}${item?.demand_score ? ` (${item.demand_score})` : ''}`
        )
        .join(', ');

      sections.push(
        [
          '## Skill Intelligence',
          `Existing: ${(skill?.existing_skills || []).slice(0, 6).join(', ') || 'None'}`,
          `Missing: ${gaps || 'None identified'}`,
          `Recommended: ${(skill?.recommended_skills || []).slice(0, 5).join(', ') || 'N/A'}`,
        ].join('\n')
      );
    }

    if (jobs?.recommended_jobs?.length) {
      const topJobs = jobs.recommended_jobs
        .slice(0, 4)
        .map(
          (job) =>
            `• ${job?.title || 'Unknown'} — ${job?.match_score ?? 0}%`
        )
        .join('\n');

      sections.push(['## Job Matches', topJobs].join('\n'));
    }

    if (market) {
      const topSkills = (market?.trending_skills || [])
        .slice(0, 5)
        .map((item) => `${item?.skill || 'Unknown'} (${item?.demand_score ?? 0})`)
        .join(', ');

      sections.push(
        [
          '## Market Intelligence',
          `Trending: ${topSkills || 'N/A'}`,
          market?.target_role_salary
            ? `Salary: Entry ${market.target_role_salary.entry_salary} | Mid ${market.target_role_salary.mid_salary} | Senior ${market.target_role_salary.senior_salary}`
            : 'Salary: unavailable',
        ].join('\n')
      );
    }

    if (risk) {
      sections.push(
        [
          '## Career Risk',
          `Risk Score: ${risk?.overall_risk_score ?? 'N/A'}`,
          `Level: ${risk?.risk_level || 'Unknown'}`,
        ].join('\n')
      );
    }

    if (radar?.emerging_opportunities?.length) {
      const topOpps = radar.emerging_opportunities
        .slice(0, 3)
        .map(
          (opp) =>
            `• ${opp?.role || 'Unknown'} (${opp?.opportunity_score ?? 0})`
        )
        .join('\n');

      sections.push(['## Opportunity Radar', topOpps].join('\n'));
    }

    return sections.join('\n\n');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Structured output
  // ────────────────────────────────────────────────────────────────────────────

  _buildStructuredOutput(
    { skill, jobs, market, risk, radar },
    aiRecommendation
  ) {
    return {
      skills_to_learn: (skill?.recommended_skills || skill?.missing_high_demand || [])
        .slice(0, 6)
        .map((item) => (typeof item === 'string' ? item : item?.name))
        .filter(Boolean),

      adjacent_skills: (skill?.adjacent_skills || []).slice(0, 5),
      learning_paths: (skill?.learning_paths || []).slice(0, 3),

      job_matches: (jobs?.recommended_jobs || []).slice(0, 5).map((job) => ({
        title: job?.title || null,
        match_score: job?.match_score ?? 0,
        missing_skills: (job?.missing_skills || []).slice(0, 3),
        salary: job?.salary || null,
      })),

      career_risk: risk?.risk_level || null,
      risk_score: risk?.overall_risk_score ?? null,
      risk_factors: (risk?.risk_factors || []).slice(0, 3),

      opportunities: (radar?.emerging_opportunities || []).slice(0, 5).map((opp) => ({
        role: opp?.role || null,
        growth_score: opp?.opportunity_score ?? null,
        match_score: opp?.match_score ?? null,
        growth_trend: opp?.growth_trend || null,
        salary: opp?.average_salary || null,
      })),

      trending_skills: (market?.trending_skills || []).slice(0, 5).map((item) => ({
        skill: item?.skill || null,
        demand_score: item?.demand_score ?? null,
      })),

      target_role_salary: market?.target_role_salary || null,
      ai_recommendation: aiRecommendation,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Fallback
  // ────────────────────────────────────────────────────────────────────────────

  _buildFallbackRecommendation({ skill, jobs, risk, radar }) {
    const messages = [];

    const topJob = jobs?.recommended_jobs?.[0];
    const topSkill =
      skill?.recommended_skills?.[0] ||
      skill?.missing_high_demand?.[0];
    const topOpportunity = radar?.emerging_opportunities?.[0];

    if (topJob?.title) {
      messages.push(
        `Your strongest match is ${topJob.title} at ${topJob.match_score ?? 0}% compatibility.`
      );
    }

    if (topSkill) {
      const name =
        typeof topSkill === 'string' ? topSkill : topSkill?.name;
      if (name) {
        messages.push(
          `Learning ${name} would most improve your position.`
        );
      }
    }

    if (topOpportunity?.role) {
      messages.push(
        `${topOpportunity.role} is an emerging opportunity worth exploring.`
      );
    }

    if (risk?.risk_level) {
      messages.push(`Current career risk is ${risk.risk_level}.`);
    }

    if (!messages.length) {
      return 'Complete your profile and upload your CV to receive personalised career recommendations.';
    }

    return messages.join(' ');
  }
}

module.exports = CareerAdvisorAgent;