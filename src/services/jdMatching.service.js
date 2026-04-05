'use strict';

/**
 * @file src/services/jdMatching.service.js
 * @description
 * JD ↔ profile keyword matching service.
 *
 * Optimized for:
 * - stable cache keys
 * - bounded in-memory cache
 * - lower stem recomputation
 * - deterministic keyword extraction
 * - Supabase-safe analytics logging
 */

const natural = require('natural');
const { removeStopwords, eng } = require('stopword');
const { supabase } = require('../config/supabase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const tokenizer = new natural.WordTokenizer();
const stemmer = natural.PorterStemmer;
const TfIdf = natural.TfIdf;

const MAX_JD_LENGTH = 10000;
const MAX_CACHE_SIZE = 500;

// lightweight bounded cache
const cache = new Map();

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function normalizeText(text) {
  return String(text || '')
    .slice(0, MAX_JD_LENGTH)
    .toLowerCase()
    .trim();
}

function normalizeTerm(term) {
  return String(term || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function getCacheKey(rawJobDescription, skills) {
  const normalizedSkills = [...new Set(
    skills
      .map((s) =>
        typeof s === 'string'
          ? normalizeTerm(s)
          : normalizeTerm(s?.name)
      )
      .filter(Boolean)
      .sort()
  )];

  return JSON.stringify({
    jd: normalizeText(rawJobDescription).slice(0, 300),
    skills: normalizedSkills,
  });
}

function boundedCacheSet(key, value) {
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) {
      cache.delete(firstKey);
    }
  }

  cache.set(key, value);
}

function getMatchCategory(score) {
  if (score >= 80) return 'excellent_match';
  if (score >= 60) return 'good_match';
  return 'low_match';
}

// ─────────────────────────────────────────────────────────────
// Keyword Extraction
// ─────────────────────────────────────────────────────────────
function extractKeywordsFromJD(rawText) {
  const normalizedText = normalizeText(rawText);
  const extracted = new Set();

  const tokens = tokenizer.tokenize(normalizedText) || [];

  const cleanTokens = removeStopwords(tokens, eng)
    .filter((token) => token.length > 2)
    .filter((token) => !/^\d+$/.test(token));

  if (!cleanTokens.length) {
    return [];
  }

  const tfidf = new TfIdf();
  tfidf.addDocument(cleanTokens.join(' '));

  tfidf
    .listTerms(0)
    .slice(0, 60)
    .forEach((term) => {
      if (term.tfidf > 0.1) {
        extracted.add(term.term);
      }
    });

  return [...extracted];
}

// ─────────────────────────────────────────────────────────────
// Match Logic
// ─────────────────────────────────────────────────────────────
function buildSkillMatchers(skills) {
  return skills
    .map((skill) =>
      typeof skill === 'string'
        ? skill
        : skill?.name
    )
    .filter(Boolean)
    .map((skill) => {
      const normalized = normalizeTerm(skill);
      return {
        raw: normalized,
        stem: stemmer.stem(normalized),
      };
    });
}

function termMatchesUserSkill(jdTerm, skillMatchers) {
  const jd = normalizeTerm(jdTerm);

  if (!jd) return false;

  const jdStem = stemmer.stem(jd);

  return skillMatchers.some((skill) => {
    if (!skill.raw) return false;

    return (
      jd === skill.raw ||
      jdStem === skill.stem ||
      skill.raw.includes(jd) ||
      jd.includes(skill.raw)
    );
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
async function matchJD({
  userProfile,
  rawJobDescription,
}) {
  const start = Date.now();

  const safeJD = normalizeText(rawJobDescription);

  if (!safeJD || safeJD.length < 50) {
    throw new AppError(
      'JD too short',
      422,
      null,
      ErrorCodes.JD_PARSE_FAILED
    );
  }

  if (
    !userProfile ||
    !Array.isArray(userProfile.skills)
  ) {
    throw new AppError(
      'Invalid user profile',
      422,
      null,
      ErrorCodes.INSUFFICIENT_PROFILE
    );
  }

  const cacheKey = getCacheKey(
    safeJD,
    userProfile.skills
  );

  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const jdKeywords = extractKeywordsFromJD(safeJD);
    const skillMatchers = buildSkillMatchers(
      userProfile.skills
    );

    const matched = [];
    const missing = [];

    for (const keyword of jdKeywords) {
      if (termMatchesUserSkill(keyword, skillMatchers)) {
        matched.push(keyword);
      } else {
        missing.push(keyword);
      }
    }

    const keywordScore = jdKeywords.length
      ? Math.round(
          (matched.length / jdKeywords.length) * 100
        )
      : 50;

    const result = {
      matchScore: keywordScore,
      matchCategory: getMatchCategory(keywordScore),
      matchedKeywords: matched.slice(0, 30),
      missingKeywords: missing.slice(0, 30),
      summary: `Match score: ${keywordScore}%`,
    };

    boundedCacheSet(cacheKey, result);

    // non-blocking analytics
    void supabase
      .from('jd_analysis_logs')
      .insert({
        match_score: result.matchScore,
        skills_count: skillMatchers.length,
        created_at: new Date().toISOString(),
      })
      .then(({ error }) => {
        if (error) {
          logger.warn('[JDMatching] analytics log failed', {
            error: error.message,
          });
        }
      })
      .catch((error) => {
        logger.warn('[JDMatching] analytics unexpected failure', {
          error: error?.message || 'Unknown analytics error',
        });
      });

    logger.info('[JDMatching] completed', {
      score: keywordScore,
      time_ms: Date.now() - start,
      keywords: jdKeywords.length,
    });

    return result;
  } catch (err) {
    logger.error('[JDMatching] failed', {
      error: err?.message || 'Unknown matching error',
    });

    throw err;
  }
}

module.exports = {
  matchJD,
};