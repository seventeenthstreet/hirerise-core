'use strict';

/**
 * src/modules/qualification/qualification.service.js
 *
 * Qualification service
 * ---------------------
 * Fully migrated for Supabase production use.
 * Firestore legacy patterns removed.
 */

const { supabase } = require('../../config/supabase');
const {
  AppError,
  ErrorCodes
} = require('../../middleware/errorHandler');

/**
 * Qualification level sort precedence
 */
const LEVEL_ORDER = Object.freeze({
  certificate: 0,
  diploma: 1,
  undergraduate: 2,
  postgraduate: 3,
  doctorate: 4
});

/**
 * Shared row mapper
 */
function mapQualificationRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name ?? null,
    level: row.level,
    domain:
      typeof row.domain === 'string' && row.domain.trim()
        ? row.domain.trim()
        : 'general',
    category: row.category ?? null,
    country: row.country ?? null,
    isActive: Boolean(row.is_active)
  };
}

/**
 * Stable application-side sort fallback
 */
function sortQualifications(rows) {
  return rows.sort((a, b) => {
    const levelDiff =
      (LEVEL_ORDER[a.level] ?? 99) -
      (LEVEL_ORDER[b.level] ?? 99);

    if (levelDiff !== 0) return levelDiff;

    return (a.name || '').localeCompare(b.name || '', 'en');
  });
}

/**
 * Fetch all active qualifications
 */
async function listActiveQualifications() {
  const { data, error } = await supabase
    .from('qualifications')
    .select(`
      id,
      name,
      short_name,
      level,
      domain,
      category,
      country,
      is_active
    `)
    .eq('is_active', true);

  if (error) {
    throw new AppError(
      'Failed to fetch qualifications.',
      500,
      { supabaseError: error.message },
      ErrorCodes.DB_ERROR
    );
  }

  const results = (data || []).map(mapQualificationRow);

  return sortQualifications(results);
}

/**
 * Fetch qualification by id
 */
async function getQualificationById(qualificationId) {
  const normalizedId =
    typeof qualificationId === 'string'
      ? qualificationId.trim()
      : '';

  if (!normalizedId) {
    throw new AppError(
      'qualificationId must be a non-empty string.',
      400,
      { qualificationId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const { data, error } = await supabase
    .from('qualifications')
    .select(`
      id,
      name,
      short_name,
      level,
      domain,
      category,
      country,
      is_active
    `)
    .eq('id', normalizedId)
    .maybeSingle();

  if (error) {
    throw new AppError(
      'Failed to fetch qualification.',
      500,
      { qualificationId: normalizedId, supabaseError: error.message },
      ErrorCodes.DB_ERROR
    );
  }

  if (!data) {
    throw new AppError(
      'Invalid qualification selected.',
      400,
      { qualificationId: normalizedId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const qualification = mapQualificationRow(data);

  if (!qualification.isActive) {
    throw new AppError(
      'The selected qualification is no longer available.',
      400,
      { qualificationId: normalizedId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return qualification;
}

module.exports = {
  listActiveQualifications,
  getQualificationById
};