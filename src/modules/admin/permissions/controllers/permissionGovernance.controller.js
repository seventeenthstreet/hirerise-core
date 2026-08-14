'use strict';

/**
 * @file src/modules/admin/permissions/controllers/permissionGovernance.controller.js
 *
 * WP-ADMIN-05C — Enterprise Permission Governance Integration
 *
 * Transport layer only. Every method here forwards to exactly one method
 * on the Permission Governance Integration Service (this WP) — no
 * lifecycle logic lives here, and this file never imports the Governance
 * domain service or the Registry directly.
 */

const { permissionGovernanceIntegrationService: defaultIntegrationService } = require('../services/permissionGovernance.integration');
const { translateDomainError } = require('../errors/permissionAdmin.errorMap');

function ok(res, data) {
  return res.json({ success: true, data });
}

/**
 * @param {import('../services/permissionGovernance.integration').PermissionGovernanceIntegrationService} [integrationService]
 */
function createPermissionGovernanceController(integrationService = defaultIntegrationService) {
  function makeTransitionHandler(method) {
    return async function transitionHandler(req, res, next) {
      try {
        const updated = await integrationService[method](req.params.id, req.adminPrincipal?.uid, req.ip);
        return ok(res, updated);
      } catch (error) {
        if (translateDomainError(error, req, res)) return undefined;
        return next(error);
      }
    };
  }

  return {
    approve: makeTransitionHandler('approve'),
    publish: makeTransitionHandler('publish'),
    adopt: makeTransitionHandler('adopt'),
    deprecate: makeTransitionHandler('deprecate'),
    retire: makeTransitionHandler('retire'),
  };
}

module.exports = {
  createPermissionGovernanceController,
  permissionGovernanceController: createPermissionGovernanceController(),
};
