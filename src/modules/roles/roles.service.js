'use strict';

/**
 * roles.service.js — Business logic for the Roles module.
 *
 * Architecture:
 *   - Direct db.collection() access. No repository layer (project convention).
 *   - All validation of roleId existence uses validateRolesExist() helper.
 *   - Tier enforcement lives here, not in middleware, because it depends on
 *     business data (how many expectedRoleIds are requested) not just a quota counter.
 *   - userProfiles/{userId} stores only roleId references — never full role objects.
 *     This is enforced at write time by this service; reads denormalise on demand.
 *
 * Collections read/written:
 *   roles/{roleId}              — read-only from public API
 *   userProfiles/{userId}       — written by saveOnboardingRoles()
 */

const { db }                   = require('../../config/firebase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger                   = require('../../utils/logger');
const {
  EXPECTED_ROLE_LIMITS,
  FREE_EXPECTED_LIMIT,
  MAX_PREVIOUS_ROLES,
  ROLES_COLLECTION,
  PROFILES_COLLECTION,
  DEFAULT_SEARCH_LIMIT,
} = require('./roles.types');

// ─── Helper: get tier limit for expected roles ────────────────────────────────

/**
 * Returns the maximum number of expectedRoleIds allowed for a given plan.
 * Falls back to the free tier limit for any unrecognised plan value.
 *
 * @param {string} plan - req.user.plan
 * @returns {number}
 */
function getExpectedRoleLimit(plan) {
  return EXPECTED_ROLE_LIMITS[plan] ?? FREE_EXPECTED_LIMIT;
}

// ─── Helper: validateRolesExist ───────────────────────────────────────────────

/**
 * validateRolesExist(roleIds)
 *
 * Verifies that every roleId in the array exists in the roles collection
 * AND has active: true.
 *
 * Uses Promise.all for parallel reads — all IDs are checked in a single
 * round-trip fan-out, not sequentially.
 *
 * @param   {string[]} roleIds
 * @returns {Promise<Map<string, object>>} Map of roleId → role data for valid roles
 * @throws  {AppError} 400 VALIDATION_ERROR listing all invalid IDs in one response
 */
async function validateRolesExist(roleIds) {
  if (!roleIds || roleIds.length === 0) {
    return new Map();
  }

  // Deduplicate before hitting Firestore to avoid redundant reads
  const uniqueIds = [...new Set(roleIds)];

  const snapshots = await Promise.all(
    uniqueIds.map(id =>
      db.collection(ROLES_COLLECTION).doc(id).get()
        .then(snap => ({ id, snap }))
    )
  );

  const invalidIds   = [];
  const inactiveIds  = [];
  const roleMap      = new Map();

  for (const { id, snap } of snapshots) {
    if (!snap.exists) {
      invalidIds.push(id);
      continue;
    }
    const data = snap.data();
    if (data.active === false) {
      inactiveIds.push(id);
      continue;
    }
    roleMap.set(id, { id, ...data });
  }

  // Surface all problems in one response — no round-trip fix-one-at-a-time loop
  if (invalidIds.length > 0 || inactiveIds.length > 0) {
    const details = {};
    if (invalidIds.length)  details.notFound = invalidIds;
    if (inactiveIds.length) details.inactive = inactiveIds;

    throw new AppError(
      'One or more role IDs are invalid or no longer active.',
      400,
      details,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return roleMap;
}

// ─── listRoles ────────────────────────────────────────────────────────────────

/**
 * listRoles({ search, category, limit })
 *
 * Returns active roles, optionally filtered by category or title search.
 *
 * Firestore limitation: native full-text search is not supported.
 * For production scale (1M+ users), replace the in-memory title filter
 * with an Algolia/Typesense integration keyed on the same role documents.
 * The interface of this function does not need to change when you do that.
 *
 * @param {{ search?: string, category?: string, limit?: number }} options
 * @returns {Promise<{ roles: object[], total: number }>}
 */
async function listRoles({ search, category, limit = DEFAULT_SEARCH_LIMIT } = {}) {
  let query = db.collection(ROLES_COLLECTION).where('active', '==', true);

  // Category is a low-cardinality enum — safe to filter in Firestore
  if (category) {
    query = query.where('category', '==', category);
  }

  // Fetch — apply limit generously when title search is active because we
  // post-filter in memory. When no search, the Firestore limit is exact.
  const fetchLimit = search ? Math.min(limit * 10, 500) : limit;
  query = query.limit(fetchLimit);

  const snap = await query.get();

  let roles = snap.docs.map(doc => ({
    id:             doc.id,
    roleId:         doc.id,
    title:          doc.data().title,
    category:       doc.data().category,
    aliases:        doc.data().aliases        ?? [],
    skillTags:      doc.data().skillTags      ?? [],
    careerPathNext: doc.data().careerPathNext ?? [],
    active:         doc.data().active,
    createdAt:      doc.data().createdAt,
    updatedAt:      doc.data().updatedAt,
  }));

  // ── In-memory title/alias search ──────────────────────────────────────────
  // Checks title and all aliases (case-insensitive).
  // Replace this block with an external search call at scale.
  if (search) {
    const term = search.toLowerCase().trim();
    roles = roles.filter(role =>
      role.title.toLowerCase().includes(term) ||
      role.aliases.some(alias => alias.toLowerCase().includes(term))
    );
  }

  // Apply the requested limit after in-memory filter
  roles = roles.slice(0, limit);

  return { roles, total: roles.length };
}

// ─── getRoleById ──────────────────────────────────────────────────────────────

/**
 * getRoleById(roleId)
 *
 * Fetches a single role document. Throws 404 if not found or inactive.
 *
 * @param   {string} roleId
 * @returns {Promise<object>}
 * @throws  {AppError} 404 ROLE_NOT_FOUND
 */
async function getRoleById(roleId) {
  if (!roleId || typeof roleId !== 'string' || !roleId.trim()) {
    throw new AppError(
      'roleId must be a non-empty string.',
      400,
      { roleId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const snap = await db.collection(ROLES_COLLECTION).doc(roleId.trim()).get();

  if (!snap.exists) {
    throw new AppError(
      `Role not found: ${roleId}`,
      404,
      { roleId },
      ErrorCodes.ROLE_NOT_FOUND
    );
  }

  const data = snap.data();

  if (data.active === false) {
    throw new AppError(
      `Role is no longer active: ${roleId}`,
      404,
      { roleId },
      ErrorCodes.ROLE_NOT_FOUND
    );
  }

  return {
    id:             snap.id,
    roleId:         snap.id,
    title:          data.title,
    category:       data.category,
    aliases:        data.aliases        ?? [],
    skillTags:      data.skillTags      ?? [],
    careerPathNext: data.careerPathNext ?? [],
    active:         data.active,
    createdAt:      data.createdAt,
    updatedAt:      data.updatedAt,
  };
}

// ─── saveOnboardingRoles ──────────────────────────────────────────────────────

/**
 * saveOnboardingRoles(userId, plan, payload)
 *
 * Validates and persists the user's role selections to userProfiles/{userId}.
 *
 * Validation order (fail-fast, most-informative errors first):
 *   1. Tier limit check — no Firestore reads, instant
 *   2. Duplicate check — no Firestore reads, instant
 *   3. Cross-array overlap check — no Firestore reads, instant
 *   4. Existence + active check — parallel Firestore reads
 *
 * Writes:
 *   - userProfiles/{userId} — set with merge: true (preserves existing fields)
 *   - onboardingProgress/{userId} — updates step flag (marks roles saved)
 *
 * Both writes happen in a Firestore batch so they succeed or fail atomically.
 *
 * @param {string}   userId
 * @param {string}   plan       - req.user.plan
 * @param {object}   payload    - validated body (from roles.validator.js)
 * @returns {Promise<object>}   - saved profile snapshot
 */
async function saveOnboardingRoles(userId, plan, payload) {
  const {
    currentRoleId,
    previousRoleIds  = [],
    expectedRoleIds  = [],
    experienceYears,
    targetLevel,
    careerIntent,
  } = payload;

  // ── 1. Tier limit enforcement ─────────────────────────────────────────────
  const expectedLimit = getExpectedRoleLimit(plan);

  if (expectedRoleIds.length > expectedLimit) {
    throw new AppError(
      `Your current plan allows a maximum of ${expectedLimit} expected role(s). ` +
      `Upgrade to unlock more.`,
      403,
      {
        plan,
        limit:      expectedLimit,
        requested:  expectedRoleIds.length,
        upgradeUrl: process.env.UPGRADE_URL ?? '/pricing',
      },
      ErrorCodes.FORBIDDEN
    );
  }

  // ── 2. Duplicate detection within each array ──────────────────────────────
  const checkDuplicates = (ids, fieldName) => {
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) {
        throw new AppError(
          `Duplicate roleId "${id}" in ${fieldName}.`,
          400,
          { field: fieldName, duplicateId: id },
          ErrorCodes.VALIDATION_ERROR
        );
      }
      seen.add(id);
    }
  };

  checkDuplicates(previousRoleIds, 'previousRoleIds');
  checkDuplicates(expectedRoleIds, 'expectedRoleIds');

  // ── 3. Cross-array overlap checks ─────────────────────────────────────────
  // currentRoleId must not appear in previousRoleIds or expectedRoleIds.
  // previousRoleIds and expectedRoleIds must not share any roleId.

  if (previousRoleIds.includes(currentRoleId)) {
    throw new AppError(
      'currentRoleId cannot appear in previousRoleIds.',
      400,
      { currentRoleId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (expectedRoleIds.includes(currentRoleId)) {
    throw new AppError(
      'currentRoleId cannot appear in expectedRoleIds.',
      400,
      { currentRoleId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const prevSet = new Set(previousRoleIds);
  const overlaps = expectedRoleIds.filter(id => prevSet.has(id));
  if (overlaps.length > 0) {
    throw new AppError(
      'expectedRoleIds and previousRoleIds cannot share the same role(s).',
      400,
      { overlappingIds: overlaps },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  // ── 4. Existence + active validation (parallel Firestore reads) ───────────
  const allRoleIds = [currentRoleId, ...previousRoleIds, ...expectedRoleIds];
  await validateRolesExist(allRoleIds); // throws descriptively if any are invalid

  // ── 5. Atomic batch write ─────────────────────────────────────────────────
  const now     = new Date();
  const batch   = db.batch();

  // userProfiles/{userId} — store only IDs, never full role objects
  const profileRef = db.collection(PROFILES_COLLECTION).doc(userId);
  const profileData = {
    userId,
    currentRoleId,
    previousRoleIds,
    expectedRoleIds,
    ...(experienceYears !== undefined && { experienceYears }),
    ...(targetLevel     !== undefined && { targetLevel }),
    ...(careerIntent    !== undefined && { careerIntent }),
    onboardingCompleted: false, // full onboarding completes after career report
    updatedAt:           now,
  };

  batch.set(profileRef, profileData, { merge: true });

  // onboardingProgress/{userId} — advance step flag
  const progressRef = db.collection('onboardingProgress').doc(userId);
  batch.set(progressRef, {
    step:      'roles_saved',
    updatedAt: now,
  }, { merge: true });

  await batch.commit();

  logger.info('[RolesService] Onboarding roles saved', {
    userId,
    plan,
    currentRoleId,
    previousCount:  previousRoleIds.length,
    expectedCount:  expectedRoleIds.length,
  });

  return {
    userId,
    currentRoleId,
    previousRoleIds,
    expectedRoleIds,
    experienceYears:  experienceYears ?? null,
    targetLevel:      targetLevel     ?? null,
    careerIntent:     careerIntent    ?? null,
    step:             'roles_saved',
    message:          'Role preferences saved successfully.',
  };
}

// ─── getUserProfile ───────────────────────────────────────────────────────────

/**
 * getUserProfile(userId)
 *
 * Fetches userProfiles/{userId}.
 * Returns null if no profile exists (user has not completed role onboarding yet).
 *
 * @param   {string} userId
 * @returns {Promise<object|null>}
 */
async function getUserProfile(userId) {
  const snap = await db.collection(PROFILES_COLLECTION).doc(userId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}


// ─── searchRolesForOnboarding (FIX G-06) ─────────────────────────────────────

/**
 * searchRolesForOnboarding({ q, jobFamilyId, limit })
 *
 * FIX G-06: Role search endpoint for Track B career intent selection.
 *
 * PROBLEM:
 *   The only existing endpoint was GET /roles which returns a flat unfiltered
 *   list. Users selecting careerHistory entries and expectedRoleIds must pick
 *   from hundreds of roles with no type-ahead, no hierarchy, no family grouping.
 *   This directly caused low Track B completion rates.
 *
 * FIX: Purpose-built search endpoint with:
 *   1. q (text search) — matches title + aliases (case-insensitive)
 *   2. jobFamilyId filter — returns all roles in a family (for dropdown hierarchy)
 *   3. Grouped-by-family response — frontend can render a grouped <select> or tree
 *   4. Scored relevance — exact matches rank above partial matches
 *   5. Onboarding-specific response shape — only fields the Track B form needs
 *
 * SCALE NOTE:
 *   The in-memory text filter is acceptable at ≤1,000 roles.
 *   At scale, replace the Firestore fan-out with an Algolia/Typesense call.
 *   The function signature does not need to change.
 *
 * @param {{ q?: string, jobFamilyId?: string, limit?: number }} options
 * @returns {Promise<{ roles: object[], grouped: object, total: number }>}
 */
async function searchRolesForOnboarding({ q, jobFamilyId, limit = 30 } = {}) {
  let query = db.collection(ROLES_COLLECTION).where('active', '==', true);

  // jobFamilyId is a low-cardinality Firestore field — safe to filter server-side
  if (jobFamilyId) {
    query = query.where('jobFamilyId', '==', jobFamilyId);
  }

  // Over-fetch when text search is active (post-filter in memory)
  const fetchLimit = q ? Math.min(limit * 15, 1000) : limit;
  query = query.limit(fetchLimit);

  const snap = await query.get();

  let roles = snap.docs.map(doc => {
    const d = doc.data();
    return {
      id:           doc.id,
      title:        d.title         || '',
      level:        d.level         || null,
      track:        d.track         || null,
      jobFamilyId:  d.jobFamilyId   || null,
      jobFamilyName: d.jobFamilyName || null,
      aliases:      d.aliases       || [],
      _score:       0, // relevance score, set below
    };
  });

  // ── In-memory relevance scoring ──────────────────────────────────────────
  if (q && q.trim()) {
    const term  = q.toLowerCase().trim();
    const exact = (s) => s.toLowerCase() === term;
    const start = (s) => s.toLowerCase().startsWith(term);
    const incl  = (s) => s.toLowerCase().includes(term);

    roles = roles
      .map(role => {
        const allText = [role.title, ...role.aliases];
        let score = 0;
        if (allText.some(exact)) score = 100;
        else if (allText.some(start)) score = 60;
        else if (allText.some(incl)) score = 30;
        return { ...role, _score: score };
      })
      .filter(r => r._score > 0)
      .sort((a, b) => b._score - a._score);
  }

  // Apply final limit after filter
  roles = roles.slice(0, limit);

  // ── Group by job family for frontend hierarchy rendering ─────────────────
  const grouped = {};
  for (const role of roles) {
    const family = role.jobFamilyId || 'other';
    if (!grouped[family]) {
      grouped[family] = {
        jobFamilyId:   family,
        jobFamilyName: role.jobFamilyName || family,
        roles:         [],
      };
    }
    // Strip internal _score from public response
    const { _score, ...publicRole } = role;
    grouped[family].roles.push(publicRole);
  }

  // Strip _score from flat list too
  const publicRoles = roles.map(({ _score, ...r }) => r);

  return {
    roles:   publicRoles,
    grouped: Object.values(grouped),
    total:   publicRoles.length,
  };
}

module.exports = {
  listRoles,
  getRoleById,
  searchRolesForOnboarding, // G-06
  saveOnboardingRoles,
  getUserProfile,
  validateRolesExist,
  getExpectedRoleLimit,
};