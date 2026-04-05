'use strict';

/**
 * similarity.service.js — Phase 2 Semantic Duplicate Detection Scaffold
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  ⚠  PHASE 2 SCAFFOLD — NOT YET IMPLEMENTED                             │
 * │                                                                          │
 * │  This file defines the architecture for AI-based semantic duplicate      │
 * │  detection using Supabase pgvector. No embeddings or vector operations   │
 * │  are active yet.                                                         │
 * │                                                                          │
 * │  Phase 1 duplicate prevention (exact normalized match) remains active.   │
 * │                                                                          │
 * │  Safe to import in production. Methods intentionally return no-op        │
 * │  results until Phase 2 rollout. Public API is stable.                   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Phase 2 Architecture Plan:
 *
 *   1. Vector Embeddings
 *      - Model : text-embedding-3-small (1536 dims)
 *      - Scope : skill names and role names
 *
 *   2. Supabase pgvector Storage
 *      - Tables  : skill_embeddings, role_embeddings
 *      - Indexes : ivfflat or hnsw via pgvector extension
 *      - Queries : nearest-neighbour via Supabase RPC or SQL function
 *      - All vector operations remain inside Supabase — no external
 *        vector store (e.g. Pinecone, Weaviate) is used.
 *
 *   3. Duplicate Suggestion (not hard rejection)
 *      - Phase 2 returns suggestions only
 *      - Phase 1 exact duplicate prevention remains blocking
 *
 *   4. Integration Point
 *      - Caller : adminCmsSkills.service.createSkill()
 *      - Called : AFTER Phase 1 exact-match validation passes
 *      - Returns: { similarEntries: [{ id, name, similarity }] }
 *
 * @module services/similarity.service
 */

const logger = require('../utils/logger');

/**
 * Frozen configuration for the similarity pipeline.
 * All thresholds and model identifiers are centralised here.
 * Do not mutate — use Object.freeze to enforce at runtime.
 *
 * @type {Readonly<{
 *   SUGGESTION_THRESHOLD:     number,
 *   HIGH_CONFIDENCE_THRESHOLD: number,
 *   TOP_K:                    number,
 *   EMBEDDING_MODEL:          string,
 *   VECTOR_STORE:             string,
 *   VECTOR_DIMS:              number,
 * }>}
 */
const SIMILARITY_CONFIG = Object.freeze({
  SUGGESTION_THRESHOLD:      0.85,
  HIGH_CONFIDENCE_THRESHOLD: 0.92,
  TOP_K:                     5,
  EMBEDDING_MODEL:           'text-embedding-3-small',
  VECTOR_STORE:              'supabase_pgvector',
  VECTOR_DIMS:               1536,
});

/**
 * Generate an embedding vector for the given text.
 * Phase 2 placeholder — throws until implemented.
 *
 * @param  {string} text - Raw input text to embed.
 * @returns {Promise<number[]>} 1536-dimension float array.
 * @throws {Error} Always throws in Phase 1 / scaffold mode.
 */
async function generateEmbedding(text) {
  const normalizedText = typeof text === 'string' ? text.trim() : '';

  logger.debug('[SimilarityService] generateEmbedding scaffold invoked', {
    hasText: Boolean(normalizedText),
    length:  normalizedText.length,
    phase:   'scaffold',
  });

  throw new Error(
    'SimilarityService.generateEmbedding: Phase 2 not yet implemented'
  );
}

/**
 * Find semantically similar entries via Supabase pgvector.
 * Phase 2 placeholder — returns empty array (safe no-op).
 *
 * Phase 2 will:
 *   1. Call generateEmbedding(name)
 *   2. Query Supabase RPC match_skill_embeddings / match_role_embeddings
 *      with the resulting vector, threshold, and topK limit
 *   3. Return mapped { id, name, similarity } rows
 *
 * @param  {object} options
 * @param  {string} options.name        - Entry name to match against.
 * @param  {string} options.datasetType - 'skills' | 'roles'
 * @param  {number} [options.topK]      - Max results (default: SIMILARITY_CONFIG.TOP_K).
 * @param  {number} [options.threshold] - Min similarity score (default: SIMILARITY_CONFIG.SUGGESTION_THRESHOLD).
 * @returns {Promise<Array<{ id: string, name: string, similarity: number }>>}
 */
