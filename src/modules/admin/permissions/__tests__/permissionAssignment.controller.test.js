'use strict';

/**
 * @file src/modules/admin/permissions/__tests__/permissionAssignment.controller.test.js
 *
 * WP-ADMIN-04F-08 — Enterprise Permission Administration API
 * WP-ADMIN-05B — Enterprise Permission Audit Integration
 *
 * Controller-level test: the certified Permission Assignment Service
 * (WP-ADMIN-04F-06) is mocked entirely — no Repository, no Registry, no
 * end-to-end request. adminAuditLogger is also mocked entirely — no
 * Supabase — so audit assertions below check only that the controller
 * calls logAdminAction() with the right shape, not that admin_logs is
 * actually written (that's adminAuditLogger.js's own test surface,
 * unchanged by this WP).
 */

const { createPermissionAssignmentController } = require('../controllers/permissionAssignment.controller');
const { PermissionNotAssignableError } = require('../../../../domain/permission/assignment/permission.assignment.errors');
const { ACTIONS: PERMISSION_AUDIT_ACTIONS } = require('../audit/permissionAudit.constants');

jest.mock('../../../../utils/adminAuditLogger');
const { logAdminAction } = require('../../../../utils/adminAuditLogger');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(overrides = {}) {
  return {
    params: {},
    query: {},
    body: {},
    requestId: 'req-1',
    adminPrincipal: { uid: 'admin-1' },
    ip: '203.0.113.9',
    ...overrides,
  };
}

