'use strict';

/**
 * @file src/modules/admin/permissions/controllers/permissionRegistry.controller.js
 *
 * WP-ADMIN-04F-08 — Enterprise Permission Administration API
 *
 * Transport layer only. Every method here does exactly three things:
 * parse/forward already-validated request input, call one method on the
 * certified Permission Registry (WP-ADMIN-04F-03), and shape the HTTP
 * response. No business logic, no direct Repository access — this file
 * never imports `src/domain/permission/repository/*`.
 */

const { permissionRegistry: defaultRegistry } = require('../../../../domain/permission/registry/permission.registry');
const { defaultAssignmentPolicy } = require('../../../../domain/permission/assignment/permission.assignment.policy');
const { translateDomainError } = require('../errors/permissionAdmin.errorMap');

function paginationOptions(req) {
  const { limit, offset } = req.query;
  const options = {};
  if (limit !== undefined) options.limit = limit;
  if (offset !== undefined) options.offset = offset;
  return options;
}

/**
 * WP-ADMIN-04F-13B — verified implementation gap (audit WP-ADMIN-04F-13A):
 * the Assignment UI needs to render only Permissions that can currently
 * be granted, but the Registry Discovery endpoints have no notion of
 * "assignable" — that question belongs to the certified Assignment
 * Policy (../../../../domain/permission/assignment/permission.assignment.policy.js),
 * never to the Registry itself (see that policy file's own header on why
 * Evaluation/Assignment/Registry stay separate). Rather than duplicating
 * `DefaultAssignmentPolicy`'s PUBLISHED/ADOPTED rule in the frontend —
 * which every constraint on this WP forbids — this transport-layer helper
 * reuses the existing certified policy singleton to post-filter whatever
 * the Registry already returned.
 *
 * `?assignableOnly=true` is opt-in and purely additive: omitted (or any
 * other value), every endpoint's response is byte-for-byte what it was
 * before this WP. When set, `items` is narrowed to entries whose status
 * the Assignment Policy considers assignable and `total` is adjusted to
 * match, so pagination metadata never lies about what the caller
 * actually received. Because the full certified Permission vocabulary
 * comfortably fits inside one page (`PAGE_LIMIT_MAX` in
 * permissionAdmin.validators.js), this is not re-paginating a filtered
 * superset — callers populating a dropdown should request a limit large
 * enough to cover the whole catalog, exactly as the existing endpoints
 * already require for a complete listing.
 */
function applyAssignableOnlyFilter(result, req) {
  if (req.query.assignableOnly !== true) return result;
  const items = result.items.filter((entry) => defaultAssignmentPolicy.isAssignable(entry.status));
  return { items, total: items.length };
}

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
 * Builds a controller object bound to a given Registry instance —
 * defaults to the certified singleton in production, constructor-
 * injectable for tests with a fake Registry (mirroring this domain's
 * own DI convention throughout the certified layers).
 *
 * @param {import('../../../../domain/permission/registry/permission.registry').PermissionRegistry} [registry]
 */
function createPermissionRegistryController(registry = defaultRegistry) {
  return {
    async listPermissions(req, res, next) {
      try {
        const result = await registry.listPermissions(paginationOptions(req));
        return ok(res, applyAssignableOnlyFilter(result, req));
      } catch (error) {
        if (translateDomainError(error, req, res)) return undefined;
        return next(error);
      }
    },

    async getPermissionById(req, res, next) {
      try {
        const entry = await registry.getPermission(req.params.id);
        if (!entry) return notFound(req, res, `No Permission found for id "${req.params.id}".`);
        return ok(res, entry);
      } catch (error) {
        if (translateDomainError(error, req, res)) return undefined;
        return next(error);
      }
    },

    async getPermissionByIdentity(req, res, next) {
      try {
        const entry = await registry.getPermissionByIdentity(req.params.identity);
        if (!entry) return notFound(req, res, `No Permission found for identity "${req.params.identity}".`);
        return ok(res, entry);
      } catch (error) {
        if (translateDomainError(error, req, res)) return undefined;
        return next(error);
      }
    },

    async findByResource(req, res, next) {
      try {
        const result = await registry.findByResource(req.params.resource, paginationOptions(req));
        return ok(res, applyAssignableOnlyFilter(result, req));
      } catch (error) {
        if (translateDomainError(error, req, res)) return undefined;
        return next(error);
      }
    },

    async findByAction(req, res, next) {
      try {
        const result = await registry.findByAction(req.params.action, paginationOptions(req));
        return ok(res, applyAssignableOnlyFilter(result, req));
      } catch (error) {
        if (translateDomainError(error, req, res)) return undefined;
        return next(error);
      }
    },

    async findByCategory(req, res, next) {
      try {
        const result = await registry.findByCategory(req.params.category, paginationOptions(req));
        return ok(res, applyAssignableOnlyFilter(result, req));
      } catch (error) {
        if (translateDomainError(error, req, res)) return undefined;
        return next(error);
      }
    },
  };
}

module.exports = {
  createPermissionRegistryController,
  // Production singleton — constructed against the certified default
  // Registry, matching every other admin controller's ready-to-mount
  // export convention in this codebase.
  permissionRegistryController: createPermissionRegistryController(),
};
