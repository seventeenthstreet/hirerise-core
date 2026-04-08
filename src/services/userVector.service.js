'use strict';

/**
 * userVector.service.js
 *
 * Handles user embedding vector generation + storage
 * Used across AI engines
 */

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');
const semanticSkillEngine = require('../engines/semanticSkill.engine');

const VECTOR_TABLE = 'user_vectors';
const VECTOR_COLUMN = 'embedding_vector';
const VECTOR_DIMENSIONS = 1536;

function isValidVector(vector) {
  return (
    Array.isArray(vector) &&
    vector.length === VECTOR_DIMENSIONS &&
    vector.every((value) => typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Generate + persist user vector
 */
async function updateUserVector(userId, skills = []) {
  if (!userId || !Array.isArray(skills) || skills.length === 0) {
    throw new Error('updateUserVector: userId and non-empty skills array required');
  }

  try {
    const vector = await semanticSkillEngine.getUserSkillVector(skills);

    if (!isValidVector(vector)) {
      throw new Error(
        `updateUserVector: invalid embedding vector shape (expected ${VECTOR_DIMENSIONS})`
      );
    }

    const payload = {
      user_id: userId,
      [VECTOR_COLUMN]: vector,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from(VECTOR_TABLE)
      .upsert(payload, {
        onConflict: 'user_id',
      });

    if (error) {
      throw error;
    }

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

/**
 * Fetch cached vector or generate fallback
 */
async function getUserVector(userId, skills = []) {
  if (!userId) {
    throw new Error('getUserVector: userId required');
  }

  try {
    const { data, error } = await supabase
      .from(VECTOR_TABLE)
      .select(VECTOR_COLUMN)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    const vector = data?.[VECTOR_COLUMN];

    if (isValidVector(vector)) {
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

module.exports = {
  updateUserVector,
  getUserVector,
};