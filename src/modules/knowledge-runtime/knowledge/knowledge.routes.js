'use strict';

/**
 * modules/knowledge-runtime/knowledge/knowledge.routes.js
 *
 * Mounted at: /api/v1/knowledge (see server.js — mounted behind the
 * existing `authenticate` middleware, matching the intelligence-quality
 * precedent).
 *
 * Endpoints:
 *   GET  /nodes/:nodeId              — resolve a single taxonomy node
 *   GET  /nodes/:nodeId/subtree      — resolve a node + bounded descendants
 *   GET  /search                     — filtered name search
 *   GET  /skill-clusters/:clusterId  — resolve a skill cluster
 *   GET  /version                    — current taxonomy version token
 *   POST /invalidate/:nodeId         — admin-only cache invalidation hook,
 *                                      called by admin CMS write paths
 *
 * Design constraints:
 *   - Read-only for regular authenticated callers — taxonomy writes remain
 *     owned by `modules/admin/cms/*`.
 *   - `/invalidate/:nodeId` is a cache-management operation, not a
 *     taxonomy write, but is still gated behind `requireAdmin` since it's
 *     only meant to be called from admin CMS write paths.
 *   - Standard { success, data } response envelope.
 */

const { Router } = require('express');
const { requireAdmin } = require('../../../middleware/auth.middleware');
const knowledgeController = require('./knowledge.controller');

const router = Router();

// ── Reads ────────────────────────────────────────────────────────────────
router.get('/nodes/:nodeId/subtree', knowledgeController.getTaxonomySubtree);
router.get('/nodes/:nodeId', knowledgeController.getTaxonomyNode);
router.get('/search', knowledgeController.searchKnowledge);
router.get('/skill-clusters/:clusterId', knowledgeController.resolveSkillCluster);
router.get('/version', knowledgeController.getVersion);

// ── Admin-only cache invalidation ───────────────────────────────────────
router.post('/invalidate/:nodeId', requireAdmin, knowledgeController.invalidateNode);

module.exports = Object.freeze(router);
