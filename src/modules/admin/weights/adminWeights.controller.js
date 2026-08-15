'use strict';

/**
 * adminWeights.controller.js — HTTP handlers for the Signal Weight /
 * Model Version Registry (read-only)
 *
 * WP-ADMIN-COMP-08-R23
 *
 * Response envelope matches the existing HireRise convention (see
 * adminUsers.controller.js / adminCmsSkills.controller.js):
 *   { success: true, data: {...} }
 *   { success: false, error: { code, message }, ... }  (via the global
 *     error handler — errors are thrown, not hand-formatted here)
 *
 * @module modules/admin/weights/adminWeights.controller
 */

const { asyncHandler } = require('../../../utils/helpers');
const weightsService = require('./adminWeights.service');
const logger = require('../../../utils/logger');

// ── GET /api/v1/admin/weights ────────────────────────────────────────────

const listVersions = asyncHandler(async (req, res) => {
  const { intelligenceDomain, modelType } = req.query;

  const result = await weightsService.listVersions({
    intelligenceDomain: intelligenceDomain || undefined,
    modelType: modelType || undefined,
  });

  logger.info('[AdminWeights] Listed signal weight/model versions', {
    adminId: req.user?.id,
    intelligenceDomain: intelligenceDomain || null,
    modelType: modelType || null,
    count: result.items.length,
  });

  return res.status(200).json({
    success: true,
    data: { items: result.items },
  });
});

// ── GET /api/v1/admin/weights/active ─────────────────────────────────────

const getActiveVersion = asyncHandler(async (req, res) => {
  const { intelligenceDomain, modelType } = req.query;

  const active = await weightsService.getActiveVersion({
    intelligenceDomain: intelligenceDomain || undefined,
    modelType: modelType || undefined,
  });

  logger.info('[AdminWeights] Resolved active model version', {
    adminId: req.user?.id,
    intelligenceDomain: intelligenceDomain || null,
    modelType: modelType || null,
    resolvedVersionId: active.id,
  });

  return res.status(200).json({ success: true, data: active });
});

module.exports = { listVersions, getActiveVersion };
