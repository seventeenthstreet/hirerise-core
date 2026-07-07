'use strict';

/**
 * modules/knowledge-runtime/knowledge/__tests__/knowledge.repository.test.js
 *
 * Repository tests for KnowledgeRepository, exercised through the real
 * BaseRepository code path against an in-memory Supabase fake (see
 * testUtils/supabaseMock.js) — not mocked at the KnowledgeRepository level,
 * since the class under test *is* the thin wrapper around BaseRepository.
 */

const { createSupabaseMock } = require('../testHelpers/supabaseMock');

jest.mock('../../../../config/supabase', () => ({
  supabase: global.__knowledgeSupabaseMock,
}));

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('KnowledgeRepository', () => {
  let KnowledgeRepository;
  let NODE_TYPE;

  const domainRow = {
    id: 'domain-1',
    name: 'Engineering',
    status: 'active',
    soft_deleted: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  const secondDomainRow = {
    id: 'domain-2',
    name: 'Design',
    status: 'active',
    soft_deleted: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  const roleRow = {
    id: 'role-1',
    name: 'Frontend Engineer',
    domain_id: 'domain-1',
    status: 'active',
    soft_deleted: false,
  };

  const clusterRow = {
    id: 'cluster-1',
    name: 'Frontend Development',
    domain_id: 'domain-1',
    status: 'active',
    soft_deleted: false,
  };

  const skillRow = {
    id: 'skill-1',
    name: 'Node.js',
    status: 'active',
    soft_deleted: false,
  };

  beforeEach(() => {
    jest.resetModules();

    global.__knowledgeSupabaseMock = createSupabaseMock({
      cms_career_domains: [domainRow, secondDomainRow],
      cms_roles: [roleRow],
      cms_skills: [skillRow],
      cms_skill_clusters: [clusterRow],
    });

    // Re-require after resetModules so the jest.mock factory above picks up
    // the freshly-assigned global mock for each test.
    ({ KnowledgeRepository, NODE_TYPE } = require('../knowledge.repository'));
  });

  describe('findNodeById', () => {
    it('returns null when nodeId is falsy', async () => {
      const repo = new KnowledgeRepository();
      await expect(repo.findNodeById(null)).resolves.toBeNull();
    });

    it('finds a node directly when nodeType is provided', async () => {
      const repo = new KnowledgeRepository();
      const result = await repo.findNodeById('skill-1', NODE_TYPE.SKILL);

      expect(result).toEqual({
        nodeType: 'SKILL',
        node: expect.objectContaining({ id: 'skill-1', name: 'Node.js' }),
      });
    });

    it('probes all node types when nodeType is omitted', async () => {
      const repo = new KnowledgeRepository();
      const result = await repo.findNodeById('cluster-1');

      expect(result.nodeType).toBe('SKILL_CLUSTER');
      expect(result.node.id).toBe('cluster-1');
    });

    it('returns null when the id does not exist in any table', async () => {
      const repo = new KnowledgeRepository();
      const result = await repo.findNodeById('does-not-exist');

      expect(result).toBeNull();
    });
  });

  describe('findChildren', () => {
    it('returns empty children for a non-DOMAIN node type', async () => {
      const repo = new KnowledgeRepository();
      const result = await repo.findChildren('skill-1', NODE_TYPE.SKILL, { depth: 2 });

      expect(result).toEqual({ roles: [], skillClusters: [] });
    });

    it('returns roles and skill clusters scoped to the domain', async () => {
      const repo = new KnowledgeRepository();
      const result = await repo.findChildren('domain-1', NODE_TYPE.DOMAIN, { depth: 1 });

      expect(result.roles).toHaveLength(1);
      expect(result.roles[0].id).toBe('role-1');
      expect(result.skillClusters).toHaveLength(1);
      expect(result.skillClusters[0].id).toBe('cluster-1');
    });

    it('returns empty children when depth is less than 1', async () => {
      const repo = new KnowledgeRepository();
      const result = await repo.findChildren('domain-1', NODE_TYPE.DOMAIN, { depth: 0 });

      expect(result).toEqual({ roles: [], skillClusters: [] });
    });
  });

  describe('searchByName', () => {
    it('returns an exact-name match across all node types by default', async () => {
      const repo = new KnowledgeRepository();
      const results = await repo.searchByName('Node.js');

      expect(results).toEqual([{ nodeType: 'SKILL', node: expect.objectContaining({ name: 'Node.js' }) }]);
    });

    it('scopes the search to the provided nodeTypes', async () => {
      const repo = new KnowledgeRepository();
      const results = await repo.searchByName('Node.js', { nodeTypes: [NODE_TYPE.DOMAIN] });

      expect(results).toEqual([]);
    });

    it('returns an empty array for an empty query', async () => {
      const repo = new KnowledgeRepository();
      await expect(repo.searchByName('')).resolves.toEqual([]);
    });
  });

  describe('listDomains (WP-XAI2-04)', () => {
    it('returns all DOMAIN nodes, unfiltered', async () => {
      const repo = new KnowledgeRepository();
      const result = await repo.listDomains();

      expect(result).toHaveLength(2);
      expect(result.map((d) => d.id).sort()).toEqual(['domain-1', 'domain-2']);
    });

    it('respects a provided limit', async () => {
      const repo = new KnowledgeRepository();
      const result = await repo.listDomains({ limit: 1 });

      expect(result).toHaveLength(1);
    });
  });
});
