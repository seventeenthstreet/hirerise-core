'use strict';

/**
 * roles.controller.js — HTTP handlers for the Roles module.
 *
 * Responsibilities:
 *   - Extract userId from req.user.uid (set by auth.middleware)
 *   - Extract plan from req.user.plan (set by auth.middleware)
 *   - Delegate to roles.service for all business logic
 *   - Return consistent { success, data } envelope
 *
 * No business logic lives here. If you find yourself writing an if-statement
 * about role IDs or tier limits in this file, move it to roles.service.js.
 */

const rolesService = require('../roles.service');
const { AppError: _AppError, ErrorCodes: _ErrorCodes } = require('../../../middleware/errorHandler');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

// ─── GET /api/v1/roles ────────────────────────────────────────────────────────

async function listRoles(req, res, next) {
  try {
    const { search, category, limit } = req.query; // already validated + coerced by Zod
    const result = await rolesService.listRoles({ search, category, limit });

    return res.status(200).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/v1/roles/:roleId ────────────────────────────────────────────────

async function getRoleById(req, res, next) {
  try {
    const { roleId } = req.params;

    if (!roleId || typeof roleId !== 'string' || !roleId.trim()) {
      return next(new AppError(
        'roleId param is required.',
        400,
        { roleId },
        ErrorCodes.VALIDATION_ERROR
      ));
    }

    const role = await rolesService.getRoleById(roleId.trim());

    return res.status(200).json({
      success: true,
      data:    { role },
    });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/v1/onboarding/roles ───────────────────────────────────────────

async function saveOnboardingRoles(req, res, next) {
  try {
    const userId = req.user?.uid;
    const plan   = req.user?.plan ?? 'free';

    if (!userId) {
      return next(new AppError('Authentication required.', 401, {}, ErrorCodes.UNAUTHORIZED));
    }

    // req.body is already validated + stripped by the Zod middleware in the route
    const result = await rolesService.saveOnboardingRoles(userId, plan, req.body);

    return res.status(200).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/v1/onboarding/roles ────────────────────────────────────────────
// Returns the user's saved role profile. Useful for the frontend to pre-fill
// the onboarding form on revisit.

async function getOnboardingRoles(req, res, next) {
  try {
    const userId = req.user?.uid;

    if (!userId) {
      return next(new AppError('Authentication required.', 401, {}, ErrorCodes.UNAUTHORIZED));
    }

    const profile = await rolesService.getUserProfile(userId);

    return res.status(200).json({
      success: true,
      data:    { profile },
    });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/v1/roles/search (FIX G-06) ─────────────────────────────────────

/**
 * FIX G-06: Onboarding-specific role search.
 *
 * Query params:
 *   q           — text search across title + aliases
 *   jobFamilyId — filter by job family (for grouped hierarchy)
 *   limit       — max results (default 30)
 *
 * Response includes both a flat `roles[]` array and a `grouped[]` structure
 * keyed by jobFamilyId — frontend can choose which to render.
 */
async function searchRolesForOnboarding(req, res, next) {
  try {
    const { q, jobFamilyId, limit } = req.query;
    const parsedLimit = limit ? Math.min(parseInt(limit, 10) || 30, 100) : 30;

    const result = await rolesService.searchRolesForOnboarding({
      q:           q           ? String(q).trim()           : undefined,
      jobFamilyId: jobFamilyId ? String(jobFamilyId).trim() : undefined,
      limit:       parsedLimit,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listRoles,
  getRoleById,
  searchRolesForOnboarding, // G-06
  saveOnboardingRoles,
  getOnboardingRoles,
};