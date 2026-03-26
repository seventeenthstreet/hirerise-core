'use strict';

/**
 * ragContextBuilder.js — RAG Context Builder
 *
 * Transforms raw retrieved data from ragRetriever into a structured,
 * compact context string injected into the LLM system prompt.
 *
 * Design principles:
 *   - Only inject FACTS that exist in retrieved data. Never fill gaps with
 *     generic text or invented values.
 *   - If a source is null, that section is omitted entirely from the prompt.
 *   - Salary figures are only included when from the salary_benchmarks source.
 *   - Numeric scores are rounded and labelled for LLM readability.
 *   - Total context is kept under 2,500 tokens to leave room for conversation
 *     history and the user's question.
 *
 * @module src/modules/career-copilot/context/ragContextBuilder
 */

'use strict';

// ─── Formatting helpers ───────────────────────────────────────────────────────

function _inr(amount) {
  if (!amount || isNaN(amount)) return null;
  if (amount >= 100000) return `₹${(amount / 100000).toFixed(1)}L`;
  return `₹${amount.toLocaleString('en-IN')}`;
}

function _pct(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${Math.min(100, Math.max(0, Math.round(n)))}%`;
}

function _score(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return Math.round(n);
}

function _list(arr, max = 6) {
  if (!arr || arr.length === 0) return 'none';
  return arr.slice(0, max).join(', ');
}

function _section(title, lines) {
  const content = lines.filter(Boolean).join('\n');
  if (!content.trim()) return null;
  return `### ${title}\n${content}`;
}

// ─── Section builders ─────────────────────────────────────────────────────────

function _buildUserProfileSection(profile) {
  if (!profile) return null;
  return _section('User Profile', [
    profile.target_role      && `Target Role:       ${profile.target_role}`,
    profile.current_role     && `Current Role:      ${profile.current_role}`,
    profile.skills?.length   && `Current Skills:    ${_list(profile.skills, 10)}`,
    profile.years_experience && `Experience:        ${profile.years_experience} years`,
    profile.industry         && `Industry:          ${profile.industry}`,
    profile.education_level  && `Education:         ${profile.education_level}`,
    profile.location         && `Location:          ${profile.location}`,
    profile.current_salary   && `Current Salary:    ${_inr(profile.current_salary)}`,
  ]);
}

function _buildCHISection(chi) {
  if (!chi || chi.chi_score === null) return null;

  const lines = [
    `Career Health Score (CHI): ${_score(chi.chi_score)}/100`,
    chi.analysis_source && `Analysis Type: ${chi.analysis_source}`,
  ];

  if (chi.dimensions) {
    const dims = Object.entries(chi.dimensions)
      .map(([k, v]) => {
        const s = typeof v === 'object' ? v.score : v;
        return s != null ? `  ${k}: ${_score(s)}/100` : null;
      })
      .filter(Boolean);
    if (dims.length > 0) {
      lines.push('Dimension Scores:');
      lines.push(...dims);
    }
  }

  return _section('Career Health Index', lines);
}

function _buildSkillGapsSection(gaps) {
  if (!gaps) return null;

  const lines = [
    gaps.existing_skills?.length && `Current Skills: ${_list(gaps.existing_skills, 8)}`,
    gaps.adjacent_skills?.length && `Adjacent Skills (learnable next): ${_list(gaps.adjacent_skills, 5)}`,
  ];

  if (gaps.missing_high_demand?.length > 0) {
    lines.push('High-Demand Missing Skills:');
    gaps.missing_high_demand.slice(0, 6).forEach(s => {
      const name  = typeof s === 'string' ? s : s.name;
      const score = typeof s === 'object' ? s.demand_score : null;
      lines.push(`  - ${name}${score ? ` (demand: ${_score(score)}/100)` : ''}`);
    });
  }

  if (gaps.role_gap) {
    lines.push(`Role Match (${gaps.role_gap.target_role}): ${_pct(gaps.role_gap.match_percentage)}`);
    if (gaps.role_gap.missing_required?.length > 0) {
      lines.push(`Missing Required: ${_list(gaps.role_gap.missing_required, 5)}`);
    }
  }

  return _section('Skill Analysis', lines);
}

function _buildJobMatchesSection(matches) {
  if (!matches?.top_matches?.length) return null;

  const lines = [`Total Roles Evaluated: ${matches.total_evaluated || 'N/A'}`];
  lines.push('Top Matched Roles:');

  matches.top_matches.forEach((j, i) => {
    lines.push(`  ${i + 1}. ${j.title} — Match: ${_score(j.match_score)}%`);
    if (j.missing_skills?.length > 0) {
      lines.push(`     Skills to add: ${j.missing_skills.join(', ')}`);
    }
    if (j.salary) {
      const salMin = _inr(j.salary.min);
      const salMax = _inr(j.salary.max);
      if (salMin || salMax) {
        lines.push(`     Salary range: ${salMin || '?'} – ${salMax || '?'}`);
      }
    }
  });

  return _section('Job Matches', lines);
}

