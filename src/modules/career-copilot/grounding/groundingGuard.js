'use strict';

/**
 * groundingGuard.js — Hallucination Prevention Guard
 *
 * Enforces strict grounding rules before and after LLM generation.
 *
 * BEFORE generation (pre-flight):
 *   1. Check data_completeness >= MIN_COMPLETENESS_THRESHOLD
 *   2. Check that the question can be answered from available sources
 *   3. Classify query intent to route to most relevant sources
 *   4. If insufficient data → return REFUSED response immediately (no LLM call)
 *
 * AFTER generation (post-flight):
 *   1. Scan response for hallucination patterns (invented salary figures,
 *      fabricated company names, ungrounded statistics)
 *   2. If violations detected → return cleaned response with caveat
 *
 * SYSTEM PROMPT RULES injected into every LLM call:
 *   - 7 explicit hallucination prevention instructions
 *   - Context-aware instruction: cite which data source each claim comes from
 *   - Hard rules: never invent salary figures, company names, statistics
 *
 * @module src/modules/career-copilot/grounding/groundingGuard
 */

'use strict';

const logger = require('../../../utils/logger');

// ─── Thresholds ───────────────────────────────────────────────────────────────

const MIN_COMPLETENESS = 0.25;  // at least 2 of 8 sources needed
const MIN_CONFIDENCE   = 0.20;  // minimum weighted quality score

// ─── Query intent classifiers ─────────────────────────────────────────────────

/**
 * Map query keywords → required source(s) for a meaningful answer.
 * If all required sources are null → refuse with specific guidance.
 */
const INTENT_PATTERNS = [
  {
    intent:   'salary',
    patterns: ['salary', 'pay', 'earn', 'income', 'ctc', 'lpa', 'package', 'compensation'],
    requires: ['salary_benchmarks'],
    fallback_ok: true,   // can use job_matches salary ranges as partial answer
  },
  {
    intent:   'career_path',
    patterns: ['career', 'path', 'move into', 'transition', 'switch', 'next role', 'progression'],
    requires: ['user_profile', 'job_matches'],
    fallback_ok: false,
  },
  {
    intent:   'skill_gap',
    patterns: ['skill', 'learn', 'missing', 'gap', 'need to know', 'upskill', 'improve'],
    requires: ['skill_gaps'],
    fallback_ok: false,
  },
  {
    intent:   'opportunity',
    patterns: ['opportunity', 'emerging', 'growth', 'future', 'trending', 'in demand'],
    requires: ['opportunity_radar'],
    fallback_ok: true,
  },
  {
    intent:   'risk',
    patterns: ['risk', 'safe', 'stable', 'automation', 'threat', 'vulnerable', 'worried'],
    requires: ['risk_analysis'],
    fallback_ok: false,
  },
  {
    intent:   'health',
    patterns: ['score', 'chi', 'health', 'readiness', 'how ready', 'career health'],
    requires: ['chi_score'],
    fallback_ok: false,
  },
];

// ─── Hallucination pattern detectors ─────────────────────────────────────────

/**
 * Patterns that indicate the model may have invented data.
 * These are used in the post-flight scan.
 */
const HALLUCINATION_PATTERNS = [
  // Invented salary-like patterns not from salary_benchmarks
  /₹\s*[\d,]+\s*(?:lpa|lakhs?|per annum|annually)/i,
  /\$\s*[\d,]+\s*(?:per year|annually|a year)/i,
  /\d+\s*(?:lpa|lakhs per annum)/i,

  // Invented statistics
  /\d+%\s+(?:of companies|of employers|of professionals|of job seekers)/i,
  /studies show|research indicates|according to reports/i,
  /industry average is|market average is/i,

  // Fabricated company references
  /(?:companies like|firms like|employers like)\s+[A-Z][a-z]+/,

  // Over-confident predictions
  /(?:guaranteed|certain|definitely will|will definitely)/i,
  /within \d+ (?:months?|years?) you (?:will|can) earn/i,
];

// ─── Refusal messages ────────────────────────────────────────────────────────

