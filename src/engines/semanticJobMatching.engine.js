'use strict';

/**
 * semanticJobMatching.engine.js — Semantic Job Matching Engine
 *
 * UPGRADE 2 — extends JobMatchingEngine with vector-based semantic scoring.
 *
 * Replaces pure keyword overlap with cosine similarity between:
 *   - User's combined skill vector (centroid of all skill embeddings)
 *   - Job's combined vector (title + description + required skills)
 *
 * Final scoring formula:
 *   final_score = 0.6 × semantic_similarity
 *               + 0.2 × experience_match
 *               + 0.1 × industry_match
 *               + 0.1 × location_match
 *
 * This engine is called by the existing jobMatchingEngine.service.js
 * when FEATURE_SEMANTIC_MATCHING=true. It does NOT replace the original
 * engine — it wraps it and enriches its output.
 *
 * @module src/engines/semanticJobMatching.engine
 */

const cacheManager         = require('../core/cache/cache.manager');
const supabase             = require('../core/supabaseClient');
const logger               = require('../utils/logger');
const semanticSkillEngine  = require('./semanticSkill.engine');

// ─── Config ───────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 600;   // 10 minutes

// Scoring weights — must sum to 1.0
const WEIGHTS = Object.freeze({
  semantic:    0.60,
  experience:  0.20,
  industry:    0.10,
  location:    0.10,
});

const cache = cacheManager.getClient();

// ─── OpenAI client (lazy) ─────────────────────────────────────────────────────

let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  const OpenAI = require('openai');
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ─── Cache wrapper ────────────────────────────────────────────────────────────

async function _cached(key, ttl, fn) {
  try {
    const hit = await cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (_) {}

  const result = await fn();

  try {
    await cache.set(key, JSON.stringify(result), 'EX', ttl);
  } catch (_) {}

  return result;
}

// ─── Cosine similarity (pure JS fallback when not using pgvector) ─────────────

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── generateJobEmbedding ─────────────────────────────────────────────────────

/**
 * Generate and persist a combined embedding vector for a job listing.
 *
 * The embedding input is constructed from:
 *   "<title>. <description (first 1000 chars)>. Required skills: <skill, skill, ...>"
 *
 * @param {{ id: string, title: string, description?: string, skills?: string[], company?: string, location?: string }} job
 * @returns {Promise<{ job_id: string, embedding_vector: number[] }>}
 */
async function generateJobEmbedding(job) {
  const { id: jobId, title, description = '', skills = [], company = '', location = '' } = job;

  if (!jobId || !title) {
    throw new Error('generateJobEmbedding: job must have id and title');
  }

  const cacheKey = `semantic:job:embed:${jobId}`;

  // Redis fast path
  try {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (_) {}

  // Check DB
  const { data: existing } = await supabase
    .from('job_embeddings')
    .select('job_id, embedding_vector')
    .eq('job_id', jobId)
    .maybeSingle();

  if (existing) {
    try { await cache.set(cacheKey, JSON.stringify(existing), 'EX', CACHE_TTL_SECONDS); } catch (_) {}
    return existing;
  }

  // Build embedding input text
  const skillsText = skills.length > 0
    ? `Required skills: ${skills.slice(0, 20).join(', ')}.`
    : '';
  const embeddingInput = [
    title,
    description.slice(0, 1000),
    skillsText,
  ].filter(Boolean).join(' ');

  logger.info('[SemanticJobMatching] generating job embedding', { jobId, title });

  const openai = getOpenAI();
  const res    = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: embeddingInput.slice(0, 8000),
  });
  const vector = res.data[0].embedding;

  // Upsert
  const row = {
    job_id:           jobId,
    embedding_vector: vector,
    job_title:        title,
    company:          company || null,
    location:         location || null,
    skills_snapshot:  skills,
  };

  const { error } = await supabase
    .from('job_embeddings')
    .upsert(row, { onConflict: 'job_id' });

  if (error) {
    logger.error('[SemanticJobMatching] job embedding upsert failed', { jobId, error: error.message });
    throw new Error(`Failed to store job embedding: ${error.message}`);
  }

  const result = { job_id: jobId, embedding_vector: vector };
  try { await cache.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS); } catch (_) {}

  return result;
}

// ─── calculateSemanticMatch ───────────────────────────────────────────────────

/**
 * Calculate semantic match score between a user profile and a single job.
 *
 * @param {{ user_id: string, skills: string[], yearsExperience?: number, industry?: string, location?: string }} userProfile
 * @param {{ id: string, title: string, description?: string, skills?: string[], company?: string, location?: string, yearsRequired?: number, industry?: string }} job
 * @returns {Promise<{ semantic_score: number, final_score: number, breakdown: object, missing_skills: string[] }>}
 */
