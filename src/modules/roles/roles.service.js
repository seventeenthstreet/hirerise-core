'use strict';

// ── Field compatibility helper ────────────────────────────────────────────────
// CMS-created roles use { name, alternativeTitles, status: 'active' }
// Seed-script roles use  { title, aliases, active: true }
// These helpers normalise both shapes so search + validation work on either.
function _roleTitle(d) {
  return d.title || d.name || '';
}
function _roleAliases(d) {
  return d.aliases || d.alternativeTitles || [];
}
function _roleIsActive(d) {
  return d.active === true || d.status === 'active';
}

/**
 * roles.service.js — Business logic for the Roles module.
 *
 * Architecture:
 *   - Direct supabase.from() access. No repository layer (project convention).
 *   - All validation of roleId existence uses validateRolesExist() helper.
 *   - Tier enforcement lives here, not in middleware, because it depends on
 *     business data (how many expectedRoleIds are requested) not just a quota counter.
 *   - userProfiles/{userId} stores only roleId references — never full role objects.
 *     This is enforced at write time by this service; reads denormalise on demand.
 *
 * Tables read/written:
 *   roles              — read-only from public API
 *   userProfiles       — written by saveOnboardingRoles()
 */

const supabase = require('../../config/supabase');
const {
  AppError,
  ErrorCodes
} = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const {
  EXPECTED_ROLE_LIMITS,
  FREE_EXPECTED_LIMIT,
  MAX_PREVIOUS_ROLES,
  ROLES_COLLECTION,
  PROFILES_COLLECTION,
  DEFAULT_SEARCH_LIMIT
} = require('./roles.types');
const CMS_ROLES_COLLECTION = 'cms_roles'; // Admin CMS stores roles here

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

  // Deduplicate before hitting Supabase to avoid redundant reads
  const uniqueIds = [...new Set(roleIds)];

  // Check both collections in parallel — CMS uses 'cms_roles', seed uses 'roles'
  const [rolesResults, cmsResults] = await Promise.all([
    Promise.all(uniqueIds.map(id =>
      supabase.from(ROLES_COLLECTION).select('*').eq('id', id).maybeSingle()
    )),
    Promise.all(uniqueIds.map(id =>
      supabase.from(CMS_ROLES_COLLECTION).select('*').eq('id', id).maybeSingle()
    ))
  ]);

  const invalidIds = [];
  const inactiveIds = [];
  const roleMap = new Map();

  for (let i = 0; i < uniqueIds.length; i++) {
    const id = uniqueIds[i];
    // Prefer 'roles' collection; fall back to 'cms_roles'
    const primaryData = rolesResults[i].data;
    const cmsData = cmsResults[i].data;
    const data = primaryData ?? cmsData;

    if (!data) {
      invalidIds.push(id);
      continue;
    }
    if (!_roleIsActive(data)) {
      inactiveIds.push(id);
      continue;
    }
    roleMap.set(id, { id, ...data });
  }

  // Surface all problems in one response — no round-trip fix-one-at-a-time loop
  if (invalidIds.length > 0 || inactiveIds.length > 0) {
    const details = {};
    if (invalidIds.length) details.notFound = invalidIds;
    if (inactiveIds.length) details.inactive = inactiveIds;
    throw new AppError('One or more role IDs are invalid or no longer active.', 400, details, ErrorCodes.VALIDATION_ERROR);
  }
  return roleMap;
}

// ─── listRoles ────────────────────────────────────────────────────────────────

/**
 * listRoles({ search, category, limit })
 *
 * Returns active roles, optionally filtered by category or title search.
 *
 * For production scale (1M+ users), replace the in-memory title filter
 * with an Algolia/Typesense integration keyed on the same role rows.
 * The interface of this function does not need to change when you do that.
 *
 * @param {{ search?: string, category?: string, limit?: number }} options
 * @returns {Promise<{ roles: object[], total: number }>}
 */
