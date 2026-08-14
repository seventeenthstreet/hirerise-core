'use strict';

/**
 * @file src/modules/admin/permissions/services/permissionEvaluationAdmin.service.js
 *
 * WP-ADMIN-04F-08 — Enterprise Permission Administration API
 *
 * A pure passthrough to the certified Authorization Evaluation Engine
 * (WP-ADMIN-04F-05). This file exists only to satisfy this codebase's
 * architectural rule that controllers must never import an `*.engine.js`
 * module directly (`no-controller-importing-engine`, enforced by
 * `.dependency-cruiser.cjs`) — it introduces no evaluation logic of its
 * own, adds no branching on the Decision outcome, and forwards its
 * single method's arguments and return value unchanged.
 */

const { authorizationEvaluationEngine: defaultEvaluationEngine } = require('../../../../domain/permission/evaluation/permission.evaluation.engine');

/**
 * @param {import('../../../../domain/permission/evaluation/permission.evaluation.engine').AuthorizationEvaluationEngine} [evaluationEngine]
 */
function createPermissionEvaluationAdminService(evaluationEngine = defaultEvaluationEngine) {
  return {
    /**
     * @param {Object} request
     * @param {string} request.userId
     * @param {import('../../../../domain/permission/permission.types').Resource} request.resource
     * @param {import('../../../../domain/permission/permission.types').Action} request.action
     * @param {string} [request.resourceId]
     * @param {Object.<string, *>} [request.metadata]
     * @returns {Promise<import('../../../../domain/permission/evaluation/permission.evaluation.engine').EvaluationResult>}
     */
    async evaluate(request) {
      return evaluationEngine.evaluate(request);
    },
  };
}

module.exports = {
  createPermissionEvaluationAdminService,
  permissionEvaluationAdminService: createPermissionEvaluationAdminService(),
};
