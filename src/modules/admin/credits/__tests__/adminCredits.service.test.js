'use strict';

/**
 * adminCredits.service.test.js — Phase 4 Usage/Credits Contract Lock
 *
 * Pure orchestration tests: repository is mocked, so these assert that
 * the service composes reads correctly and maps RPC-surfaced error codes
 * (DUPLICATE_REFERENCE / USER_NOT_FOUND / INSUFFICIENT_CREDITS /
 * INVALID_AMOUNT / REASON_REQUIRED / REFERENCE_REQUIRED) onto the
 * existing AppError/ErrorCodes convention. Mirrors the mocking shape
 * already used by adminWeights.service.test.js.
 */

jest.mock('../adminCredits.repository', () => ({
  adminCreditsRepository: {
    findUserByIdOrEmail: jest.fn(),
    getUserById: jest.fn(),
    getUsageCounterState: jest.fn(),
    getFeatureQuotaState: jest.fn(),
    listLedger: jest.fn(),
    grant: jest.fn(),
    adjust: jest.fn(),
  },
  LEDGER_TRANSACTION_TYPES: ['CONSUME', 'GRANT', 'ADJUST', 'REFUND'],
}));

const { adminCreditsRepository: repo } = require('../adminCredits.repository');
const service = require('../adminCredits.service');

function userRow(overrides = {}) {
  return {
    id: 'user-1',
    email: 'user1@example.com',
    displayName: 'User One',
    role: 'user',
    aiCreditsRemaining: 10,
    ...overrides,
  };
}

