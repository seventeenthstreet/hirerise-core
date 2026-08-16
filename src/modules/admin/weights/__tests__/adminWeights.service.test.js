'use strict';

/**
 * adminWeights.service.test.js — WP-ADMIN-COMP-08-R23 + R24
 *
 * Pure orchestration tests: the repository is mocked, so these assert
 * that the service composes it correctly (including the no-active-version
 * 404 contract, and R24's required-field validation for createVersion())
 * rather than re-testing Supabase itself. Mirrors the mocking shape
 * already used by modules/admin/users/__tests__/adminUsers.service.test.js.
 */

jest.mock('../adminWeights.repository', () => ({
  list: jest.fn(),
  getActiveModelVersion: jest.fn(),
  create: jest.fn(),
  findById: jest.fn(),
  approve: jest.fn(),
  deprecate: jest.fn(),
}));

jest.mock('../../../../utils/adminAuditLogger', () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const weightsRepo = require('../adminWeights.repository');
const { logAdminAction } = require('../../../../utils/adminAuditLogger');
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

  describe('createVersion() — WP-ADMIN-COMP-08-R24', () => {
    function draftPayload(overrides = {}) {
      return {
        versionTag: 'v2.0.0',
        modelType: 'signal_weights',
        intelligenceDomain: 'professional',
        description: 'Draft weights for professional domain',
        weights: { systems_thinker: { weight: 0.8 } },
        ...overrides,
      };
    }

    it('forwards a valid payload to the repository and returns the created draft', async () => {
      const created = versionRow({
        id: 'v-draft',
        intelligenceDomain: 'professional',
        approvedBy: null,
        approvedAt: null,
        isApproved: false,
      });
      weightsRepo.create.mockResolvedValue(created);

      const result = await service.createVersion(draftPayload());

      expect(weightsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          versionTag: 'v2.0.0',
          modelType: 'signal_weights',
          intelligenceDomain: 'professional',
          description: 'Draft weights for professional domain',
          weights: { systems_thinker: { weight: 0.8 } },
        })
      );
      expect(result).toBe(created);
    });

    it('forwards optional fields (domainOverrides, weightRationale, effectiveFrom) when provided', async () => {
      weightsRepo.create.mockResolvedValue(versionRow({ id: 'v-draft' }));

      await service.createVersion(
        draftPayload({
          domainOverrides: { academic: 1.0 },
          weightRationale: { systems_thinker: 'because' },
          effectiveFrom: '2026-09-01T00:00:00.000Z',
        })
      );

      expect(weightsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          domainOverrides: { academic: 1.0 },
          weightRationale: { systems_thinker: 'because' },
          effectiveFrom: '2026-09-01T00:00:00.000Z',
        })
      );
    });

    it.each(['versionTag', 'modelType', 'intelligenceDomain', 'description', 'weights'])(
      'throws a 400 VALIDATION_ERROR when %s is missing, without calling the repository',
      async (field) => {
        const payload = draftPayload();
        delete payload[field];

        await expect(service.createVersion(payload)).rejects.toMatchObject({
          name: 'AppError',
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        });
        expect(weightsRepo.create).not.toHaveBeenCalled();
      }
    );

    it('never forwards approvedBy/approvedAt/deprecatedAt even if present on the payload', async () => {
      weightsRepo.create.mockResolvedValue(versionRow({ id: 'v-draft' }));

      await service.createVersion(
        draftPayload({
          approvedBy: 'someone',
          approvedAt: '2026-01-01T00:00:00.000Z',
          deprecatedAt: '2026-01-01T00:00:00.000Z',
        })
      );

      const forwarded = weightsRepo.create.mock.calls[0][0];
      expect(forwarded.approvedBy).toBeUndefined();
      expect(forwarded.approvedAt).toBeUndefined();
      expect(forwarded.deprecatedAt).toBeUndefined();
    });

    it('propagates a repository failure unchanged (e.g. 409 CONFLICT on duplicate)', async () => {
      const conflictError = Object.assign(new Error('duplicate'), {
        name: 'AppError',
        statusCode: 409,
        code: 'CONFLICT',
      });
      weightsRepo.create.mockRejectedValue(conflictError);

      await expect(service.createVersion(draftPayload())).rejects.toBe(conflictError);
    });
  });

  describe('approveVersion() — WP-ADMIN-COMP-08-R25', () => {
    function draftRow(overrides = {}) {
      return versionRow({
        id: 'v-draft',
        approvedBy: null,
        approvedAt: null,
        deprecatedAt: null,
        isApproved: false,
        isDeprecated: false,
        ...overrides,
      });
    }

    it('approves an eligible draft and returns the approved version', async () => {
      weightsRepo.findById.mockResolvedValue(draftRow());
      const approved = versionRow({ id: 'v-draft', approvedBy: 'admin-1', isApproved: true });
      weightsRepo.approve.mockResolvedValue(approved);

      const result = await service.approveVersion('v-draft', 'admin-1');

      expect(weightsRepo.findById).toHaveBeenCalledWith('v-draft');
      expect(weightsRepo.approve).toHaveBeenCalledWith('v-draft', 'admin-1');
      expect(result).toBe(approved);
    });

    it('forwards only req.user.id-sourced adminId as the approving actor', async () => {
      weightsRepo.findById.mockResolvedValue(draftRow());
      weightsRepo.approve.mockResolvedValue(versionRow({ id: 'v-draft' }));

      await service.approveVersion('v-draft', 'admin-42');

      expect(weightsRepo.approve).toHaveBeenCalledWith('v-draft', 'admin-42');
    });

    it('throws a 404 AppError with ErrorCodes.NOT_FOUND when the version does not exist, without calling approve()', async () => {
      weightsRepo.findById.mockResolvedValue(null);

      await expect(service.approveVersion('missing', 'admin-1')).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(weightsRepo.approve).not.toHaveBeenCalled();
    });

    it('throws a 409 AppError with ErrorCodes.CONFLICT when already approved, without calling approve()', async () => {
      weightsRepo.findById.mockResolvedValue(
        draftRow({ approvedAt: '2026-06-01T00:00:00.000Z', approvedBy: 'admin-0', isApproved: true })
      );

      await expect(service.approveVersion('v-draft', 'admin-1')).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 409,
        code: 'CONFLICT',
      });
      expect(weightsRepo.approve).not.toHaveBeenCalled();
    });

    it('throws a 409 AppError with ErrorCodes.CONFLICT when deprecated, without calling approve()', async () => {
      weightsRepo.findById.mockResolvedValue(
        draftRow({ deprecatedAt: '2026-07-01T00:00:00.000Z', isDeprecated: true })
      );

      await expect(service.approveVersion('v-draft', 'admin-1')).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 409,
        code: 'CONFLICT',
      });
      expect(weightsRepo.approve).not.toHaveBeenCalled();
    });

    it('does not rewrite approval history: a repeated approval attempt is rejected before touching approve()', async () => {
      weightsRepo.findById.mockResolvedValue(
        draftRow({ approvedAt: '2026-06-01T00:00:00.000Z', approvedBy: 'first-admin', isApproved: true })
      );

      await expect(service.approveVersion('v-draft', 'second-admin')).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(weightsRepo.approve).not.toHaveBeenCalled();
    });

    it('throws a 409 AppError with ErrorCodes.CONFLICT when eligibility is lost between the read and the atomic update (race)', async () => {
      weightsRepo.findById.mockResolvedValue(draftRow());
      weightsRepo.approve.mockResolvedValue(null);

      await expect(service.approveVersion('v-draft', 'admin-1')).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 409,
        code: 'CONFLICT',
      });
    });

    it('fires a fire-and-forget MODEL_VERSION_APPROVED audit log entry on success', async () => {
      weightsRepo.findById.mockResolvedValue(draftRow());
      weightsRepo.approve.mockResolvedValue(
        versionRow({ id: 'v-draft', versionTag: 'v2.0.0', modelType: 'signal_weights', intelligenceDomain: 'professional' })
      );

      await service.approveVersion('v-draft', 'admin-1');

      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: 'admin-1',
          action: 'MODEL_VERSION_APPROVED',
          entityType: 'signal_weight_version',
          entityId: 'v-draft',
        })
      );
    });

    it('does not fire an audit log entry when approval fails', async () => {
      weightsRepo.findById.mockResolvedValue(null);

      await expect(service.approveVersion('missing', 'admin-1')).rejects.toBeTruthy();
      expect(logAdminAction).not.toHaveBeenCalled();
    });

    it('propagates an unexpected findById() repository failure unchanged (no swallowing)', async () => {
      const dbError = new Error('boom');
      weightsRepo.findById.mockRejectedValue(dbError);
      await expect(service.approveVersion('v-draft', 'admin-1')).rejects.toBe(dbError);
    });

    it('propagates an unexpected approve() repository failure unchanged (no swallowing)', async () => {
      weightsRepo.findById.mockResolvedValue(draftRow());
      const dbError = new Error('boom');
      weightsRepo.approve.mockRejectedValue(dbError);
      await expect(service.approveVersion('v-draft', 'admin-1')).rejects.toBe(dbError);
    });
  });

  describe('deprecateVersion() — WP-ADMIN-COMP-08-R26', () => {
    function approvedRow(overrides = {}) {
      return versionRow({
        id: 'v-approved',
        approvedBy: 'admin-0',
        approvedAt: '2026-06-01T00:00:00.000Z',
        deprecatedAt: null,
        isApproved: true,
        isDeprecated: false,
        ...overrides,
      });
    }

    it('deprecates an eligible approved version and returns the deprecated version', async () => {
      weightsRepo.findById.mockResolvedValue(approvedRow());
      const deprecated = versionRow({
        id: 'v-approved',
        deprecatedAt: '2026-08-16T00:00:00.000Z',
        isDeprecated: true,
      });
      weightsRepo.deprecate.mockResolvedValue(deprecated);

      const result = await service.deprecateVersion('v-approved', 'admin-1');

      expect(weightsRepo.findById).toHaveBeenCalledWith('v-approved');
      expect(weightsRepo.deprecate).toHaveBeenCalledWith('v-approved');
      expect(result).toBe(deprecated);
    });

    it('throws a 404 AppError with ErrorCodes.NOT_FOUND when the version does not exist, without calling deprecate()', async () => {
      weightsRepo.findById.mockResolvedValue(null);

      await expect(service.deprecateVersion('missing', 'admin-1')).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(weightsRepo.deprecate).not.toHaveBeenCalled();
    });

    it('throws a 409 AppError with ErrorCodes.CONFLICT when the version is still a draft (never approved), without calling deprecate()', async () => {
      weightsRepo.findById.mockResolvedValue(
        versionRow({
          id: 'v-draft',
          approvedBy: null,
          approvedAt: null,
          deprecatedAt: null,
          isApproved: false,
          isDeprecated: false,
        })
      );

      await expect(service.deprecateVersion('v-draft', 'admin-1')).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 409,
        code: 'CONFLICT',
      });
      expect(weightsRepo.deprecate).not.toHaveBeenCalled();
    });

    it('throws a 409 AppError with ErrorCodes.CONFLICT when already deprecated, without calling deprecate()', async () => {
      weightsRepo.findById.mockResolvedValue(
        approvedRow({ deprecatedAt: '2026-07-01T00:00:00.000Z', isDeprecated: true })
      );

      await expect(service.deprecateVersion('v-approved', 'admin-1')).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 409,
        code: 'CONFLICT',
      });
      expect(weightsRepo.deprecate).not.toHaveBeenCalled();
    });

    it('does not rewrite deprecation history: a repeated deprecation attempt is rejected before touching deprecate()', async () => {
      weightsRepo.findById.mockResolvedValue(
        approvedRow({ deprecatedAt: '2026-07-01T00:00:00.000Z', isDeprecated: true })
      );

      await expect(service.deprecateVersion('v-approved', 'second-admin')).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(weightsRepo.deprecate).not.toHaveBeenCalled();
    });

    it('allows deprecating a version that currently resolves as active (does not block on that basis)', async () => {
      weightsRepo.findById.mockResolvedValue(approvedRow());
      weightsRepo.deprecate.mockResolvedValue(
        versionRow({ id: 'v-approved', deprecatedAt: '2026-08-16T00:00:00.000Z', isDeprecated: true })
      );

      await expect(service.deprecateVersion('v-approved', 'admin-1')).resolves.toBeTruthy();
      expect(weightsRepo.deprecate).toHaveBeenCalledWith('v-approved');
    });

    it('throws a 409 AppError with ErrorCodes.CONFLICT when eligibility is lost between the read and the atomic update (race)', async () => {
      weightsRepo.findById.mockResolvedValue(approvedRow());
      weightsRepo.deprecate.mockResolvedValue(null);

      await expect(service.deprecateVersion('v-approved', 'admin-1')).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 409,
        code: 'CONFLICT',
      });
    });

    it('fires a fire-and-forget MODEL_VERSION_DEPRECATED audit log entry on success', async () => {
      weightsRepo.findById.mockResolvedValue(approvedRow());
      weightsRepo.deprecate.mockResolvedValue(
        versionRow({
          id: 'v-approved',
          versionTag: 'v2.0.0',
          modelType: 'signal_weights',
          intelligenceDomain: 'professional',
          deprecatedAt: '2026-08-16T00:00:00.000Z',
          isDeprecated: true,
        })
      );

      await service.deprecateVersion('v-approved', 'admin-1');

      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: 'admin-1',
          action: 'MODEL_VERSION_DEPRECATED',
          entityType: 'signal_weight_version',
          entityId: 'v-approved',
        })
      );
    });

    it('does not fire an audit log entry when deprecation fails', async () => {
      weightsRepo.findById.mockResolvedValue(null);

      await expect(service.deprecateVersion('missing', 'admin-1')).rejects.toBeTruthy();
      expect(logAdminAction).not.toHaveBeenCalled();
    });

    it('propagates an unexpected findById() repository failure unchanged (no swallowing)', async () => {
      const dbError = new Error('boom');
      weightsRepo.findById.mockRejectedValue(dbError);
      await expect(service.deprecateVersion('v-approved', 'admin-1')).rejects.toBe(dbError);
    });

    it('propagates an unexpected deprecate() repository failure unchanged (no swallowing)', async () => {
      weightsRepo.findById.mockResolvedValue(approvedRow());
      const dbError = new Error('boom');
      weightsRepo.deprecate.mockRejectedValue(dbError);
      await expect(service.deprecateVersion('v-approved', 'admin-1')).rejects.toBe(dbError);
    });
  });
});