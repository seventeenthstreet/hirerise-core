'use strict';

/**
 * modules/knowledge-runtime/student/__tests__/studentIntelligence.controller.test.js
 */

const mockService = {
  getStudentIntelligenceProfile: jest.fn(),
  getAcademicSnapshot: jest.fn(),
  getCareerSnapshot: jest.fn(),
  getSkillSnapshot: jest.fn(),
  getFutureSnapshot: jest.fn(),
  getReadinessSnapshot: jest.fn(),
  refreshFromOnboarding: jest.fn(),
};

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../knowledge-runtime.module', () => ({
  getStudentService: () => mockService,
}));

const controller = require('../studentIntelligence.controller');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('studentIntelligence.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMyContext', () => {
    it('resolves userId from req.user.id, not from any client input', async () => {
      // WP-XAI2-03: the service's raw profile still carries `userId`
      // (studentIntelligence.service.js line ~245 — unmodified), but the
      // public response contract does not. `expect.objectContaining` is
      // used at the top level because WP-XAI2-02's `meta` (dynamic
      // timestamp/requestId) is additive and out of this WP's scope to
      // assert on exactly.
      mockService.getStudentIntelligenceProfile.mockResolvedValue({ userId: 'user-1', personal: {} });

      const req = { user: { id: 'user-1' }, params: {}, query: {} };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyContext(req, res, next);

      expect(mockService.getStudentIntelligenceProfile).toHaveBeenCalledWith('user-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: { personal: {} } }),
      );
    });

    it('forwards a validation error to next() when req.user is missing', async () => {
      const req = { user: undefined, params: {}, query: {} };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyContext(req, res, next);

      expect(mockService.getStudentIntelligenceProfile).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    // WP-XAI2-03 regression coverage: one dedicated test per success call
    // site protects `_toPublicStudentPayload` from silent reversion on any
    // of the 8 endpoints it guards.
    it('WP-XAI2-03 regression: never exposes userId, even when the service returns it', async () => {
      mockService.getStudentIntelligenceProfile.mockResolvedValue({ userId: 'user-1', personal: {} });
      const req = { user: { id: 'user-1' }, params: {}, query: {} };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyContext(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data).not.toHaveProperty('userId');
      expect(JSON.stringify(body)).not.toContain('user-1');
    });
  });

  describe('me/* slices', () => {
    it('getMyAcademicSnapshot delegates to service.getAcademicSnapshot with req.user.id', async () => {
      mockService.getAcademicSnapshot.mockResolvedValue({ userId: 'user-1', academic: {} });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyAcademicSnapshot(req, res, next);

      expect(mockService.getAcademicSnapshot).toHaveBeenCalledWith('user-1');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: { academic: {} } }),
      );
    });

    it('WP-XAI2-03 regression: getMyAcademicSnapshot never exposes userId', async () => {
      mockService.getAcademicSnapshot.mockResolvedValue({ userId: 'user-1', academic: {} });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyAcademicSnapshot(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data).not.toHaveProperty('userId');
      expect(JSON.stringify(body)).not.toContain('user-1');
    });

    it('getMyCareerSnapshot delegates to service.getCareerSnapshot with req.user.id', async () => {
      mockService.getCareerSnapshot.mockResolvedValue({ userId: 'user-1', career: {} });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyCareerSnapshot(req, res, next);

      expect(mockService.getCareerSnapshot).toHaveBeenCalledWith('user-1');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: { career: {} } }),
      );
    });

    it('WP-XAI2-03 regression: getMyCareerSnapshot never exposes userId', async () => {
      mockService.getCareerSnapshot.mockResolvedValue({ userId: 'user-1', career: {} });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyCareerSnapshot(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data).not.toHaveProperty('userId');
      expect(JSON.stringify(body)).not.toContain('user-1');
    });

    it('getMySkillSnapshot delegates to service.getSkillSnapshot with req.user.id', async () => {
      mockService.getSkillSnapshot.mockResolvedValue({ userId: 'user-1', skills: {} });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMySkillSnapshot(req, res, next);

      expect(mockService.getSkillSnapshot).toHaveBeenCalledWith('user-1');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: { skills: {} } }),
      );
    });

    it('WP-XAI2-03 regression: getMySkillSnapshot never exposes userId', async () => {
      mockService.getSkillSnapshot.mockResolvedValue({ userId: 'user-1', skills: {} });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMySkillSnapshot(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data).not.toHaveProperty('userId');
      expect(JSON.stringify(body)).not.toContain('user-1');
    });

    it('getMyFutureSnapshot delegates to service.getFutureSnapshot with req.user.id', async () => {
      mockService.getFutureSnapshot.mockResolvedValue({ userId: 'user-1', goals: [], readiness: {} });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyFutureSnapshot(req, res, next);

      expect(mockService.getFutureSnapshot).toHaveBeenCalledWith('user-1');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: { goals: [], readiness: {} } }),
      );
    });

    it('WP-XAI2-03 regression: getMyFutureSnapshot never exposes userId', async () => {
      mockService.getFutureSnapshot.mockResolvedValue({ userId: 'user-1', goals: [], readiness: {} });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyFutureSnapshot(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data).not.toHaveProperty('userId');
      expect(JSON.stringify(body)).not.toContain('user-1');
    });

    it('getMyReadinessSnapshot delegates to service.getReadinessSnapshot', async () => {
      mockService.getReadinessSnapshot.mockResolvedValue({ userId: 'user-1', readiness: { available: false } });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyReadinessSnapshot(req, res, next);

      expect(mockService.getReadinessSnapshot).toHaveBeenCalledWith('user-1');
    });

    it('WP-XAI2-03 regression: getMyReadinessSnapshot never exposes userId', async () => {
      mockService.getReadinessSnapshot.mockResolvedValue({ userId: 'user-1', readiness: { available: false } });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getMyReadinessSnapshot(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data).not.toHaveProperty('userId');
      expect(JSON.stringify(body)).not.toContain('user-1');
    });
  });

  describe('refreshMyContext', () => {
    it('delegates to service.refreshFromOnboarding with req.user.id', async () => {
      mockService.refreshFromOnboarding.mockResolvedValue({ userId: 'user-1' });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.refreshMyContext(req, res, next);

      expect(mockService.refreshFromOnboarding).toHaveBeenCalledWith('user-1');
    });

    it('forwards service errors to next()', async () => {
      mockService.refreshFromOnboarding.mockRejectedValue(new Error('boom'));
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.refreshMyContext(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('WP-XAI2-03 regression: refreshMyContext never exposes userId', async () => {
      mockService.refreshFromOnboarding.mockResolvedValue({ userId: 'user-1', personal: {} });
      const req = { user: { id: 'user-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.refreshMyContext(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data).not.toHaveProperty('userId');
      expect(JSON.stringify(body)).not.toContain('user-1');
    });
  });

  describe('getStudentContextByUserId (admin route)', () => {
    it('returns 200 with the profile when available', async () => {
      mockService.getStudentIntelligenceProfile.mockResolvedValue({
        personal: { available: true },
        readiness: { available: false },
      });
      const req = { params: { userId: 'user-2' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getStudentContextByUserId(req, res, next);

      expect(mockService.getStudentIntelligenceProfile).toHaveBeenCalledWith('user-2');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    // WP-XAI2-03 regression coverage: the one non-self-scoped call site.
    // The admin already supplies `userId` in the request path, but the
    // response body must still not echo it back at the top level.
    it('WP-XAI2-03 regression: never exposes userId, even for the admin route', async () => {
      mockService.getStudentIntelligenceProfile.mockResolvedValue({
        userId: 'user-2',
        personal: { available: true },
        readiness: { available: false },
      });
      const req = { params: { userId: 'user-2' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getStudentContextByUserId(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data).not.toHaveProperty('userId');
      expect(JSON.stringify(body)).not.toContain('user-2');
    });

    it('returns 404 when neither personal nor readiness data is available', async () => {
      mockService.getStudentIntelligenceProfile.mockResolvedValue({
        personal: { available: false },
        readiness: { available: false },
      });
      const req = { params: { userId: 'user-missing' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getStudentContextByUserId(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('rejects an empty userId param', async () => {
      const req = { params: { userId: '' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getStudentContextByUserId(req, res, next);

      expect(mockService.getStudentIntelligenceProfile).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