describe('adminCredits.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getUserCreditSummary()', () => {
    it('404s when the user is not found', async () => {
      repo.findUserByIdOrEmail.mockResolvedValue(null);

      await expect(service.getUserCreditSummary('missing@example.com')).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('returns identity + authoritative balance + both quota systems + ledger page', async () => {
      repo.findUserByIdOrEmail.mockResolvedValue(userRow());
      repo.getUsageCounterState.mockResolvedValue({ monthlyAiUsageCount: 3, aiUsageResetDate: '2026-09-01' });
      repo.getFeatureQuotaState.mockResolvedValue({ monthKey: '2026-08', features: [{ feature: 'jobMatchAnalysis', count: 2 }] });
      repo.listLedger.mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 });

      const result = await service.getUserCreditSummary('user1@example.com');

      expect(result.creditBalance).toBe(10);
      expect(result.quota.usageCounter.monthlyAiUsageCount).toBe(3);
      expect(result.quota.featureQuota.features).toEqual([{ feature: 'jobMatchAnalysis', count: 2 }]);
      // Both systems must remain visibly separate (Phase 3 Contract §21) —
      // never merged into a single counter.
      expect(result.quota.usageCounter).not.toHaveProperty('features');
      expect(result.quota.featureQuota).not.toHaveProperty('monthlyAiUsageCount');
      expect(repo.listLedger).toHaveBeenCalledWith('user-1', { limit: 25, offset: 0 });
    });
  });

  describe('listLedger()', () => {
    it('404s for an unknown user before paginating', async () => {
      repo.getUserById.mockResolvedValue(null);
      await expect(service.listLedger('ghost-id', {})).rejects.toMatchObject({ statusCode: 404 });
      expect(repo.listLedger).not.toHaveBeenCalled();
    });

    it('forwards filters to the repository', async () => {
      repo.getUserById.mockResolvedValue(userRow());
      repo.listLedger.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 10 });

      await service.listLedger('user-1', { limit: 50, offset: 10, transactionType: 'GRANT' });

      expect(repo.listLedger).toHaveBeenCalledWith('user-1', { limit: 50, offset: 10, transactionType: 'GRANT' });
    });
  });

  describe('grantCredits() — error mapping', () => {
    it('succeeds and returns balanceAfter/ledgerId', async () => {
      repo.grant.mockResolvedValue({ balanceAfter: 20, ledgerId: 'ledger-1' });

      const result = await service.grantCredits({
        targetUserId: 'user-1', amount: 10, reason: 'promo', referenceId: 'ref-1', actorAdminId: 'admin-1',
      });

      expect(result).toEqual({ balanceAfter: 20, ledgerId: 'ledger-1' });
    });

    it('maps DUPLICATE_REFERENCE to 409 CONFLICT', async () => {
      repo.grant.mockRejectedValue(new Error('DUPLICATE_REFERENCE: reference_id ref-1 already applied for user user-1'));

      await expect(service.grantCredits({
        targetUserId: 'user-1', amount: 10, reason: 'promo', referenceId: 'ref-1', actorAdminId: 'admin-1',
      })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('maps USER_NOT_FOUND to 404', async () => {
      repo.grant.mockRejectedValue(new Error('USER_NOT_FOUND: No user exists with id: ghost'));

      await expect(service.grantCredits({
        targetUserId: 'ghost', amount: 10, reason: 'promo', referenceId: 'ref-1', actorAdminId: 'admin-1',
      })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('maps INVALID_AMOUNT to 400', async () => {
      repo.grant.mockRejectedValue(new Error('INVALID_AMOUNT: amount must be a positive integer, got -5'));

      await expect(service.grantCredits({
        targetUserId: 'user-1', amount: -5, reason: 'promo', referenceId: 'ref-1', actorAdminId: 'admin-1',
      })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('maps UNAUTHORIZED (RPC-level actor rejection — Phase 4B security fix) to 403, not a generic 500', async () => {
      repo.grant.mockRejectedValue(new Error('UNAUTHORIZED: actor admin-1 is not an active MASTER_ADMIN'));

      await expect(service.grantCredits({
        targetUserId: 'user-1', amount: 10, reason: 'promo', referenceId: 'ref-1', actorAdminId: 'admin-1',
      })).rejects.toMatchObject({ statusCode: 403 });
    });

    it('maps unexpected failures to 500', async () => {
      repo.grant.mockRejectedValue(new Error('connection reset'));

      await expect(service.grantCredits({
        targetUserId: 'user-1', amount: 10, reason: 'promo', referenceId: 'ref-1', actorAdminId: 'admin-1',
      })).rejects.toMatchObject({ statusCode: 500 });
    });
  });

  describe('adjustCredits() — error mapping', () => {
    it('succeeds for a negative adjustment', async () => {
      repo.adjust.mockResolvedValue({ balanceAfter: 5, ledgerId: 'ledger-2' });

      const result = await service.adjustCredits({
        targetUserId: 'user-1', adjustment: -5, reason: 'correction', referenceId: 'ref-2', actorAdminId: 'admin-1',
      });

      expect(result).toEqual({ balanceAfter: 5, ledgerId: 'ledger-2' });
    });

    it('maps INSUFFICIENT_CREDITS (negative-balance protection) to 409', async () => {
      repo.adjust.mockRejectedValue(new Error('INSUFFICIENT_CREDITS: adjustment -50 would take balance below zero (current=10)'));

      await expect(service.adjustCredits({
        targetUserId: 'user-1', adjustment: -50, reason: 'correction', referenceId: 'ref-2', actorAdminId: 'admin-1',
      })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('maps REASON_REQUIRED to 400', async () => {
      repo.adjust.mockRejectedValue(new Error('REASON_REQUIRED: reason is required for ADJUST'));

      await expect(service.adjustCredits({
        targetUserId: 'user-1', adjustment: 5, reason: '', referenceId: 'ref-2', actorAdminId: 'admin-1',
      })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('maps UNAUTHORIZED (RPC-level actor rejection — Phase 4B security fix) to 403', async () => {
      repo.adjust.mockRejectedValue(new Error('UNAUTHORIZED: actor admin-1 is not an active MASTER_ADMIN'));

      await expect(service.adjustCredits({
        targetUserId: 'user-1', adjustment: 5, reason: 'correction', referenceId: 'ref-2', actorAdminId: 'admin-1',
      })).rejects.toMatchObject({ statusCode: 403 });
    });
  });
});
