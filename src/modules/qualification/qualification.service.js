'use strict';

/**
 * src/modules/qualification/qualification.service.js
 *
 * Supabase version — Firestore fully removed.
 */

const { supabase } = require('../../config/supabase');

const {
  AppError,
  ErrorCodes
} = require('../../middleware/errorHandler');

// Level sort order
const LEVEL_ORDER = {
  certificate: 0,
  diploma: 1,
  undergraduate: 2,
  postgraduate: 3,
  doctorate: 4
};

// ─────────────────────────────────────────────────────────
// listActiveQualifications
// ─────────────────────────────────────────────────────────

async function listActiveQualifications() {

  const { data, error } = await supabase
    .from('qualifications')
    .select('*')
    .eq('isActive', true); // ⚠️ change to is_active if DB uses snake_case

  if (error) throw error;

  const results = (data || []).map(row => ({
    id: row.id,
    name: row.name,
    shortName: row.shortName ?? null,
    level: row.level,
    domain:
      typeof row.domain === 'string' && row.domain
        ? row.domain
        : 'general',
    category: row.category,
    country: row.country
  }));

  return results.sort((a, b) => {
    const levelDiff =
      (LEVEL_ORDER[a.level] ?? 99) -
      (LEVEL_ORDER[b.level] ?? 99);

    if (levelDiff !== 0) return levelDiff;

    return a.name.localeCompare(b.name, 'en');
  });
}

// ─────────────────────────────────────────────────────────
// getQualificationById
// ─────────────────────────────────────────────────────────

async function getQualificationById(qualificationId) {

  if (!qualificationId || typeof qualificationId !== 'string') {
    throw new AppError(
      'qualificationId must be a non-empty string.',
      400,
      { qualificationId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const { data, error } = await supabase
    .from('qualifications')
    .select('*')
    .eq('id', qualificationId.trim())
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    throw new AppError(
      'Invalid qualification selected.',
      400,
      { qualificationId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (!data.isActive) { // ⚠️ snake_case: is_active
    throw new AppError(
      'The selected qualification is no longer available.',
      400,
      { qualificationId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return {
    id: data.id,
    name: data.name,
    shortName: data.shortName ?? null,
    level: data.level,
    domain:
      typeof data.domain === 'string' && data.domain
        ? data.domain
        : 'general',
    category: data.category,
    country: data.country,
    isActive: data.isActive
  };
}

module.exports = {
  listActiveQualifications,
  getQualificationById
};
