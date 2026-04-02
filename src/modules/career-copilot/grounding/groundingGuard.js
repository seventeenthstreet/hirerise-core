'use strict';

/**
 * @file src/modules/career-copilot/grounding/groundingGuard.js
 * @description
 * Production-grade hallucination prevention and response grounding guard.
 *
 * Supabase migration posture:
 * - No Firebase auth / Firestore snapshot assumptions
 * - Works on row-based RAG payloads and JSONB aggregations
 * - Null-safe for RPC / left-join partial payloads
 * - Deterministic intent routing and confidence scoring
 */

const logger = require('../../../utils/logger');

const MIN_COMPLETENESS = 0.25;
const MIN_CONFIDENCE = 0.2;

const METADATA_KEYS = new Set([
  'data_sources_used',
  'data_completeness',
  'confidence_score',
  'is_sufficient',
  'retrieval_ms',
  'retrieved_at',
  '_cached',
]);

const INTENT_PATTERNS = [
  {
    intent: 'salary',
    patterns: ['salary', 'pay', 'earn', 'income', 'ctc', 'lpa', 'package', 'compensation'],
    requires: ['salary_benchmarks'],
    fallback_ok: true,
    refusal_key: 'no_salary_data',
  },
  {
    intent: 'career_path',
    patterns: ['career', 'path', 'move into', 'transition', 'switch', 'next role', 'progression'],
    requires: ['user_profile', 'job_matches'],
    fallback_ok: false,
  },
  {
    intent: 'skill_gap',
    patterns: ['skill', 'learn', 'missing', 'gap', 'need to know', 'upskill', 'improve'],
    requires: ['skill_gaps'],
    fallback_ok: false,
    refusal_key: 'no_skill_data',
  },
  {
    intent: 'opportunity',
    patterns: ['opportunity', 'emerging', 'growth', 'future', 'trending', 'in demand'],
    requires: ['opportunity_radar'],
    fallback_ok: true,
    refusal_key: 'no_opportunity_data',
  },
  {
    intent: 'risk',
    patterns: ['risk', 'safe', 'stable', 'automation', 'threat', 'vulnerable', 'worried'],
    requires: ['risk_analysis'],
    fallback_ok: false,
  },
  {
    intent: 'health',
    patterns: ['score', 'chi', 'health', 'readiness', 'how ready', 'career health'],
    requires: ['chi_score'],
    fallback_ok: false,
  },
];

const HALLUCINATION_PATTERNS = [
  /₹\s*[\d,]+\s*(?:lpa|lakhs?|per annum|annually)/i,
  /\$\s*[\d,]+\s*(?:per year|annually|a year)/i,
  /\d+\s*(?:lpa|lakhs per annum)/i,
  /\d+%\s+(?:of companies|of employers|of professionals|of job seekers)/i,
  /studies show|research indicates|according to reports/i,
  /industry average is|market average is/i,
  /(?:companies like|firms like|employers like)\s+[A-Z][a-z]+/,
  /(?:guaranteed|certain|definitely will|will definitely)/i,
  /within \d+ (?:months?|years?) you (?:will|can) earn/i,
];

