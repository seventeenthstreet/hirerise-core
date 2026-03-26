'use strict';

/**
 * prompts/advisorPrompt.builder.js  — AVA v2 UPGRADED
 *
 * WHAT CHANGED FROM v1:
 *   v1 problem: Ava gave warm-but-vague answers like "your profile looks strong,
 *   consider improving market alignment."  Zero specificity.
 *
 *   v2 fix: Every response is *forced* to reference at least 2 concrete data points
 *   by name, use real numbers from the user's profile, name specific skills/roles,
 *   and end with one action that can be started today.
 *
 *   The INTENT_RESPONSE_TEMPLATES section gives Ava per-intent answer scaffolds so
 *   she never defaults to a generic coaching paragraph.
 */

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatLPA(amount) {
  if (!amount || isNaN(amount)) return null;
  return `₹${(amount / 100_000).toFixed(1)} LPA`;
}
function pct(n) {
  if (n == null || isNaN(n)) return null;
  return `${Math.min(100, Math.max(0, Math.round(n)))}%`;
}
function score(n, max = 100) {
  if (n == null || isNaN(n)) return null;
  return `${Math.round(n)}/${max}`;
}
function cap(str) { return str ? str.charAt(0).toUpperCase() + str.slice(1) : ''; }
function list(arr, max = 6) {
  if (!arr?.length) return null;
  return arr.slice(0, max).join(', ');
}

// ─── Intent detection ──────────────────────────────────────────────────────────

const INTENT_PATTERNS = [
  { intent: 'score_explain',  patterns: ['score', 'why', 'low', 'high', 'mean', 'explain', 'breakdown', 'chi', 'health index'] },
  { intent: 'skill_gap',      patterns: ['skill', 'learn', 'missing', 'gap', 'upskill', 'need to know', 'should i learn', 'certif'] },
  { intent: 'salary',         patterns: ['salary', 'pay', 'earn', 'income', 'ctc', 'lpa', 'package', 'raise', 'negotiate', 'worth'] },
  { intent: 'career_path',    patterns: ['career', 'path', 'move into', 'transition', 'switch', 'next role', 'promotion', 'how long', 'timeline'] },
  { intent: 'job_match',      patterns: ['job', 'match', 'apply', 'role', 'opening', 'best fit', 'which job', 'should i apply'] },
  { intent: 'interview',      patterns: ['interview', 'prepare', 'question', 'answer', 'tell me about', 'coding round'] },
];

function detectIntent(message) {
  const lower = (message || '').toLowerCase();
  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.some(p => lower.includes(p))) return intent;
  }
  return 'general';
}

// ─── Per-intent answer scaffolds ───────────────────────────────────────────────
// These are injected into the system prompt when the intent is detected,
// forcing Ava to structure her answer around real data rather than prose.

const INTENT_RESPONSE_TEMPLATES = {
  score_explain: `
ANSWER FORMAT for score explanation questions:
  Line 1: State the exact score and the #1 reason it is at that level (name the specific dimension that is lowest).
  Line 2: Name the 2 specific sub-scores that are dragging it down, with their actual values.
  Line 3: Name 1 specific sub-score that is a genuine strength.
  Line 4-5: Two concrete things the user can do this week to raise it.
  Line 6: "If you fix [specific thing], your score could reach [realistic number] within [timeframe]."
  NEVER say "your profile looks strong" or "good foundation." Be specific.`,

  skill_gap: `
ANSWER FORMAT for skill gap questions:
  Line 1: Name the exact skills missing from their profile (use the Skill Gap data — list by name).
  Line 2: State how many job matches require each missing skill (use job match data).
  Line 3: Name the single highest-ROI skill to learn first and why (market demand score).
  Line 4: Recommend a specific learning path (not "take a course" — name a specific platform/cert).
  Line 5: Estimated time to close the gap based on the gap size.
  NEVER recommend a skill not in their actual skill gap data.`,

  salary: `
ANSWER FORMAT for salary questions:
  Line 1: State the exact salary range for their target role from salary benchmark data.
  Line 2: State where they currently fall in that range based on their experience/score.
  Line 3: Name the 2-3 specific skills or credentials that command the upper quartile of that range.
  Line 4: One concrete negotiation tactic based on their specific CHI score vs. market benchmark.
  NEVER give salary estimates not backed by the salary_benchmarks or job_matches data.`,

  career_path: `
ANSWER FORMAT for career path questions:
  Line 1: Name the specific recommended next role (from job_matches or user profile target role).
  Line 2: State the match score for that role and how many months the transition typically takes.
  Line 3: Name exactly 2-3 skills they need to acquire (from skill gap data) to qualify.
  Line 4: Name 1 stepping-stone role if the gap is > 40%.
  Line 5: "Start with [specific skill/cert] — it unlocks [specific % of job matches]."
  NEVER give a vague "build your network" step without connecting it to a specific data point.`,

  job_match: `
ANSWER FORMAT for job match questions:
  Line 1: State their top matched role, the exact match score, and why (which skills matched).
  Line 2: Name the 2-3 specific skills causing any score below 80%.
  Line 3: Compare their profile to what the role requires (use role requirements from data).
  Line 4: "To reach a 90%+ match for [role], you need: [specific skills]."
  NEVER list job titles without their scores.`,

  interview: `
ANSWER FORMAT for interview questions:
  Line 1: Name 3 specific technical topics likely to be tested (based on their target role's required skills).
  Line 2: State their current interview prep score if available.
  Line 3: One specific weakness to address based on their skill gaps.
  Line 4: A concrete prep exercise tied to a specific skill gap (e.g. "build a React CRUD app" not "practice coding").`,

  general: `
ANSWER FORMAT for general questions:
  Ground every statement in a specific data point from the user's profile.
  Start each insight with the actual number or fact: "Your 68% job match for [role] means..."
  End with one specific action: "This week, [exact thing] because [data reason]."
  NEVER open with "Great question!" or any pleasantry.
  NEVER end without a specific next step.`,
};

