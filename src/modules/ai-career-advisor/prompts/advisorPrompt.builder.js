'use strict';

/**
 * @file prompts/advisorPrompt.builder.js
 *
 * Optimized for lower Claude token cost + faster response.
 *
 * Phase 4B — AI Confidence Language Registry integration.
 *
 * Changes from original:
 *   - buildSystemPrompt() accepts a fourth argument: confidenceTier
 *   - Confidence language grounding instructions are appended to the system
 *     prompt when a tier is available, sourced from the deterministic
 *     IntelligenceSnapshot — never from AI output or user input.
 *   - If tier is absent or unrecognised, NO_DATA grounding is applied
 *     (fail-safe default — most restrictive vocabulary).
 *
 * Governance constraints preserved:
 *   ✅ Tier always comes from deterministic engine — never mutated here
 *   ✅ Grounding injected at end of prompt — cannot be overridden by context
 *   ✅ All existing logic is unchanged — additive patch only
 *   ✅ Module remains stateless and pure
 *
 * Call-site change in advisor.service.js:
 *   const systemPrompt = buildSystemPrompt(
 *     ragContext,
 *     intent,
 *     userName,
 *     intelligenceSnapshot?.confidence?.tier   // ← add this argument
 *   );
 */

// ─────────────────────────────────────────────────────────────
// Phase 4B — Confidence Language Registry
// ─────────────────────────────────────────────────────────────

const {
  getPromptGroundingInstructions,
  CONFIDENCE_TIERS,
} = require('../../../ai/confidence-language')  // ✅ resolves correctly

// ─────────────────────────────────────────────────────────────
// Formatters (unchanged)
// ─────────────────────────────────────────────────────────────

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
// Intent detection (unchanged)
// ─────────────────────────────────────────────────────────────

const INTENT_PATTERNS = [
  { intent: 'salary',      patterns: ['salary', 'ctc', 'lpa', 'package'] },
  { intent: 'skill_gap',   patterns: ['skill', 'gap', 'learn', 'upskill'] },
  { intent: 'job_match',   patterns: ['job', 'match', 'role', 'apply'] },
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
// Compact context builders (unchanged)
// ─────────────────────────────────────────────────────────────

function buildCompactProfile(profile) {
  if (!profile) return null;

  const lines = [];

  if (profile.target_role)      lines.push(`Target: ${profile.target_role}`);
  if (profile.years_experience) lines.push(`Experience: ${profile.years_experience} yrs`);
  if (profile.skills?.length)   lines.push(`Skills: ${list(profile.skills, 5)}`);

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
// Phase 4B — Confidence grounding (internal)
//
// Resolves the confidence tier from the deterministic snapshot and
// returns the governed vocabulary instruction block to append to
// the system prompt. Defaults to NO_DATA (most restrictive) on any
// missing or unrecognised tier — fail-safe behaviour.
// ─────────────────────────────────────────────────────────────

function _buildConfidenceGrounding(confidenceTier) {
  const normalised = (confidenceTier ?? '').toUpperCase();
  const safeTier   = CONFIDENCE_TIERS[normalised] ?? CONFIDENCE_TIERS.NO_DATA;

  return getPromptGroundingInstructions(safeTier);
}

// ─────────────────────────────────────────────────────────────
// System prompt
//
// Phase 4B change: accepts confidenceTier (4th argument).
// Sourced from IntelligenceSnapshot at the call site — never from AI.
// ─────────────────────────────────────────────────────────────

/**
 * @param {Object}      ragContext       — RAG context (profile, gaps, matches, salary)
 * @param {string}      intent           — detected intent ('salary' | 'skill_gap' | ...)
 * @param {string}      [userName]       — user display name (unused in prompt body; reserved)
 * @param {string}      [confidenceTier] — deterministic confidence tier from IntelligenceSnapshot
 *                                         ('HIGH' | 'MEDIUM' | 'LOW' | 'NO_DATA')
 * @returns {string}
 */
function buildSystemPrompt(ragContext, intent, userName, confidenceTier) {
  const blocks = [
    buildCompactProfile(ragContext?.user_profile),
    buildCompactSkillGap(ragContext?.skill_gaps),
    buildCompactJobMatches(ragContext?.job_matches),
  ];

  if (intent === 'salary') {
    blocks.push(buildCompactSalary(ragContext?.salary_benchmarks));
  }

  const context = blocks.filter(Boolean).join('\n\n');

  // ── Base prompt (unchanged from original) ─────────────────
  const base = `
You are Ava, HireRise's senior career advisor.

Rules:
- Use only provided data
- Be direct and numbers-first
- Always end with one bold action step
- Never invent salary or skills
- Keep answer under 150 words

${context || 'No profile data available.'}
`;

  // ── Phase 4B: append confidence language grounding ────────
  // Injected at the END of the prompt so it cannot be shadowed
  // by any earlier context block.
  const grounding = _buildConfidenceGrounding(confidenceTier);

  return `${base}\n---\nLANGUAGE GOVERNANCE:\n${grounding}`;
}

// ─────────────────────────────────────────────────────────────
// Conversation memory (unchanged)
// ─────────────────────────────────────────────────────────────

function buildConversationMessages(history, userMessage) {
  const messages = [];
  const recent   = (history || []).slice(-4); // only 2 turns

  for (const turn of recent) {
    messages.push({ role: 'user',      content: turn.user_message });
    messages.push({ role: 'assistant', content: turn.ai_response  });
  }

  messages.push({ role: 'user', content: userMessage });

  return messages;
}

// ─────────────────────────────────────────────────────────────
// Exports (unchanged shape — backward compatible)
// ─────────────────────────────────────────────────────────────

module.exports = {
  buildSystemPrompt,
  buildConversationMessages,
  detectIntent,
};