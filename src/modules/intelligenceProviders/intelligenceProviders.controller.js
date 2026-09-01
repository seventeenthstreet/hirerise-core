'use strict';

/**
 * @file src/modules/intelligenceProviders/intelligenceProviders.controller.js
 *
 * WP-ADMIN-INTEL-06 — thin HTTP controller for the "Add Provider" flow.
 * Mirrors intelligenceSecrets.controller.js's shape (sendSuccess /
 * sendError, getAdminId, handleError, manual `value` validation to avoid
 * express-validator ever echoing a credential back on a failed rule).
 */

const logger = require('../../utils/logger');
const { sendSuccess, sendError } = require('../../shared/response');
const svc = require('./intelligenceProviders.service');

function getAdminId(req) {
  return req?.user?.id || req?.user?.user_id || null;
}

function handleError(res, err, next) {
  if (err?.status && err.status < 500) {
    const extra = err.details ? { details: err.details } : {};
    return sendError(res, err.status, err.message, err.code || 'BAD_REQUEST', extra);
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

async function getOne(req, res, next) {
  try {
    const provider = await svc.getProvider(req.params.providerKey);
    return sendSuccess(res, { provider });
  } catch (err) {
    return handleError(res, err, next);
  }
}

async function create(req, res, next) {
  try {
    const body = req.body ?? {};
    const { value, ...rest } = body;
    const adminId = getAdminId(req);

    if (value !== undefined && typeof value !== 'string') {
      return sendError(res, 400, 'value must be a string', 'INVALID_INPUT');
    }

    const provider = await svc.addProvider(rest, value, adminId);
    return sendSuccess(res, { provider }, {}, {}, 201);
  } catch (err) {
    logger.error('[IntelligenceProvidersCtrl] create failed', { message: err.message });
    return handleError(res, err, next);
  }
}

async function update(req, res, next) {
  try {
    const adminId = getAdminId(req);
    const provider = await svc.updateProvider(req.params.providerKey, req.body ?? {}, adminId);
    return sendSuccess(res, { provider });
  } catch (err) {
    logger.error('[IntelligenceProvidersCtrl] update failed', {
      providerKey: req.params?.providerKey,
      message: err.message,
    });
    return handleError(res, err, next);
  }
}

async function setCredential(req, res, next) {
  try {
    const { value } = req.body ?? {};
    const adminId = getAdminId(req);

    if (!value || typeof value !== 'string') {
      return sendError(res, 400, 'value required', 'INVALID_INPUT');
    }

    const result = await svc.setCredential(req.params.providerKey, value, adminId);
    // Never echoes `value` — only the masked preview + safe metadata.
    return sendSuccess(res, { credential: result }, {}, {}, 200);
  } catch (err) {
    logger.error('[IntelligenceProvidersCtrl] setCredential failed', {
      providerKey: req.params?.providerKey,
      message: err.message,
    });
    return handleError(res, err, next);
  }
}

async function remove(req, res, next) {
  try {
    const adminId = getAdminId(req);
    const result = await svc.removeProvider(req.params.providerKey, adminId);
    return sendSuccess(res, { provider: result });
  } catch (err) {
    return handleError(res, err, next);
  }
}

module.exports = {
  list,
  getOne,
  create,
  update,
  setCredential,
  remove,
};