describe('permissionAssignment.controller', () => {
  let assignmentService;
  let controller;
  let next;

  beforeEach(() => {
    assignmentService = {
      assignPermission: jest.fn(),
      revokePermission: jest.fn(),
      hasAssignment: jest.fn(),
      listAssignments: jest.fn(),
      getAssignments: jest.fn(),
    };
    controller = createPermissionAssignmentController(assignmentService);
    next = jest.fn();
    logAdminAction.mockReset();
    logAdminAction.mockResolvedValue();
  });

  describe('assignPermission', () => {
    it('returns 201 with the created Assignment (idempotent grant)', async () => {
      const assignment = { assignmentIdentity: 'u1::job_listing:view', principalId: 'u1' };
      assignmentService.hasAssignment.mockResolvedValue(false);
      assignmentService.assignPermission.mockResolvedValue(assignment);
      const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
      const res = makeRes();

      await controller.assignPermission(req, res, next);

      expect(assignmentService.assignPermission).toHaveBeenCalledWith({
        principalId: 'u1',
        resource: 'job_listing',
        action: 'view',
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: assignment });
    });

    it('translates PermissionNotAssignableError (e.g. a retired Permission) into a 422 canonical response', async () => {
      assignmentService.hasAssignment.mockResolvedValue(false);
      assignmentService.assignPermission.mockRejectedValue(
        new PermissionNotAssignableError('job_listing:view', 'status "retired" is not assignable')
      );
      const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
      const res = makeRes();

      await controller.assignPermission(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'ASSIGNMENT_PERMISSION_NOT_ASSIGNABLE' }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('repeated assignment of the same grant remains 201 with the existing Assignment (Service-level idempotency, not a duplicate error)', async () => {
      const existing = { assignmentIdentity: 'u1::job_listing:view', principalId: 'u1' };
      assignmentService.assignPermission.mockResolvedValue(existing);
      assignmentService.hasAssignment.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
      const res = makeRes();

      await controller.assignPermission(req, res, next);
      await controller.assignPermission(req, res, next);

      expect(assignmentService.assignPermission).toHaveBeenCalledTimes(2);
      expect(res.status).toHaveBeenCalledWith(201);
    });

    // ── WP-ADMIN-05B — Audit Integration ────────────────────────────

    it('emits a fire-and-forget PERMISSION_ASSIGNED audit event after a genuine grant', async () => {
      assignmentService.hasAssignment.mockResolvedValue(false);
      assignmentService.assignPermission.mockResolvedValue({ assignmentIdentity: 'u1::job_listing:view', principalId: 'u1' });
      const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
      const res = makeRes();

      await controller.assignPermission(req, res, next);

      expect(logAdminAction).toHaveBeenCalledTimes(1);
      expect(logAdminAction).toHaveBeenCalledWith({
        adminId: 'admin-1',
        action: PERMISSION_AUDIT_ACTIONS.ASSIGNED,
        entityType: 'permission',
        entityId: 'job_listing:view',
        metadata: { principalId: 'u1' },
        ipAddress: '203.0.113.9',
      });
    });

    it('does not emit an audit event for an idempotent no-op grant (already assigned)', async () => {
      assignmentService.hasAssignment.mockResolvedValue(true);
      assignmentService.assignPermission.mockResolvedValue({ assignmentIdentity: 'u1::job_listing:view', principalId: 'u1' });
      const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
      const res = makeRes();

      await controller.assignPermission(req, res, next);

      expect(logAdminAction).not.toHaveBeenCalled();
    });

    it('does not emit an audit event when the mutation fails', async () => {
      assignmentService.hasAssignment.mockResolvedValue(false);
      assignmentService.assignPermission.mockRejectedValue(
        new PermissionNotAssignableError('job_listing:view', 'status "retired" is not assignable')
      );
      const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
      const res = makeRes();

      await controller.assignPermission(req, res, next);

      expect(logAdminAction).not.toHaveBeenCalled();
    });

    it('an audit-write failure never blocks the response (fire-and-forget)', async () => {
      assignmentService.hasAssignment.mockResolvedValue(false);
      assignmentService.assignPermission.mockResolvedValue({ assignmentIdentity: 'u1::job_listing:view', principalId: 'u1' });
      logAdminAction.mockRejectedValue(new Error('admin_logs unavailable'));
      const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
      const res = makeRes();

      await controller.assignPermission(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('revokePermission', () => {
    it('returns 200 with { revoked: true } when an Assignment existed', async () => {
      assignmentService.revokePermission.mockResolvedValue(true);
      const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
      const res = makeRes();

      await controller.revokePermission(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: { revoked: true } });
    });

    it('returns 200 with { revoked: false } for a no-op revoke (safe to call repeatedly)', async () => {
      assignmentService.revokePermission.mockResolvedValue(false);
      const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
      const res = makeRes();

      await controller.revokePermission(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: { revoked: false } });
    });

    // ── WP-ADMIN-05B — Audit Integration ────────────────────────────

    it('emits a fire-and-forget PERMISSION_REVOKED audit event when an Assignment was actually revoked', async () => {
      assignmentService.revokePermission.mockResolvedValue(true);
      const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
      const res = makeRes();

      await controller.revokePermission(req, res, next);

      expect(logAdminAction).toHaveBeenCalledTimes(1);
      expect(logAdminAction).toHaveBeenCalledWith({
        adminId: 'admin-1',
        action: PERMISSION_AUDIT_ACTIONS.REVOKED,
        entityType: 'permission',
        entityId: 'job_listing:view',
        metadata: { principalId: 'u1' },
        ipAddress: '203.0.113.9',
      });
    });

    it('does not emit an audit event for a no-op revoke (nothing existed to revoke)', async () => {
      assignmentService.revokePermission.mockResolvedValue(false);
      const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
      const res = makeRes();

      await controller.revokePermission(req, res, next);

      expect(logAdminAction).not.toHaveBeenCalled();
    });
  });

  describe('checkAssignment', () => {
    it('returns 200 with { assigned: true }', async () => {
      assignmentService.hasAssignment.mockResolvedValue(true);
      const req = makeReq({ query: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
      const res = makeRes();

      await controller.checkAssignment(req, res, next);

      expect(assignmentService.hasAssignment).toHaveBeenCalledWith({
        principalId: 'u1',
        resource: 'job_listing',
        action: 'view',
      });
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { assigned: true } });
    });
  });

  describe('listAssignments', () => {
    it('returns 200 with all Assignments for a Permission', async () => {
      assignmentService.listAssignments.mockResolvedValue([{ principalId: 'u1' }, { principalId: 'u2' }]);
      const req = makeReq({ query: { resource: 'job_listing', action: 'view' } });
      const res = makeRes();

      await controller.listAssignments(req, res, next);

      expect(assignmentService.listAssignments).toHaveBeenCalledWith({ resource: 'job_listing', action: 'view' });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { assignments: [{ principalId: 'u1' }, { principalId: 'u2' }] },
      });
    });
  });

  describe('getAssignmentsForPrincipal', () => {
    it('returns 200 with all Assignments held by a Principal', async () => {
      assignmentService.getAssignments.mockResolvedValue([{ principalId: 'u1', permissionIdentity: 'job_listing:view' }]);
      const req = makeReq({ params: { principalId: 'u1' } });
      const res = makeRes();

      await controller.getAssignmentsForPrincipal(req, res, next);

      expect(assignmentService.getAssignments).toHaveBeenCalledWith({ principalId: 'u1' });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { assignments: [{ principalId: 'u1', permissionIdentity: 'job_listing:view' }] },
      });
    });
  });
});