const REFUSAL_MESSAGES = {
  no_profile: `I don't have enough information about your profile yet to provide personalised career advice. 

To get started, please:
1. Complete your profile (target role, skills, experience)
2. Upload your CV for analysis
3. Browse job listings to build your interest profile

Once your data is available, I can give you grounded, specific advice based on your actual career situation.`,

  no_skill_data: `I can't see your skill analysis data yet. To answer this question accurately, please:
• Upload your CV so the Skill Analysis Engine can process it
• Or manually add your skills in your profile

I won't guess at your skill gaps — my answers are based only on your real data.`,

  no_salary_data: `I don't have salary benchmark data for your target role yet. 

The platform collects salary data from verified job postings. Try:
• Checking the Salary Intelligence section directly
• Specifying a more common role title in your profile

I won't invent salary figures.`,

  no_opportunity_data: `Opportunity Radar data is still loading for your profile. 

This typically updates within a few minutes after your CV is processed. Meanwhile, you can:
• Check the Opportunity Radar dashboard directly
• Ask me about your current skill gaps or job matches instead`,

  insufficient_data: `I don't have enough platform data about your profile to answer this confidently.

Available data: {sources}
Missing data: {missing}

Please complete your profile and upload your CV. Once the platform has analysed your data, I can give you grounded, specific career advice.`,
};

// ─── Pre-flight check ─────────────────────────────────────────────────────────

/**
 * Run pre-flight grounding check before calling the LLM.
 *
 * @param {RAGContext} ragContext
 * @param {string}     userQuery
 * @returns {{ allowed: boolean, refusalMessage?: string, intent?: string, warningFlags?: string[] }}
 */
function preFlightCheck(ragContext, userQuery) {
  // 1. Absolute minimum: some data must exist
  if (!ragContext || ragContext.data_completeness < MIN_COMPLETENESS) {
    const available = ragContext?.data_sources_used || [];
    const missing   = (ragContext ? Object.keys(ragContext).filter(k =>
      k !== 'data_sources_used' && k !== 'data_completeness' &&
      k !== 'confidence_score' && k !== 'is_sufficient' &&
      k !== 'retrieval_ms' && k !== 'retrieved_at' && k !== '_cached' &&
      ragContext[k] === null
    ) : ['all sources']);

    // No profile at all → specific guidance
    if (!ragContext?.user_profile) {
      return { allowed: false, refusalMessage: REFUSAL_MESSAGES.no_profile, intent: 'no_data' };
    }

    const msg = REFUSAL_MESSAGES.insufficient_data
      .replace('{sources}', available.join(', ') || 'none')
      .replace('{missing}', missing.join(', '));

    return { allowed: false, refusalMessage: msg, intent: 'insufficient_data' };
  }

  // 2. Classify query intent
  const queryLower = userQuery.toLowerCase();
  let detectedIntent = 'general';
  const warningFlags = [];

  for (const pattern of INTENT_PATTERNS) {
    const matched = pattern.patterns.some(p => queryLower.includes(p));
    if (!matched) continue;

    detectedIntent = pattern.intent;

    // Check if required sources are available
    const missingRequired = pattern.requires.filter(
      src => !ragContext.data_sources_used.includes(src)
    );

    if (missingRequired.length > 0 && !pattern.fallback_ok) {
      // Specific refusal for this intent
      const refusalKey = `no_${pattern.intent.replace('_', '_')}`;
      const refusalMsg = REFUSAL_MESSAGES[refusalKey]
        || REFUSAL_MESSAGES.insufficient_data
          .replace('{sources}', ragContext.data_sources_used.join(', '))
          .replace('{missing}', missingRequired.join(', '));

      logger.info('[GroundingGuard] Pre-flight refused', {
        intent: pattern.intent, missing: missingRequired,
      });

      return {
        allowed:         false,
        refusalMessage:  refusalMsg,
        intent:          pattern.intent,
      };
    }

    // Warn if fallback is being used
    if (missingRequired.length > 0 && pattern.fallback_ok) {
      warningFlags.push(`${pattern.intent}_data_partial`);
    }

    break;
  }

  return { allowed: true, intent: detectedIntent, warningFlags };
}

// ─── Post-flight scan ─────────────────────────────────────────────────────────

/**
 * Scan generated response for hallucination patterns.
 * If violations found, append a transparency caveat.
 *
 * @param {string}   response     — raw LLM response text
 * @param {RAGContext} ragContext
 * @returns {{ cleanedResponse: string, violations: string[], wasModified: boolean }}
 */
