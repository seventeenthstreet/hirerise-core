/**
 * jdMatching.service.js — Job Description Matching Engine
 *
 * This service compares a user's profile against raw job description text.
 * It uses lightweight NLP (no external API required) to:
 *   1. Extract keywords and skill signals from raw JD text
 *   2. Normalize and deduplicate extracted terms
 *   3. Compare against user's skills, experience, and education
 *   4. Score match quality and surface missing keywords
 *   5. Generate actionable improvement suggestions
 *
 * NLP stack: 'natural' library (TF-IDF + tokenization) + stopword removal
 *
 * Scalability note:
 *   The NLP processing is CPU-bound. At high volume, this service should
 *   be extracted into a worker thread or dedicated microservice.
 *   Consider Bull/BullMQ queue for async JD analysis requests.
 *
 *   For production accuracy, replace keyword extraction with a fine-tuned
 *   skill extraction model (e.g., trained on ESCO taxonomy) or a dedicated
 *   NER API (e.g., Skill Extractor by LightCast/EMSI).
 */

'use strict';

const natural          = require('natural');
const { removeStopwords, eng } = require('stopword');
const { db }           = require('../config/supabase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger           = require('../utils/logger');

// ── NLP tools ────────────────────────────────────────────────────────────────
const tokenizer = new natural.WordTokenizer();
const stemmer   = natural.PorterStemmer;
const TfIdf     = natural.TfIdf;

// ── Curated skill signal patterns (augment via Firestore in Phase 2) ──────────
// These regex-testable patterns catch compound skills and frameworks that
// single-word tokenization would split incorrectly.
const COMPOUND_SKILL_PATTERNS = [
  /node\.?js/gi, /react\.?js/gi, /vue\.?js/gi, /next\.?js/gi,
  /rest[\s-]?api/gi, /graphql/gi, /ci[\s/]?cd/gi, /aws[\s-]?lambda/gi,
  /machine[\s-]?learning/gi, /deep[\s-]?learning/gi, /natural[\s-]?language/gi,
  /data[\s-]?engineering/gi, /system[\s-]?design/gi, /micro[\s-]?services/gi,
  /object[\s-]?oriented/gi, /test[\s-]?driven/gi, /agile[\s-]?scrum/gi,
  /kubernetes/gi, /docker/gi, /terraform/gi, /elasticsearch/gi,
  /postgresql/gi, /mongodb/gi, /redis/gi,
];

// ── Education level ordinal ───────────────────────────────────────────────────
const EDUCATION_ORDINAL = {
  high_school:  1,
  diploma:      2,
  bachelors:    3,
  masters:      4,
  phd:          5,
  mba:          4,
};

// ─────────────────────────────────────────────────────────────────────────────
//  Internal: Extract skill signals from raw JD text
// ─────────────────────────────────────────────────────────────────────────────
const extractKeywordsFromJD = (rawText) => {
  const normalizedText = rawText.toLowerCase();
  const extracted      = new Set();

  // 1. Extract compound skill patterns first (before tokenization breaks them)
  COMPOUND_SKILL_PATTERNS.forEach(pattern => {
    const matches = normalizedText.match(pattern);
    if (matches) {
      matches.forEach(m => extracted.add(m.replace(/\s+/g, ' ').trim()));
    }
  });

  // 2. Tokenize + remove stopwords + remove short tokens
  const tokens = tokenizer.tokenize(normalizedText) || [];
  const cleanTokens = removeStopwords(tokens, eng)
    .filter(t => t.length > 2)
    .filter(t => !/^\d+$/.test(t)); // Remove pure numbers

  // 3. Use TF-IDF to find high-signal terms in the JD
  const tfidf = new TfIdf();
  tfidf.addDocument(cleanTokens.join(' '));

  const tfidfTerms = [];
  tfidf.listTerms(0).forEach(term => {
    if (term.tfidf > 0.1) tfidfTerms.push(term.term);
  });

  // Combine compound skills with high-signal tokens
  tfidfTerms.slice(0, 60).forEach(t => extracted.add(t));

  return Array.from(extracted);
};

// ─────────────────────────────────────────────────────────────────────────────
//  Internal: Normalize a term for comparison
// ─────────────────────────────────────────────────────────────────────────────
const normalizeTerm = (term) =>
  term.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

// ─────────────────────────────────────────────────────────────────────────────
//  Internal: Check if a JD keyword matches a user skill
// ─────────────────────────────────────────────────────────────────────────────
const termMatchesUserSkill = (jdTerm, userSkillNames) => {
  const normalizedJdTerm = normalizeTerm(jdTerm);
  const jdStem           = stemmer.stem(normalizedJdTerm);

  return userSkillNames.some(skillName => {
    const normalizedSkill = normalizeTerm(skillName);
    const skillStem       = stemmer.stem(normalizedSkill);

    // Exact match, stem match, or substring match for compound skills
    return (
      normalizedJdTerm === normalizedSkill ||
      jdStem           === skillStem       ||
      normalizedSkill.includes(normalizedJdTerm) ||
      normalizedJdTerm.includes(normalizedSkill)
    );
  });
};

// ─────────────────────────────────────────────────────────────────────────────
//  Internal: Score experience match
//  Returns 0.0 – 1.0
// ─────────────────────────────────────────────────────────────────────────────
const scoreExperienceMatch = (userExperience, jdRequiredYears) => {
  if (!jdRequiredYears || jdRequiredYears <= 0) return 1.0; // Not specified = full match
  if (userExperience >= jdRequiredYears) return 1.0;
  if (userExperience >= jdRequiredYears * 0.75) return 0.7; // Close enough
  if (userExperience >= jdRequiredYears * 0.5) return 0.4;
  return 0.1;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Internal: Extract minimum years from JD text heuristically
// ─────────────────────────────────────────────────────────────────────────────
const extractRequiredYears = (text) => {
  const patterns = [
    /(\d+)\+?\s*years?\s*of\s*(relevant\s*)?experience/i,
    /minimum\s*(\d+)\s*years?/i,
    /(\d+)[-–](\d+)\s*years?\s*of\s*experience/i,
    /experience[:\s]+(\d+)\+?\s*years?/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  return null; // Could not determine
};

// ─────────────────────────────────────────────────────────────────────────────
//  Internal: Extract education requirement from JD text
// ─────────────────────────────────────────────────────────────────────────────
const extractEducationRequirement = (text) => {
  const lower = text.toLowerCase();
  if (/ph\.?d|doctorate/i.test(lower))    return 'phd';
  if (/m\.?b\.?a/i.test(lower))           return 'mba';
  if (/master'?s?|m\.?tech|m\.?e\.|msc/i.test(lower)) return 'masters';
  if (/bachelor'?s?|b\.?tech|b\.?e\.|bsc|b\.?sc|degree/i.test(lower)) return 'bachelors';
  if (/diploma/i.test(lower))             return 'diploma';
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Internal: Generate improvement suggestions
// ─────────────────────────────────────────────────────────────────────────────
const generateImprovementSuggestions = ({
  missingKeywords,
  experienceGap,
  educationGap,
  matchScore,
}) => {
  const suggestions = [];

  // Skill suggestions
  const criticalMissing = missingKeywords.slice(0, 5);
  if (criticalMissing.length > 0) {
    suggestions.push({
      type:     'skill',
      priority: 'high',
      action:   `Add these skills to your profile and resume: ${criticalMissing.join(', ')}`,
      impact:   `Could improve match score by ~${Math.round(criticalMissing.length * 4)}%`,
    });
  }

  // Experience suggestions
  if (experienceGap > 0) {
    suggestions.push({
      type:     'experience',
      priority: experienceGap >= 2 ? 'high' : 'medium',
      action:   `The role requires ${experienceGap} more year(s) of experience than you have. Consider roles at your current experience level first.`,
      impact:   'Targeting roles where you meet the experience requirement will increase response rates.',
    });
  }

  // Education suggestions
  if (educationGap) {
    suggestions.push({
      type:     'education',
      priority: 'low',
      action:   `The role may prefer ${educationGap} qualification. Online certifications can sometimes substitute.`,
      impact:   'Education requirements are often flexible for candidates with strong experience.',
    });
  }

  // Resume keyword optimization
  if (matchScore < 70) {
    suggestions.push({
      type:     'resume_keywords',
      priority: 'medium',
      action:   'Mirror the JD language in your resume and LinkedIn profile headline. Use exact terminology from the job posting.',
      impact:   'ATS systems score resumes by keyword density — matching JD language improves shortlisting probability.',
    });
  }

  if (matchScore >= 80) {
    suggestions.push({
      type:     'application',
      priority: 'low',
      action:   'You are a strong match for this role. Prioritize personalizing your cover letter to highlight your top 3 matching skills.',
      impact:   'Strong keyword match + personalized cover letter significantly improves interview conversion.',
    });
  }

  return suggestions;
};

// ═════════════════════════════════════════════════════════════════════════════
//  PUBLIC: matchJD
// ═════════════════════════════════════════════════════════════════════════════
/**
 * @param {object} params
 * @param {object} params.userProfile
 * @param {string[]]} params.userProfile.skills           - Skill name strings
 * @param {number}   params.userProfile.totalExperience   - Total years
 * @param {string}   params.userProfile.educationLevel    - 'bachelors' | 'masters' | etc.
 * @param {string}   params.rawJobDescription             - Raw JD text
 *
 * @returns {Promise<{
 *   matchScore: number,
 *   matchCategory: string,
 *   matchedKeywords: string[],
 *   missingKeywords: string[],
 *   experienceAnalysis: object,
 *   educationAnalysis: object,
 *   improvements: object[],
 *   summary: string,
 * }>}
 */
const matchJD = async ({ userProfile, rawJobDescription }) => {
  if (!rawJobDescription || rawJobDescription.trim().length < 50) {
    throw new AppError(
      'Job description text is too short to analyze (minimum 50 characters)',
      422,
      null,
      ErrorCodes.JD_PARSE_FAILED
    );
  }

  if (!userProfile || !Array.isArray(userProfile.skills)) {
    throw new AppError(
      'User profile with skills array is required for JD matching',
      422,
      null,
      ErrorCodes.INSUFFICIENT_PROFILE
    );
  }

  logger.debug('[JDMatchingService] matchJD start', {
    jdLength:   rawJobDescription.length,
    skillCount: userProfile.skills.length,
  });

  // ── 1. Extract keywords from JD ───────────────────────────────────────────
  const jdKeywords = extractKeywordsFromJD(rawJobDescription);

  // ── 2. Normalize user skill names ─────────────────────────────────────────
  const userSkillNames = userProfile.skills.map(s =>
    typeof s === 'string' ? s : s.name
  );

  // ── 3. Match JD keywords against user skills ─────────────────────────────
  const matchedKeywords = [];
  const missingKeywords = [];

  jdKeywords.forEach(kw => {
    if (termMatchesUserSkill(kw, userSkillNames)) {
      matchedKeywords.push(kw);
    } else {
      missingKeywords.push(kw);
    }
  });

  // ── 4. Compute keyword match score ────────────────────────────────────────
  const keywordMatchScore = jdKeywords.length > 0
    ? Math.round((matchedKeywords.length / jdKeywords.length) * 100)
    : 50;

  // ── 5. Experience analysis ────────────────────────────────────────────────
  const requiredYears    = extractRequiredYears(rawJobDescription);
  const userExp          = userProfile.totalExperience || 0;
  const experienceScore  = scoreExperienceMatch(userExp, requiredYears);
  const experienceGap    = requiredYears ? Math.max(0, requiredYears - userExp) : 0;

  const experienceAnalysis = {
    requiredYears:    requiredYears,
    userYears:        userExp,
    gap:              experienceGap,
    meets:            experienceGap === 0,
    matchScore:       Math.round(experienceScore * 100),
  };

  // ── 6. Education analysis ─────────────────────────────────────────────────
  const requiredEducation = extractEducationRequirement(rawJobDescription);
  const userEducation     = userProfile.educationLevel || null;
  let educationScore      = 1.0;
  let educationGapNote    = null;

  if (requiredEducation && userEducation) {
    const userEduOrd = EDUCATION_ORDINAL[userEducation]     || 3;
    const reqEduOrd  = EDUCATION_ORDINAL[requiredEducation] || 3;
    if (userEduOrd < reqEduOrd) {
      educationScore   = 0.8;
      educationGapNote = requiredEducation;
    }
  }

  const educationAnalysis = {
    required: requiredEducation,
    user:     userEducation,
    meets:    educationScore === 1.0,
  };

  // ── 7. Composite match score ──────────────────────────────────────────────
  // Weights: keywords 60%, experience 30%, education 10%
  const compositeScore = Math.round(
    (keywordMatchScore * 0.60) +
    (experienceAnalysis.matchScore * 0.30) +
    (educationScore * 100 * 0.10)
  );

  const matchCategory =
    compositeScore >= 80 ? 'excellent_match' :
    compositeScore >= 65 ? 'good_match' :
    compositeScore >= 45 ? 'partial_match' :
    'low_match';

  // ── 8. Improvement suggestions ────────────────────────────────────────────
  const improvements = generateImprovementSuggestions({
    missingKeywords: missingKeywords.slice(0, 20),
    experienceGap,
    educationGap: educationGapNote,
    matchScore:   compositeScore,
  });

  const summary = `Your profile is a ${matchCategory.replace(/_/g, ' ')} for this role with a ${compositeScore}% match score. ` +
    (missingKeywords.length > 0
      ? `Add ${Math.min(5, missingKeywords.length)} key skill(s) to improve your candidacy.`
      : 'Your skills closely align with the requirements.');

  logger.debug('[JDMatchingService] matchJD complete', {
    compositeScore,
    matchCategory,
    keywordsFound:   jdKeywords.length,
    keywordsMatched: matchedKeywords.length,
  });

  return {
    matchScore:          compositeScore,
    matchCategory,
    keywordAnalysis: {
      totalExtracted:  jdKeywords.length,
      matched:         matchedKeywords.length,
      missing:         missingKeywords.length,
      matchScore:      keywordMatchScore,
    },
    matchedKeywords:     matchedKeywords.slice(0, 30),
    missingKeywords:     missingKeywords.slice(0, 30),
    experienceAnalysis,
    educationAnalysis,
    improvementSuggestions: improvements,
    summary,
  };
};

module.exports = { matchJD };









