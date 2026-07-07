'use strict';

/**
 * modules/knowledge-runtime/knowledge/__tests__/knowledge.service.test.js
 *
 * Unit tests for KnowledgeService. Dependencies are injected as mocks via
 * the constructor — no jest.mock() of require() paths, per
 * TESTING_STRATEGY.md §1.
 */

const KnowledgeService = require('../knowledge.service');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeCacheClient({ store = new Map() } = {}) {
  return {
    get: jest.fn(async (key) => store.get(key) ?? null),
    set: jest.fn(async (key, value) => {
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key) => {
      store.delete(key);
      return 1;
    }),
  };
}

function makeKnowledgeRepository(overrides = {}) {
  return {
    findNodeById: jest.fn(async () => null),
    findChildren: jest.fn(async () => ({ roles: [], skillClusters: [] })),
    searchByName: jest.fn(async () => []),
    findSkillClusterById: jest.fn(async () => null),
    listDomains: jest.fn(async () => []),
    ...overrides,
  };
}

describe('KnowledgeService', () => {
  describe('constructor', () => {
    it('throws if knowledgeRepository is missing', () => {
      expect(
        () => new KnowledgeService({ logger: makeLogger() })
      ).toThrow('knowledgeRepository is required');
    });

    it('throws if logger is missing', () => {
      expect(
        () => new KnowledgeService({ knowledgeRepository: makeKnowledgeRepository() })
      ).toThrow('logger is required');
    });
  });

  describe('getTaxonomyNode', () => {
    it('returns null and does not cache when the repository finds nothing', async () => {
      const knowledgeRepository = makeKnowledgeRepository();
      const cacheClient = makeCacheClient();
      const service = new KnowledgeService({
        knowledgeRepository,
        cacheClient,
        logger: makeLogger(),
      });

      const result = await service.getTaxonomyNode('missing-id');

      expect(result).toBeNull();
      expect(cacheClient.set).not.toHaveBeenCalled();
    });

    it('returns the repository result on a cache miss and caches it', async () => {
      const node = { nodeType: 'SKILL', node: { id: 'skill-1', name: 'Node.js' } };
      const knowledgeRepository = makeKnowledgeRepository({
        findNodeById: jest.fn(async () => node),
      });
      const cacheClient = makeCacheClient();
      const service = new KnowledgeService({
        knowledgeRepository,
        cacheClient,
        logger: makeLogger(),
      });

      const result = await service.getTaxonomyNode('skill-1', 'SKILL');

      expect(result).toEqual(node);
      expect(knowledgeRepository.findNodeById).toHaveBeenCalledWith('skill-1', 'SKILL');
      expect(cacheClient.set).toHaveBeenCalledTimes(1);
    });

    it('returns the cached value without calling the repository on a cache hit', async () => {
      const node = { nodeType: 'SKILL', node: { id: 'skill-1', name: 'Node.js' } };
      const store = new Map();
      store.set('knowledge-runtime:node:SKILL:skill-1', JSON.stringify(node));

      const knowledgeRepository = makeKnowledgeRepository();
      const cacheClient = makeCacheClient({ store });
      const service = new KnowledgeService({
        knowledgeRepository,
        cacheClient,
        logger: makeLogger(),
      });

      const result = await service.getTaxonomyNode('skill-1', 'SKILL');

      expect(result).toEqual(node);
      expect(knowledgeRepository.findNodeById).not.toHaveBeenCalled();
    });

    it('does not throw when cacheClient is null (cache-optional behaviour)', async () => {
      const node = { nodeType: 'SKILL', node: { id: 'skill-1', name: 'Node.js' } };
      const knowledgeRepository = makeKnowledgeRepository({
        findNodeById: jest.fn(async () => node),
      });
      const service = new KnowledgeService({
        knowledgeRepository,
        cacheClient: null,
        logger: makeLogger(),
      });

      await expect(service.getTaxonomyNode('skill-1')).resolves.toEqual(node);
    });

    it('does not throw and treats it as a cache miss when the cache read fails', async () => {
      const node = { nodeType: 'SKILL', node: { id: 'skill-1', name: 'Node.js' } };
      const knowledgeRepository = makeKnowledgeRepository({
        findNodeById: jest.fn(async () => node),
      });
      const cacheClient = {
        get: jest.fn(async () => {
          throw new Error('redis unavailable');
        }),
        set: jest.fn(async () => 'OK'),
        del: jest.fn(async () => 1),
      };
      const logger = makeLogger();
      const service = new KnowledgeService({ knowledgeRepository, cacheClient, logger });

      const result = await service.getTaxonomyNode('skill-1');

      expect(result).toEqual(node);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('getTaxonomySubtree', () => {
    it('returns null when the root node does not exist', async () => {
      const knowledgeRepository = makeKnowledgeRepository();
      const service = new KnowledgeService({
        knowledgeRepository,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.getTaxonomySubtree('missing-domain', { depth: 2 });

      expect(result).toBeNull();
      expect(knowledgeRepository.findChildren).not.toHaveBeenCalled();
    });

    it('resolves children for a DOMAIN root node', async () => {
      const domainNode = { nodeType: 'DOMAIN', node: { id: 'domain-1', name: 'Engineering' } };
      const children = { roles: [{ id: 'role-1' }], skillClusters: [{ id: 'cluster-1' }] };
      const knowledgeRepository = makeKnowledgeRepository({
        findNodeById: jest.fn(async () => domainNode),
        findChildren: jest.fn(async () => children),
      });
      const service = new KnowledgeService({
        knowledgeRepository,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.getTaxonomySubtree('domain-1', { depth: 2 });

      expect(result).toEqual({
        nodeType: 'DOMAIN',
        node: domainNode.node,
        children,
      });
      expect(knowledgeRepository.findChildren).toHaveBeenCalledWith('domain-1', 'DOMAIN', { depth: 2 });
    });
  });

  describe('searchKnowledge', () => {
    it('returns repository results when skillRepository has no alias match', async () => {
      const repoResults = [{ nodeType: 'SKILL', node: { name: 'Node.js' } }];
      const knowledgeRepository = makeKnowledgeRepository({
        searchByName: jest.fn(async () => repoResults),
      });
      const skillRepository = { getByName: jest.fn(async () => null) };
      const service = new KnowledgeService({
        knowledgeRepository,
        skillRepository,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.searchKnowledge('node', { limit: 20 });

      expect(result).toEqual(repoResults);
    });

    it('prepends an alias match from skillRepository when not already present', async () => {
      const knowledgeRepository = makeKnowledgeRepository({
        searchByName: jest.fn(async () => []),
      });
      const aliasMatch = { name: 'Node.js', aliases: ['node', 'nodejs'] };
      const skillRepository = { getByName: jest.fn(async () => aliasMatch) };
      const service = new KnowledgeService({
        knowledgeRepository,
        skillRepository,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.searchKnowledge('node', {});

      expect(result).toEqual([
        { nodeType: 'SKILL', node: aliasMatch, matchedVia: 'skillRepository.alias' },
      ]);
    });

    it('does not throw when the skillRepository alias lookup fails', async () => {
      const repoResults = [{ nodeType: 'SKILL', node: { name: 'Node.js' } }];
      const knowledgeRepository = makeKnowledgeRepository({
        searchByName: jest.fn(async () => repoResults),
      });
      const skillRepository = {
        getByName: jest.fn(async () => {
          throw new Error('lookup failed');
        }),
      };
      const logger = makeLogger();
      const service = new KnowledgeService({
        knowledgeRepository,
        skillRepository,
        cacheClient: makeCacheClient(),
        logger,
      });

      const result = await service.searchKnowledge('node', {});

      expect(result).toEqual(repoResults);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('listDomains (WP-XAI2-04)', () => {
    it('returns repository results and caches them', async () => {
      const domains = [{ id: 'domain-1', name: 'Engineering' }];
      const knowledgeRepository = makeKnowledgeRepository({
        listDomains: jest.fn(async () => domains),
      });
      const cacheClient = makeCacheClient();
      const service = new KnowledgeService({
        knowledgeRepository,
        cacheClient,
        logger: makeLogger(),
      });

      const result = await service.listDomains();

      expect(result).toEqual(domains);
      expect(cacheClient.set).toHaveBeenCalled();
    });

    it('returns the cached value on a cache hit without calling the repository again', async () => {
      const domains = [{ id: 'domain-1', name: 'Engineering' }];
      const knowledgeRepository = makeKnowledgeRepository({
        listDomains: jest.fn(async () => domains),
      });
      const cacheClient = makeCacheClient();
      const service = new KnowledgeService({
        knowledgeRepository,
        cacheClient,
        logger: makeLogger(),
      });

      await service.listDomains();
      const result = await service.listDomains();

      expect(result).toEqual(domains);
      expect(knowledgeRepository.listDomains).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveSkillCluster', () => {
    it('returns null when the cluster does not exist', async () => {
      const knowledgeRepository = makeKnowledgeRepository();
      const service = new KnowledgeService({
        knowledgeRepository,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.resolveSkillCluster('missing-cluster');

      expect(result).toBeNull();
    });

    it('returns the cluster with an empty, flagged memberSkills list', async () => {
      const cluster = { id: 'cluster-1', name: 'Frontend Development' };
      const knowledgeRepository = makeKnowledgeRepository({
        findSkillClusterById: jest.fn(async () => cluster),
      });
      const service = new KnowledgeService({
        knowledgeRepository,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.resolveSkillCluster('cluster-1');

      expect(result).toEqual({
        cluster,
        memberSkills: [],
        memberSkillsAvailable: false,
      });
    });
  });

  describe('invalidate', () => {
    it('deletes all node-type cache keys and bumps the version', async () => {
      const knowledgeRepository = makeKnowledgeRepository();
      const cacheClient = makeCacheClient();
      const service = new KnowledgeService({
        knowledgeRepository,
        cacheClient,
        logger: makeLogger(),
      });

      await service.invalidate('node-1');

      expect(cacheClient.del).toHaveBeenCalledTimes(5);
      expect(cacheClient.set).toHaveBeenCalledWith(
        'knowledge-runtime:version',
        expect.any(String)
      );
    });

    it('is a no-op when nodeId is falsy', async () => {
      const cacheClient = makeCacheClient();
      const service = new KnowledgeService({
        knowledgeRepository: makeKnowledgeRepository(),
        cacheClient,
        logger: makeLogger(),
      });

      await service.invalidate(null);

      expect(cacheClient.del).not.toHaveBeenCalled();
    });
  });

  describe('getVersion', () => {
    it('mints and caches a version token on first call', async () => {
      const cacheClient = makeCacheClient();
      const service = new KnowledgeService({
        knowledgeRepository: makeKnowledgeRepository(),
        cacheClient,
        logger: makeLogger(),
      });

      const result = await service.getVersion();

      expect(result).toEqual({ version: expect.any(String) });
      expect(cacheClient.set).toHaveBeenCalledTimes(1);
    });

    it('returns the same version on a subsequent cache hit', async () => {
      const cacheClient = makeCacheClient();
      const service = new KnowledgeService({
        knowledgeRepository: makeKnowledgeRepository(),
        cacheClient,
        logger: makeLogger(),
      });

      const first = await service.getVersion();
      const second = await service.getVersion();

      expect(second).toEqual(first);
      expect(cacheClient.set).toHaveBeenCalledTimes(1);
    });
  });
});
