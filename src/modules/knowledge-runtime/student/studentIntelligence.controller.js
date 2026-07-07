'use strict';

/**
 * modules/knowledge-runtime/student/studentIntelligence.controller.js
 *
 * HTTP controller for the student-context runtime endpoints. Same shape as
 * `knowledge.controller.js`: validate → delegate to service (via the
 * knowledge-runtime module singleton) → `{ success, data }` envelope →
 * `next(err)` on failure. No business logic, no direct DB access.
 *
 * AUTHORIZATION NOTE: `intelligence_entity_snapshots`' own RLS policy
 * restricts a student to `auth.uid() = entity_id` — but BaseRepository
 * (and therefore this whole module) uses the service-role Supabase client,
 * which bypasses RLS. That means this app layer, not the database, is the
 * only thing enforcing "a student can only read their own context" for
 * requests that go through this controller. The `/me/*` routes sidestep
 * the question entirely by always using `req.user.id` rather than trusting
 * a client-supplied id. The one route that accepts an arbitrary `:userId`
 * (`GET /api/v1/student-context/:userId`) is mounted behind `requireAdmin`
 * at the route layer (see `studentIntelligence.routes.js`) for exactly
 * this reason.
 */

const logger = require('../../../utils/logger');
const { getStudentService } = require('../knowledge-runtime.module');
const { validateUserId } = require('./studentIntelligence.validator');
// WP-XAI2-02 (Response Contract Governance): canonical shared envelope
// helper, replacing a locally duplicated `sendSuccess`. Additive only.
const { sendSuccess } = require('../../../shared/response');

// `sendNotFound` intentionally stays local — see the identical rationale in
// `knowledge.controller.js` (this module's twin): migrating to the shared
// `sendError` would change `error` from a string to a `{ code, message }`
// object, a real type change for existing consumers, not merely additive.
// Tracked as a known limitation, not fixed in this pass.
function sendNotFound(res, message) {
  return res.status(404).json({ success: false, error: message });
}

function _resolveSelfUserId(req) {
  return validateUserId(req.user?.id);
}

// WP-XAI2-03 (Enterprise Controller Security Audit): extends WP-SEC-01's
// review methodology to this controller. `StudentService`'s profile and
// every snapshot method (`getAcademicSnapshot`, `getCareerSnapshot`,
// `getSkillSnapshot`, `getFutureSnapshot`, `getReadinessSnapshot`) each
// independently include `userId` in their returned object — confirmed by
// direct read of `studentIntelligence.service.js`. For the `/me/*` routes
// the caller already knows their own id; for the one admin route
// (`getStudentContextByUserId`) the admin already supplied that exact id
// in the request path. Per WP-SEC-01 precedent this is still the same
// class of undisciplined response boundary and is closed the same way,
// at the controller — `StudentService` itself is unmodified.
function _toPublicStudentPayload(result) {
  if (result === null || typeof result !== 'object') return result;
  const { userId, ...publicResult } = result;
  return publicResult;
}

// ── /me/* — always the authenticated caller's own context ─────────────────

async function getMyContext(req, res, next) {
  try {
    const userId = _resolveSelfUserId(req);
    const service = getStudentService();
    const result = await service.getStudentIntelligenceProfile(userId);
    return sendSuccess(res, _toPublicStudentPayload(result));
  } catch (err) {
    logger.error('[StudentContextController.getMyContext]', { error: err.message });
    return next(err);
  }
}

async function getMyAcademicSnapshot(req, res, next) {
  try {
    const userId = _resolveSelfUserId(req);
    const result = await getStudentService().getAcademicSnapshot(userId);
    return sendSuccess(res, _toPublicStudentPayload(result));
  } catch (err) {
    logger.error('[StudentContextController.getMyAcademicSnapshot]', { error: err.message });
    return next(err);
  }
}

async function getMyCareerSnapshot(req, res, next) {
  try {
    const userId = _resolveSelfUserId(req);
    const result = await getStudentService().getCareerSnapshot(userId);
    return sendSuccess(res, _toPublicStudentPayload(result));
  } catch (err) {
    logger.error('[StudentContextController.getMyCareerSnapshot]', { error: err.message });
    return next(err);
  }
}

async function getMySkillSnapshot(req, res, next) {
  try {
    const userId = _resolveSelfUserId(req);
    const result = await getStudentService().getSkillSnapshot(userId);
    return sendSuccess(res, _toPublicStudentPayload(result));
  } catch (err) {
    logger.error('[StudentContextController.getMySkillSnapshot]', { error: err.message });
    return next(err);
  }
}

async function getMyFutureSnapshot(req, res, next) {
  try {
    const userId = _resolveSelfUserId(req);
    const result = await getStudentService().getFutureSnapshot(userId);
    return sendSuccess(res, _toPublicStudentPayload(result));
  } catch (err) {
    logger.error('[StudentContextController.getMyFutureSnapshot]', { error: err.message });
    return next(err);
  }
}

async function getMyReadinessSnapshot(req, res, next) {
  try {
    const userId = _resolveSelfUserId(req);
    const result = await getStudentService().getReadinessSnapshot(userId);
    return sendSuccess(res, _toPublicStudentPayload(result));
  } catch (err) {
    logger.error('[StudentContextController.getMyReadinessSnapshot]', { error: err.message });
    return next(err);
  }
}

async function refreshMyContext(req, res, next) {
  try {
    const userId = _resolveSelfUserId(req);
    const result = await getStudentService().refreshFromOnboarding(userId);
    return sendSuccess(res, _toPublicStudentPayload(result));
  } catch (err) {
    logger.error('[StudentContextController.refreshMyContext]', { error: err.message });
    return next(err);
  }
}

// ── Admin — arbitrary userId, mounted behind requireAdmin ─────────────────

async function getStudentContextByUserId(req, res, next) {
  try {
    const userId = validateUserId(req.params.userId);
    const service = getStudentService();
    const result = await service.getStudentIntelligenceProfile(userId);

    if (!result?.personal?.available && !result?.readiness?.available) {
      return sendNotFound(res, 'No student context found for this user');
    }

    return sendSuccess(res, _toPublicStudentPayload(result));
  } catch (err) {
    logger.error('[StudentContextController.getStudentContextByUserId]', { error: err.message });
    return next(err);
  }
}

module.exports = Object.freeze({
  getMyContext,
  getMyAcademicSnapshot,
  getMyCareerSnapshot,
  getMySkillSnapshot,
  getMyFutureSnapshot,
  getMyReadinessSnapshot,
  refreshMyContext,
  getStudentContextByUserId,
});
