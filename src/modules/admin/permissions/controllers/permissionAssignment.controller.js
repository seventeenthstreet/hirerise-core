'use strict';

/**
 * @file src/modules/admin/permissions/controllers/permissionAssignment.controller.js
 *
 * WP-ADMIN-04F-08 — Enterprise Permission Administration API
 *
 * Transport layer only. Every method here forwards to exactly one method
 * on the certified Permission Assignment Service (WP-ADMIN-04F-06) — no
 * assignment/grantability logic lives here, and this file never imports
 * the Assignment Repository directly.
 */

const { permissionAssignmentService: defaultAssignmentService } = require('../../../../domain/permission/assignment/permission.assignment.service');
const { buildPermissionName } = require('../../../../domain/permission/permission.model');
const { translateDomainError } = require('../errors/permissionAdmin.errorMap');
const { logAdminAction } = require('../../../../utils/adminAuditLogger');
const { ACTIONS: PERMISSION_AUDIT_ACTIONS, buildPermissionAuditEvent } = require('../audit/permissionAudit.constants');
const { enrichAssignmentsWithIdentity: defaultEnrichAssignmentsWithIdentity } = require('../identity/assignmentIdentity');

/**
 * Fire-and-forget audit emission — WP-ADMIN-05B.
 *
 * Mirrors the established pattern (requireAdmin.middleware.js,
 * mfa.service.js, adminPrincipal.repository.js): runs after the mutation
 * has already succeeded, never awaited by the response path, and its own
 * failure is swallowed (logAdminAction() itself never throws — see
 * adminAuditLogger.js — this catch is defense in depth only).
 * @private
 */
function emitPermissionAudit(action, adminId, entityId, metadata, ipAddress) {
  logAdminAction(buildPermissionAuditEvent(action, adminId, entityId, metadata, ipAddress)).catch(() => {});
}

function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}

/**
 * @param {import('../../../../domain/permission/assignment/permission.assignment.service').PermissionAssignmentService} [assignmentService]
 * @param {(assignments: object[]) => Promise<object[]>} [enrichAssignmentsWithIdentity]
 *   Blocker 3A — batch-resolves each Assignment's `principal` (email/
 *   displayName) for display. Presentation-only: never alters
 *   `principalId` or any other Assignment field. Injectable for tests.
 */
function createPermissionAssignmentController(
  assignmentService = defaultAssignmentService,
  enrichAssignmentsWithIdentity = defaultEnrichAssignmentsWithIdentity
) {
  return {
    async assignPermission(req, res, next) {
      try {
        const { principalId, resource, action } = req.body;

        // Pre-check, read-only: assignPermission() is idempotent and
        // returns the existing Assignment silently on a repeat request.
        // Only a genuine state change gets an audit event — see
        // WP-ADMIN-05B decision. This does not alter Assignment's own
        // idempotency contract; it only observes it beforehand.
        const alreadyAssigned = await assignmentService.hasAssignment({ principalId, resource, action });

        const assignment = await assignmentService.assignPermission({ principalId, resource, action });

        if (!alreadyAssigned) {
          emitPermissionAudit(
            PERMISSION_AUDIT_ACTIONS.ASSIGNED,
            req.adminPrincipal?.uid,
            buildPermissionName(resource, action),
            { principalId },
            req.ip
          );
        }

        return ok(res, assignment, 201);
      } catch (error) {
        if (translateDomainError(error, req, res)) return undefined;
        return next(error);
      }
    },

    async revokePermission(req, res, next) {
      try {
        const { principalId, resource, action } = req.body;
        const revoked = await assignmentService.revokePermission({ principalId, resource, action });

        // revokePermission() already reports genuine-mutation-or-not via
        // its boolean return — no pre-check needed here.
        if (revoked) {
          emitPermissionAudit(
            PERMISSION_AUDIT_ACTIONS.REVOKED,
            req.adminPrincipal?.uid,
            buildPermissionName(resource, action),
            { principalId },
            req.ip
          );
        }

        return ok(res, { revoked });
      } catch (error) {
        if (translateDomainError(error, req, res)) return undefined;
        return next(error);
      }
    },

    async checkAssignment(req, res, next) {
      try {
        const { principalId, resource, action } = req.query;
        const assigned = await assignmentService.hasAssignment({ principalId, resource, action });
        return ok(res, { assigned });
      } catch (error) {
        if (translateDomainError(error, req, res)) return undefined;
        return next(error);
      }
    },

    async listAssignments(req, res, next) {
      try {
        const { resource, action } = req.query;
        const assignments = await assignmentService.listAssignments({ resource, action });
        const enriched = await enrichAssignmentsWithIdentity(assignments);
        return ok(res, { assignments: enriched });
      } catch (error) {
        if (translateDomainError(error, req, res)) return undefined;
        return next(error);
      }
    },

    async getAssignmentsForPrincipal(req, res, next) {
      try {
        const assignments = await assignmentService.getAssignments({ principalId: req.params.principalId });
        const enriched = await enrichAssignmentsWithIdentity(assignments);
        return ok(res, { assignments: enriched });
      } catch (error) {
        if (translateDomainError(error, req, res)) return undefined;
        return next(error);
      }
    },
  };
}

module.exports = {
  createPermissionAssignmentController,
  permissionAssignmentController: createPermissionAssignmentController(),
};
