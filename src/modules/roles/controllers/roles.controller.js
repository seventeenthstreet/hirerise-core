'use strict';

/**
 * src/modules/roles/controllers/roles.controller.js
 *
 * Supabase-ready HTTP handlers for the Roles module.
 *
 * Responsibilities:
 *   - Extract authenticated user identity from req.user
 *   - Normalize request inputs
 *   - Delegate business logic to roles.service
 *   - Return consistent { success, data } response envelopes
 *
 * Notes:
 *   - No business logic should live here
 *   - Compatible with Supabase auth middleware payloads
 *   - Legacy Firebase uid payloads still supported for backward compatibility
 */

const rolesService = require('../roles.service');
const {
  AppError,
  ErrorCodes,
} = require('../../../middleware/errorHandler');

/**
 * Extract authenticated user ID from auth middleware payload.
 *
 * Supports:
 *   - Supabase: req.user.id
 *   - Legacy compatibility: req.user.uid
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function getAuthenticatedUserId(req) {
  return req.user?.id || req.user?.uid || null;
}

/**
 * Normalize numeric query limit safely.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
function parseSafeLimit(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/roles
// ─────────────────────────────────────────────────────────────────────────────
async function listRoles(req, res, next) {
  try {
    const { search, category, limit } = req.query;

    const result = await rolesService.listRoles({
      search,
      category,
      limit,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/roles/:roleId
// ─────────────────────────────────────────────────────────────────────────────
async function getRoleById(req, res, next) {
  try {
    const roleId = String(req.params?.roleId || '').trim();

    if (!roleId) {
      return next(
        new AppError(
          'roleId param is required.',
          400,
          { roleId: req.params?.roleId },
          ErrorCodes.VALIDATION_ERROR
        )
      );
    }

    const role = await rolesService.getRoleById(roleId);

    return res.status(200).json({
      success: true,
      data: { role },
    });
  } catch (error) {
    return next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/onboarding/roles
// ─────────────────────────────────────────────────────────────────────────────
async function saveOnboardingRoles(req, res, next) {
  try {
    const userId = getAuthenticatedUserId(req);
    const plan = req.user?.plan ?? 'free';

    if (!userId) {
      return next(
        new AppError(
          'Authentication required.',
          401,
          {},
          ErrorCodes.UNAUTHORIZED
        )
      );
    }

    const result = await rolesService.saveOnboardingRoles(
      userId,
      plan,
      req.body
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/onboarding/roles
// ─────────────────────────────────────────────────────────────────────────────
async function getOnboardingRoles(req, res, next) {
  try {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return next(
        new AppError(
          'Authentication required.',
          401,
          {},
          ErrorCodes.UNAUTHORIZED
        )
      );
    }

    const profile = await rolesService.getUserProfile(userId);

    return res.status(200).json({
      success: true,
      data: { profile },
    });
  } catch (error) {
    return next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/roles/search
// ─────────────────────────────────────────────────────────────────────────────
async function searchRolesForOnboarding(req, res, next) {
  try {
    const { q, jobFamilyId, limit } = req.query;

    const result = await rolesService.searchRolesForOnboarding({
      q: q ? String(q).trim() : undefined,
      jobFamilyId: jobFamilyId
        ? String(jobFamilyId).trim()
        : undefined,
      limit: parseSafeLimit(limit, 30, 100),
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/onboarding/suggest-roles
// ─────────────────────────────────────────────────────────────────────────────
async function suggestRolesForOnboarding(req, res, next) {
  try {
    const { q, limit } = req.query;
    const jobTitle = String(q || '').trim();

    if (!jobTitle) {
      return res.status(200).json({
        success: true,
        data: {
          suggestions: [],
          total: 0,
        },
      });
    }

    const result = await rolesService.suggestRolesForOnboarding({
      jobTitle,
      limit: parseSafeLimit(limit, 5, 10),
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listRoles,
  getRoleById,
  searchRolesForOnboarding,
  suggestRolesForOnboarding,
  saveOnboardingRoles,
  getOnboardingRoles,
};