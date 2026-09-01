'use strict';

/**
 * @file src/modules/intelligenceSecrets/intelligenceSecrets.controller.js
 *
 * WP-ADMIN-INTEL-03 — thin HTTP controller for Intelligence provider
 * secret administration. Uses the canonical V2 response helpers
 * (sendSuccess / sendError), matching secrets.controller.js.
 *
 * The submitted credential `value` is deliberately validated here (not via
 * an express-validator chain): express-validator's failure path can echo
 * `err.value` back into the response body in non-production environments
 * (see requestValidator.js), which would leak the raw credential on a
 * validation failure. Manual validation avoids that entirely — mirrors the
 * existing secrets.controller.js's own `createOrUpdate` handling of `value`.
 */

const logger = require('../../utils/logger');
const { sendSuccess, sendError } = require('../../shared/response');
const svc = require('./intelligenceSecrets.service');

function getAdminId(req) {
  return req?.user?.id || req?.user?.user_id || null;
}

function handleError(res, err, next) {
  if (err?.status && err.status < 500) {
    return sendError(res, err.status, err.message, err.code || 'BAD_REQUEST');
  }
  return next(err);
}

async function list(req, res, next) {
  try {
    const result = await svc.listProviders();
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

async function getStatus(req, res, next) {
  try {
    const result = await svc.getProvider(req.params.provider);
    return sendSuccess(res, { provider: result });
  } catch (err) {
    return handleError(res, err, next);
  }
}

async function createOrUpdate(req, res, next) {
  try {
    const { value } = req.body ?? {};
    const adminId = getAdminId(req);

    if (!value || typeof value !== 'string') {
      return sendError(res, 400, 'value required', 'INVALID_INPUT');
    }

    const result = await svc.saveProvider(req.params.provider, value, adminId);

    // Never echoes `value` — only the masked preview + safe metadata the
    // underlying Secrets Manager already returns from upsertSecret().
    return sendSuccess(res, { provider: result }, {}, {}, 200);
  } catch (err) {
    logger.error('[IntelligenceSecretsCtrl] createOrUpdate failed', {
      provider: req.params?.provider,
      message: err.message,
    });
    return handleError(res, err, next);
  }
}

async function deleteProvider(req, res, next) {
  try {
    const adminId = getAdminId(req);
    const result = await svc.deleteProvider(req.params.provider, adminId);
    return sendSuccess(res, { provider: result });
  } catch (err) {
    return handleError(res, err, next);
  }
}

module.exports = {
  list,
  getStatus,
  createOrUpdate,
  deleteProvider,
};
