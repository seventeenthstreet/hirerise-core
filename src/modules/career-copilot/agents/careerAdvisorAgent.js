'use strict';

/**
 * careerAdvisorAgent.js — Career Advisor Agent
 *
 * The synthesis agent. Receives structured outputs from all specialist
 * agents and generates the final grounded career recommendation using
 * the existing multi-provider LLM router (anthropic.client.js).
 *
 * Called LAST by the coordinator, after all other agents complete.
 *
 * Input:
 *   context.userQuery    — the user's original question (or null)
 *   context.agentOutputs — { skill, jobs, market, risk, radar }
 *   context.userProfile  — { skills[], target_role, years_experience, … }
 *
 * Output:
 *   ai_recommendation  — synthesized advice paragraph
 *   structured_output  — full { skills_to_learn, job_matches, career_risk, … }
 *   data_sources       — which agents contributed
 *
 * Grounding rules (injected into system prompt):
 *   - Only reference facts present in agent outputs
 *   - Never invent salary figures not from MarketIntelligenceAgent
 *   - Cite the specific agent/data source for each claim
 *   - If data is missing, say so — don't speculate
 *
 * File location: src/modules/career-copilot/agents/careerAdvisorAgent.js
 *
 * @module src/modules/career-copilot/agents/careerAdvisorAgent
 */

const BaseAgent  = require('./baseAgent');
const anthropic  = require('../../../config/anthropic.client');
const logger     = require('../../../utils/logger');

const MODEL       = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS  = 512;
const TEMPERATURE = 0.3; // low temperature for factual, grounded answers

class CareerAdvisorAgent extends BaseAgent {

  get agentName()   { return 'CareerAdvisorAgent'; }
  get cachePrefix() { return 'agent:advisor'; }

  async run(userId, context) {
    const { userQuery = null, agentOutputs = {}, userProfile = {} } = context;

    const { skill, jobs, market, risk, radar } = agentOutputs;

    // ── Build system prompt from real data only ───────────────────────────────
    const systemPrompt = this._buildSystemPrompt(
      { skill, jobs, market, risk, radar },
      userProfile
    );

    const userMessage = userQuery
      ? `User question: "${userQuery}"\n\nAnswer using ONLY the data provided above. Be specific, cite data points, end with one clear action step.`
      : 'Provide a comprehensive career recommendation using ONLY the data above. Be specific, cite data points, end with one clear action step.';

    // ── LLM call (multi-provider router) ─────────────────────────────────────
    let aiRecommendation = '';
    try {
      const completion = await anthropic.messages.create({
        model:       MODEL,
        max_tokens:  MAX_TOKENS,
        temperature: TEMPERATURE,
        system:      systemPrompt,
        messages:    [{ role: 'user', content: userMessage }],
      });

      aiRecommendation = completion.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();

    } catch (err) {
      logger.error('[CareerAdvisorAgent] LLM call failed', { userId, err: err.message });
      // Fallback: rule-based recommendation from structured data
      aiRecommendation = this._buildFallbackRecommendation({ skill, jobs, market, risk, radar });
    }

    // ── Assemble structured output ────────────────────────────────────────────
    const structuredOutput = this._buildStructuredOutput(
      { skill, jobs, market, risk, radar },
      aiRecommendation
    );

    const dataSources = Object.entries({ skill, jobs, market, risk, radar })
      .filter(([, v]) => v !== null)
      .map(([k]) => k);

    return {
      ai_recommendation: aiRecommendation,
      structured_output: structuredOutput,
      data_sources:      dataSources,
    };
  }

  // ─── System prompt builder ────────────────────────────────────────────────

