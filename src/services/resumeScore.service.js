'use strict';

/**
 * resumeScore.service.js — Supabase Version
 *
 * Production-hardened:
 * - snake_case Postgres aligned
 * - latest resume hot-path indexed
 * - deterministic scoring
 * - lock-safe cache orchestration
 * - null-safe parsed resume fallback
 */

const lockService = require('../core/infrastructure/locking/lock.utils');
const cacheManager = require('../core/cache/cache.manager');
const logger = require('../utils/logger');

const { supabase } = require('../config/supabase');

// Phase 2: lazy getter — resolves Redis post-bootstrap on each call
const getCache = () => cacheManager.getClient();

// ── CONFIG ────────────────────────────────────────────────────────────────
const CACHE_TTL_SECONDS = 300;
const LOCK_TTL_MS = 30000;
const DB_TIMEOUT_MS = 10000;

// ── WEIGHTS ───────────────────────────────────────────────────────────────
const W = {
  skills: 30,
  experience: 25,
  roleMatch: 20,
  education: 15,
  completeness: 10,
};

const EDUCATION_ORDINAL = {
  'High School': 1,
  Diploma: 2,
  "Bachelor's Degree": 3,
  'Professional Certification': 4,
  "Master's Degree": 5,
  MBA: 5,
  PhD: 6,
};

const MAX_EDU_ORDINAL = 6;

// ─────────────────────────────────────────────────────────────────────────
// SCORING FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────

function scoreSkills(skills) {
  if (!Array.isArray(skills) || skills.length === 0) {
    return 0;
  }

  const unique = new Set(
    skills.map((s) =>
      String(s)
        .toLowerCase()
        .trim()
        .replace(/[.\-_]/g, '')
    )
  ).size;

  const raw = Math.sqrt(Math.min(unique, 40)) / Math.sqrt(40);
  return Math.round(raw * W.skills);
}

function scoreExperience(yearsExperience) {
  if (yearsExperience == null) {
    return 0;
  }

  const years = Math.max(0, Number(yearsExperience) || 0);

  return Math.min(
    W.experience,
    Math.round((years / 7) * W.experience)
  );
}

function scoreRoleMatch(detectedRoles, confidenceScore) {
  const confidence = Math.min(
    100,
    Math.max(0, Number(confidenceScore) || 0)
  );

  if (!Array.isArray(detectedRoles) || detectedRoles.length === 0) {
    return Math.round(
      (confidence / 100) * W.roleMatch * 0.4
    );
  }

  const topRole = detectedRoles[0];
  const roleScore =
    typeof topRole === 'object'
      ? topRole.score || 1
      : 1;

  const blended =
    Math.min(roleScore / 5, 1) * 0.6 +
    (confidence / 100) * 0.4;

  return Math.round(blended * W.roleMatch);
}

function scoreEducation(education, educationLevel) {
  let ordinal = EDUCATION_ORDINAL[educationLevel] || 0;

  if (!ordinal && Array.isArray(education)) {
    for (const entry of education) {
      const entryStr = String(entry).toLowerCase();

      for (const [label, val] of Object.entries(
        EDUCATION_ORDINAL
      )) {
        if (
          entryStr.includes(label.toLowerCase()) &&
          val > ordinal
        ) {
          ordinal = val;
        }
      }
    }
  }

  return ordinal
    ? Math.round((ordinal / MAX_EDU_ORDINAL) * W.education)
    : 0;
}

function scoreCompleteness(profile) {
  const checks = [
    !!profile.name,
    !!profile.email,
    !!profile.phone,
    !!(
      profile.location &&
      (
        profile.location.city ||
        profile.location.country ||
        typeof profile.location === 'string'
      )
    ),
    !!(profile.linkedInUrl || profile.portfolioUrl),
  ];

  return Math.round(
    (checks.filter(Boolean).length / checks.length) *
      W.completeness
  );
}

// ─────────────────────────────────────────────────────────────────────────
// CORE COMPUTATION
// ─────────────────────────────────────────────────────────────────────────

