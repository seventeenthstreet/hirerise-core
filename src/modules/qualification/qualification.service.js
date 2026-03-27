'use strict';

/**
 * src/modules/qualification/qualification.service.js
 *
 * Read-only access to the qualifications/{qualificationId} Firestore collection.
 *
 * No repository layer — direct db.collection() access per project convention.
 *
 * Schema guarantees (enforced by seed + this service):
 *   - domain  is always a non-null string ('general' for cross-domain qualifications)
 *   - category is always one of: 'degree' | 'professional' | 'diploma' | 'certificate'
 */
const {
  db
} = require('../../config/supabase');
const {
  AppError,
  ErrorCodes
} = require('../../middleware/errorHandler');

// Level sort order — controls the sort for listActiveQualifications.
const LEVEL_ORDER = {
  certificate: 0,
  diploma: 1,
  undergraduate: 2,
  postgraduate: 3,
  doctorate: 4
};

// ─────────────────────────────────────────────────────────────────────────────
// listActiveQualifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all active qualifications sorted by level (ascending) then name
 * (alphabetical). Suitable for populating select dropdowns in onboarding.
 *
 * @returns {Promise<Array<{
 *   id:        string,
 *   name:      string,
 *   shortName: string|null,
 *   level:     string,
 *   domain:    string,
 *   category:  string,
 *   country:   string,
 * }>>}
 */
async function listActiveQualifications() {
  const snap = await supabase.from('qualifications').select("*").eq('isActive', true);
  const results = snap.docs.map(doc => {
    const data = doc.data();
    return {
      id: doc.id,
      name: data.name,
      shortName: data.shortName ?? null,
      level: data.level,
      domain: typeof data.domain === 'string' && data.domain ? data.domain : 'general',
      category: data.category,
      country: data.country
    };
  });
  return results.sort((a, b) => {
    const levelDiff = (LEVEL_ORDER[a.level] ?? 99) - (LEVEL_ORDER[b.level] ?? 99);
    if (levelDiff !== 0) return levelDiff;
    return a.name.localeCompare(b.name, 'en');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// getQualificationById
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches a single qualification by its Firestore document ID.
 *
 * Throws if the document does not exist or if isActive is false.
 * Callers (e.g. onboarding.service.js) use this to validate a user-supplied
 * qualificationId before storing it.
 *
 * @param   {string} qualificationId  Firestore document ID.
 * @returns {Promise<{
 *   id:        string,
 *   name:      string,
 *   shortName: string|null,
 *   level:     string,
 *   domain:    string,
 *   category:  string,
 *   country:   string,
 *   isActive:  boolean,
 * }>}
 * @throws  {AppError} 400 VALIDATION_ERROR — not found or inactive.
 */
async function getQualificationById(qualificationId) {
  if (!qualificationId || typeof qualificationId !== 'string') {
    throw new AppError('qualificationId must be a non-empty string.', 400, {
      qualificationId
    }, ErrorCodes.VALIDATION_ERROR);
  }
  const snap = await supabase.from('qualifications').select("*").eq("id", qualificationId.trim()).single();
  if (!snap.exists) {
    throw new AppError('Invalid qualification selected.', 400, {
      qualificationId
    }, ErrorCodes.VALIDATION_ERROR);
  }
  const data = snap.data();
  if (!data.isActive) {
    throw new AppError('The selected qualification is no longer available.', 400, {
      qualificationId
    }, ErrorCodes.VALIDATION_ERROR);
  }
  return {
    id: snap.id,
    name: data.name,
    shortName: data.shortName ?? null,
    level: data.level,
    domain: typeof data.domain === 'string' && data.domain ? data.domain : 'general',
    category: data.category,
    country: data.country,
    isActive: data.isActive
  };
}
module.exports = {
  listActiveQualifications,
  getQualificationById
};