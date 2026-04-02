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

// ─────────────────────────────────────────────
// UPDATE USER VECTOR
// ─────────────────────────────────────────────

async function updateUserVector(userId, skills = []) {
  if (!userId || !Array.isArray(skills) || skills.length === 0) {
    throw new Error('updateUserVector: userId and skills required');
  }

  try {
    // Generate vector
    const vector = await semanticSkillEngine.getUserSkillVector(skills);

    // Upsert into DB
    const { error } = await supabase
      .from('user_vectors')
      .upsert({
        user_id: userId,
        embedding_vector: vector,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });

    if (error) throw error;

    return vector;

  } catch (err) {
    logger.error('[UserVector] update failed', {
      userId,
      err: err.message
    });
    throw err;
  }
}

// ─────────────────────────────────────────────
// GET USER VECTOR (WITH FALLBACK)
// ─────────────────────────────────────────────

async function getUserVector(userId, skills = []) {
  if (!userId) throw new Error('userId required');

  try {
    // Try DB first
    const { data } = await supabase
      .from('user_vectors')
      .select('embedding_vector')
      .eq('user_id', userId)
      .maybeSingle();

    if (data?.embedding_vector) {
      return data.embedding_vector;
    }

    // Fallback → generate + store
    if (skills.length > 0) {
      return await updateUserVector(userId, skills);
    }

    return null;

  } catch (err) {
    logger.warn('[UserVector] fetch failed', {
      userId,
      err: err.message
    });

    return null;
  }
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  updateUserVector,
  getUserVector
};