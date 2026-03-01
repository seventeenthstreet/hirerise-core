'use strict';

/**
 * jobApplications.controller.js
 *
 * Thin controller — no business logic, no Firestore.
 * Receives validated req.body/params/query, calls service, formats response.
 */

const {
  addApplication,
  getApplications,
  updateApplication,
  deleteApplication,
} = require('../jobApplications.service');

function _safeUserId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

// ─── POST /applications ───────────────────────────────────────────────────────

async function create(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const tier   = req.user.plan ?? 'free';
    const result = await addApplication(userId, tier, req.body);

    return res.status(201).json({
      success: true,
      data: { id: result.id },
    });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /applications ────────────────────────────────────────────────────────

async function list(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const tier   = req.user.plan ?? 'free';
    const limit  = parseInt(req.query.limit  || '20', 10);
    const cursor = req.query.cursor || null;
    const status = req.query.status || null;

    const result = await getApplications(userId, tier, { limit, cursor, status });

    return res.status(200).json({
      success: true,
      data: {
        applications: result.applications,
        pagination: {
          hasMore:    result.hasMore,
          nextCursor: result.nextCursor,
          limit,
        },
      },
    });
  } catch (err) {
    return next(err);
  }
}

// ─── PATCH /applications/:id ──────────────────────────────────────────────────

async function update(req, res, next) {
  try {
    const userId        = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const applicationId = req.params.id;
    const updated       = await updateApplication(applicationId, userId, req.body);

    return res.status(200).json({
      success: true,
      data: { application: updated },
    });
  } catch (err) {
    return next(err);
  }
}

// ─── DELETE /applications/:id ─────────────────────────────────────────────────

async function remove(req, res, next) {
  try {
    const userId        = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const applicationId = req.params.id;
    await deleteApplication(applicationId, userId);

    return res.status(200).json({
      success: true,
      data:    { deleted: true, id: applicationId },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { create, list, update, remove };