async function calculateSemanticMatch(userProfile, job) {
  const { userId, skills: userSkills = [], yearsExperience = 0, industry: userIndustry = '', location: userLocation = '' } = userProfile;
  const { id: jobId, skills: jobSkills = [], yearsRequired = 0, industry: jobIndustry = '', location: jobLocation = '' } = job;

  const cacheKey = `semantic:match:${userId}:${jobId}`;

  return _cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    // 1. Get user vector (centroid of skill embeddings)
    let userVector;
    try {
      userVector = await semanticSkillEngine.getUserSkillVector(userSkills);
    } catch (err) {
      logger.warn('[SemanticJobMatching] could not get user vector, falling back to 0', { err: err.message });
      return _zeroScoreResult(job, userSkills, jobSkills);
    }

    // 2. Get job vector
    let jobEmbed;
    try {
      jobEmbed = await generateJobEmbedding(job);
    } catch (err) {
      logger.warn('[SemanticJobMatching] could not get job vector, falling back to 0', { err: err.message });
      return _zeroScoreResult(job, userSkills, jobSkills);
    }

    // 3. Cosine similarity → semantic score (0–100)
    const rawSimilarity  = cosineSimilarity(userVector, jobEmbed.embedding_vector);
    const semanticScore  = Math.round(Math.max(0, Math.min(100, rawSimilarity * 100)));

    // 4. Experience match (0–100)
    let experienceScore = 100;
    if (yearsRequired > 0) {
      if (yearsExperience >= yearsRequired) {
        experienceScore = 100;
      } else {
        const ratio = yearsExperience / yearsRequired;
        experienceScore = Math.round(ratio * 100);
      }
    }

    // 5. Industry match (0 or 100 — binary for now)
    const industryScore = _fuzzyMatch(userIndustry, jobIndustry) ? 100 : 30;

    // 6. Location match
    const locationScore = _fuzzyMatch(userLocation, jobLocation) ? 100 : 50; // remote-first assumption

    // 7. Weighted final score
    const finalScore = Math.round(
      WEIGHTS.semantic    * semanticScore   +
      WEIGHTS.experience  * experienceScore +
      WEIGHTS.industry    * industryScore   +
      WEIGHTS.location    * locationScore
    );

    // 8. Missing skills
    const userSkillsNorm = new Set(userSkills.map(s => s.toLowerCase().trim()));
    const missingSkills  = jobSkills.filter(s => !userSkillsNorm.has(s.toLowerCase().trim()));

    const result = {
      semantic_score:   semanticScore,
      final_score:      Math.min(99, finalScore),  // cap at 99 — 100 reserved for perfect
      breakdown: {
        semantic:    semanticScore,
        experience:  experienceScore,
        industry:    industryScore,
        location:    locationScore,
      },
      missing_skills: missingSkills,
    };

    // Persist to Supabase semantic_match_cache for analytics
    supabase.from('semantic_match_cache').upsert({
      user_id:         userId,
      job_id:          jobId,
      semantic_score:  semanticScore,
      final_score:     result.final_score,
      score_breakdown: result.breakdown,
      missing_skills:  missingSkills,
    }, { onConflict: 'user_id,job_id' }).then(() => {}).catch(() => {});

    return result;
  });
}

// ─── getSemanticJobRecommendations ────────────────────────────────────────────

/**
 * Return top-N semantically matched jobs for a user profile.
 *
 * Fetches candidate jobs from Supabase (or passes them in), scores each,
 * sorts descending by final_score, filters by minScore.
 *
 * @param {object} userProfile
 * @param {object[]} candidateJobs  — array of job objects
 * @param {{ topN?: number, minScore?: number }} opts
 * @returns {Promise<{ recommended_jobs: object[] }>}
 */
async function getSemanticJobRecommendations(userProfile, candidateJobs, opts = {}) {
  const { topN = 10, minScore = 30 } = opts;
  const cacheKey = `semantic:recommendations:${userProfile.userId}:${topN}:${minScore}`;

  return _cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    if (!candidateJobs || candidateJobs.length === 0) {
      return { recommended_jobs: [] };
    }

    // Score all candidates in parallel (capped at 20 concurrent)
    const BATCH = 20;
    const scored = [];

    for (let i = 0; i < candidateJobs.length; i += BATCH) {
      const chunk = candidateJobs.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        chunk.map(job => calculateSemanticMatch(userProfile, job))
      );

      results.forEach((res, idx) => {
        if (res.status === 'fulfilled') {
          const job = chunk[idx];
          scored.push({
            title:           job.title,
            company:         job.company || null,
            location:        job.location || null,
            match_score:     res.value.final_score,
            semantic_score:  res.value.semantic_score,
            missing_skills:  res.value.missing_skills,
            breakdown:       res.value.breakdown,
            job_id:          job.id,
          });
        }
      });
    }

    const recommended = scored
      .filter(j => j.match_score >= minScore)
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, topN);

    return { recommended_jobs: recommended };
  });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _fuzzyMatch(a = '', b = '') {
  if (!a || !b) return false;
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  return na === nb || na.includes(nb) || nb.includes(na);
}

function _zeroScoreResult(job, userSkills, jobSkills) {
  const userSkillsNorm = new Set(userSkills.map(s => s.toLowerCase().trim()));
  return {
    semantic_score:  0,
    final_score:     0,
    breakdown:       { semantic: 0, experience: 0, industry: 0, location: 0 },
    missing_skills:  jobSkills.filter(s => !userSkillsNorm.has(s.toLowerCase().trim())),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generateJobEmbedding,
  calculateSemanticMatch,
  getSemanticJobRecommendations,
  WEIGHTS,
};









