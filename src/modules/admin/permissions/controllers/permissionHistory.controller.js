'use strict';

/**
 * @file src/modules/admin/permissions/controllers/permissionHistory.controller.js
 *
 * WP-ADMIN-05D — Enterprise Permission Audit & Governance History
 *
 * Transport layer only: request/response shaping, delegating every call
 * 1:1 to the Permission History Integration Service. No history-assembly
 * logic, no direct Repository or Registry access — mirrors every other
 * controller in this module (permissionRegistry.controller.js,
 * permissionGovernance.controller.js).
 */

const { permissionHistoryIntegrationService: defaultIntegrationService } = require('../services/permissionHistory.integration');

function ok(res, data) {
  return res.json({ success: true, data });
}

function notFound(req, res, message) {
  return res.status(404).json({
    success: false,
    error: { code: 'PERMISSION_NOT_FOUND', message },
    meta: { requestId: req?.requestId ?? null, timestamp: new Date().toISOString() },
  });
}

/**
 * Parses the shared History query-filter shape (pagination, action,
 * administrator, date range, sort) already validated by
 * permissionAdmin.validators.js's `historyQuery`. Only picks known
 * keys through — never forwards arbitrary query params to the
 * Integration Service / Repository.
 */
function historyQueryOptions(req) {
  const { limit, offset, action, adminId, dateFrom, dateTo, sort } = req.query;
  const options = {};
  if (limit !== undefined) options.limit = limit;
  if (offset !== undefined) options.offset = offset;
  if (action !== undefined) options.action = action;
  if (adminId !== undefined) options.adminId = adminId;
  if (dateFrom !== undefined) options.dateFrom = dateFrom;
  if (dateTo !== undefined) options.dateTo = dateTo;
  if (sort !== undefined) options.sort = sort;
  return options;
}

/**
 * @param {import('../services/permissionHistory.integration').PermissionHistoryIntegrationService} [integrationService]
 */
function createPermissionHistoryController(integrationService = defaultIntegrationService) {
  return {
    /** GET /permissions/:id/history — one Permission's unified Assignment + Governance timeline. */
    async getHistoryForPermission(req, res, next) {
      try {
        const result = await integrationService.getHistoryForPermission(req.params.id, historyQueryOptions(req));
        if (!result) return notFound(req, res, `No Permission found for id "${req.params.id}".`);
        return ok(res, result);
      } catch (error) {
        return next(error);
      }
    },

    /** GET /permissions/history — cross-Permission audit timeline. */
    async listHistory(req, res, next) {
      try {
        const result = await integrationService.listHistory(historyQueryOptions(req));
        return ok(res, result);
      } catch (error) {
        return next(error);
      }
    },
  };
}

module.exports = {
  createPermissionHistoryController,
  permissionHistoryController: createPermissionHistoryController(),
};
