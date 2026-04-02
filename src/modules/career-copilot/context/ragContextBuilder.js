'use strict';

/**
 * @file src/modules/career-copilot/context/ragContextBuilder.js
 * @description
 * Production-ready RAG Context Builder.
 *
 * Purpose:
 *   Transforms normalized row-based Supabase retrieval output into a compact,
 *   deterministic context string for LLM system prompts.
 *
 * Migration status:
 *   - No Firebase / Firestore dependencies
 *   - No snapshot iteration assumptions
 *   - Pure row-object based processing
 *   - Null-safe and serialization-safe for Supabase JSONB payloads
 *
 * Design guarantees:
 *   - Injects only retrieved facts
 *   - Omits empty sections automatically
 *   - Keeps output compact and token-efficient
 *   - Defensive against malformed JSON columns / partial rows
 *   - Drop-in compatible with existing ragRetriever contract
 */

const MAX_CONTEXT_CHARS = 12000;
const DEFAULT_LIST_LIMIT = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Internal utilities
// ─────────────────────────────────────────────────────────────────────────────

function isNil(value) {
  return value === null || value === undefined;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatINR(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num) || num <= 0) return null;

  if (num >= 100000) {
    return `₹${(num / 100000).toFixed(1)}L`;
  }

  return `₹${num.toLocaleString('en-IN')}`;
}

function formatPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'N/A';
  return `${clamp(Math.round(num), 0, 100)}%`;
}

function formatScore(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : 'N/A';
}

function formatList(items, max = DEFAULT_LIST_LIMIT) {
  const list = asArray(items).filter(Boolean);
  if (!list.length) return 'none';
  return list.slice(0, max).join(', ');
}

function createSection(title, lines) {
  const content = asArray(lines)
    .filter(line => typeof line === 'string' && line.trim())
    .join('\n');

  if (!content) return null;
  return `### ${title}\n${content}`;
}

