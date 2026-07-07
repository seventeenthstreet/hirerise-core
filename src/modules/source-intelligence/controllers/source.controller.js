'use strict';

/**
 * src/modules/source-intelligence/controllers/source.controller.js
 *
 * Thin HTTP layer: parses request, calls the service, shapes the
 * response. No business logic here — matches the pattern used in
 * university.controller.js elsewhere in the codebase.
 */

const logger = require('../../../utils/logger');
const sourceService = require('../services/sourceRegistry.service');

function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}

function fail(res, err) {
  const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;

  if (statusCode >= 500) {
    logger.error('[SIM.controller] unhandled error', { error: err.message, stack: err.stack });
  }

  return res.status(statusCode).json({
    success: false,
    error: {
      code: err?.code || 'SIM_INTERNAL_ERROR',
      message: statusCode >= 500 ? 'Unexpected error in Source Intelligence Management.' : err.message,
      ...(err?.details ? { details: err.details } : {}),
    },
  });
}

function getActorId(req) {
  return req.user?.id || req.user?.uid || req.user?.user_id || req.auth?.userId || 'system';
}

// ─────────────────────────────────────────────────────────────
// Registry CRUD
// ─────────────────────────────────────────────────────────────

async function createSource(req, res) {
  try {
    const created = await sourceService.registerSource(req.body, { actorId: getActorId(req) });
    return ok(res, created, 201);
  } catch (err) {
    return fail(res, err);
  }
}

async function getSource(req, res) {
  try {
    const source = await sourceService.getSource(req.params.sourceId);
    return ok(res, source);
  } catch (err) {
    return fail(res, err);
  }
}

async function searchSources(req, res) {
  try {
    const result = await sourceService.searchSources(req.query);
    return ok(res, result);
  } catch (err) {
    return fail(res, err);
  }
}

async function updateSource(req, res) {
  try {
    const updated = await sourceService.updateMetadata(req.params.sourceId, req.body, {
      actorId: getActorId(req),
    });
    return ok(res, updated);
  } catch (err) {
    return fail(res, err);
  }
}

async function archiveSource(req, res) {
  try {
    const archived = await sourceService.archiveSource(req.params.sourceId, {
      actorId: getActorId(req),
      reason: req.body?.reason,
    });
    return ok(res, archived);
  } catch (err) {
    return fail(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
// Governance
// ─────────────────────────────────────────────────────────────

async function requestApproval(req, res) {
  try {
    const updated = await sourceService.requestApproval(req.params.sourceId, {
      actorId: getActorId(req),
      reason: req.body?.reason,
    });
    return ok(res, updated);
  } catch (err) {
    return fail(res, err);
  }
}

async function decideApproval(req, res) {
  try {
    const updated = await sourceService.decideApproval(req.params.sourceId, {
      approved: Boolean(req.body?.approved),
      actorId: getActorId(req),
      reason: req.body?.reason,
    });
    return ok(res, updated);
  } catch (err) {
    return fail(res, err);
  }
}

async function changeStatus(req, res) {
  try {
    const updated = await sourceService.transitionStatus(req.params.sourceId, req.body.status, {
      actorId: getActorId(req),
      reason: req.body?.reason,
    });
    return ok(res, updated);
  } catch (err) {
    return fail(res, err);
  }
}

async function getAuditTrail(req, res) {
  try {
    const trail = await sourceService.getAuditTrail(req.params.sourceId, {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    return ok(res, trail);
  } catch (err) {
    return fail(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────

async function recordHealth(req, res) {
  try {
    const result = await sourceService.recordHealthObservation(req.params.sourceId, req.body, {
      actorId: getActorId(req),
    });
    return ok(res, result, 201);
  } catch (err) {
    return fail(res, err);
  }
}

async function getHealthSummary(req, res) {
  try {
    const summary = await sourceService.getHealthSummary(req.params.sourceId);
    return ok(res, summary);
  } catch (err) {
    return fail(res, err);
  }
}

async function getHealthHistory(req, res) {
  try {
    const history = await sourceService.getHealthHistory(req.params.sourceId, {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    return ok(res, history);
  } catch (err) {
    return fail(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
// Enterprise Enhancement 8 — Source Relationship Model
// ─────────────────────────────────────────────────────────────

async function addRelationship(req, res) {
  try {
    const created = await sourceService.addRelationship(req.params.sourceId, req.body, {
      actorId: getActorId(req),
    });
    return ok(res, created, 201);
  } catch (err) {
    return fail(res, err);
  }
}

async function listRelationships(req, res) {
  try {
    const relationships = await sourceService.listRelationships(req.params.sourceId);
    return ok(res, relationships);
  } catch (err) {
    return fail(res, err);
  }
}

async function removeRelationship(req, res) {
  try {
    const removed = await sourceService.removeRelationship(
      req.params.sourceId,
      req.params.relationshipId,
      { actorId: getActorId(req) }
    );
    return ok(res, removed);
  } catch (err) {
    return fail(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
// COM integration read
// ─────────────────────────────────────────────────────────────

async function listEligibleSources(req, res) {
  try {
    const sources = await sourceService.listActiveEligibleSources();
    return ok(res, sources);
  } catch (err) {
    return fail(res, err);
  }
}

module.exports = {
  createSource,
  getSource,
  searchSources,
  updateSource,
  archiveSource,
  requestApproval,
  decideApproval,
  changeStatus,
  getAuditTrail,
  recordHealth,
  getHealthSummary,
  getHealthHistory,
  listEligibleSources,
  addRelationship,
  listRelationships,
  removeRelationship,
};
