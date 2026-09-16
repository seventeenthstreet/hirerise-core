'use strict';

/**
 * @file src/modules/admin/cms/curriculum/adminCmsCurriculum.service.js
 *
 * HireRise Curriculum Architecture — Phase 2 / P2.2
 * Admin Configuration Layer — business rules.
 *
 * Owns every rule the DB schema/triggers do NOT already enforce:
 *   - "only draft rows/children are Admin-editable" (rule 6) — the guard
 *     trigger only protects curriculum_versions itself; academic_streams,
 *     curriculum_pathways, subject_stream_map, and subject_group_map have
 *     no such trigger, so this service checks the parent version's status
 *     before allowing any write to them.
 *   - pre-publish validation (requirement H).
 *   - board/region existence + board_region_map compatibility, since
 *     that's application-level validation the DB only partially expresses
 *     (curriculum_versions.region_id has no FK-level tie to board_id —
 *     board_region_map is the existing taxonomy's own mechanism for that
 *     relationship, per its table comment, and is reused here rather than
 *     inventing a new one).
 *
 * Does NOT re-implement:
 *   - the lifecycle state machine itself (draft->published->archived) —
 *     that's trg_curriculum_versions_lifecycle_guard, always.
 *   - audit writing — that's trg_curriculum_version_audit_writer, always.
 *   - the group-size-exceeds-members check or XOR/composite-FK
 *     constraints already enforced at the DB level — this service
 *     re-validates the SAME rules pre-publish (so Admin gets a clean
 *     multi-error report instead of the first DB constraint violation),
 *     but the DB constraints remain the actual source of truth; this is
 *     belt-and-braces for UX, not a second authority.
 */

const repo = require('./adminCmsCurriculum.repository');
const {
  CurriculumNotFoundError,
  CurriculumNotEditableError,
  CurriculumAdminValidationError,
  CurriculumDraftInvalidError,
  CurriculumGovernanceViolationError,
} = require('./adminCmsCurriculum.errors');

// Locked vocabulary from 20260913030000_p1_correction_ncert_vocab_and_draft_rls.sql
// (chk_curriculum_versions_ncert_relationship). Single source of truth
// duplicated here only as a JS-side pre-check so Admin gets a clean 400
// instead of a raw Postgres CHECK-constraint error; the DB constraint is
// still what's actually authoritative.
const NCERT_RELATIONSHIP_VALUES = Object.freeze([
  'prescribed', 'adopted', 'adapted', 'aligned',
  'referenced', 'independent', 'mixed', 'unknown',
]);

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CurriculumAdminValidationError(`${field} must be a non-empty string`, { field, received: value });
  }
}

function assertValidDate(value, field) {
  if (Number.isNaN(new Date(value).getTime())) {
    throw new CurriculumAdminValidationError(`${field} must be a valid date`, { field, received: value });
  }
}

async function requireCurriculumVersion(id) {
  const version = await repo.getCurriculumVersionById(id);
  if (!version) {
    throw new CurriculumNotFoundError(`curriculum_versions row ${id} not found`, { id });
  }
  return version;
}

async function requireDraftCurriculumVersion(id) {
  const version = await requireCurriculumVersion(id);
  if (version.status !== 'draft') {
    throw new CurriculumNotEditableError(
      `curriculum_versions row ${id} is ${version.status}, not draft — Admin CRUD cannot edit it`,
      { id, status: version.status },
    );
  }
  return version;
}

// ─────────────────────────────────────────────────────────────────────────
// A. List / read
// ─────────────────────────────────────────────────────────────────────────

async function listCurriculumVersions(query) {
  return repo.listCurriculumVersions(query);
}

async function getCurriculumVersion(id) {
  const version = await requireCurriculumVersion(id);
  const [streams, pathways, subjectMappings, subjectGroups] = await Promise.all([
    repo.listStreamsForVersion(id),
    repo.listPathwaysForVersion(id),
    repo.listSubjectMappingsForVersion(id),
    repo.listSubjectGroupsForVersion(id),
  ]);
  return { ...version, streams, pathways, subjectMappings, subjectGroups };
}