function truncateContext(text) {
  if (!text || text.length <= MAX_CONTEXT_CHARS) return text || '';
  return `${text.slice(0, MAX_CONTEXT_CHARS - 32)}\n\n[context truncated for token safety]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section builders
// ─────────────────────────────────────────────────────────────────────────────

function buildUserProfileSection(profile) {
  if (!profile || typeof profile !== 'object') return null;

  return createSection('User Profile', [
    profile.target_role && `Target Role:       ${profile.target_role}`,
    profile.current_role && `Current Role:      ${profile.current_role}`,
    asArray(profile.skills).length && `Current Skills:    ${formatList(profile.skills, 10)}`,
    !isNil(profile.years_experience) && `Experience:        ${profile.years_experience} years`,
    profile.industry && `Industry:          ${profile.industry}`,
    profile.education_level && `Education:         ${profile.education_level}`,
    profile.location && `Location:          ${profile.location}`,
    formatINR(profile.current_salary) && `Current Salary:    ${formatINR(profile.current_salary)}`,
  ]);
}

function buildCHISection(chi) {
  if (!chi || isNil(chi.chi_score)) return null;

  const lines = [
    `Career Health Score (CHI): ${formatScore(chi.chi_score)}/100`,
    chi.analysis_source && `Analysis Type: ${chi.analysis_source}`,
  ];

  if (chi.dimensions && typeof chi.dimensions === 'object') {
    const dimensions = Object.entries(chi.dimensions)
      .map(([key, value]) => {
        const score = value && typeof value === 'object' ? value.score : value;
        return !isNil(score) ? `  ${key}: ${formatScore(score)}/100` : null;
      })
      .filter(Boolean);

    if (dimensions.length) {
      lines.push('Dimension Scores:');
      lines.push(...dimensions);
    }
  }

  return createSection('Career Health Index', lines);
}

function buildSkillGapsSection(gaps) {
  if (!gaps || typeof gaps !== 'object') return null;

  const lines = [
    asArray(gaps.existing_skills).length && `Current Skills: ${formatList(gaps.existing_skills, 8)}`,
    asArray(gaps.adjacent_skills).length &&
      `Adjacent Skills (learnable next): ${formatList(gaps.adjacent_skills, 5)}`,
  ];

  const missingHighDemand = asArray(gaps.missing_high_demand);
  if (missingHighDemand.length) {
    lines.push('High-Demand Missing Skills:');
    missingHighDemand.slice(0, 6).forEach(skill => {
      const name = typeof skill === 'string' ? skill : skill?.name;
      const demand = typeof skill === 'object' ? skill?.demand_score : null;
      if (name) {
        lines.push(`  - ${name}${!isNil(demand) ? ` (demand: ${formatScore(demand)}/100)` : ''}`);
      }
    });
  }

  if (gaps.role_gap?.target_role) {
    lines.push(
      `Role Match (${gaps.role_gap.target_role}): ${formatPercent(gaps.role_gap.match_percentage)}`,
    );

    if (asArray(gaps.role_gap.missing_required).length) {
      lines.push(`Missing Required: ${formatList(gaps.role_gap.missing_required, 5)}`);
    }
  }

  return createSection('Skill Analysis', lines);
}

function buildJobMatchesSection(matches) {
  const topMatches = asArray(matches?.top_matches);
  if (!topMatches.length) return null;

  const lines = [`Total Roles Evaluated: ${matches?.total_evaluated ?? 'N/A'}`];
  lines.push('Top Matched Roles:');

  topMatches.forEach((job, index) => {
    if (!job?.title) return;

    lines.push(`  ${index + 1}. ${job.title} — Match: ${formatScore(job.match_score)}%`);

    if (asArray(job.missing_skills).length) {
      lines.push(`     Skills to add: ${job.missing_skills.join(', ')}`);
    }

    if (job.salary) {
      const min = formatINR(job.salary.min);
      const max = formatINR(job.salary.max);
      if (min || max) {
        lines.push(`     Salary range: ${min || '?'} – ${max || '?'}`);
      }
    }
  });

  return createSection('Job Matches', lines);
}

function buildOpportunityRadarSection(radar) {
  const opportunities = asArray(radar?.emerging_opportunities);
  if (!opportunities.length) return null;

  const lines = ['Top Emerging Career Opportunities:'];

  opportunities.forEach((opportunity, index) => {
    if (!opportunity?.role) return;

    lines.push(`  ${index + 1}. ${opportunity.role}`);
    lines.push(
      `     Opportunity Score: ${formatScore(opportunity.opportunity_score)}/100 | Match: ${formatScore(opportunity.match_score)}% | Growth: ${opportunity.growth_trend || 'N/A'}`,
    );

    if (opportunity.average_salary) {
      lines.push(`     Average Salary: ${opportunity.average_salary}`);
    }

    const skills = asArray(opportunity.skills_to_learn);
    if (skills.length) {
      lines.push(`     Skills needed: ${skills.slice(0, 3).join(', ')}`);
    }
  });

  return createSection('Career Opportunity Radar', lines);
}

function buildRiskSection(risk) {
  if (!risk || isNil(risk.overall_risk_score)) return null;

  const lines = [
    `Overall Risk Score: ${formatScore(risk.overall_risk_score)}/100 (${risk.risk_level || 'N/A'})`,
  ];

  const riskFactors = asArray(risk.risk_factors);
  if (riskFactors.length) {
    lines.push('Key Risk Factors:');
    riskFactors.slice(0, 3).forEach(factor => {
      const label = typeof factor === 'string' ? factor : factor?.factor;
      const description = typeof factor === 'object' ? factor?.description : null;
      if (label) {
        lines.push(`  - ${label}${description ? `: ${description}` : ''}`);
      }
    });
  }

  const recommendations = asArray(risk.recommendations);
  if (recommendations.length) {
    lines.push('Risk Mitigation:');
    recommendations.slice(0, 2).forEach(item => lines.push(`  - ${item}`));
  }

  return createSection('Career Risk Analysis', lines);
}

function buildSalarySection(salary) {
  if (!salary || typeof salary !== 'object') return null;

  const lines = [
    salary.role && `Role: ${salary.role}`,
    formatINR(salary.median_salary) && `Median Salary: ${formatINR(salary.median_salary)}`,
    formatINR(salary.min_salary) &&
      `Salary Range: ${formatINR(salary.min_salary)} – ${formatINR(salary.max_salary) || '?'}`,
  ].filter(Boolean);

  const benchmarks = asArray(salary.benchmarks);
  benchmarks.slice(0, 3).forEach(benchmark => {
    if (benchmark?.role_name) {
      lines.push(`  ${benchmark.role_name}: median ${formatINR(benchmark.median_salary) || 'N/A'}`);
    }
  });

  return lines.length ? createSection('Salary Benchmarks', lines) : null;
}

function buildPersonalizationSection(profile) {
  if (!profile || Number(profile.total_events) < 1) return null;

  return createSection('User Interests (Behavioral)', [
    asArray(profile.preferred_roles).length &&
      `Interest in Roles: ${profile.preferred_roles.slice(0, 4).map(role => role?.name).filter(Boolean).join(', ')}`,
    asArray(profile.preferred_skills).length &&
      `Interest in Skills: ${profile.preferred_skills.slice(0, 4).map(skill => skill?.name).filter(Boolean).join(', ')}`,
    asArray(profile.career_interests).length &&
      `Industry Interests: ${profile.career_interests.slice(0, 3).map(item => item?.industry).filter(Boolean).join(', ')}`,
    `Platform Engagement: ${profile.total_events} interactions recorded`,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object|null|undefined} ragContext
 * @returns {{ contextString: string, dataSources: string[], sectionCount: number }}
 */
function buildContext(ragContext) {
  if (!ragContext || typeof ragContext !== 'object') {
    return {
      contextString: '',
      dataSources: [],
      sectionCount: 0,
    };
  }

  const sections = [
    { source: 'user_profile', text: buildUserProfileSection(ragContext.user_profile) },
    { source: 'chi_score', text: buildCHISection(ragContext.chi_score) },
    { source: 'skill_gaps', text: buildSkillGapsSection(ragContext.skill_gaps) },
    { source: 'job_matches', text: buildJobMatchesSection(ragContext.job_matches) },
    {
      source: 'opportunity_radar',
      text: buildOpportunityRadarSection(ragContext.opportunity_radar),
    },
    { source: 'risk_analysis', text: buildRiskSection(ragContext.risk_analysis) },
    {
      source: 'salary_benchmarks',
      text: buildSalarySection(ragContext.salary_benchmarks),
    },
    {
      source: 'personalization_profile',
      text: buildPersonalizationSection(ragContext.personalization_profile),
    },
  ].filter(section => section.text);

  const contextString = truncateContext(
    sections.map(section => section.text).join('\n\n'),
  );

  return {
    contextString,
    dataSources: sections.map(section => section.source),
    sectionCount: sections.length,
  };
}

module.exports = {
  buildContext,
};