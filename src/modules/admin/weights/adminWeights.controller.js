'use strict';

/**
 * adminWeights.controller.js — HTTP handlers for the Signal Weight /
 * Model Version Registry
 *
 * WP-ADMIN-COMP-08-R23 (read-only foundation) + R24 (draft creation) +
 * R25 (approval)
 *
 * Response envelope matches the existing HireRise convention (see
 * adminUsers.controller.js / adminCmsSkills.controller.js):
 *   { success: true, data: {...} }
 *   { success: false, error: { code, message }, ... }  (via the global
 *     error handler — errors are thrown, not hand-formatted here)
 *
 * createVersion() follows adminCmsRoles.controller.js's createRole()
 * convention for a creation response: 201 + { success, data, meta }
 * (vs. the 200 used by this module's existing GET handlers).
 *
 * approveVersion() (R25) returns 200 + { success, data } — a lifecycle
 * transition on an existing resource, not a creation, so it follows the
 * GET handlers' envelope shape rather than createVersion()'s 201+meta
 * one. The version id comes only from req.params.id; the approving actor
 * comes only from req.user.id (set by the authenticate middleware) — no
 * lifecycle field is ever read from req.body here.
 *
 * deprecateVersion() (R26) follows the identical envelope/identity
 * pattern as approveVersion() — 200 + { success, data }, id from
 * req.params.id only, actor from req.user.id only (used solely for the
 * audit log — see service doc comment; no lifecycle field is read from
 * req.body, matching approveVersion()).
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

// ── POST /api/v1/admin/weights ───────────────────────────────────────────

const createVersion = asyncHandler(async (req, res) => {
  const adminId = req.user?.id;

  const {
    versionTag,
    modelType,
    intelligenceDomain,
    description,
    weights,
    domainOverrides,
    weightRationale,
    effectiveFrom,
  } = req.body;

  const created = await weightsService.createVersion({
    versionTag,
    modelType,
    intelligenceDomain,
    description,
    weights,
    domainOverrides,
    weightRationale,
    effectiveFrom,
  });

  logger.info('[AdminWeights] Created draft model version', {
    adminId: adminId || null,
    versionId: created.id,
    intelligenceDomain: created.intelligenceDomain,
    modelType: created.modelType,
    versionTag: created.versionTag,
  });

  return res.status(201).json({
    success: true,
    data: created,
    meta: {
      createdByAdminId: adminId || null,
      timestamp: new Date().toISOString(),
    },
  });
});

// ── POST /api/v1/admin/weights/:id/approve ───────────────────────────────

const approveVersion = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const adminId = req.user?.id;

  const approved = await weightsService.approveVersion(id, adminId);

  logger.info('[AdminWeights] Approved model version', {
    adminId: adminId || null,
    versionId: approved.id,
    intelligenceDomain: approved.intelligenceDomain,
    modelType: approved.modelType,
    versionTag: approved.versionTag,
  });

  return res.status(200).json({
    success: true,
    data: approved,
  });
});

// ── POST /api/v1/admin/weights/:id/deprecate ─────────────────────────────

const deprecateVersion = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const adminId = req.user?.id;

  const deprecated = await weightsService.deprecateVersion(id, adminId);

  logger.info('[AdminWeights] Deprecated model version', {
    adminId: adminId || null,
    versionId: deprecated.id,
    intelligenceDomain: deprecated.intelligenceDomain,
    modelType: deprecated.modelType,
    versionTag: deprecated.versionTag,
  });

  return res.status(200).json({
    success: true,
    data: deprecated,
  });
});

module.exports = {
  listVersions,
  getActiveVersion,
  createVersion,
  approveVersion,
  deprecateVersion,
};