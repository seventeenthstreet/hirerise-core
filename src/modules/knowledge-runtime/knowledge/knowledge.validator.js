'use strict';

/**
 * modules/knowledge-runtime/knowledge/knowledge.validator.js
 *
 * Input validation for KnowledgeService's public surface. Runs before a
 * controller calls into the service — matches
 * `validator.validateCreateStudent(...)` called before
 * `service.createStudent(...)` in `student.controller.js`
 * (ENGINEERING_STANDARDS.md §5).
 *
 * Throws AppError with ErrorCodes.VALIDATION_ERROR — no new error type.
 */

const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const { NODE_TYPE } = require('./knowledge.repository');

const MAX_SUBTREE_DEPTH = 5;
const MAX_QUERY_LENGTH = 200;
const MAX_SEARCH_LIMIT = 100;

const VALID_NODE_TYPES = Object.freeze(Object.values(NODE_TYPE));

function _fail(message, meta = {}) {
  throw new AppError(message, 400, meta, ErrorCodes.VALIDATION_ERROR);
}

/**
 * @param {string} nodeId
 * @returns {string} the trimmed, validated nodeId
 */
function validateNodeId(nodeId) {
  if (typeof nodeId !== 'string' || !nodeId.trim()) {
    _fail('nodeId is required and must be a non-empty string', { nodeId });
  }
  return nodeId.trim();
}

/**
 * @param {string} [nodeType]
 * @returns {string|null} the validated nodeType, or null if not provided
 */
function validateNodeType(nodeType) {
  if (nodeType === undefined || nodeType === null) return null;

  if (typeof nodeType !== 'string' || !VALID_NODE_TYPES.includes(nodeType)) {
    _fail(
      `nodeType must be one of: ${VALID_NODE_TYPES.join(', ')}`,
      { nodeType }
    );
  }
  return nodeType;
}

/**
 * @param {{ depth?: number }} [options]
 * @returns {{ depth: number }}
 */
function validateSubtreeOptions(options = {}) {
  const { depth = 1 } = options ?? {};

  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_SUBTREE_DEPTH) {
    _fail(
      `depth must be an integer between 1 and ${MAX_SUBTREE_DEPTH}`,
      { depth }
    );
  }

  return { depth };
}

/**
 * @param {string} query
 * @returns {string} trimmed, validated query
 */
function validateSearchQuery(query) {
  if (typeof query !== 'string' || !query.trim()) {
    _fail('query is required and must be a non-empty string', { query });
  }

  const trimmed = query.trim();

  if (trimmed.length > MAX_QUERY_LENGTH) {
    _fail(`query must be ${MAX_QUERY_LENGTH} characters or fewer`, {
      queryLength: trimmed.length,
    });
  }

  return trimmed;
}

/**
 * @param {{ nodeTypes?: string[], limit?: number }} [filters]
 * @returns {{ nodeTypes: string[]|null, limit: number }}
 */
function validateSearchFilters(filters = {}) {
  const { nodeTypes = null, limit = 20 } = filters ?? {};

  let validatedNodeTypes = null;

  if (nodeTypes !== null && nodeTypes !== undefined) {
    if (!Array.isArray(nodeTypes) || nodeTypes.length === 0) {
      _fail('filters.nodeTypes must be a non-empty array when provided', {
        nodeTypes,
      });
    }

    const invalid = nodeTypes.filter((t) => !VALID_NODE_TYPES.includes(t));
    if (invalid.length) {
      _fail(
        `filters.nodeTypes contains invalid values: ${invalid.join(', ')}`,
        { invalid, validNodeTypes: VALID_NODE_TYPES }
      );
    }

    validatedNodeTypes = nodeTypes;
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    _fail(
      `filters.limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`,
      { limit }
    );
  }

  return { nodeTypes: validatedNodeTypes, limit };
}

module.exports = {
  validateNodeId,
  validateNodeType,
  validateSubtreeOptions,
  validateSearchQuery,
  validateSearchFilters,
  MAX_SUBTREE_DEPTH,
  MAX_QUERY_LENGTH,
  MAX_SEARCH_LIMIT,
};