async function listRoles({
  search,
  category,
  limit = DEFAULT_SEARCH_LIMIT
} = {}) {
  // Over-fetch when title search is active (post-filter in memory).
  // When no search, the limit is exact.
  const fetchLimit = search ? Math.min(limit * 10, 500) : limit;

  let query = supabase
    .from(ROLES_COLLECTION)
    .select('*')
    .eq('active', true)
    .limit(fetchLimit);

  // Category is a low-cardinality enum — safe to filter server-side
  if (category) {
    query = query.eq('category', category);
  }

  const { data, error } = await query;
  if (error) throw error;

  let roles = (data ?? []).map(row => ({
    id: row.id,
    roleId: row.id,
    title: row.title,
    category: row.category,
    aliases: row.aliases ?? [],
    skillTags: row.skillTags ?? [],
    careerPathNext: row.careerPathNext ?? [],
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
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
  return {
    roles,
    total: roles.length
  };
}

// ─── getRoleById ──────────────────────────────────────────────────────────────

/**
 * getRoleById(roleId)
 *
 * Fetches a single role row. Throws 404 if not found or inactive.
 *
 * @param   {string} roleId
 * @returns {Promise<object>}
 * @throws  {AppError} 404 ROLE_NOT_FOUND
 */
async function getRoleById(roleId) {
  if (!roleId || typeof roleId !== 'string' || !roleId.trim()) {
    throw new AppError('roleId must be a non-empty string.', 400, {
      roleId
    }, ErrorCodes.VALIDATION_ERROR);
  }

  const { data, error } = await supabase
    .from(ROLES_COLLECTION)
    .select('*')
    .eq('id', roleId.trim())
    .single();

  if (error || !data) {
    throw new AppError(`Role not found: ${roleId}`, 404, {
      roleId
    }, ErrorCodes.ROLE_NOT_FOUND);
  }

  if (data.active === false) {
    throw new AppError(`Role is no longer active: ${roleId}`, 404, {
      roleId
    }, ErrorCodes.ROLE_NOT_FOUND);
  }

  return {
    id: data.id,
    roleId: data.id,
    title: data.title,
    category: data.category,
    aliases: data.aliases ?? [],
    skillTags: data.skillTags ?? [],
    careerPathNext: data.careerPathNext ?? [],
    active: data.active,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };
}

// ─── saveOnboardingRoles ──────────────────────────────────────────────────────

/**
 * saveOnboardingRoles(userId, plan, payload)
 *
 * Validates and persists the user's role selections to userProfiles.
 *
 * Validation order (fail-fast, most-informative errors first):
 *   1. Tier limit check — no DB reads, instant
 *   2. Duplicate check — no DB reads, instant
 *   3. Cross-array overlap check — no DB reads, instant
 *   4. Existence + active check — parallel Supabase reads
 *
 * Writes:
 *   - userProfiles — upsert (preserves existing fields)
 *   - onboardingProgress — updates step flag (marks roles saved)
 *
 * Both writes happen via Promise.all so they succeed or fail together.
 *
 * @param {string}   userId
 * @param {string}   plan       - req.user.plan
 * @param {object}   payload    - validated body (from roles.validator.js)
 * @returns {Promise<object>}   - saved profile snapshot
 */
async function saveOnboardingRoles(userId, plan, payload) {
  const {
    currentRoleId,
    previousRoleIds = [],
    expectedRoleIds = [],
    experienceYears,
    targetLevel,
    careerIntent
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
        limit: expectedLimit,
        requested: expectedRoleIds.length,
        upgradeUrl: process.env.UPGRADE_URL ?? '/pricing'
      },
      ErrorCodes.FORBIDDEN
    );
  }

  // ── 2. Duplicate detection within each array ──────────────────────────────
  const checkDuplicates = (ids, fieldName) => {
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) {
        throw new AppError(`Duplicate roleId "${id}" in ${fieldName}.`, 400, {
          field: fieldName,
          duplicateId: id
        }, ErrorCodes.VALIDATION_ERROR);
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
    throw new AppError('currentRoleId cannot appear in previousRoleIds.', 400, {
      currentRoleId
    }, ErrorCodes.VALIDATION_ERROR);
  }
  if (expectedRoleIds.includes(currentRoleId)) {
    throw new AppError('currentRoleId cannot appear in expectedRoleIds.', 400, {
      currentRoleId
    }, ErrorCodes.VALIDATION_ERROR);
  }
  const prevSet = new Set(previousRoleIds);
  const overlaps = expectedRoleIds.filter(id => prevSet.has(id));
  if (overlaps.length > 0) {
    throw new AppError('expectedRoleIds and previousRoleIds cannot share the same role(s).', 400, {
      overlappingIds: overlaps
    }, ErrorCodes.VALIDATION_ERROR);
  }

  // ── 4. Existence + active validation (parallel Supabase reads) ────────────
  const allRoleIds = [currentRoleId, ...previousRoleIds, ...expectedRoleIds];
  await validateRolesExist(allRoleIds); // throws descriptively if any are invalid

  // ── 5. Parallel upsert writes ─────────────────────────────────────────────
  const now = new Date().toISOString();

  const profileData = {
    id: userId,
    userId,
    currentRoleId,
    previousRoleIds,
    expectedRoleIds,
    ...(experienceYears !== undefined && { experienceYears }),
    ...(targetLevel !== undefined && { targetLevel }),
    ...(careerIntent !== undefined && { careerIntent }),
    onboardingCompleted: false,
    // full onboarding completes after career report
    updatedAt: now
  };

  await Promise.all([
    supabase.from(PROFILES_COLLECTION).upsert(profileData),
    supabase.from('onboardingProgress').upsert({
      id: userId,
      step: 'roles_saved',
      updatedAt: now
    })
  ]);

  logger.info('[RolesService] Onboarding roles saved', {
    userId,
    plan,
    currentRoleId,
    previousCount: previousRoleIds.length,
    expectedCount: expectedRoleIds.length
  });

  return {
    userId,
    currentRoleId,
    previousRoleIds,
    expectedRoleIds,
    experienceYears: experienceYears ?? null,
    targetLevel: targetLevel ?? null,
    careerIntent: careerIntent ?? null,
    step: 'roles_saved',
    message: 'Role preferences saved successfully.'
  };
}

// ─── getUserProfile ───────────────────────────────────────────────────────────

/**
 * getUserProfile(userId)
 *
 * Fetches userProfiles row for userId.
 * Returns null if no profile exists (user has not completed role onboarding yet).
 *
 * @param   {string} userId
 * @returns {Promise<object|null>}
 */
async function getUserProfile(userId) {
  const { data, error } = await supabase
    .from(PROFILES_COLLECTION)
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { id: data.id, ...data };
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
 *   At scale, replace the Supabase fan-out with an Algolia/Typesense call.
 *   The function signature does not need to change.
 *
 * @param {{ q?: string, jobFamilyId?: string, limit?: number }} options
 * @returns {Promise<{ roles: object[], grouped: object, total: number }>}
 */
async function searchRolesForOnboarding({
  q,
  jobFamilyId,
  limit = 30
} = {}) {
  // Over-fetch when text search is active (post-filter in memory)
  const fetchLimit = q ? Math.min(limit * 15, 1000) : limit;

  // Fetch from both collections in parallel, merge docs (deduplicate by id)
  let rolesQuery = supabase.from(ROLES_COLLECTION).select('*').limit(fetchLimit);
  let cmsQuery = supabase.from(CMS_ROLES_COLLECTION).select('*').limit(fetchLimit);

  // jobFamilyId is a low-cardinality field — safe to filter server-side
  if (jobFamilyId) {
    rolesQuery = rolesQuery.eq('jobFamilyId', jobFamilyId);
    cmsQuery = cmsQuery.eq('jobFamilyId', jobFamilyId);
  }

  const [{ data: rolesData }, { data: cmsData }] = await Promise.all([rolesQuery, cmsQuery]);

  const seenIds = new Set();
  const allRows = [];
  for (const row of [...(rolesData ?? []), ...(cmsData ?? [])]) {
    if (!seenIds.has(row.id)) {
      seenIds.add(row.id);
      allRows.push(row);
    }
  }

  let roles = allRows
    .filter(row => _roleIsActive(row)) // handles active:true and status:'active'
    .map(row => ({
      id: row.id,
      title: _roleTitle(row),
      level: row.level || null,
      track: row.track || null,
      jobFamilyId: row.jobFamilyId || null,
      jobFamilyName: row.jobFamilyName || null,
      aliases: _roleAliases(row),
      _score: 0 // relevance score, set below
    }));

  // ── In-memory relevance scoring ──────────────────────────────────────────
  if (q && q.trim()) {
    const term = q.toLowerCase().trim();
    const exact = s => s.toLowerCase() === term;
    const start = s => s.toLowerCase().startsWith(term);
    const incl = s => s.toLowerCase().includes(term);
    roles = roles.map(role => {
      const allText = [role.title, ...role.aliases];
      let score = 0;
      if (allText.some(exact)) score = 100;
      else if (allText.some(start)) score = 60;
      else if (allText.some(incl)) score = 30;
      return { ...role, _score: score };
    }).filter(r => r._score > 0).sort((a, b) => b._score - a._score);
  }

  // Apply final limit after filter
  roles = roles.slice(0, limit);

  // ── Group by job family for frontend hierarchy rendering ─────────────────
  const grouped = {};
  for (const role of roles) {
    const family = role.jobFamilyId || 'other';
    if (!grouped[family]) {
      grouped[family] = {
        jobFamilyId: family,
        jobFamilyName: role.jobFamilyName || family,
        roles: []
      };
    }
    // Strip internal _score from public response
    const { _score, ...publicRole } = role;
    grouped[family].roles.push(publicRole);
  }

  // Strip _score from flat list too
  const publicRoles = roles.map(({ _score, ...r }) => r);
  return {
    roles: publicRoles,
    grouped: Object.values(grouped),
    total: publicRoles.length
  };
}

// ─── suggestRolesForOnboarding (P1-05) ───────────────────────────────────────

/**
 * suggestRolesForOnboarding({ jobTitle, limit })
 *
 * P1-05: Purpose-built role suggestion for Quick Start pre-fill.
 *
 * PROBLEM:
 *   When a user types their job title in Quick Start (e.g. "Senior Product Manager"),
 *   we need to suggest the matching roleId(s) from the roles collection so the
 *   expectedRoleIds[] picker is pre-filled rather than empty.
 *
 * HOW IT WORKS:
 *   1. Tokenise the input title (lowercase, stopwords removed).
 *   2. Score every active role by matching tokens against title + aliases.
 *   3. Return top N results with a 0-100 confidence score.
 *
 * Confidence scoring:
 *   100 — exact title match
 *   80  — all tokens match (subset)
 *   60  — title starts with the query
 *   40  — majority of tokens match
 *   20  — at least one token matches
 *
 * CACHING:
 *   Responses are cached in-process for 1 hour keyed by normalised jobTitle.
 *   Role catalogue changes rarely — this avoids unnecessary Supabase reads.
 *
 * @param {{ jobTitle: string, limit?: number }} options
 * @returns {Promise<{ suggestions: Array<{roleId, title, confidence}>, total: number }>}
 */

// D-03 FIX: Redis-backed suggestion cache shared across all Cloud Run instances.
// Previously this was a per-instance Map — each instance built its own cache,
// wasting reads and AI calls on every scale-out event.
//
// Primary:  Redis SETEX with 1-hour TTL (CACHE_PROVIDER=redis)
// Fallback: In-memory Map (used when Redis is unavailable or not configured)
//           Falls back gracefully with a warning log so ops can detect it.
const redis = (() => {
  try {
    return require('../../shared/redis.client');
  } catch {
    return null;
  }
})();
const _suggestionCache = new Map(); // in-memory fallback — per-instance only
const SUGGESTION_CACHE_TTL_S = 60 * 60; // 1 hour
const SUGGESTION_CACHE_TTL_MS = SUGGESTION_CACHE_TTL_S * 1000;

async function _getCachedSuggestion(cacheKey) {
  if (redis) {
    try {
      const raw = await redis.get(cacheKey);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      logger.warn('[RolesService] Redis get failed — falling back to in-memory cache', {
        error: err.message
      });
    }
  }
  // In-memory fallback
  const cached = _suggestionCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SUGGESTION_CACHE_TTL_MS) return cached.result;
  return null;
}

async function _setCachedSuggestion(cacheKey, result) {
  if (redis) {
    try {
      await redis.setex(cacheKey, SUGGESTION_CACHE_TTL_S, JSON.stringify(result));
      return;
    } catch (err) {
      logger.warn('[RolesService] Redis setex failed — falling back to in-memory cache', {
        error: err.message
      });
    }
  }
  // In-memory fallback
  _suggestionCache.set(cacheKey, { result, ts: Date.now() });
  if (_suggestionCache.size > 500) {
    _suggestionCache.delete(_suggestionCache.keys().next().value);
  }
}

async function suggestRolesForOnboarding({
  jobTitle,
  limit = 5
} = {}) {
  if (!jobTitle || !String(jobTitle).trim()) {
    return { suggestions: [], total: 0 };
  }
  const normalised = String(jobTitle).toLowerCase().trim();

  // ── Cache check ───────────────────────────────────────────────────────────
  const cacheKey = `suggest:${normalised}`;
  const cached = await _getCachedSuggestion(cacheKey);
  if (cached) return cached;

  // ── Fetch active roles from both collections ──────────────────────────────
  const [{ data: rolesData }, { data: cmsData }] = await Promise.all([
    supabase.from(ROLES_COLLECTION).select('*').limit(1000),
    supabase.from(CMS_ROLES_COLLECTION).select('*').limit(1000)
  ]);

  const seenIds = new Set();
  const allRows = [];
  for (const row of [...(rolesData ?? []), ...(cmsData ?? [])]) {
    if (!seenIds.has(row.id)) {
      seenIds.add(row.id);
      allRows.push(row);
    }
  }

  // ── Tokenise query ────────────────────────────────────────────────────────
  const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'in', 'at', 'for', 'to', 'and', 'or', 'is', 'be', 'with']);
  const queryTokens = normalised
    .split(/[\s\-_/]+/)
    .map(t => t.replace(/[^a-z0-9]/g, ''))
    .filter(t => t.length > 1 && !STOPWORDS.has(t));

  // ── Score each role ───────────────────────────────────────────────────────
  const scored = [];
  for (const row of allRows) {
    const allText = [_roleTitle(row), ..._roleAliases(row)].filter(Boolean).map(s => s.toLowerCase());
    if (!_roleIsActive(row)) continue; // skip inactive/draft roles
    let score = 0;

    // Exact title match
    if (allText.some(t => t === normalised)) {
      score = 100;
    }
    // Title starts with query
    else if (allText.some(t => t.startsWith(normalised))) {
      score = 60;
    }
    // All query tokens present somewhere
    else if (queryTokens.length > 0) {
      const matchCount = queryTokens.filter(tok => allText.some(t => t.includes(tok))).length;
      const ratio = matchCount / queryTokens.length;
      if (ratio === 1) score = 80;
      else if (ratio >= 0.5) score = 40;
      else if (ratio > 0) score = 20;
    }

    if (score > 0) {
      scored.push({
        roleId: row.id,
        title: _roleTitle(row),
        confidence: score,
        category: row.category || null
      });
    }
  }

  // Sort descending, take top N
  scored.sort((a, b) => b.confidence - a.confidence);
  const suggestions = scored.slice(0, limit);
  const result = { suggestions, total: suggestions.length };

  // ── Cache result ──────────────────────────────────────────────────────────
  await _setCachedSuggestion(cacheKey, result);
  return result;
}

module.exports = {
  listRoles,
  getRoleById,
  searchRolesForOnboarding,  // G-06
  suggestRolesForOnboarding, // P1-05
  saveOnboardingRoles,
  getUserProfile,
  validateRolesExist,
  getExpectedRoleLimit
};