function computeScoreFromParsedData(parsedData, userId) {
  const breakdown = {
    skills: scoreSkills(parsedData.skills),
    experience: scoreExperience(
      parsedData.yearsExperience
    ),
    roleMatch: scoreRoleMatch(
      parsedData.detectedRoles,
      parsedData.confidenceScore
    ),
    education: scoreEducation(
      parsedData.education,
      parsedData.educationLevel
    ),
    completeness: scoreCompleteness(parsedData),
  };

  const overallScore = Math.min(
    100,
    Object.values(breakdown).reduce(
      (sum, value) => sum + value,
      0
    )
  );

  // ── roleFit: experience section is the authoritative source ─────────────
  //
  // detectedRoles is a keyword-frequency scorer over the whole document and
  // routinely fires on incidental words (e.g. "accounts receivable" → Accountant).
  // It must NEVER override an actual job title from the experience section.
  //
  // Priority:
  //   1. experience[0].title   (most specific, from the structured experience block)
  //   2. experience[0].role    (alternate field name used by some parsers)
  //   3. detectedRoles[0]      ONLY when no experience section exists at all
  //   4. 'unknown'             hard fallback
  const experienceTitle =
    parsedData.experience?.[0]?.title ??
    parsedData.experience?.[0]?.role  ??
    null;

  const hasExperience = (parsedData.experience?.length ?? 0) > 0;

  let roleFit;
  if (experienceTitle) {
    // Primary: real job title from the experience section
    roleFit = String(experienceTitle).trim() || 'unknown';
  } else if (hasExperience) {
    // Experience entries exist but no title — leave as unknown rather than
    // fabricating a wrong label from keyword matching
    roleFit = 'unknown';
  } else {
    // Last resort: no experience at all — use detectedRoles keyword match
    const topRole = parsedData.detectedRoles?.[0];
    roleFit = topRole
      ? typeof topRole === 'object'
        ? topRole.canonical || topRole.role || 'unknown'
        : String(topRole)
      : 'unknown';
  }

  /* DEBUG – remove before go-live */
  if (process.env.RESUME_PARSER_DEBUG === 'true') {
    console.debug('[resumeScore] detectedRoles:', parsedData.detectedRoles);
    console.debug('[resumeScore] experience[0]:', parsedData.experience?.[0]);
    console.debug('[resumeScore] resolved roleFit:', roleFit);
  }

  return {
    isMockData: false,
    userId,
    roleFit,
    overallScore,
    breakdown,
    scoredAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// SUPABASE FETCH (PRODUCTION FIXED)
// ─────────────────────────────────────────────────────────────────────────

async function fetchLatestResume(userId) {
  const { data, error } = await supabase
    .from('resumes')
    .select('*')
    .eq('user_id', userId)
    .eq('soft_deleted', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase error: ${error.message}`);
  }

  return data || null;
}

// ─────────────────────────────────────────────────────────────────────────
// SCORING FLOW
// ─────────────────────────────────────────────────────────────────────────

async function performScoring(userId) {
  const resumeRow = await fetchLatestResume(userId);

  if (!resumeRow) {
    const err = new Error('No resume found');
    err.code = 'RESUME_NOT_FOUND';

    logger.warn('[ResumeScore] Resume missing', {
      user_id: userId,
    });

    throw err;
  }

  const parsedData =
    resumeRow.parsed_data || resumeRow.parsedData;

  if (!parsedData) {
    logger.warn('[ResumeScore] Missing parsed_data', {
      user_id: userId,
    });

    return computeScoreFromParsedData(
      {
        skills: [],
        detectedRoles: [],
        yearsExperience: null,
        education: [],
        confidenceScore: 20,
      },
      userId
    );
  }

  return computeScoreFromParsedData(parsedData, userId);
}

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────

// FIX (WP-CACHE-01): getCache() returns either the real ioredis client or
// the in-memory fallback depending on Redis availability. The real ioredis
// client only understands its native `SET key value EX seconds` syntax and
// only stores strings — it does not accept a bare numeric TTL as the 3rd
// argument (that produced "ERR syntax error" from Redis) and does not
// serialize JS objects for you. These helpers speak that dialect on every
// call; MemoryCache tolerates the same calls (it ignores the extra 'EX'
// token and falls back to its own defaultTTL, which matches
// CACHE_TTL_SECONDS here) so both backends stay correct.
function serializeCacheValue(value) {
  return JSON.stringify(value);
}

function deserializeCacheValue(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw; // already an object (MemoryCache path)
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function calculate(userId) {
  if (!userId) {
    throw new Error('userId required');
  }

  const cacheKey = `resumeScore:${userId}`;

  const cached = deserializeCacheValue(await getCache().get(cacheKey));
  if (cached) {
    return cached;
  }

  return lockService.executeWithLock(
    `lock:${userId}`,
    async () => {
      const cachedAgain = deserializeCacheValue(await getCache().get(cacheKey));
      if (cachedAgain) {
        return cachedAgain;
      }

      const result = await performScoring(userId);

      await getCache().set(
        cacheKey,
        serializeCacheValue(result),
        'EX',
        CACHE_TTL_SECONDS
      );

      return result;
    },
    LOCK_TTL_MS
  );
}

async function invalidate(userId) {
  if (!userId) {
    return;
  }

  // ioredis exposes `.del()`, not `.delete()` — MemoryCache defines both as
  // aliases, so `.del()` is the one call that works against either backend.
  await getCache().del(`resumeScore:${userId}`);
}

module.exports = {
  calculate,
  invalidate,
  computeScoreFromParsedData,
};