// ─── Context section builders ─────────────────────────────────────────────────
// Build only what we have; omit absent data entirely.

function buildProfileSection(profile) {
  if (!profile) return null;
  const lines = [];
  if (profile.name)              lines.push(`Name: ${profile.name.split(' ')[0]}`);
  if (profile.target_role)       lines.push(`Target Role: ${profile.target_role}`);
  if (profile.current_role)      lines.push(`Current Role: ${profile.current_role}`);
  if (profile.years_experience)  lines.push(`Experience: ${profile.years_experience} yrs`);
  if (profile.skills?.length)    lines.push(`Skills (${profile.skills.length}): ${list(profile.skills, 10)}`);
  if (profile.education_level)   lines.push(`Education: ${cap(profile.education_level)}`);
  if (profile.location)          lines.push(`Location: ${profile.location}`);
  if (profile.industry)          lines.push(`Industry: ${cap(profile.industry)}`);
  if (profile.current_salary)    lines.push(`Current Salary: ${formatLPA(profile.current_salary) ?? 'Not provided'}`);
  return lines.length ? `[PROFILE]\n${lines.join('\n')}` : null;
}

function buildScoreSection(chi) {
  if (!chi || chi.chi_score == null) return null;
  const lines = [`CHI Score: ${score(chi.chi_score)}`];
  if (chi.analysis_source) lines.push(`Source: ${chi.analysis_source}`);
  if (chi.dimensions) {
    lines.push('Dimension breakdown:');
    for (const [k, v] of Object.entries(chi.dimensions)) {
      const s = typeof v === 'object' ? v.score : v;
      if (s != null) lines.push(`  ${k}: ${score(s)}`);
    }
  }
  if (chi.strengths?.length)   lines.push(`Strengths: ${list(chi.strengths)}`);
  if (chi.weaknesses?.length)  lines.push(`Weaknesses: ${list(chi.weaknesses)}`);
  if (chi.ava_insight)         lines.push(`AI Summary: ${chi.ava_insight}`);
  return `[CAREER HEALTH INDEX]\n${lines.join('\n')}`;
}

function buildSkillGapSection(gaps) {
  if (!gaps) return null;
  const lines = [];
  if (gaps.missing_core?.length)
    lines.push(`Missing Core Skills (${gaps.missing_core.length}): ${list(gaps.missing_core)}`);
  if (gaps.missing_complementary?.length)
    lines.push(`Missing Complementary Skills: ${list(gaps.missing_complementary)}`);
  if (gaps.has?.length)
    lines.push(`Confirmed Skills: ${list(gaps.has, 8)}`);
  if (gaps.gap_severity)
    lines.push(`Gap Severity: ${gaps.gap_severity}`);
  if (gaps.priority_skills?.length)
    lines.push(`Priority to Learn: ${list(gaps.priority_skills, 4)}`);
  return lines.length ? `[SKILL GAP ANALYSIS]\n${lines.join('\n')}` : null;
}

function buildJobMatchSection(matches) {
  if (!matches?.length) return null;
  const lines = [`Top ${Math.min(matches.length, 5)} Job Matches:`];
  matches.slice(0, 5).forEach((m, i) => {
    const matchPct = pct(m.match_score ?? m.score);
    const salary   = m.salary_range ?? (m.salary_min && m.salary_max
      ? `${formatLPA(m.salary_min)}–${formatLPA(m.salary_max)}` : null);
    const missing  = m.missing_skills?.slice(0, 3).join(', ');
    lines.push(
      `  ${i + 1}. ${m.role || m.title} — Match: ${matchPct ?? 'N/A'}` +
      (salary   ? ` | Salary: ${salary}` : '') +
      (missing  ? ` | Missing: ${missing}` : '')
    );
  });
  return `[JOB MATCHES]\n${lines.join('\n')}`;
}