function _buildOpportunityRadarSection(radar) {
  if (!radar?.emerging_opportunities?.length) return null;

  const lines = ['Top Emerging Career Opportunities:'];

  radar.emerging_opportunities.forEach((opp, i) => {
    const role   = opp.role;
    const oScore = _score(opp.opportunity_score);
    const mScore = _score(opp.match_score);
    const trend  = opp.growth_trend || '';
    const salary = opp.average_salary || '';

    lines.push(`  ${i + 1}. ${role}`);
    lines.push(`     Opportunity Score: ${oScore}/100 | Match: ${mScore}% | Growth: ${trend}`);
    if (salary) lines.push(`     Average Salary: ${salary}`);
    if (opp.skills_to_learn?.length > 0) {
      lines.push(`     Skills needed: ${opp.skills_to_learn.slice(0, 3).join(', ')}`);
    }
  });

  return _section('Career Opportunity Radar', lines);
}

function _buildRiskSection(risk) {
  if (!risk || risk.overall_risk_score === null) return null;

  const lines = [
    `Overall Risk Score: ${_score(risk.overall_risk_score)}/100 (${risk.risk_level || 'N/A'})`,
  ];

  if (risk.risk_factors?.length > 0) {
    lines.push('Key Risk Factors:');
    risk.risk_factors.slice(0, 3).forEach(f => {
      const factor = typeof f === 'string' ? f : f.factor;
      const desc   = typeof f === 'object' ? f.description : null;
      lines.push(`  - ${factor}${desc ? `: ${desc}` : ''}`);
    });
  }

  if (risk.recommendations?.length > 0) {
    lines.push('Risk Mitigation:');
    risk.recommendations.slice(0, 2).forEach(r => lines.push(`  - ${r}`));
  }

  return _section('Career Risk Analysis', lines);
}

function _buildSalarySection(salary) {
  if (!salary) return null;

  const lines = [
    salary.role           && `Role: ${salary.role}`,
    salary.median_salary  && `Median Salary: ${_inr(salary.median_salary)}`,
    salary.min_salary     && `Salary Range: ${_inr(salary.min_salary)} – ${_inr(salary.max_salary)}`,
  ].filter(Boolean);

  // Also include benchmarks array if present
  if (salary.benchmarks?.length > 0) {
    salary.benchmarks.slice(0, 3).forEach(b => {
      lines.push(`  ${b.role_name}: median ${_inr(b.median_salary)}`);
    });
  }

  if (lines.length === 0) return null;

  return _section('Salary Benchmarks', lines);
}

function _buildPersonalizationSection(p) {
  if (!p || p.total_events < 1) return null;

  const lines = [
    p.preferred_roles?.length  && `Interest in Roles: ${p.preferred_roles.slice(0, 4).map(r => r.name).join(', ')}`,
    p.preferred_skills?.length && `Interest in Skills: ${p.preferred_skills.slice(0, 4).map(s => s.name).join(', ')}`,
    p.career_interests?.length && `Industry Interests: ${p.career_interests.slice(0, 3).map(i => i.industry).join(', ')}`,
    p.total_events             && `Platform Engagement: ${p.total_events} interactions recorded`,
  ];

  return _section('User Interests (Behavioral)', lines);
}

// ═════════════════════════════════════════════════════════════════════════════
// buildContext(ragContext) — main export
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build the structured context string to inject into the LLM system prompt.
 *
 * @param {RAGContext} ragContext — output of ragRetriever.retrieveContext()
 * @returns {{ contextString: string, dataSources: string[], sectionCount: number }}
 */
function buildContext(ragContext) {
  if (!ragContext) {
    return {
      contextString: '',
      dataSources:   [],
      sectionCount:  0,
    };
  }

  const sections = [
    { source: 'user_profile',            text: _buildUserProfileSection(ragContext.user_profile) },
    { source: 'chi_score',               text: _buildCHISection(ragContext.chi_score) },
    { source: 'skill_gaps',              text: _buildSkillGapsSection(ragContext.skill_gaps) },
    { source: 'job_matches',             text: _buildJobMatchesSection(ragContext.job_matches) },
    { source: 'opportunity_radar',       text: _buildOpportunityRadarSection(ragContext.opportunity_radar) },
    { source: 'risk_analysis',           text: _buildRiskSection(ragContext.risk_analysis) },
    { source: 'salary_benchmarks',       text: _buildSalarySection(ragContext.salary_benchmarks) },
    { source: 'personalization_profile', text: _buildPersonalizationSection(ragContext.personalization_profile) },
  ].filter(s => s.text !== null);

  const contextString = sections.map(s => s.text).join('\n\n');
  const dataSources   = sections.map(s => s.source);

  return {
    contextString,
    dataSources,
    sectionCount: sections.length,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { buildContext };









