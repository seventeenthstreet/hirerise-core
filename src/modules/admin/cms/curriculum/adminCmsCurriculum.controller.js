'use strict';

/**
 * @file src/modules/admin/cms/curriculum/adminCmsCurriculum.controller.js
 *
 * HireRise Curriculum Architecture — Phase 2 / P2.2
 * Admin Configuration Layer — HTTP handlers.
 *
 * Security contract (matches adminCmsSkills.controller.js):
 *   - adminId is ALWAYS req.user.id — never accepted from req.body.
 *   - authenticate + requireAdmin + requireElevatedSession are enforced
 *     at the mount point in server.js, not here — every route in this
 *     file assumes they already ran.
 *
 * Response envelope: this module's new endpoints use sendSuccess/sendError
 * (src/shared/response) per that module's "all new endpoints MUST use
 * sendSuccess/sendError" contract — not the older inline res.json() shape
 * some pre-existing Admin CMS modules (e.g. adminCmsCareerDomains.module.js)
 * still use.
 *
 * Error mapping: ./adminCmsCurriculum.service.js and
 * ./adminCmsCurriculum.repository.js throw the domain error classes from
 * ./adminCmsCurriculum.errors.js, which have no HTTP awareness by design.
 * mapCurriculumErrorToResponse() below is the single place that assigns
 * each of them an HTTP status.
 */

const { sendSuccess, sendError } = require('../../../../shared/response');
const service = require('./adminCmsCurriculum.service');
const {
  CurriculumAdminRepositoryError,
  CurriculumGovernanceViolationError,
  CurriculumNotFoundError,
  CurriculumNotEditableError,
  CurriculumAdminValidationError,
  CurriculumDraftInvalidError,
} = require('./adminCmsCurriculum.errors');

function mapCurriculumErrorToResponse(res, error) {
  if (error instanceof CurriculumNotFoundError) {
    return sendError(res, 404, error.message, error.code, { metadata: error.metadata });
  }
  if (error instanceof CurriculumAdminValidationError) {
    return sendError(res, 400, error.message, error.code, { metadata: error.metadata });
  }
  if (error instanceof CurriculumNotEditableError || error instanceof CurriculumGovernanceViolationError) {
    return sendError(res, 409, error.message, error.code, { metadata: error.metadata });
  }
  if (error instanceof CurriculumDraftInvalidError) {
    return sendError(res, 422, error.message, error.code, { errors: error.errors });
  }
  if (error instanceof CurriculumAdminRepositoryError) {
    return sendError(res, 500, 'Curriculum admin operation failed', error.code);
  }
  // Not one of our domain errors — rethrow so it hits the global handler
  // (and gets logged/alerted there) rather than silently 500ing here.
  throw error;
}

function withCurriculumErrorHandling(handler) {
  return async function wrapped(req, res, next) {
    try {
      await handler(req, res);
    } catch (error) {
      try {
        mapCurriculumErrorToResponse(res, error);
      } catch (rethrown) {
        next(rethrown);
      }
    }
  };
}

// ── GET /admin/cms/curriculum/versions ──────────────────────────────────────
const listVersions = withCurriculumErrorHandling(async (req, res) => {
  const { boardId, status, limit, offset } = req.query;
  const result = await service.listCurriculumVersions({
    boardId: boardId || undefined,
    status: status || undefined,
    limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
    offset: offset ? Math.max(parseInt(offset, 10), 0) : 0,
  });
  return sendSuccess(res, result);
});

// ── GET /admin/cms/curriculum/versions/:versionId ───────────────────────────
const getVersion = withCurriculumErrorHandling(async (req, res) => {
  const version = await service.getCurriculumVersion(req.params.versionId);
  return sendSuccess(res, version);
});

// ── POST /admin/cms/curriculum/versions ─────────────────────────────────────
const createVersion = withCurriculumErrorHandling(async (req, res) => {
  const adminId = req.user.id;
  const { boardId, regionId, versionLabel, effectiveFrom, effectiveTo, ncertRelationship, notes } = req.body;
  const created = await service.createDraftVersion(
    { boardId, regionId, versionLabel, effectiveFrom, effectiveTo, ncertRelationship, notes },
    adminId,
  );
  return sendSuccess(res, created, {}, {}, 201);
});

// ── PATCH /admin/cms/curriculum/versions/:versionId ─────────────────────────
const updateVersion = withCurriculumErrorHandling(async (req, res) => {
  const { regionId, versionLabel, effectiveFrom, effectiveTo, ncertRelationship, notes } = req.body;
  const updates = {};
  if (regionId !== undefined) updates.regionId = regionId;
  if (versionLabel !== undefined) updates.versionLabel = versionLabel;
  if (effectiveFrom !== undefined) updates.effectiveFrom = effectiveFrom;
  if (effectiveTo !== undefined) updates.effectiveTo = effectiveTo;
  if (ncertRelationship !== undefined) updates.ncertRelationship = ncertRelationship;
  if (notes !== undefined) updates.notes = notes;

  const updated = await service.updateDraftVersionMetadata(req.params.versionId, updates);
  return sendSuccess(res, updated);
});