  _buildSystemPrompt({ skill, jobs, market, risk, radar }, userProfile) {
    const lines = [];

    lines.push(`You are the Career Advisor AI for HireRise — a career intelligence platform.

GROUNDING RULES (mandatory):
1. Base EVERY claim on the structured data sections below
2. Never invent salary figures — use only those from Market Intelligence
3. Never guess at skills not listed in the agent outputs
4. If a section is missing, acknowledge it: "I don't have your [risk/opportunity] data yet"
5. Keep response to 3-4 sentences + 1 action step`);

    // User profile
    if (userProfile?.target_role || (userProfile?.skills || []).length > 0) {
      lines.push(`\n## User Profile
Target Role:   ${userProfile.target_role || 'Not specified'}
Current Skills: ${(userProfile.skills || []).slice(0, 8).join(', ') || 'None on file'}
Experience:    ${userProfile.years_experience || 0} years`);
    }

    // Skill Intelligence
    if (skill) {
      const gapNames = (skill.missing_high_demand || []).slice(0, 5)
        .map(s => `${s.name}${s.demand_score ? ` (demand: ${s.demand_score})` : ''}`).join(', ');

      lines.push(`\n## Skill Intelligence (SkillIntelligenceAgent)
Existing Skills:    ${(skill.existing_skills || []).slice(0, 6).join(', ') || 'None'}
Missing High-Demand: ${gapNames || 'None identified'}
Recommended Skills:  ${(skill.recommended_skills || []).slice(0, 5).join(', ') || 'N/A'}
${skill.role_gap
  ? `Role Gap: ${skill.role_gap.match_percentage}% match for ${skill.role_gap.target_role}. Missing: ${(skill.role_gap.missing_required || []).slice(0, 4).join(', ')}`
  : ''}`);
    }

    // Job Matches
    if (jobs?.recommended_jobs?.length > 0) {
      const topJobs = jobs.recommended_jobs.slice(0, 4)
        .map(j => `  • ${j.title} — ${j.match_score}% match${j.missing_skills?.length ? ` (needs: ${j.missing_skills.slice(0,2).join(', ')})` : ''}`).join('\n');

      lines.push(`\n## Job Matches (JobMatchingAgent)
${topJobs}
Total evaluated: ${jobs.total_evaluated}
Scoring mode:    ${jobs.scoring_mode}`);
    }

    // Market Intelligence
    if (market) {
      const topSkills = (market.trending_skills || []).slice(0, 5)
        .map(s => `${s.skill} (${s.demand_score})`).join(', ');

      lines.push(`\n## Market Intelligence (MarketIntelligenceAgent)
Top Trending Skills: ${topSkills || 'N/A'}
${market.target_role_salary
  ? `Target Role Salary: Entry ${market.target_role_salary.entry_salary} | Mid ${market.target_role_salary.mid_salary} | Senior ${market.target_role_salary.senior_salary}`
  : 'No salary data for target role yet'}
${(market.market_insights || []).join(' ')}`);
    }

    // Career Risk
    if (risk) {
      lines.push(`\n## Career Risk (CareerRiskAgent)
Risk Score:  ${risk.overall_risk_score}/100 (${risk.risk_level})
Top Factors: ${(risk.risk_factors || []).slice(0, 2).map(f => f.factor || f).join(', ')}
Insight:     ${risk.stability_insight || ''}`);
    }

    // Opportunity Radar
    if (radar?.emerging_opportunities?.length > 0) {
      const topOpps = radar.emerging_opportunities.slice(0, 3)
        .map(o => `  • ${o.role} — score ${o.opportunity_score}${o.average_salary ? `, avg ${o.average_salary}` : ''}`).join('\n');

      lines.push(`\n## Opportunity Radar (OpportunityRadarAgent)
${topOpps}`);
    }

    return lines.join('\n');
  }

  // ─── Structured output assembler ──────────────────────────────────────────

  _buildStructuredOutput({ skill, jobs, market, risk, radar }, aiRecommendation) {
    return {
      // From SkillIntelligenceAgent
      skills_to_learn: (skill?.recommended_skills || skill?.missing_high_demand || [])
        .slice(0, 6)
        .map(s => typeof s === 'string' ? s : s?.name)
        .filter(Boolean),

      adjacent_skills: (skill?.adjacent_skills || []).slice(0, 5),

      learning_paths: (skill?.learning_paths || []).slice(0, 3),

      // From JobMatchingAgent
      job_matches: (jobs?.recommended_jobs || []).slice(0, 5).map(j => ({
        title:          j.title,
        match_score:    j.match_score,
        missing_skills: (j.missing_skills || []).slice(0, 3),
        salary:         j.salary         || null,
      })),

      // From CareerRiskAgent
      career_risk:  risk?.risk_level         || null,
      risk_score:   risk?.overall_risk_score ?? null,
      risk_factors: (risk?.risk_factors      || []).slice(0, 3),

      // From OpportunityRadarAgent
      opportunities: (radar?.emerging_opportunities || []).slice(0, 5).map(o => ({
        role:          o.role,
        growth_score:  o.opportunity_score,
        match_score:   o.match_score    || null,
        growth_trend:  o.growth_trend   || null,
        salary:        o.average_salary || null,
      })),

      // From MarketIntelligenceAgent
      trending_skills: (market?.trending_skills || []).slice(0, 5).map(s => ({
        skill:        s.skill,
        demand_score: s.demand_score,
      })),

      target_role_salary: market?.target_role_salary || null,

      // Synthesis
      ai_recommendation: aiRecommendation,
    };
  }

  // ─── Fallback when LLM unavailable ───────────────────────────────────────

  _buildFallbackRecommendation({ skill, jobs, market, risk, radar }) {
    const parts = [];

    const topJob   = jobs?.recommended_jobs?.[0];
    const topSkill = skill?.recommended_skills?.[0] || skill?.missing_high_demand?.[0];
    const topOpp   = radar?.emerging_opportunities?.[0];
    const riskNote = risk?.risk_level ? ` Your career risk is ${risk.risk_level}.` : '';

    if (topJob) {
      parts.push(`Your strongest job match is ${topJob.title} at ${topJob.match_score}% compatibility.`);
    }
    if (topSkill) {
      const name = typeof topSkill === 'string' ? topSkill : topSkill.name;
      parts.push(`Learning ${name} would most improve your market position.`);
    }
    if (topOpp && topOpp.role !== topJob?.title) {
      parts.push(`${topOpp.role} is an emerging opportunity (score: ${topOpp.opportunity_score}).`);
    }
    if (riskNote) parts.push(riskNote);

    return parts.length > 0
      ? parts.join(' ')
      : 'Complete your profile and upload your CV to receive personalised career recommendations.';
  }
}

module.exports = CareerAdvisorAgent;









