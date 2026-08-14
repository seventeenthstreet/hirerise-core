'use strict';

/**
 * administrators.controller.js — HTTP handlers for Enterprise Administrator
 * Management (WP-ADMIN-05A).
 *
 * Response envelope matches the existing HireRise convention (see
 * adminUsers.controller.js):
 *   { success: true, data: {...} }
 *   { success: false, error: { code, message }, details: {...} }
 *
 * Every handler is a thin transport-layer wrapper around
 * administrators.service.js — no lifecycle decision is made here.
 *
 * @module modules/admin/administrators/administrators.controller
 */

const { asyncHandler } = require('../../../utils/helpers');
const service = require('./administrators.service');
const logger = require('../../../utils/logger');

// ── GET /api/v1/admin/administrators ───────────────────────────────────────

const listAdministrators = asyncHandler(async (req, res) => {
  const { limit, offset, search, status } = req.query;

  const result = await service.listAdministrators({
    status: status || undefined,
    search: search || undefined,
    limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
    offset: offset ? Math.max(parseInt(offset, 10), 0) : 0,
  });

  logger.info('[AdministratorManagement] Listed administrators', {
    adminId: req.user?.id,
    count: result.administrators.length,
    total: result.total,
  });

  return res.status(200).json({
    success: true,
    data: { items: result.administrators, total: result.total },
  });
});

// ── GET /api/v1/admin/administrators/:uid ───────────────────────────────────

const getAdministrator = asyncHandler(async (req, res) => {
  const administrator = await service.getAdministrator(req.params.uid);

  logger.info('[AdministratorManagement] Viewed administrator detail', {
    adminId: req.user?.id,
    targetUid: req.params.uid,
  });

  return res.status(200).json({ success: true, data: administrator });
});

// ── POST /api/v1/admin/administrators/:uid/grant ────────────────────────────

const grantAdministrator = asyncHandler(async (req, res) => {
  const { uid } = req.params;
  const { role } = req.body;

  const administrator = await service.grantAdministrator(uid, role, req.user?.id);
  return res.status(200).json({ success: true, data: administrator });
});

// ── POST /api/v1/admin/administrators/:uid/suspend ──────────────────────────

const suspendAdministrator = asyncHandler(async (req, res) => {
  const { uid } = req.params;
  const { reason } = req.body;

  const administrator = await service.suspendAdministrator(uid, req.user?.id, reason || null);
  return res.status(200).json({ success: true, data: administrator });
});

// ── POST /api/v1/admin/administrators/:uid/reactivate ───────────────────────

const reactivateAdministrator = asyncHandler(async (req, res) => {
  const { uid } = req.params;

  const administrator = await service.reactivateAdministrator(uid, req.user?.id);
  return res.status(200).json({ success: true, data: administrator });
});

// ── POST /api/v1/admin/administrators/:uid/revoke ───────────────────────────

const revokeAdministrator = asyncHandler(async (req, res) => {
  const { uid } = req.params;

  const administrator = await service.revokeAdministrator(uid, req.user?.id);
  return res.status(200).json({ success: true, data: administrator });
});

module.exports = {
  listAdministrators,
  getAdministrator,
  grantAdministrator,
  suspendAdministrator,
  reactivateAdministrator,
  revokeAdministrator,
};