// ── POST /admin/cms/curriculum/versions/:versionId/validate ─────────────────
const validateVersion = withCurriculumErrorHandling(async (req, res) => {
  const result = await service.validateDraftConfiguration(req.params.versionId);
  return sendSuccess(res, result);
});

// ── POST /admin/cms/curriculum/versions/:versionId/publish ──────────────────
const publishVersion = withCurriculumErrorHandling(async (req, res) => {
  const published = await service.publishVersion(req.params.versionId);
  return sendSuccess(res, published);
});

// ── POST /admin/cms/curriculum/versions/:versionId/archive ──────────────────
const archiveVersion = withCurriculumErrorHandling(async (req, res) => {
  const archived = await service.archiveVersion(req.params.versionId);
  return sendSuccess(res, archived);
});

// ── Streams ──────────────────────────────────────────────────────────────
const createStream = withCurriculumErrorHandling(async (req, res) => {
  const { streamCode, streamName, applicableFromClass, applicableToClass } = req.body;
  const created = await service.createDraftStream(req.params.versionId, { streamCode, streamName, applicableFromClass, applicableToClass });
  return sendSuccess(res, created, {}, {}, 201);
});

const updateStream = withCurriculumErrorHandling(async (req, res) => {
  const { streamName, applicableFromClass, applicableToClass, isActive } = req.body;
  const updated = await service.updateDraftStream(req.params.versionId, req.params.streamId, {
    streamName,
    applicableFromClass,
    applicableToClass,
    isActive,
  });
  return sendSuccess(res, updated);
});

// ── Pathways ─────────────────────────────────────────────────────────────
const createPathway = withCurriculumErrorHandling(async (req, res) => {
  const { streamId, pathwayCode, pathwayName, externalReference } = req.body;
  const created = await service.createDraftPathway(req.params.versionId, { streamId, pathwayCode, pathwayName, externalReference });
  return sendSuccess(res, created, {}, {}, 201);
});

const updatePathway = withCurriculumErrorHandling(async (req, res) => {
  const { pathwayName, externalReference, isActive } = req.body;
  const updated = await service.updateDraftPathway(req.params.versionId, req.params.pathwayId, { pathwayName, externalReference, isActive });
  return sendSuccess(res, updated);
});

// ── Subject mappings ─────────────────────────────────────────────────────
const createSubjectMapping = withCurriculumErrorHandling(async (req, res) => {
  const { subjectId, streamId, pathwayId, isMandatory } = req.body;
  const created = await service.createDraftSubjectMapping(req.params.versionId, { subjectId, streamId, pathwayId, isMandatory });
  return sendSuccess(res, created, {}, {}, 201);
});

const updateSubjectMapping = withCurriculumErrorHandling(async (req, res) => {
  const { isMandatory, isActive } = req.body;
  const updated = await service.updateDraftSubjectMapping(req.params.versionId, req.params.mappingId, { isMandatory, isActive });
  return sendSuccess(res, updated);
});

// ── Subject groups ───────────────────────────────────────────────────────
const createSubjectGroup = withCurriculumErrorHandling(async (req, res) => {
  const { streamId, pathwayId, groupCode, groupLabel, minSelect, maxSelect } = req.body;
  const created = await service.createDraftSubjectGroup(req.params.versionId, { streamId, pathwayId, groupCode, groupLabel, minSelect, maxSelect });
  return sendSuccess(res, created, {}, {}, 201);
});

const updateSubjectGroup = withCurriculumErrorHandling(async (req, res) => {
  const { groupLabel, minSelect, maxSelect, isActive } = req.body;
  const updated = await service.updateDraftSubjectGroup(req.params.versionId, req.params.groupId, { groupLabel, minSelect, maxSelect, isActive });
  return sendSuccess(res, updated);
});

const addGroupMember = withCurriculumErrorHandling(async (req, res) => {
  const { subjectId } = req.body;
  const created = await service.addDraftGroupMember(req.params.versionId, req.params.groupId, subjectId);
  return sendSuccess(res, created, {}, {}, 201);
});

const removeGroupMember = withCurriculumErrorHandling(async (req, res) => {
  await service.removeDraftGroupMember(req.params.versionId, req.params.groupId, req.params.subjectId);
  return sendSuccess(res, null);
});

module.exports = {
  listVersions,
  getVersion,
  createVersion,
  updateVersion,
  validateVersion,
  publishVersion,
  archiveVersion,
  createStream,
  updateStream,
  createPathway,
  updatePathway,
  createSubjectMapping,
  updateSubjectMapping,
  createSubjectGroup,
  updateSubjectGroup,
  addGroupMember,
  removeGroupMember,
  // exported for tests
  mapCurriculumErrorToResponse,
};
