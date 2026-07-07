'use strict';

/**
 * tests/contract/knowledgeService.contract.test.js
 *
 * Freezes the SHAPE (not the values) of `KnowledgeService.getVersion()`,
 * per TESTING_STRATEGY.md §3 — this is consumed by other services
 * (RecommendationService, StudentService per RUNTIME_CLASS_REFERENCE.md),
 * so a shape change here should fail CI, not surface downstream.
 *
 * Business-logic correctness is out of scope for this test — only that
 * required fields exist with the right types.
 *
 * RUN: jest tests/contract/knowledgeService.contract.test.js
 */

const KnowledgeService = require('../../src/modules/knowledge-runtime/knowledge/knowledge.service');

function makeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeKnowledgeRepository() {
  return {
    findNodeById: async () => null,
    findChildren: async () => ({ roles: [], skillClusters: [] }),
    searchByName: async () => [],
    findSkillClusterById: async () => null,
  };
}

describe('KnowledgeService contract: getVersion()', () => {
  it('resolves an object with a string `version` field, with no cache backing', async () => {
    const service = new KnowledgeService({
      knowledgeRepository: makeKnowledgeRepository(),
      cacheClient: null,
      logger: makeLogger(),
    });

    const result = await service.getVersion();

    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
    expect(typeof result.version).toBe('string');
    expect(result.version.length).toBeGreaterThan(0);
  });

  it('resolves the same shape with a working cache client', async () => {
    const store = new Map();
    const cacheClient = {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => {
        store.set(key, value);
        return 'OK';
      },
      del: async (key) => {
        store.delete(key);
        return 1;
      },
    };

    const service = new KnowledgeService({
      knowledgeRepository: makeKnowledgeRepository(),
      cacheClient,
      logger: makeLogger(),
    });

    const result = await service.getVersion();

    expect(typeof result.version).toBe('string');
  });
});
