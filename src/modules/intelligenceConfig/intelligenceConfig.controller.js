'use strict';

/**
 * @file src/modules/intelligenceConfig/intelligenceConfig.controller.js
 *
 * WP-ADMIN-INTEL-04 — thin HTTP controller for ordinary, non-secret
 * Intelligence configuration administration. Mirrors
 * intelligenceSecrets.controller.js's shape (sendSuccess / sendError,
 * getAdminId, handleError) for consistency with the sibling INTEL-03
 * admin API this sits next to.
 */

const logger = require('../../utils/logger');
const { sendSuccess, sendError } = require('../../shared/response');
const svc = require('./intelligenceConfig.service');

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
    const settings = await svc.listSettings();
    return sendSuccess(res, { settings });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const setting = await svc.getSetting(req.params.key);
    return sendSuccess(res, { setting });
  } catch (err) {
    return handleError(res, err, next);
  }
}

async function update(req, res, next) {
  try {
    const { value } = req.body ?? {};
    const adminId = getAdminId(req);

    if (typeof value !== 'string') {
      return sendError(res, 400, 'value (string) is required', 'INVALID_INPUT');
    }

    const setting = await svc.updateSetting(req.params.key, value, adminId);
    return sendSuccess(res, { setting }, {}, {}, 200);
  } catch (err) {
    logger.error('[IntelligenceConfigCtrl] update failed', {
      key: req.params?.key,
      message: err.message,
    });
    return handleError(res, err, next);
  }
}

async function reset(req, res, next) {
  try {
    const adminId = getAdminId(req);
    const setting = await svc.resetSetting(req.params.key, adminId);
    return sendSuccess(res, { setting });
  } catch (err) {
    return handleError(res, err, next);
  }
}

module.exports = {
  list,
  getOne,
  update,
  reset,
};