async function findSimilar(options = {}) {
  const {
    name        = '',
    datasetType = 'skills',
    topK        = SIMILARITY_CONFIG.TOP_K,
    threshold   = SIMILARITY_CONFIG.SUGGESTION_THRESHOLD,
  } = options;

  logger.debug('[SimilarityService] findSimilar scaffold invoked', {
    hasName:     Boolean(name),
    datasetType,
    topK,
    threshold,
    phase: 'scaffold',
  });

  return [];
}

/**
 * Index a newly inserted entry by upserting its embedding into Supabase pgvector.
 * Phase 2 placeholder — no-op with debug log.
 *
 * Phase 2 will:
 *   1. Call generateEmbedding(name)
 *   2. Upsert { id, embedding } into skill_embeddings or role_embeddings
 *   3. Execute non-blocking (fire-and-forget with error logging)
 *
 * @param  {object} options
 * @param  {string} options.id          - Row UUID from the primary table.
 * @param  {string} options.name        - Entry name to embed.
 * @param  {string} options.datasetType - 'skills' | 'roles'
 * @param  {string} [options.adminId]   - UUID of the admin who created the entry.
 * @returns {Promise<void>}
 */
async function indexEntry(options = {}) {
  const { id, name, datasetType, adminId } = options;

  logger.debug('[SimilarityService] indexEntry scaffold invoked', {
    id,
    hasName:     Boolean(name),
    datasetType,
    adminId,
    phase: 'scaffold',
  });
}

/**
 * Remove a vector row from the Supabase pgvector index table.
 * Phase 2 placeholder — no-op with debug log.
 *
 * Phase 2 will:
 *   DELETE FROM skill_embeddings / role_embeddings WHERE id = p_id
 *
 * @param  {string} id - UUID of the entry to deindex.
 * @returns {Promise<void>}
 */
async function deleteIndex(id) {
  logger.debug('[SimilarityService] deleteIndex scaffold invoked', {
    id,
    phase: 'scaffold',
  });
}

/**
 * Compute cosine similarity between two equal-length numeric vectors.
 * Pure function — no I/O, no side effects.
 *
 * Returns 0 when either vector is the zero vector (no meaningful direction).
 *
 * @param  {number[]} vecA
 * @param  {number[]} vecB
 * @returns {number} Similarity in [-1, 1]; 1 = identical direction.
 *
 * @throws {TypeError} If inputs are not arrays, are empty, differ in length,
 *                     or contain non-finite values (NaN, Infinity, null, undefined).
 */
function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB)) {
    throw new TypeError('cosineSimilarity: both arguments must be arrays');
  }

  if (vecA.length === 0 || vecB.length === 0) {
    throw new TypeError('cosineSimilarity: vectors must not be empty');
  }

  if (vecA.length !== vecB.length) {
    throw new TypeError(
      `cosineSimilarity: vectors must be equal length ` +
      `(got ${vecA.length} and ${vecB.length})`
    );
  }

  let dot  = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < vecA.length; i += 1) {
    // Coerce first so typeof-number inputs with NaN values are also caught
    const a = vecA[i];
    const b = vecB[i];

    if (typeof a !== 'number' || !Number.isFinite(a)) {
      throw new TypeError(
        `cosineSimilarity: vecA[${i}] is not a finite number (got ${a})`
      );
    }

    if (typeof b !== 'number' || !Number.isFinite(b)) {
      throw new TypeError(
        `cosineSimilarity: vecB[${i}] is not a finite number (got ${b})`
      );
    }

    dot  += a * b;
    magA += a * a;
    magB += b * b;
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);

  // Zero vector has no directional meaning — return 0 rather than NaN
  if (magnitude === 0) return 0;

  // Clamp to [-1, 1] to guard against floating-point drift
  return Math.max(-1, Math.min(1, dot / magnitude));
}

module.exports = {
  findSimilar,
  generateEmbedding,
  indexEntry,
  deleteIndex,
  cosineSimilarity,
  SIMILARITY_CONFIG,
};