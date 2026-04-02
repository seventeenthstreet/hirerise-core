'use strict';

/**
 * jobApplications.controller.js (Supabase Optimized)
 *
 * Principles:
 * - No DB logic (delegated to service)
 * - Uses Supabase auth user id (req.user.id)
 * - Clean pagination inputs (cursor-based)
 * - No redundant parsing / unsafe defaults
 */

const {
  addApplication,
  getApplications,
  updateApplication,
  deleteApplication,
} = require('../jobApplications.service');

// ─────────────────────────────────────────────
// 🔹 SAFE USER ID (Supabase-first)
// ─────────────────────────────────────────────

function _safeUserId(req) {
  // Supabase → req.user.id
  // fallback for legacy tokens if any
  return req?.user?.id ?? req?.user?.uid ?? null;
}

// ─────────────────────────────────────────────
// 🔹 CREATE APPLICATION
// ─────────────────────────────────────────────

async function create(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    const tier = req.user?.plan || 'free';

    const { id } = await addApplication(userId, tier, req.body);

    return res.status(201).json({
      success: true,
      data: { id },
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// 🔹 LIST APPLICATIONS (Cursor Pagination)
// ─────────────────────────────────────────────

async function list(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    const tier = req.user?.plan || 'free';

    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100); // hard cap
    const cursor = req.query.cursor || null;
    const status = req.query.status || null;

    const { applications, hasMore, nextCursor } =
      await getApplications(userId, tier, {
        limit,
        cursor,
        status,
      });

    return res.status(200).json({
      success: true,
      data: {
        applications,
        pagination: {
          hasMore,
          nextCursor,
          limit,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// 🔹 UPDATE APPLICATION
// ─────────────────────────────────────────────

async function update(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    const applicationId = req.params.id;

    const application = await updateApplication(
      applicationId,
      userId,
      req.body
    );

    return res.status(200).json({
      success: true,
      data: { application },
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────
// 🔹 DELETE APPLICATION
// ─────────────────────────────────────────────

async function remove(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    const applicationId = req.params.id;

    await deleteApplication(applicationId, userId);

    return res.status(200).json({
      success: true,
      data: {
        deleted: true,
        id: applicationId,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  create,
  list,
  update,
  remove,
};