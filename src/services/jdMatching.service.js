'use strict';

/**
 * jdMatching.service.js — Optimized + Supabase Ready
 *
 * ✅ Crash-safe
 * ✅ Performance-aware
 * ✅ Supabase logging ready
 * ✅ Cleaned + hardened
 */

const natural = require('natural');
const { removeStopwords, eng } = require('stopword');
const { supabase } = require('../config/supabase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const tokenizer = new natural.WordTokenizer();
const stemmer = natural.PorterStemmer;
const TfIdf = natural.TfIdf;

// Optional: in-memory cache (can replace with Redis)
const cache = new Map();

// ─────────────────────────────────────────────
// Keyword Extraction
// ─────────────────────────────────────────────
const extractKeywordsFromJD = (rawText) => {
  const normalizedText = rawText.toLowerCase();
  const extracted = new Set();

  // Tokenization
  const tokens = tokenizer.tokenize(normalizedText) || [];

  const cleanTokens = removeStopwords(tokens, eng)
    .filter(t => t.length > 2)
    .filter(t => !/^\d+$/.test(t));

  const tfidf = new TfIdf();
  tfidf.addDocument(cleanTokens.join(' '));

  tfidf.listTerms(0)
    .slice(0, 60)
    .forEach(term => {
      if (term.tfidf > 0.1) extracted.add(term.term);
    });

  return Array.from(extracted);
};

// ─────────────────────────────────────────────
// Normalize
// ─────────────────────────────────────────────
const normalizeTerm = (term) =>
  term?.toLowerCase()?.replace(/[^a-z0-9\s]/g, '').trim();

// ─────────────────────────────────────────────
// Match Logic
// ─────────────────────────────────────────────
const termMatchesUserSkill = (jdTerm, userSkillNames) => {
  const jd = normalizeTerm(jdTerm);
  if (!jd) return false;

  const jdStem = stemmer.stem(jd);

  return userSkillNames.some(skill => {
    const s = normalizeTerm(skill);
    if (!s) return false;

    const sStem = stemmer.stem(s);

    return (
      jd === s ||
      jdStem === sStem ||
      s.includes(jd) ||
      jd.includes(s)
    );
  });
};

// ─────────────────────────────────────────────
// MAIN FUNCTION
// ─────────────────────────────────────────────
const matchJD = async ({ userProfile, rawJobDescription }) => {
  const start = Date.now();

  if (!rawJobDescription || rawJobDescription.length < 50) {
    throw new AppError(
      'JD too short',
      422,
      null,
      ErrorCodes.JD_PARSE_FAILED
    );
  }

  if (!userProfile || !Array.isArray(userProfile.skills)) {
    throw new AppError(
      'Invalid user profile',
      422,
      null,
      ErrorCodes.INSUFFICIENT_PROFILE
    );
  }

  // 🔥 Cache key
  const cacheKey = JSON.stringify({
    jd: rawJobDescription.slice(0, 200),
    skills: userProfile.skills
  });

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  try {
    const jdKeywords = extractKeywordsFromJD(rawJobDescription);

    const userSkillNames = userProfile.skills
      .map(s => (typeof s === 'string' ? s : s?.name))
      .filter(Boolean);

    const matched = [];
    const missing = [];

    for (const kw of jdKeywords) {
      if (termMatchesUserSkill(kw, userSkillNames)) {
        matched.push(kw);
      } else {
        missing.push(kw);
      }
    }

    const keywordScore = jdKeywords.length
      ? Math.round((matched.length / jdKeywords.length) * 100)
      : 50;

    const result = {
      matchScore: keywordScore,
      matchCategory:
        keywordScore >= 80 ? 'excellent_match' :
        keywordScore >= 60 ? 'good_match' :
        'low_match',
      matchedKeywords: matched.slice(0, 30),
      missingKeywords: missing.slice(0, 30),
      summary: `Match score: ${keywordScore}%`,
    };

    // 🔥 Save to cache
    cache.set(cacheKey, result);

    // 🔥 Optional: store in Supabase (analytics)
    try {
      await supabase.from('jd_analysis_logs').insert({
        match_score: result.matchScore,
        skills_count: userSkillNames.length,
        created_at: new Date().toISOString()
      });
    } catch (_) {}

    logger.info('[JDMatching] completed', {
      score: keywordScore,
      timeMs: Date.now() - start
    });

    return result;

  } catch (err) {
    logger.error('[JDMatching] failed', {
      error: err.message
    });

    throw err;
  }
};

module.exports = { matchJD };