'use strict';

/**
 * adminWeights.service.test.js — WP-ADMIN-COMP-08-R23
 *
 * Pure orchestration tests: the repository is mocked, so these assert
 * that the service composes it correctly (including the no-active-version
 * 404 contract) rather than re-testing Supabase itself. Mirrors the
 * mocking shape already used by
 * modules/admin/users/__tests__/adminUsers.service.test.js.
 */

jest.mock('../adminWeights.repository', () => ({
  list: jest.fn(),
  getActiveModelVersion: jest.fn(),
}));

const weightsRepo = require('../adminWeights.repository');
const service = require('../adminWeights.service');

function versionRow(overrides = {}) {
  return {
    id: 'v-1',
    versionTag: 'v1.0.0',
    modelType: 'signal_weights',
    intelligenceDomain: 'student',
    description: 'Initial weights',
    approvedBy: 'system',
    approvedAt: '2026-06-01T00:00:00.000Z',
    effectiveFrom: '2026-06-01T00:00:00.000Z',
    deprecatedAt: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    isApproved: true,
    isDeprecated: false,
    ...overrides,
  };
}

describe('adminWeights.service — WP-ADMIN-COMP-08-R23', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('listVersions()', () => {
    it('forwards filters to the repository and wraps the result as { items }', async () => {
      weightsRepo.list.mockResolvedValue([versionRow()]);

      const result = await service.listVersions({
        intelligenceDomain: 'student',
        modelType: 'signal_weights',
      });

      expect(weightsRepo.list).toHaveBeenCalledWith({
        intelligenceDomain: 'student',
        modelType: 'signal_weights',
      });
      expect(result).toEqual({ items: [versionRow()] });
    });

    it('returns an empty items array when the registry has no matching rows', async () => {
      weightsRepo.list.mockResolvedValue([]);
      const result = await service.listVersions({});
      expect(result).toEqual({ items: [] });
    });

    it('propagates a repository failure unchanged (no swallowing)', async () => {
      const dbError = new Error('boom');
      weightsRepo.list.mockRejectedValue(dbError);
      await expect(service.listVersions({})).rejects.toBe(dbError);
    });
  });

  describe('getActiveVersion()', () => {
    it('calls fn_get_active_model_version through the repository and returns the resolved version', async () => {
      weightsRepo.getActiveModelVersion.mockResolvedValue(versionRow({ id: 'v-active' }));

      const result = await service.getActiveVersion({
        intelligenceDomain: 'student',
        modelType: 'signal_weights',
      });

      expect(weightsRepo.getActiveModelVersion).toHaveBeenCalledWith({
        intelligenceDomain: 'student',
        modelType: 'signal_weights',
      });
      expect(result.id).toBe('v-active');
    });

    it('throws a 404 AppError with ErrorCodes.NOT_FOUND when no active version resolves', async () => {
      weightsRepo.getActiveModelVersion.mockResolvedValue(null);

      await expect(
        service.getActiveVersion({ intelligenceDomain: 'employer', modelType: 'matching_model' })
      ).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('includes the requested domain/type in the 404 error metadata for debuggability', async () => {
      weightsRepo.getActiveModelVersion.mockResolvedValue(null);

      await expect(
        service.getActiveVersion({ intelligenceDomain: 'employer', modelType: 'matching_model' })
      ).rejects.toMatchObject({
        metadata: { intelligenceDomain: 'employer', modelType: 'matching_model' },
      });
    });

    it('propagates a repository failure unchanged (no swallowing)', async () => {
      const dbError = new Error('boom');
      weightsRepo.getActiveModelVersion.mockRejectedValue(dbError);
      await expect(service.getActiveVersion({})).rejects.toBe(dbError);
    });
  });
});
