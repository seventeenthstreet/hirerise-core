'use strict';

/**
 * src/modules/master/master.routes.js
 *
 * MASTER_ADMIN External API Management Routes
 *
 * FULL SUPABASE HARDENING:
 * - Preserves existing REST contract
 * - Keeps repository-managed encryption + masking
 * - Removes legacy camelCase DB assumptions from route payloads
 * - Improves patch safety
 * - Adds providerName patch support
 * - Improves validation consistency
 * - Keeps admin audit behavior unchanged
 */

const express = require('express');
const { body, param } = require('express-validator');
const { validate } = require('../../middleware/requestValidator');
const { asyncHandler } = require('../../utils/helpers');
const externalApiRepo = require('./externalApi.repository');
const { logAdminAction } = require('../../utils/adminAuditLogger');

const router = express.Router();

/* ────────────────────────────────────────────────────────────────────────── */
/* Validation */
/* ────────────────────────────────────────────────────────────────────────── */

const idValidation = [
  param('id')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('id is required'),
];

const createApiValidation = [
  body('providerName')
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: 100 })
    .withMessage('providerName is required'),

  body('baseUrl')
    .isURL()
    .withMessage('baseUrl must be a valid URL'),

  body('apiKey')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('apiKey is required'),

  body('rateLimit')
    .optional()
    .isInt({ min: 1 })
    .toInt()
    .withMessage('rateLimit must be a positive integer'),

  body('enabled')
    .optional()
    .isBoolean()
    .toBoolean()
    .withMessage('enabled must be boolean'),
];

const patchApiValidation = [
  ...idValidation,

  body('providerName')
    .optional()
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: 100 }),

  body('apiKey')
    .optional()
    .isString()
    .trim()
    .notEmpty(),

  body('baseUrl')
    .optional()
    .isURL(),

  body('rateLimit')
    .optional()
    .isInt({ min: 1 })
    .toInt(),

  body('enabled')
    .optional()
    .isBoolean()
    .toBoolean(),
];

/* ────────────────────────────────────────────────────────────────────────── */
/* POST /api/v1/master/apis */
/* ────────────────────────────────────────────────────────────────────────── */

router.post(
  '/',
  validate(createApiValidation),
  asyncHandler(async (req, res) => {
    const adminId = req.user.id;

    const created = await externalApiRepo.create(
      {
        providerName: req.body.providerName,
        baseUrl: req.body.baseUrl,
        apiKey: req.body.apiKey,
        rateLimit: req.body.rateLimit ?? 1000,
        enabled: req.body.enabled ?? false,
        lastSync: null,
      },
      adminId
    );

    await logAdminAction({
      adminId,
      action: 'API_REGISTERED',
      entityType: 'external_salary_apis',
      entityId: created.id,
      metadata: {
        providerName: created.providerName,
        baseUrl: created.baseUrl,
      },
      ipAddress: req.ip,
    });

    return res.status(201).json({
      success: true,
      data: created,
    });
  })
);

/* ────────────────────────────────────────────────────────────────────────── */
/* GET /api/v1/master/apis */
/* ────────────────────────────────────────────────────────────────────────── */

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const apis = await externalApiRepo.listAll();

    return res.status(200).json({
      success: true,
      data: apis,
      count: apis.length,
    });
  })
);

/* ────────────────────────────────────────────────────────────────────────── */
/* PATCH /api/v1/master/apis/:id */
/* ────────────────────────────────────────────────────────────────────────── */

router.patch(
  '/:id',
  validate(patchApiValidation),
  asyncHandler(async (req, res) => {
    const adminId = req.user.id;
    const updates = {};

    if (req.body.providerName !== undefined) {
      updates.providerName = req.body.providerName;
    }

    if (req.body.apiKey !== undefined) {
      updates.apiKey = req.body.apiKey;
    }

    if (req.body.baseUrl !== undefined) {
      updates.baseUrl = req.body.baseUrl;
    }

    if (req.body.rateLimit !== undefined) {
      updates.rateLimit = req.body.rateLimit;
    }

    if (req.body.enabled !== undefined) {
      updates.enabled = req.body.enabled;
    }

    const updated = await externalApiRepo.update(
      req.params.id,
      updates,
      adminId
    );

    await logAdminAction({
      adminId,
      action: 'API_UPDATED',
      entityType: 'external_salary_apis',
      entityId: req.params.id,
      metadata: {
        fields: Object.keys(updates),
      },
      ipAddress: req.ip,
    });

    return res.status(200).json({
      success: true,
      data: updated,
    });
  })
);

/* ────────────────────────────────────────────────────────────────────────── */
/* DELETE /api/v1/master/apis/:id */
/* ────────────────────────────────────────────────────────────────────────── */

router.delete(
  '/:id',
  validate(idValidation),
  asyncHandler(async (req, res) => {
    const adminId = req.user.id;

    await externalApiRepo.softDelete(req.params.id, adminId);

    await logAdminAction({
      adminId,
      action: 'API_DELETED',
      entityType: 'external_salary_apis',
      entityId: req.params.id,
      metadata: {},
      ipAddress: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: 'API configuration deleted.',
    });
  })
);

module.exports = router;