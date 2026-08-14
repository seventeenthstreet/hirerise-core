'use strict';

/**
 * @file src/modules/admin/permissions/controllers/permissionEvaluation.controller.js
 *
 * WP-ADMIN-04F-08 — Enterprise Permission Administration API
 *
 * Transport layer only, exposing a single administrative endpoint that
 * lets an administrator evaluate an Authorization Decision for an
 * arbitrary (principal, resource, action) triple — forwarding to the
 * certified Authorization Evaluation Engine (WP-ADMIN-04F-05) via the
 * thin `permissionEvaluationAdmin.service.js` passthrough (required by
 * this codebase's `no-controller-importing-engine` dependency rule; see
 * that service's header — it adds no evaluation logic of its own). No
 * evaluation logic is duplicated here.
 */

const { permissionEvaluationAdminService: defaultEvaluationService } = require('../services/permissionEvaluationAdmin.service');
const { translateDomainError } = require('../errors/permissionAdmin.errorMap');

/**
 * @param {ReturnType<import('../services/permissionEvaluationAdmin.service').createPermissionEvaluationAdminService>} [evaluationService]
 */
function createPermissionEvaluationController(evaluationService = defaultEvaluationService) {
  return {
    async evaluate(req, res, next) {
      try {
        const { principalId, resource, action, resourceId, metadata } = req.body;
        const result = await evaluationService.evaluate({
          userId: principalId,
          resource,
          action,
          resourceId,
          metadata,
        });
        return res.json({ success: true, data: result });
      } catch (error) {
        if (translateDomainError(error, req, res)) return undefined;
        return next(error);
      }
    },
  };
}

module.exports = {
  createPermissionEvaluationController,
  permissionEvaluationController: createPermissionEvaluationController(),
};
