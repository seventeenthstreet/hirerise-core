'use strict';

/**
 * master.routes.js — MASTER_ADMIN External API Management Routes
 *
 * SECURITY UPGRADE: apiKey encryption/masking is now handled entirely
 * in externalApi.repository.js. Routes no longer need sanitizeApiRecord().
 * The repository's create() and update() methods return masked records directly.
 *
 * Routes:
 *   POST   /api/v1/master/apis     → register new external salary API
 *   GET    /api/v1/master/apis     → list all external APIs (keys masked)
 *   PATCH  /api/v1/master/apis/:id → update API config
 *   DELETE /api/v1/master/apis/:id → soft-delete API
 *
 * @module modules/master/master.routes
 */

const express          = require('express');
const { body, param }  = require('express-validator');
const { validate }     = require('../../middleware/requestValidator');
const { asyncHandler } = require('../../utils/helpers');
const externalApiRepo  = require('./externalApi.repository');
const { logAdminAction } = require('../../utils/adminAuditLogger');

const router = express.Router();

// ── Validation ────────────────────────────────────────────────────────────────

const createApiValidation = [
  body('providerName').isString().trim().notEmpty().isLength({ max: 100 })
    .withMessage('providerName is required'),
  body('baseUrl').isURL().withMessage('baseUrl must be a valid URL'),
  body('apiKey').isString().trim().notEmpty()
    .withMessage('apiKey is required'),
  body('rateLimit').optional().isInt({ min: 1 }).toInt()
    .withMessage('rateLimit must be a positive integer'),
  body('enabled').optional().isBoolean().toBoolean()
    .withMessage('enabled must be boolean'),
];

const patchApiValidation = [
  param('id').isString().trim().notEmpty().withMessage('id is required'),
  body('apiKey').optional().isString().trim().notEmpty(),
  body('baseUrl').optional().isURL(),
  body('rateLimit').optional().isInt({ min: 1 }).toInt(),
  body('enabled').optional().isBoolean().toBoolean(),
];

// ── POST /api/v1/master/apis ──────────────────────────────────────────────────
router.post(
  '/',
  validate(createApiValidation),
  asyncHandler(async (req, res) => {
    const adminId = req.user.uid;

    // Repository encrypts apiKey before storing, returns masked record
    const created = await externalApiRepo.create({
      providerName: req.body.providerName,
      baseUrl:      req.body.baseUrl,
      apiKey:       req.body.apiKey,
      rateLimit:    req.body.rateLimit ?? 1000,
      enabled:      req.body.enabled  ?? false,
      lastSync:     null,
    }, adminId);

    await logAdminAction({
      adminId,
      action:     'API_REGISTERED',
      entityType: 'external_salary_apis',
      entityId:   created.id,
      metadata:   { providerName: created.providerName, baseUrl: created.baseUrl },
      ipAddress:  req.ip,
    });

    return res.status(201).json({ success: true, data: created });
  })
);

// ── GET /api/v1/master/apis ───────────────────────────────────────────────────
router.get(
  '/',
  asyncHandler(async (req, res) => {
    // listAll() returns masked records
    const apis = await externalApiRepo.listAll();
    return res.status(200).json({ success: true, data: apis, count: apis.length });
  })
);

// ── PATCH /api/v1/master/apis/:id ─────────────────────────────────────────────
router.patch(
  '/:id',
  validate(patchApiValidation),
  asyncHandler(async (req, res) => {
    const adminId = req.user.uid;
    const updates = {};

    if (req.body.apiKey    !== undefined) updates.apiKey    = req.body.apiKey;
    if (req.body.baseUrl   !== undefined) updates.baseUrl   = req.body.baseUrl;
    if (req.body.rateLimit !== undefined) updates.rateLimit = req.body.rateLimit;
    if (req.body.enabled   !== undefined) updates.enabled   = req.body.enabled;

    // Repository re-encrypts apiKey if present, returns masked record
    const updated = await externalApiRepo.update(req.params.id, updates, adminId);

    await logAdminAction({
      adminId,
      action:     'API_UPDATED',
      entityType: 'external_salary_apis',
      entityId:   req.params.id,
      metadata:   { fields: Object.keys(updates) },
      ipAddress:  req.ip,
    });

    return res.status(200).json({ success: true, data: updated });
  })
);

// ── DELETE /api/v1/master/apis/:id ───────────────────────────────────────────
router.delete(
  '/:id',
  validate([param('id').isString().trim().notEmpty()]),
  asyncHandler(async (req, res) => {
    const adminId = req.user.uid;
    await externalApiRepo.softDelete(req.params.id, adminId);

    await logAdminAction({
      adminId,
      action:     'API_DELETED',
      entityType: 'external_salary_apis',
      entityId:   req.params.id,
      metadata:   {},
      ipAddress:  req.ip,
    });

    return res.status(200).json({ success: true, message: 'API configuration deleted.' });
  })
);

module.exports = router;