function buildSalarySection(salary) {
  if (!salary) return null;
  const lines = [];
  if (salary.role)        lines.push(`Role: ${salary.role}`);
  if (salary.median)      lines.push(`Median: ${formatLPA(salary.median)}`);
  if (salary.p25 && salary.p75)
    lines.push(`Range: ${formatLPA(salary.p25)} – ${formatLPA(salary.p75)}`);
  if (salary.top_10_pct)  lines.push(`Top 10%: ${formatLPA(salary.top_10_pct)}`);
  if (salary.entry)       lines.push(`Entry Level: ${formatLPA(salary.entry)}`);
  if (salary.senior)      lines.push(`Senior Level: ${formatLPA(salary.senior)}`);
  if (salary.differentiators?.length)
    lines.push(`Skills that unlock upper range: ${list(salary.differentiators)}`);
  return lines.length ? `[SALARY BENCHMARKS]\n${lines.join('\n')}` : null;
}

function buildRiskSection(risk) {
  if (!risk) return null;
  const lines = [];
  if (risk.overall_risk)      lines.push(`Risk Level: ${cap(risk.overall_risk)}`);
  if (risk.risk_score != null) lines.push(`Risk Score: ${score(risk.risk_score)}`);
  if (risk.top_risks?.length) {
    lines.push('Top Risks:');
    risk.top_risks.slice(0, 3).forEach(r => lines.push(`  • ${r}`));
  }
  if (risk.mitigation_steps?.length) {
    lines.push('Suggested Mitigations:');
    risk.mitigation_steps.slice(0, 2).forEach(s => lines.push(`  → ${s}`));
  }
  return lines.length ? `[RISK ANALYSIS]\n${lines.join('\n')}` : null;
}

function buildOpportunitySection(radar) {
  if (!radar?.opportunities?.length) return null;
  const lines = ['Top Opportunities:'];
  radar.opportunities.slice(0, 3).forEach(o => {
    lines.push(`  • ${o.title ?? o.role} — ${o.reason ?? ''} (${o.match_pct ? pct(o.match_pct) : ''})`);
  });
  return `[OPPORTUNITY RADAR]\n${lines.join('\n')}`;
}

// ─── Core system prompt ────────────────────────────────────────────────────────

function buildSystemPrompt(ragContext, intent, userName) {
  const name = userName ? userName.split(' ')[0] : null;

  const sections = [
    buildProfileSection(ragContext?.user_profile),
    buildScoreSection(ragContext?.chi_score),
    buildSkillGapSection(ragContext?.skill_gaps),
    buildJobMatchSection(ragContext?.job_matches),
    buildSalarySection(ragContext?.salary_benchmarks),
    buildRiskSection(ragContext?.risk_analysis),
    buildOpportunitySection(ragContext?.opportunity_radar),
  ].filter(Boolean);

  const contextBlock = sections.length
    ? sections.join('\n\n')
    : '[No profile data available — ask the user to complete their HireRise profile analysis first.]';

  const intentTemplate = INTENT_RESPONSE_TEMPLATES[intent] ?? INTENT_RESPONSE_TEMPLATES.general;

  return `You are Ava, a senior career advisor at HireRise.${name ? ` You are speaking with ${name}.` : ''}

YOUR COMMUNICATION STYLE:
- Direct, specific, numbers-first. Lead with data, not warmth.
- Short sentences. No fluff. No preamble.
- Never open with "Great question!", "Sure!", "Of course!", or any equivalent.
- Never use these phrases: "strong profile", "good foundation", "market alignment",
  "leverage your experience", "broad skill set", "various opportunities".
- Every claim must cite a specific number or fact from the data context below.
- Write like a trusted advisor who has studied this person's career file — not a chatbot.

GROUNDING RULES:
1. Only state salary figures that appear in [SALARY BENCHMARKS] or [JOB MATCHES].
2. Only name specific skills that appear in [SKILL GAP ANALYSIS] or [PROFILE].
3. If data for a question is missing, say exactly what is missing and how to fix it.
4. Do not invent job titles, companies, certifications, or statistics.
5. If you give a percentage or score, it must match a value in the data below.

${intentTemplate}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USER CAREER DATA (ground ALL responses in this)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${contextBlock}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Answer the user's question using the data above.
End every response with exactly one bold action step prefixed with "→ Action:".`;
}

// ─── Conversation messages builder ────────────────────────────────────────────

function buildConversationMessages(history, userMessage) {
  const messages = [];
  const recent = (history || []).slice(-8); // 4 turns max
  for (const turn of recent) {
    messages.push({ role: 'user',      content: turn.user_message });
    messages.push({ role: 'assistant', content: turn.ai_response  });
  }
  messages.push({ role: 'user', content: userMessage });
  return messages;
}

module.exports = {
  buildSystemPrompt,
  buildConversationMessages,
  detectIntent,
  // Exposed for testing
  _buildProfileSection:     buildProfileSection,
  _buildScoreSection:       buildScoreSection,
  _buildSkillGapSection:    buildSkillGapSection,
  _buildJobMatchSection:    buildJobMatchSection,
  _buildSalarySection:      buildSalarySection,
  _INTENT_RESPONSE_TEMPLATES: INTENT_RESPONSE_TEMPLATES,
};