function postFlightScan(response, ragContext) {
  if (!response) return { cleanedResponse: '', violations: [], wasModified: false };

  const violations = [];

  // Check for salary hallucinations when no salary data was retrieved
  const hasSalaryData = ragContext?.salary_benchmarks !== null;
  const hasJobSalary  = ragContext?.job_matches?.top_matches?.some(j => j.salary?.min || j.salary?.max);

  if (!hasSalaryData && !hasJobSalary) {
    // Check if response contains salary figures
    const salaryPattern = /₹\s*[\d.,]+\s*(?:L|lakh|LPA|lpa)/gi;
    const salaryMatches = response.match(salaryPattern);
    if (salaryMatches) {
      violations.push('salary_figures_without_data');
      logger.warn('[GroundingGuard] Salary hallucination detected', {
        matches: salaryMatches.slice(0, 3),
      });
    }
  }

  // Check for statistical hallucinations
  for (const pattern of HALLUCINATION_PATTERNS.slice(2)) {
    if (pattern.test(response)) {
      violations.push('statistical_hallucination');
      break;
    }
  }

  if (violations.length === 0) {
    return { cleanedResponse: response, violations: [], wasModified: false };
  }

  // Append transparency caveat
  const caveat = `\n\n---\n⚠️ *Note: Some statements above may be general guidance rather than data from your specific profile. For verified figures, check your platform dashboards directly.*`;

  return {
    cleanedResponse: response + caveat,
    violations,
    wasModified: true,
  };
}

// ─── System prompt injection ──────────────────────────────────────────────────

/**
 * Build the grounding instruction section injected into every system prompt.
 * These are the hard rules the LLM must follow.
 *
 * @param {string[]} availableSources — list of retrieved data source names
 * @returns {string}
 */
function buildGroundingInstructions(availableSources) {
  return `## Grounding Rules (MUST FOLLOW)

You are the Career Copilot for the HireRise platform. You assist job seekers with career decisions.

CRITICAL: You may ONLY base your answers on the structured platform data provided in the CONTEXT section below. You must NOT:
1. Invent, estimate, or assume salary figures not present in the context
2. Reference companies, statistics, or studies not present in the context
3. Make predictions with specific numbers unless those numbers are in the context
4. Say "typically" or "on average" without a source from the context
5. Provide career advice that contradicts the retrieved job matches or opportunity scores
6. Claim a skill is "in demand" unless the skill gap or opportunity data says so
7. Give salary ranges unless they appear explicitly in the Salary Benchmarks or Job Matches sections

If the user asks about something not covered by the available data, say:
"I don't have that specific data in your profile yet. You can find this in [relevant dashboard section]."

Available data sources for this response: ${availableSources.join(', ')}

When answering, reference the specific source (e.g. "Based on your Job Matches...", "Your Career Health Score shows...", "The Opportunity Radar indicates...").`;
}

// ─── Confidence score builder ─────────────────────────────────────────────────

/**
 * Calculate the final confidence score for the response metadata.
 * Combines data completeness, source count, and whether the primary
 * source for the detected intent was available.
 *
 * @param {RAGContext} ragContext
 * @param {string}     intent
 * @param {string[]}   dataSources — sources actually used in context
 * @returns {number} 0–1
 */
function calculateResponseConfidence(ragContext, intent, dataSources) {
  // Base: data completeness
  let confidence = ragContext.confidence_score || 0;

  // Bonus: primary intent source available
  const intentPattern = INTENT_PATTERNS.find(p => p.intent === intent);
  if (intentPattern) {
    const primaryAvailable = intentPattern.requires.every(r => dataSources.includes(r));
    if (primaryAvailable) confidence = Math.min(1.0, confidence + 0.15);
  }

  // Penalty: very few sources
  if (dataSources.length < 2) confidence = Math.min(confidence, 0.4);
  if (dataSources.length < 1) confidence = 0.1;

  return Math.round(confidence * 1000) / 1000;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  preFlightCheck,
  postFlightScan,
  buildGroundingInstructions,
  calculateResponseConfidence,
  MIN_COMPLETENESS,
  REFUSAL_MESSAGES,
};









