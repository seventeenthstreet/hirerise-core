'use strict';

/**
 * modules/student-onboarding/__tests__/aspiration.controller.test.js
 *
 * Focus: HTTP adapter correctness and identity/ownership — the
 * security-critical part of this layer. Business logic itself is covered
 * by aspiration.service.test.js.
 */

jest.mock('../services/aspiration.service');
jest.mock('../services/recommendation-lifecycle.service');

const svc = require('../services/aspiration.service');
const lifecycle = require('../services/recommendation-lifecycle.service');
const { getAspiration, saveAspiration } = require('../controllers/aspiration.controller');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('aspiration.controller', () => {
  beforeEach(() => {
    lifecycle.initiateProcessingTransition.mockResolvedValue({ session: { current_step: 'processing' } });
  });
  afterEach(() => jest.clearAllMocks());

  describe('saveAspiration', () => {
    it("derives identity from req.user.id, never from req.body.user_id / req.body.userId", async () => {
      svc.saveAspirationStep.mockResolvedValue({
        aspiration: { careerInterests: ['medicine'], motivationDriver: null, timeHorizon: null },
      });

      const req = {
        user: { id: 'authenticated-user-id' },
        supabase: { fake: true },
        // A client attempting IDOR by supplying a different user_id in the body —
        // must be completely ignored.
        body: { user_id: 'someone-elses-id', userId: 'also-someone-elses-id' },
        validatedAspiration: { careerInterests: ['medicine'], motivationDriver: null, timeHorizon: null },
      };
      const res = mockRes();
      const next = jest.fn();

      await saveAspiration(req, res, next);

      expect(svc.saveAspirationStep).toHaveBeenCalledWith(
        { supabase: req.supabase },
        'authenticated-user-id',
        req.validatedAspiration,
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        aspiration: { careerInterests: ['medicine'], motivationDriver: null, timeHorizon: null },
      });
      expect(next).not.toHaveBeenCalled();

      // Backend-owned processing transition + generation kickoff — invoked
      // once, for the authenticated user only, after data is saved. See
      // recommendation-lifecycle.service.js for the transition itself.
      expect(lifecycle.initiateProcessingTransition).toHaveBeenCalledTimes(1);
      expect(lifecycle.initiateProcessingTransition).toHaveBeenCalledWith('authenticated-user-id');
    });

    it('forwards recommendation-lifecycle errors to next() rather than throwing', async () => {
      svc.saveAspirationStep.mockResolvedValue({
        aspiration: { careerInterests: ['medicine'], motivationDriver: null, timeHorizon: null },
      });
      const err = new Error('session advance failed');
      lifecycle.initiateProcessingTransition.mockRejectedValue(err);

      const req = {
        user: { id: 'user-1' },
        supabase: {},
        body: {},
        validatedAspiration: { careerInterests: ['medicine'], motivationDriver: null, timeHorizon: null },
      };
      const res = mockRes();
      const next = jest.fn();

      await saveAspiration(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('passes through req.validatedAspiration (the validator output), not raw req.body', async () => {
      svc.saveAspirationStep.mockResolvedValue({
        aspiration: { careerInterests: ['law'], motivationDriver: 'impact', timeHorizon: 'short' },
      });

      const req = {
        user: { id: 'user-1' },
        supabase: {},
        body: { careerInterests: ['law', 'law'] }, // raw, unnormalized body
        validatedAspiration: { careerInterests: ['law'], motivationDriver: 'impact', timeHorizon: 'short' },
      };
      const res = mockRes();
      const next = jest.fn();

      await saveAspiration(req, res, next);

      expect(svc.saveAspirationStep).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        req.validatedAspiration,
      );
    });

    it('forwards service errors to next() rather than throwing', async () => {
      const err = new Error('db unavailable');
      svc.saveAspirationStep.mockRejectedValue(err);

      const req = {
        user: { id: 'user-1' },
        supabase: {},
        body: {},
        validatedAspiration: { careerInterests: ['medicine'], motivationDriver: null, timeHorizon: null },
      };
      const res = mockRes();
      const next = jest.fn();

      await saveAspiration(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('getAspiration', () => {
    it("fetches using req.user.id only", async () => {
      svc.getAspirationStep.mockResolvedValue({ aspiration: null });

      const req = { user: { id: 'user-1' }, supabase: {}, query: { user_id: 'someone-else' } };
      const res = mockRes();
      const next = jest.fn();

      await getAspiration(req, res, next);

      expect(svc.getAspirationStep).toHaveBeenCalledWith({ supabase: req.supabase }, 'user-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true, aspiration: null });
    });

    it('forwards service errors to next()', async () => {
      const err = new Error('boom');
      svc.getAspirationStep.mockRejectedValue(err);

      const req = { user: { id: 'user-1' }, supabase: {} };
      const res = mockRes();
      const next = jest.fn();

      await getAspiration(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });
});
