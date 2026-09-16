'use strict';

/**
 * modules/student-onboarding/__tests__/aspiration.service.test.js
 */

jest.mock('../repositories/aspiration.repository');

const repo = require('../repositories/aspiration.repository');
const { getAspirationStep, saveAspirationStep } = require('../services/aspiration.service');

describe('aspiration.service', () => {
  afterEach(() => jest.clearAllMocks());

  describe('saveAspirationStep', () => {
    it('delegates to the repository with the userId and validated fields, and shapes the response', async () => {
      repo.upsertAspiration.mockResolvedValue({
        user_id: 'user-1',
        career_interests: ['engineering', 'science'],
        motivation_driver: 'impact',
        time_horizon: 'medium',
      });

      const ctx = { supabase: { fake: true } };
      const result = await saveAspirationStep(ctx, 'user-1', {
        careerInterests: ['engineering', 'science'],
        motivationDriver: 'impact',
        timeHorizon: 'medium',
      });

      expect(repo.upsertAspiration).toHaveBeenCalledWith(ctx.supabase, {
        user_id: 'user-1',
        career_interests: ['engineering', 'science'],
        motivation_driver: 'impact',
        time_horizon: 'medium',
      });

      expect(result).toEqual({
        aspiration: {
          careerInterests: ['engineering', 'science'],
          motivationDriver: 'impact',
          timeHorizon: 'medium',
        },
      });
    });

    it('never derives userId from anything other than the explicit argument (no req/body reads)', async () => {
      repo.upsertAspiration.mockResolvedValue({
        user_id: 'authenticated-user-id',
        career_interests: ['medicine'],
        motivation_driver: null,
        time_horizon: null,
      });

      await saveAspirationStep(
        { supabase: {} },
        'authenticated-user-id',
        { careerInterests: ['medicine'], motivationDriver: null, timeHorizon: null },
      );

      const [, payload] = repo.upsertAspiration.mock.calls[0];
      expect(payload.user_id).toBe('authenticated-user-id');
    });

    it('does not read, write, or reference student_onboarding_sessions in any way', async () => {
      // Regression guard for the double-write risk this phase was explicitly
      // asked to avoid: this service module must not import session.service
      // at all. If a future change adds that import, this test fails loudly
      // rather than silently reintroducing a second progression writer.
      // eslint-disable-next-line global-require
      const serviceSource = require('fs').readFileSync(
        require.resolve('../services/aspiration.service'),
        'utf8',
      );
      // Strip comments/docblocks before asserting — this file's own
      // documentation discusses sessionService.updateProgression() by name
      // as the thing it deliberately does NOT do, so a naive text match
      // over the raw source would false-positive on the explanation itself.
      const codeOnly = serviceSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(codeOnly).not.toMatch(/require\(['"][^'"]*session\.service['"]\)/);
      expect(codeOnly).not.toMatch(/\bsessionService\b/);
    });
  });

  describe('getAspirationStep', () => {
    it('returns aspiration: null when no record exists', async () => {
      repo.fetchAspiration.mockResolvedValue(null);

      const result = await getAspirationStep({ supabase: {} }, 'user-1');

      expect(result).toEqual({ aspiration: null });
    });

    it('shapes an existing record into the camelCase API contract', async () => {
      repo.fetchAspiration.mockResolvedValue({
        user_id: 'user-1',
        career_interests: ['law'],
        motivation_driver: 'autonomy',
        time_horizon: 'long',
      });

      const result = await getAspirationStep({ supabase: {} }, 'user-1');

      expect(result).toEqual({
        aspiration: {
          careerInterests: ['law'],
          motivationDriver: 'autonomy',
          timeHorizon: 'long',
        },
      });
    });
  });
});
