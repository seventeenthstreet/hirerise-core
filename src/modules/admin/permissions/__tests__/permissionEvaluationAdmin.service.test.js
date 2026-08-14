'use strict';

/**
 * @file src/modules/admin/permissions/__tests__/permissionEvaluationAdmin.service.test.js
 *
 * WP-ADMIN-04F-08 — Enterprise Permission Administration API
 *
 * Confirms the service is exactly the passthrough its header claims:
 * it forwards its argument unchanged to the injected Evaluation Engine
 * and returns its result unchanged, with no branching of its own.
 */

const { createPermissionEvaluationAdminService } = require('../services/permissionEvaluationAdmin.service');

describe('permissionEvaluationAdmin.service', () => {
  it('forwards the request to the Evaluation Engine unchanged and returns its result unchanged', async () => {
    const request = { userId: 'u1', resource: 'job_listing', action: 'view' };
    const engineResult = { decision: { outcome: 'ALLOW' }, explanation: {} };
    const evaluationEngine = { evaluate: jest.fn().mockResolvedValue(engineResult) };

    const service = createPermissionEvaluationAdminService(evaluationEngine);
    const result = await service.evaluate(request);

    expect(evaluationEngine.evaluate).toHaveBeenCalledWith(request);
    expect(evaluationEngine.evaluate).toHaveBeenCalledTimes(1);
    expect(result).toBe(engineResult);
  });

  it('propagates a rejection from the Evaluation Engine unchanged', async () => {
    const boom = new Error('evaluation failed');
    const evaluationEngine = { evaluate: jest.fn().mockRejectedValue(boom) };
    const service = createPermissionEvaluationAdminService(evaluationEngine);

    await expect(service.evaluate({ userId: 'u1', resource: 'job_listing', action: 'view' })).rejects.toBe(boom);
  });
});