const REFUSAL_MESSAGES = {
  no_profile: `I don't have enough information about your profile yet to provide personalised career advice. \n\nTo get started, please:\n1. Complete your profile (target role, skills, experience)\n2. Upload your CV for analysis\n3. Browse job listings to build your interest profile\n\nOnce your data is available, I can give you grounded, specific advice based on your actual career situation.`,
  no_skill_data: `I can't see your skill analysis data yet. To answer this question accurately, please:\n• Upload your CV so the Skill Analysis Engine can process it\n• Or manually add your skills in your profile\n\nI won't guess at your skill gaps — my answers are based only on your real data.`,
  no_salary_data: `I don't have salary benchmark data for your target role yet. \n\nThe platform collects salary data from verified job postings. Try:\n• Checking the Salary Intelligence section directly\n• Specifying a more common role title in your profile\n\nI won't invent salary figures.`,
  no_opportunity_data: `Opportunity Radar data is still loading for your profile. \n\nThis typically updates within a few minutes after your CV is processed. Meanwhile, you can:\n• Check the Opportunity Radar dashboard directly\n• Ask me about your current skill gaps or job matches instead`,
  insufficient_data: `I don't have enough platform data about your profile to answer this confidently.\n\nAvailable data: {sources}\nMissing data: {missing}\n\nPlease complete your profile and upload your CV. Once the platform has analysed your data, I can give you grounded, specific career advice.`,
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSources(ragContext) {
  return asArray(ragContext?.data_sources_used).filter(Boolean);
}

function detectIntent(userQuery = '') {
  const query = String(userQuery).toLowerCase();

  for (const config of INTENT_PATTERNS) {
    if (config.patterns.some(pattern => query.includes(pattern))) {
      return config;
    }
  }

  return null;
}

function getMissingSources(ragContext) {
  if (!ragContext || typeof ragContext !== 'object') return ['all sources'];

  return Object.keys(ragContext).filter(
    key => !METADATA_KEYS.has(key) && ragContext[key] == null,
  );
}

function preFlightCheck(ragContext, userQuery) {
  const availableSources = normalizeSources(ragContext);

  if (!ragContext || Number(ragContext.data_completeness || 0) < MIN_COMPLETENESS) {
    if (!ragContext?.user_profile) {
      return {
        allowed: false,
        refusalMessage: REFUSAL_MESSAGES.no_profile,
        intent: 'no_data',
        warningFlags: [],
      };
    }

    return {
      allowed: false,
      refusalMessage: REFUSAL_MESSAGES.insufficient_data
        .replace('{sources}', availableSources.join(', ') || 'none')
        .replace('{missing}', getMissingSources(ragContext).join(', ')),
      intent: 'insufficient_data',
      warningFlags: [],
    };
  }

  const intentConfig = detectIntent(userQuery);
  if (!intentConfig) {
    return { allowed: true, intent: 'general', warningFlags: [] };
  }

  const missingRequired = intentConfig.requires.filter(
    source => !availableSources.includes(source),
  );

  if (missingRequired.length && !intentConfig.fallback_ok) {
    logger.info('[GroundingGuard] Pre-flight refused', {
      intent: intentConfig.intent,
      missingRequired,
    });

    return {
      allowed: false,
      refusalMessage:
        REFUSAL_MESSAGES[intentConfig.refusal_key] ||
        REFUSAL_MESSAGES.insufficient_data
          .replace('{sources}', availableSources.join(', ') || 'none')
          .replace('{missing}', missingRequired.join(', ')),
      intent: intentConfig.intent,
      warningFlags: [],
    };
  }

  return {
    allowed: true,
    intent: intentConfig.intent,
    warningFlags: missingRequired.length
      ? [`${intentConfig.intent}_data_partial`]
      : [],
  };
}

function postFlightScan(response, ragContext) {
  const text = typeof response === 'string' ? response : '';
  if (!text) {
    return { cleanedResponse: '', violations: [], wasModified: false };
  }

  const violations = [];
  const hasSalaryData = !!ragContext?.salary_benchmarks;
  const hasJobSalary = asArray(ragContext?.job_matches?.top_matches).some(
    job => job?.salary?.min || job?.salary?.max,
  );

  if (!hasSalaryData && !hasJobSalary) {
    const salaryPattern = /₹\s*[\d.,]+\s*(?:L|lakh|LPA|lpa)/gi;
    if (text.match(salaryPattern)) {
      violations.push('salary_figures_without_data');
      logger.warn('[GroundingGuard] Salary hallucination detected');
    }
  }

  if (HALLUCINATION_PATTERNS.some(pattern => pattern.test(text))) {
    violations.push('ungrounded_claim_pattern');
  }

  if (!violations.length) {
    return { cleanedResponse: text, violations: [], wasModified: false };
  }

  return {
    cleanedResponse:
      `${text}\n\n---\n⚠️ *Note: Some statements above may be general guidance rather than data from your specific profile. For verified figures, check your platform dashboards directly.*`,
    violations,
    wasModified: true,
  };
}

function buildGroundingInstructions(availableSources = []) {
  const sources = asArray(availableSources).filter(Boolean).join(', ') || 'none';

  return `## Grounding Rules (MUST FOLLOW)\n\nYou are the Career Copilot for the HireRise platform. You assist job seekers with career decisions.\n\nCRITICAL: You may ONLY base your answers on the structured platform data provided in the CONTEXT section below. You must NOT:\n1. Invent, estimate, or assume salary figures not present in the context\n2. Reference companies, statistics, or studies not present in the context\n3. Make predictions with specific numbers unless those numbers are in the context\n4. Say \"typically\" or \"on average\" without a source from the context\n5. Provide career advice that contradicts the retrieved job matches or opportunity scores\n6. Claim a skill is \"in demand\" unless the skill gap or opportunity data says so\n7. Give salary ranges unless they appear explicitly in the Salary Benchmarks or Job Matches sections\n\nAvailable data sources for this response: ${sources}`;
}

function calculateResponseConfidence(ragContext, intent, dataSources) {
  const sources = asArray(dataSources).filter(Boolean);
  let confidence = Number(ragContext?.confidence_score || 0);

  const intentConfig = INTENT_PATTERNS.find(item => item.intent === intent);
  if (intentConfig && intentConfig.requires.every(req => sources.includes(req))) {
    confidence = Math.min(1, confidence + 0.15);
  }

  if (sources.length < 2) confidence = Math.min(confidence, 0.4);
  if (!sources.length) confidence = 0.1;

  confidence = Math.max(confidence, MIN_CONFIDENCE * 0.5);
  return Math.round(confidence * 1000) / 1000;
}

module.exports = {
  preFlightCheck,
  postFlightScan,
  buildGroundingInstructions,
  calculateResponseConfidence,
  MIN_COMPLETENESS,
  MIN_CONFIDENCE,
  REFUSAL_MESSAGES,
};