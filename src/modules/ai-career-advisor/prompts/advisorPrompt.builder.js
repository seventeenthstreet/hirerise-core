'use strict';

/**
 * prompts/advisorPrompt.builder.js
 * Optimized for lower Claude token cost + faster response
 */

function formatLPA(amount) {
  if (!amount || isNaN(amount)) return null;
  return `₹${(amount / 100000).toFixed(1)} LPA`;
}

function pct(n) {
  if (n == null || isNaN(n)) return null;
  return `${Math.round(Math.min(100, Math.max(0, n)))}%`;
}

function list(arr, max = 3) {
  return arr?.length ? arr.slice(0, max).join(', ') : null;
}

// ─────────────────────────────────────────────────────────────
// Intent detection
// ─────────────────────────────────────────────────────────────
const INTENT_PATTERNS = [
  { intent: 'salary', patterns: ['salary', 'ctc', 'lpa', 'package'] },
  { intent: 'skill_gap', patterns: ['skill', 'gap', 'learn', 'upskill'] },
  { intent: 'job_match', patterns: ['job', 'match', 'role', 'apply'] },
  { intent: 'career_path', patterns: ['career', 'path', 'switch', 'next role'] },
];

function detectIntent(message) {
  const lower = (message || '').toLowerCase();

  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.some((p) => lower.includes(p))) return intent;
  }

  return 'general';
}

// ─────────────────────────────────────────────────────────────
// Compact context builders
// ─────────────────────────────────────────────────────────────
function buildCompactProfile(profile) {
  if (!profile) return null;

  const lines = [];

  if (profile.target_role) lines.push(`Target: ${profile.target_role}`);
  if (profile.years_experience)
    lines.push(`Experience: ${profile.years_experience} yrs`);
  if (profile.skills?.length)
    lines.push(`Skills: ${list(profile.skills, 5)}`);

  return lines.join('\n');
}

function buildCompactSkillGap(gaps) {
  if (!gaps?.priority_skills?.length) return null;
  return `Priority Skills: ${list(gaps.priority_skills, 3)}`;
}

function buildCompactJobMatches(matches) {
  if (!matches?.length) return null;

  return matches
    .slice(0, 3)
    .map((m) => `${m.role}: ${pct(m.match_score ?? m.score)}`)
    .join('\n');
}

function buildCompactSalary(salary) {
  if (!salary?.median) return null;

  return [
    `Median: ${formatLPA(salary.median)}`,
    salary.p75 ? `Upper: ${formatLPA(salary.p75)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────
function buildSystemPrompt(ragContext, intent, userName) {
  const blocks = [
    buildCompactProfile(ragContext?.user_profile),
    buildCompactSkillGap(ragContext?.skill_gaps),
    buildCompactJobMatches(ragContext?.job_matches),
  ];

  if (intent === 'salary') {
    blocks.push(buildCompactSalary(ragContext?.salary_benchmarks));
  }

  const context = blocks.filter(Boolean).join('\n\n');

  return `
You are Ava, HireRise's senior career advisor.

Rules:
- Use only provided data
- Be direct and numbers-first
- Always end with one bold action step
- Never invent salary or skills
- Keep answer under 150 words

${context || 'No profile data available.'}
`;
}

// ─────────────────────────────────────────────────────────────
// Conversation memory
// ─────────────────────────────────────────────────────────────
function buildConversationMessages(history, userMessage) {
  const messages = [];
  const recent = (history || []).slice(-4); // only 2 turns

  for (const turn of recent) {
    messages.push({
      role: 'user',
      content: turn.user_message,
    });

    messages.push({
      role: 'assistant',
      content: turn.ai_response,
    });
  }

  messages.push({
    role: 'user',
    content: userMessage,
  });

  return messages;
}

module.exports = {
  buildSystemPrompt,
  buildConversationMessages,
  detectIntent,
};