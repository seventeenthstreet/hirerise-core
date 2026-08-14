'use strict';

/**
 * @file src/modules/admin/permissions/__tests__/permissionEvaluation.controller.test.js
 *
 * WP-ADMIN-04F-08 — Enterprise Permission Administration API
 *
 * Controller-level test: the Evaluation Admin service (a pure
 * passthrough to the certified Authorization Evaluation Engine,
 * WP-ADMIN-04F-05) is mocked entirely — no Registry, no Repository, no
 * end-to-end request.
 */

const { createPermissionEvaluationController } = require('../controllers/permissionEvaluation.controller');
const {
  PermissionNotFoundError,
  PermissionNotEvaluableError,
} = require('../../../../domain/permission/evaluation/permission.evaluation.errors');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(overrides = {}) {
  return { params: {}, query: {}, body: {}, requestId: 'req-1', ...overrides };
}

describe('permissionEvaluation.controller', () => {
  let evaluationService;
  let controller;
  let next;

  beforeEach(() => {
    evaluationService = { evaluate: jest.fn() };
    controller = createPermissionEvaluationController(evaluationService);
    next = jest.fn();
  });

  it('returns 200 with an Allow decision', async () => {
    const result = {
      decision: { outcome: 'ALLOW', reason: 'governed and evaluable' },
      explanation: { permission: 'job_listing:view', decision: 'ALLOW' },
    };
    evaluationService.evaluate.mockResolvedValue(result);
    const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
    const res = makeRes();

    await controller.evaluate(req, res, next);

    expect(evaluationService.evaluate).toHaveBeenCalledWith({
      userId: 'u1',
      resource: 'job_listing',
      action: 'view',
      resourceId: undefined,
      metadata: undefined,
    });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: result });
  });

  it('returns 200 with a Deny decision (not an HTTP error — Deny is a valid, well-formed Decision)', async () => {
    const result = {
      decision: { outcome: 'DENY', reason: 'not currently governed for this Action' },
      explanation: { permission: 'job_listing:delete', decision: 'DENY' },
    };
    evaluationService.evaluate.mockResolvedValue(result);
    const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'delete' } });
    const res = makeRes();

    await controller.evaluate(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: result });
  });

  it('translates PermissionNotFoundError (invalid/unknown Permission) into a 404 canonical response', async () => {
    evaluationService.evaluate.mockRejectedValue(new PermissionNotFoundError('job_listing:teleport'));
    const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'teleport' } });
    const res = makeRes();

    await controller.evaluate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'EVALUATION_PERMISSION_NOT_FOUND' }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('translates PermissionNotEvaluableError (a retired Permission) into a 422 canonical response', async () => {
    evaluationService.evaluate.mockRejectedValue(
      new PermissionNotEvaluableError('job_listing:view', 'retired')
    );
    const req = makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } });
    const res = makeRes();

    await controller.evaluate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'EVALUATION_PERMISSION_NOT_EVALUABLE' }),
      })
    );
  });

  it('forwards an unrecognized error to next()', async () => {
    const boom = new Error('downstream outage');
    evaluationService.evaluate.mockRejectedValue(boom);
    const res = makeRes();

    await controller.evaluate(makeReq({ body: { principalId: 'u1', resource: 'job_listing', action: 'view' } }), res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });
});
