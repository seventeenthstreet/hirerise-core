'use strict';

/**
 * modules/knowledge-runtime/knowledge/knowledge.controller.js
 *
 * HTTP controller for the knowledge-runtime read endpoints.
 *
 * Responsibilities:
 *   - Validate request input via knowledge.validator.js
 *   - Delegate to KnowledgeService (via the lazy singleton module)
 *   - Return the existing { success, data } response envelope
 *   - Forward errors to Express error handler (next(err))
 *
 * Does NOT:
 *   - Access the database directly
 *   - Contain business logic
 *   - Introduce a custom response wrapper (matches
 *     `intelligence-quality.controller.js`, ENGINEERING_STANDARDS.md §4)
 */

const logger = require('../../../utils/logger');
const { getKnowledgeService } = require('../knowledge-runtime.module');
const {
  validateNodeId,
  validateNodeType,
  validateSubtreeOptions,
  validateSearchQuery,
  validateSearchFilters,
} = require('./knowledge.validator');
// WP-XAI2-02 (Response Contract Governance): success responses now go
// through the repository's single canonical envelope helper instead of a
// locally duplicated `sendSuccess`. Additive only — `success`/`data` are
// unchanged; `meta` (timestamp/requestId) is now present.
const { sendSuccess } = require('../../../shared/response');

// ─────────────────────────────────────────────────────────────
// RESPONSE HELPERS
// ─────────────────────────────────────────────────────────────

// `sendNotFound` intentionally stays local rather than migrating to the
// shared `sendError` helper in this pass: `sendError` reports its canonical
// error as `{ code, message }`, whereas this module's existing, documented
// contract has always returned `error` as a plain string. Changing that
// field's *type* (not just adding a field) is a real backward-compatibility
// risk for any existing consumer that reads `body.error` as a string, and
// this work package's mandate is governance without behavior change.
// Tracked as a known limitation (see WP_XAI2_02 report §10) for a
// dedicated, separately-reviewed error-contract migration.
function sendNotFound(res, message) {
  return res.status(404).json({ success: false, error: message });
}

// ─────────────────────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/knowledge/nodes/:nodeId
 * Query params: ?nodeType=DOMAIN|ROLE|SKILL|SKILL_CLUSTER (optional)
 */
async function getTaxonomyNode(req, res, next) {
  try {
    const nodeId = validateNodeId(req.params.nodeId);
    const nodeType = validateNodeType(req.query.nodeType);

    const service = getKnowledgeService();
    const result = await service.getTaxonomyNode(nodeId, nodeType);

    if (!result) {
      return sendNotFound(res, 'Taxonomy node not found');
    }

    return sendSuccess(res, result);
  } catch (err) {
    logger.error('[KnowledgeController.getTaxonomyNode]', { error: err.message });
    return next(err);
  }
}

/**
 * GET /api/v1/knowledge/nodes/:nodeId/subtree
 * Query params: ?depth=1-5 (optional, default 1)
 */
async function getTaxonomySubtree(req, res, next) {
  try {
    const nodeId = validateNodeId(req.params.nodeId);
    const depthRaw = req.query.depth !== undefined ? Number(req.query.depth) : undefined;
    const { depth } = validateSubtreeOptions({ depth: depthRaw ?? 1 });

    const service = getKnowledgeService();
    const result = await service.getTaxonomySubtree(nodeId, { depth });

    if (!result) {
      return sendNotFound(res, 'Taxonomy node not found');
    }

    return sendSuccess(res, result);
  } catch (err) {
    logger.error('[KnowledgeController.getTaxonomySubtree]', { error: err.message });
    return next(err);
  }
}

/**
 * GET /api/v1/knowledge/search
 * Query params: ?query=...&nodeTypes=SKILL,ROLE&limit=20
 */
async function searchKnowledge(req, res, next) {
  try {
    const query = validateSearchQuery(req.query.query);

    const nodeTypesRaw = req.query.nodeTypes
      ? String(req.query.nodeTypes).split(',').map((t) => t.trim())
      : null;
    const limitRaw = req.query.limit !== undefined ? Number(req.query.limit) : undefined;

    const filters = validateSearchFilters({
      nodeTypes: nodeTypesRaw,
      limit: limitRaw ?? 20,
    });

    const service = getKnowledgeService();
    const results = await service.searchKnowledge(query, filters);

    return sendSuccess(res, { results });
  } catch (err) {
    logger.error('[KnowledgeController.searchKnowledge]', { error: err.message });
    return next(err);
  }
}

/**
 * GET /api/v1/knowledge/skill-clusters/:clusterId
 */
async function resolveSkillCluster(req, res, next) {
  try {
    const clusterId = validateNodeId(req.params.clusterId);

    const service = getKnowledgeService();
    const result = await service.resolveSkillCluster(clusterId);

    if (!result) {
      return sendNotFound(res, 'Skill cluster not found');
    }

    return sendSuccess(res, result);
  } catch (err) {
    logger.error('[KnowledgeController.resolveSkillCluster]', { error: err.message });
    return next(err);
  }
}

/**
 * POST /api/v1/knowledge/invalidate/:nodeId
 *
 * Called by admin CMS write paths after a taxonomy mutation. Mounted
 * behind `requireAdmin` at the route layer (see knowledge.routes.js) —
 * this is a cache-management operation, not a taxonomy write; taxonomy
 * writes remain owned exclusively by `modules/admin/cms/*`.
 */
async function invalidateNode(req, res, next) {
  try {
    const nodeId = validateNodeId(req.params.nodeId);

    const service = getKnowledgeService();
    await service.invalidate(nodeId);

    return sendSuccess(res, { invalidated: true, nodeId });
  } catch (err) {
    logger.error('[KnowledgeController.invalidateNode]', { error: err.message });
    return next(err);
  }
}

/**
 * GET /api/v1/knowledge/version
 */
async function getVersion(req, res, next) {
  try {
    const service = getKnowledgeService();
    const version = await service.getVersion();

    return sendSuccess(res, version);
  } catch (err) {
    logger.error('[KnowledgeController.getVersion]', { error: err.message });
    return next(err);
  }
}

module.exports = Object.freeze({
  getTaxonomyNode,
  getTaxonomySubtree,
  searchKnowledge,
  resolveSkillCluster,
  invalidateNode,
  getVersion,
});
