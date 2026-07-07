'use strict';

/**
 * modules/knowledge-runtime/knowledge/__tests__/knowledge.controller.test.js
 *
 * Controller unit tests. The knowledge-runtime module singleton is mocked
 * via `_setServiceForTesting`-equivalent direct jest.mock, matching
 * `adminSignalLineage.controller.test.js`'s precedent of mocking
 * collaborators rather than hitting real infra.
 */

const mockService = {
  getTaxonomyNode: jest.fn(),
  getTaxonomySubtree: jest.fn(),
  searchKnowledge: jest.fn(),
  resolveSkillCluster: jest.fn(),
  invalidate: jest.fn(),
  getVersion: jest.fn(),
};

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../knowledge-runtime.module', () => ({
  getKnowledgeService: () => mockService,
}));

const controller = require('../knowledge.controller');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('knowledge.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getTaxonomyNode', () => {
    it('returns 200 with the node on success', async () => {
      const node = { nodeType: 'SKILL', node: { id: 'skill-1' } };
      mockService.getTaxonomyNode.mockResolvedValue(node);

      const req = { params: { nodeId: 'skill-1' }, query: {} };
      const res = makeRes();
      const next = jest.fn();

      await controller.getTaxonomyNode(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: node });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 404 when the service finds nothing', async () => {
      mockService.getTaxonomyNode.mockResolvedValue(null);

      const req = { params: { nodeId: 'missing' }, query: {} };
      const res = makeRes();
      const next = jest.fn();

      await controller.getTaxonomyNode(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('forwards validation errors to next() without calling the service', async () => {
      const req = { params: { nodeId: '' }, query: {} };
      const res = makeRes();
      const next = jest.fn();

      await controller.getTaxonomyNode(req, res, next);

      expect(mockService.getTaxonomyNode).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('rejects an invalid nodeType query param', async () => {
      const req = { params: { nodeId: 'skill-1' }, query: { nodeType: 'NOT_A_TYPE' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getTaxonomyNode(req, res, next);

      expect(mockService.getTaxonomyNode).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('getTaxonomySubtree', () => {
    it('defaults depth to 1 when not provided', async () => {
      mockService.getTaxonomySubtree.mockResolvedValue({ nodeType: 'DOMAIN', node: {}, children: {} });

      const req = { params: { nodeId: 'domain-1' }, query: {} };
      const res = makeRes();
      const next = jest.fn();

      await controller.getTaxonomySubtree(req, res, next);

      expect(mockService.getTaxonomySubtree).toHaveBeenCalledWith('domain-1', { depth: 1 });
    });

    it('rejects a depth outside the valid range', async () => {
      const req = { params: { nodeId: 'domain-1' }, query: { depth: '99' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.getTaxonomySubtree(req, res, next);

      expect(mockService.getTaxonomySubtree).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('searchKnowledge', () => {
    it('parses comma-separated nodeTypes and numeric limit', async () => {
      mockService.searchKnowledge.mockResolvedValue([]);

      const req = { query: { query: 'node', nodeTypes: 'SKILL,ROLE', limit: '10' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.searchKnowledge(req, res, next);

      expect(mockService.searchKnowledge).toHaveBeenCalledWith('node', {
        nodeTypes: ['SKILL', 'ROLE'],
        limit: 10,
      });
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { results: [] } });
    });

    it('rejects a missing query param', async () => {
      const req = { query: {} };
      const res = makeRes();
      const next = jest.fn();

      await controller.searchKnowledge(req, res, next);

      expect(mockService.searchKnowledge).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('invalidateNode', () => {
    it('calls service.invalidate and returns success', async () => {
      mockService.invalidate.mockResolvedValue(undefined);

      const req = { params: { nodeId: 'node-1' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.invalidateNode(req, res, next);

      expect(mockService.invalidate).toHaveBeenCalledWith('node-1');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { invalidated: true, nodeId: 'node-1' },
      });
    });
  });

  describe('getVersion', () => {
    it('returns the version payload from the service', async () => {
      mockService.getVersion.mockResolvedValue({ version: '123' });

      const req = {};
      const res = makeRes();
      const next = jest.fn();

      await controller.getVersion(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: { version: '123' } });
    });

    it('forwards service errors to next()', async () => {
      mockService.getVersion.mockRejectedValue(new Error('cache down'));

      const req = {};
      const res = makeRes();
      const next = jest.fn();

      await controller.getVersion(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
