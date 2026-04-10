'use strict';

/**
 * Wave 1 Drift Hardened userVector.service.js
 *
 * Hardening:
 *  - vector dimension drift tolerance
 *  - column/table rollout fallback
 *  - malformed persisted vector recovery
 *  - safe regeneration path
 *  - cross-engine contract stabilization
 */

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');
const semanticSkillEngine = require('../engines/semanticSkill.engine');

const VECTOR_TABLE = 'user_vectors';
const VECTOR_COLUMN = 'embedding_vector';
const FALLBACK_VECTOR_COLUMN = 'embedding';
const VECTOR_DIMENSIONS = 1536;

function isValidVector(vector, expectedDimensions = VECTOR_DIMENSIONS) {
  return (
    Array.isArray(vector) &&
    vector.length === expectedDimensions &&
    vector.every(
      (value) => typeof value === 'number' && Number.isFinite(value)
    )
  );
}

function normalizeVector(vector) {
  if (!Array.isArray(vector)) return null;

  const normalized = vector
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));

  // strict preferred path
  if (normalized.length === VECTOR_DIMENSIONS) {
    return normalized;
  }

  // drift-tolerant path for staged model upgrades
  if (normalized.length > 0 && normalized.length >= 512) {
    logger.warn('[UserVector] dimension drift tolerated', {
      receivedDimensions: normalized.length,
      expectedDimensions: VECTOR_DIMENSIONS,
    });
    return normalized;
  }

  return null;
}

async function updateUserVector(userId, skills = []) {
  if (!userId || !Array.isArray(skills) || skills.length === 0) {
    throw new Error(
      'updateUserVector: userId and non-empty skills array required'
    );
  }

  try {
    const rawVector =
      await semanticSkillEngine.getUserSkillVector(skills);

    const vector = normalizeVector(rawVector);

    if (!vector) {
      throw new Error(
        `updateUserVector: invalid embedding vector shape (expected ~${VECTOR_DIMENSIONS})`
      );
    }

    const payload = {
      user_id: userId,
      [VECTOR_COLUMN]: vector,
      updated_at: new Date().toISOString(),
    };

    let { error } = await supabase
      .from(VECTOR_TABLE)
      .upsert(payload, {
        onConflict: 'user_id',
      });

    // rollout fallback if column renamed during vector migration
    if (error && isColumnDrift(error)) {
      logger.warn('[UserVector] column drift fallback write', {
        userId,
        column: VECTOR_COLUMN,
        error: error.message,
      });

      const fallbackPayload = {
        user_id: userId,
        [FALLBACK_VECTOR_COLUMN]: vector,
        updated_at: new Date().toISOString(),
      };

      ({ error } = await supabase
        .from(VECTOR_TABLE)
        .upsert(fallbackPayload, {
          onConflict: 'user_id',
        }));
    }

    if (error) throw error;

    logger.info('[UserVector] vector updated', {
      userId,
      dimensions: vector.length,
      skillCount: skills.length,
    });

    return vector;
  } catch (error) {
    logger.error('[UserVector] update failed', {
      userId,
      skillCount: skills.length,
      error: error.message,
    });

    throw error;
  }
}

async function getUserVector(userId, skills = []) {
  if (!userId) {
    throw new Error('getUserVector: userId required');
  }

  try {
    let { data, error } = await supabase
      .from(VECTOR_TABLE)
      .select(`${VECTOR_COLUMN}, ${FALLBACK_VECTOR_COLUMN}`)
      .eq('user_id', userId)
      .maybeSingle();

    // tolerate staged column rollout where one column may not exist
    if (error && isColumnDrift(error)) {
      logger.warn('[UserVector] column drift fallback read', {
        userId,
        error: error.message,
      });

      ({ data, error } = await supabase
        .from(VECTOR_TABLE)
        .select(VECTOR_COLUMN)
        .eq('user_id', userId)
        .maybeSingle());
    }

    if (error) throw error;

    const vector = normalizeVector(
      data?.[VECTOR_COLUMN] ?? data?.[FALLBACK_VECTOR_COLUMN]
    );

    if (vector) {
      return vector;
    }

    if (Array.isArray(skills) && skills.length > 0) {
      logger.info('[UserVector] cache miss → regenerating vector', {
        userId,
        skillCount: skills.length,
      });

      return updateUserVector(userId, skills);
    }

    return null;
  } catch (error) {
    logger.warn('[UserVector] fetch failed', {
      userId,
      error: error.message,
    });

    return null;
  }
}

function isColumnDrift(error) {
  const msg = String(error?.message || '').toLowerCase();
  return (
    error?.code === '42703' ||
    msg.includes('column') ||
    msg.includes('does not exist') ||
    msg.includes('schema cache')
  );
}

module.exports = {
  updateUserVector,
  getUserVector,
  isValidVector,
};