// ─────────────────────────────────────────────────────────────────────────
// B. Create draft version
// ─────────────────────────────────────────────────────────────────────────

async function createDraftVersion(input, adminId) {
  const { boardId, regionId = null, versionLabel, effectiveFrom, effectiveTo = null, ncertRelationship = null, notes = null } = input;

  assertNonEmptyString(boardId, 'boardId');
  assertNonEmptyString(versionLabel, 'versionLabel');
  assertValidDate(effectiveFrom, 'effectiveFrom');
  if (effectiveTo !== null) assertValidDate(effectiveTo, 'effectiveTo');
  if (ncertRelationship !== null && !NCERT_RELATIONSHIP_VALUES.includes(ncertRelationship)) {
    throw new CurriculumAdminValidationError(
      `ncertRelationship must be one of: ${NCERT_RELATIONSHIP_VALUES.join(', ')}`,
      { received: ncertRelationship },
    );
  }

  const board = await repo.getBoardById(boardId);
  if (!board || !board.is_active) {
    throw new CurriculumAdminValidationError(`boardId ${boardId} does not reference an active academic_boards row`, { boardId });
  }

  if (regionId !== null) {
    assertNonEmptyString(regionId, 'regionId');
    const mapped = await repo.hasActiveBoardRegionMapping(boardId, regionId);
    if (!mapped) {
      throw new CurriculumAdminValidationError(
        `regionId ${regionId} has no active board_region_map row for board ${boardId}`,
        { boardId, regionId },
      );
    }
  }

  // status is never accepted from input — createDraftCurriculumVersion()
  // never writes one, and the DB guard forces 'draft' on every INSERT
  // regardless (see repository file header).
  return repo.createDraftCurriculumVersion({
    boardId,
    regionId,
    versionLabel,
    effectiveFrom,
    effectiveTo,
    ncertRelationship,
    notes,
    createdBy: adminId ?? null,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// C. Edit draft version metadata
// ─────────────────────────────────────────────────────────────────────────

async function updateDraftVersionMetadata(id, updates) {
  await requireDraftCurriculumVersion(id);

  if (updates.versionLabel !== undefined) assertNonEmptyString(updates.versionLabel, 'versionLabel');
  if (updates.effectiveFrom !== undefined) assertValidDate(updates.effectiveFrom, 'effectiveFrom');
  if (updates.effectiveTo !== undefined && updates.effectiveTo !== null) assertValidDate(updates.effectiveTo, 'effectiveTo');
  if (updates.ncertRelationship !== undefined && updates.ncertRelationship !== null && !NCERT_RELATIONSHIP_VALUES.includes(updates.ncertRelationship)) {
    throw new CurriculumAdminValidationError(
      `ncertRelationship must be one of: ${NCERT_RELATIONSHIP_VALUES.join(', ')}`,
      { received: updates.ncertRelationship },
    );
  }

  return repo.updateCurriculumVersionMetadata(id, updates);
}

// ─────────────────────────────────────────────────────────────────────────
// D. Streams (version-scoped, draft-only)
// ─────────────────────────────────────────────────────────────────────────

async function createDraftStream(curriculumVersionId, input) {
  const version = await requireDraftCurriculumVersion(curriculumVersionId);
  assertNonEmptyString(input.streamCode, 'streamCode');
  assertNonEmptyString(input.streamName, 'streamName');
  return repo.createStream({
    boardId: version.board_id,
    curriculumVersionId,
    streamCode: input.streamCode,
    streamName: input.streamName,
    applicableFromClass: input.applicableFromClass ?? null,
    applicableToClass: input.applicableToClass ?? null,
  });
}

async function updateDraftStream(curriculumVersionId, streamId, updates) {
  await requireDraftCurriculumVersion(curriculumVersionId);
  const stream = await repo.getStreamById(streamId);
  if (!stream || stream.curriculum_version_id !== curriculumVersionId) {
    throw new CurriculumNotFoundError(`stream ${streamId} does not belong to curriculum version ${curriculumVersionId}`, {
      streamId,
      curriculumVersionId,
    });
  }
  return repo.updateStream(streamId, updates);
}

// ─────────────────────────────────────────────────────────────────────────
// E. Pathways (draft-only; stream must belong to the same version)
// ─────────────────────────────────────────────────────────────────────────

async function createDraftPathway(curriculumVersionId, input) {
  await requireDraftCurriculumVersion(curriculumVersionId);
  assertNonEmptyString(input.streamId, 'streamId');
  assertNonEmptyString(input.pathwayCode, 'pathwayCode');
  assertNonEmptyString(input.pathwayName, 'pathwayName');

  const stream = await repo.getStreamById(input.streamId);
  if (!stream || stream.curriculum_version_id !== curriculumVersionId) {
    throw new CurriculumAdminValidationError(
      `streamId ${input.streamId} does not belong to curriculum version ${curriculumVersionId}`,
      { streamId: input.streamId, curriculumVersionId },
    );
  }

  return repo.createPathway({
    streamId: input.streamId,
    curriculumVersionId,
    pathwayCode: input.pathwayCode,
    pathwayName: input.pathwayName,
    externalReference: input.externalReference ?? null,
  });
}

async function updateDraftPathway(curriculumVersionId, pathwayId, updates) {
  await requireDraftCurriculumVersion(curriculumVersionId);
  const pathway = await repo.getPathwayById(pathwayId);
  if (!pathway || pathway.curriculum_version_id !== curriculumVersionId) {
    throw new CurriculumNotFoundError(`pathway ${pathwayId} does not belong to curriculum version ${curriculumVersionId}`, {
      pathwayId,
      curriculumVersionId,
    });
  }
  return repo.updatePathway(pathwayId, updates);
}

// ─────────────────────────────────────────────────────────────────────────
// F. Subject mappings — respects the stream_id/pathway_id XOR
// ─────────────────────────────────────────────────────────────────────────

function assertStreamPathwayXor(streamId, pathwayId) {
  const hasStream = streamId !== undefined && streamId !== null;
  const hasPathway = pathwayId !== undefined && pathwayId !== null;
  if (hasStream === hasPathway) {
    throw new CurriculumAdminValidationError(
      'exactly one of streamId / pathwayId must be provided (never both, never neither)',
      { streamId, pathwayId },
    );
  }
  return hasStream ? 'stream' : 'pathway';
}

async function createDraftSubjectMapping(curriculumVersionId, input) {
  await requireDraftCurriculumVersion(curriculumVersionId);
  assertNonEmptyString(input.subjectId, 'subjectId');
  const scope = assertStreamPathwayXor(input.streamId, input.pathwayId);

  if (scope === 'stream') {
    const stream = await repo.getStreamById(input.streamId);
    if (!stream || stream.curriculum_version_id !== curriculumVersionId) {
      throw new CurriculumAdminValidationError(`streamId ${input.streamId} does not belong to curriculum version ${curriculumVersionId}`, {
        streamId: input.streamId,
        curriculumVersionId,
      });
    }
  } else {
    const pathway = await repo.getPathwayById(input.pathwayId);
    if (!pathway || pathway.curriculum_version_id !== curriculumVersionId) {
      throw new CurriculumAdminValidationError(`pathwayId ${input.pathwayId} does not belong to curriculum version ${curriculumVersionId}`, {
        pathwayId: input.pathwayId,
        curriculumVersionId,
      });
    }
  }

  const [subject] = await repo.listAcademicSubjectsByIds([input.subjectId]);
  if (!subject || !subject.is_active) {
    throw new CurriculumAdminValidationError(`subjectId ${input.subjectId} does not reference an active academic_subjects row`, {
      subjectId: input.subjectId,
    });
  }

  return repo.createSubjectMapping({
    subjectId: input.subjectId,
    streamId: input.streamId ?? null,
    pathwayId: input.pathwayId ?? null,
    curriculumVersionId,
    isMandatory: Boolean(input.isMandatory),
  });
}

async function updateDraftSubjectMapping(curriculumVersionId, mappingId, updates) {
  await requireDraftCurriculumVersion(curriculumVersionId);
  return repo.updateSubjectMapping(mappingId, updates);
}

// ─────────────────────────────────────────────────────────────────────────
// G. Subject groups + membership
// ─────────────────────────────────────────────────────────────────────────

function assertValidMinMax(minSelect, maxSelect) {
  if (!Number.isInteger(minSelect) || minSelect < 0) {
    throw new CurriculumAdminValidationError('minSelect must be a non-negative integer', { minSelect });
  }
  if (!Number.isInteger(maxSelect) || maxSelect < minSelect) {
    throw new CurriculumAdminValidationError('maxSelect must be an integer >= minSelect', { minSelect, maxSelect });
  }
}

async function createDraftSubjectGroup(curriculumVersionId, input) {
  await requireDraftCurriculumVersion(curriculumVersionId);
  assertNonEmptyString(input.groupCode, 'groupCode');
  assertNonEmptyString(input.groupLabel, 'groupLabel');
  assertValidMinMax(input.minSelect, input.maxSelect);
  const scope = assertStreamPathwayXor(input.streamId, input.pathwayId);

  if (scope === 'stream') {
    const stream = await repo.getStreamById(input.streamId);
    if (!stream || stream.curriculum_version_id !== curriculumVersionId) {
      throw new CurriculumAdminValidationError(`streamId ${input.streamId} does not belong to curriculum version ${curriculumVersionId}`, {
        streamId: input.streamId,
        curriculumVersionId,
      });
    }
  } else {
    const pathway = await repo.getPathwayById(input.pathwayId);
    if (!pathway || pathway.curriculum_version_id !== curriculumVersionId) {
      throw new CurriculumAdminValidationError(`pathwayId ${input.pathwayId} does not belong to curriculum version ${curriculumVersionId}`, {
        pathwayId: input.pathwayId,
        curriculumVersionId,
      });
    }
  }

  return repo.createSubjectGroup({
    curriculumVersionId,
    streamId: input.streamId ?? null,
    pathwayId: input.pathwayId ?? null,
    groupCode: input.groupCode,
    groupLabel: input.groupLabel,
    minSelect: input.minSelect,
    maxSelect: input.maxSelect,
  });
}

async function updateDraftSubjectGroup(curriculumVersionId, groupId, updates) {
  await requireDraftCurriculumVersion(curriculumVersionId);
  const group = await repo.getSubjectGroupById(groupId);
  if (!group || group.curriculum_version_id !== curriculumVersionId) {
    throw new CurriculumNotFoundError(`subject group ${groupId} does not belong to curriculum version ${curriculumVersionId}`, {
      groupId,
      curriculumVersionId,
    });
  }
  if (updates.minSelect !== undefined || updates.maxSelect !== undefined) {
    assertValidMinMax(
      updates.minSelect !== undefined ? updates.minSelect : group.min_select,
      updates.maxSelect !== undefined ? updates.maxSelect : group.max_select,
    );
  }
  return repo.updateSubjectGroup(groupId, updates);
}

async function addDraftGroupMember(curriculumVersionId, groupId, subjectId) {
  await requireDraftCurriculumVersion(curriculumVersionId);
  const group = await repo.getSubjectGroupById(groupId);
  if (!group || group.curriculum_version_id !== curriculumVersionId) {
    throw new CurriculumNotFoundError(`subject group ${groupId} does not belong to curriculum version ${curriculumVersionId}`, {
      groupId,
      curriculumVersionId,
    });
  }
  const [subject] = await repo.listAcademicSubjectsByIds([subjectId]);
  if (!subject || !subject.is_active) {
    throw new CurriculumAdminValidationError(`subjectId ${subjectId} does not reference an active academic_subjects row`, { subjectId });
  }
  return repo.addGroupMember(groupId, subjectId);
}

async function removeDraftGroupMember(curriculumVersionId, groupId, subjectId) {
  await requireDraftCurriculumVersion(curriculumVersionId);
  const group = await repo.getSubjectGroupById(groupId);
  if (!group || group.curriculum_version_id !== curriculumVersionId) {
    throw new CurriculumNotFoundError(`subject group ${groupId} does not belong to curriculum version ${curriculumVersionId}`, {
      groupId,
      curriculumVersionId,
    });
  }
  return repo.removeGroupMember(groupId, subjectId);
}

// ─────────────────────────────────────────────────────────────────────────
// H. Pre-publish validation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Validates a draft's full configuration. Returns { valid, errors }
 * rather than throwing, so callers (e.g. a "validate draft" endpoint
 * distinct from "publish") can surface the full error list without
 * triggering an actual publish attempt.
 */
async function validateDraftConfiguration(curriculumVersionId) {
  const errors = [];
  const version = await requireCurriculumVersion(curriculumVersionId);

  if (!version.version_label) errors.push({ code: 'MISSING_VERSION_LABEL', message: 'version_label is required' });
  if (!version.effective_from) errors.push({ code: 'MISSING_EFFECTIVE_FROM', message: 'effective_from is required' });
  if (version.ncert_relationship !== null && !NCERT_RELATIONSHIP_VALUES.includes(version.ncert_relationship)) {
    errors.push({ code: 'INVALID_NCERT_RELATIONSHIP', message: `ncert_relationship "${version.ncert_relationship}" is not in the locked vocabulary` });
  }

  if (version.region_id) {
    const mapped = await repo.hasActiveBoardRegionMapping(version.board_id, version.region_id);
    if (!mapped) {
      errors.push({
        code: 'INVALID_BOARD_REGION_RELATIONSHIP',
        message: `no active board_region_map row for board ${version.board_id} / region ${version.region_id}`,
      });
    }
  }

  const [streams, pathways, subjectMappings, subjectGroups] = await Promise.all([
    repo.listStreamsForVersion(curriculumVersionId),
    repo.listPathwaysForVersion(curriculumVersionId),
    repo.listSubjectMappingsForVersion(curriculumVersionId),
    repo.listSubjectGroupsForVersion(curriculumVersionId),
  ]);

  const streamIds = new Set(streams.map((s) => s.id));
  const pathwayIds = new Set(pathways.map((p) => p.id));

  for (const pathway of pathways) {
    if (!streamIds.has(pathway.stream_id)) {
      errors.push({ code: 'INVALID_PATHWAY_STREAM', message: `pathway ${pathway.id} references a stream not in this version`, pathwayId: pathway.id });
    }
  }

  for (const mapping of subjectMappings) {
    const hasStream = mapping.stream_id !== null;
    const hasPathway = mapping.pathway_id !== null;
    if (hasStream === hasPathway) {
      errors.push({ code: 'INVALID_SUBJECT_MAPPING_SCOPE', message: `subject_stream_map row ${mapping.id} must set exactly one of stream_id/pathway_id`, mappingId: mapping.id });
    } else if (hasStream && !streamIds.has(mapping.stream_id)) {
      errors.push({ code: 'INVALID_SUBJECT_MAPPING_STREAM', message: `subject_stream_map row ${mapping.id} references a stream not in this version`, mappingId: mapping.id });
    } else if (hasPathway && !pathwayIds.has(mapping.pathway_id)) {
      errors.push({ code: 'INVALID_SUBJECT_MAPPING_PATHWAY', message: `subject_stream_map row ${mapping.id} references a pathway not in this version`, mappingId: mapping.id });
    }
  }

  for (const group of subjectGroups) {
    const hasStream = group.stream_id !== null;
    const hasPathway = group.pathway_id !== null;
    if (hasStream === hasPathway) {
      errors.push({ code: 'INVALID_SUBJECT_GROUP_SCOPE', message: `subject_group_map row ${group.id} must set exactly one of stream_id/pathway_id`, groupId: group.id });
    } else if (hasStream && !streamIds.has(group.stream_id)) {
      errors.push({ code: 'INVALID_SUBJECT_GROUP_STREAM', message: `subject_group_map row ${group.id} references a stream not in this version`, groupId: group.id });
    } else if (hasPathway && !pathwayIds.has(group.pathway_id)) {
      errors.push({ code: 'INVALID_SUBJECT_GROUP_PATHWAY', message: `subject_group_map row ${group.id} references a pathway not in this version`, groupId: group.id });
    }

    if (group.min_select > group.max_select) {
      errors.push({ code: 'INVALID_GROUP_MIN_MAX', message: `subject_group_map row ${group.id} has min_select > max_select`, groupId: group.id });
    }

    // eslint-disable-next-line no-await-in-loop
    const members = await repo.listGroupMembers(group.id);
    if (group.max_select > members.length) {
      errors.push({
        code: 'GROUP_MAX_SELECT_EXCEEDS_MEMBERS',
        message: `subject_group_map row ${group.id} has max_select (${group.max_select}) greater than its member count (${members.length})`,
        groupId: group.id,
      });
    }
    if (members.length === 0) {
      errors.push({ code: 'GROUP_HAS_NO_MEMBERS', message: `subject_group_map row ${group.id} has no subject_group_members`, groupId: group.id });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────────────────
// I. Publish
// ─────────────────────────────────────────────────────────────────────────

async function publishVersion(id) {
  const version = await requireCurriculumVersion(id);
  if (version.status !== 'draft') {
    throw new CurriculumNotEditableError(`curriculum_versions row ${id} is ${version.status} — only draft may be published`, {
      id,
      status: version.status,
    });
  }

  const { valid, errors } = await validateDraftConfiguration(id);
  if (!valid) {
    throw new CurriculumDraftInvalidError(`curriculum_versions row ${id} failed pre-publish validation`, errors, { id });
  }

  // The actual draft -> published transition, structural-immutability
  // lock, published_at stamping, and audit row are all owned by
  // trg_curriculum_versions_lifecycle_guard + trg_curriculum_version_audit_writer.
  // This call does nothing more than attempt the UPDATE.
  const updated = await repo.transitionCurriculumVersionStatus(id, 'draft', 'published');
  if (!updated) {
    // Someone else changed its status between our read and this UPDATE.
    const current = await requireCurriculumVersion(id);
    throw new CurriculumNotEditableError(`curriculum_versions row ${id} is no longer draft (now ${current.status}) — publish aborted`, {
      id,
      status: current.status,
    });
  }
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────
// J. Archive
// ─────────────────────────────────────────────────────────────────────────

async function archiveVersion(id) {
  const version = await requireCurriculumVersion(id);
  if (version.status !== 'published') {
    throw new CurriculumNotEditableError(`curriculum_versions row ${id} is ${version.status} — only published may be archived`, {
      id,
      status: version.status,
    });
  }

  const updated = await repo.transitionCurriculumVersionStatus(id, 'published', 'archived');
  if (!updated) {
    const current = await requireCurriculumVersion(id);
    throw new CurriculumNotEditableError(`curriculum_versions row ${id} is no longer published (now ${current.status}) — archive aborted`, {
      id,
      status: current.status,
    });
  }
  return updated;
}

module.exports = {
  NCERT_RELATIONSHIP_VALUES,
  listCurriculumVersions,
  getCurriculumVersion,
  createDraftVersion,
  updateDraftVersionMetadata,
  createDraftStream,
  updateDraftStream,
  createDraftPathway,
  updateDraftPathway,
  createDraftSubjectMapping,
  updateDraftSubjectMapping,
  createDraftSubjectGroup,
  updateDraftSubjectGroup,
  addDraftGroupMember,
  removeDraftGroupMember,
  validateDraftConfiguration,
  publishVersion,
  archiveVersion,
  // exported for tests / controller error-mapping convenience
  CurriculumGovernanceViolationError,
};
