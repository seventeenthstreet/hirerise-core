'use strict';

/**
 * @file src/modules/admin/cms/curriculum/adminCmsCurriculum.repository.js
 *
 * HireRise Curriculum Architecture — Phase 2 / P2.2
 * Admin Configuration Layer — persistence.
 *
 * Follows the established "manual Supabase query" Admin CMS repository
 * convention (src/modules/admin/cms/skills/adminCmsSkills.repository.js,
 * src/modules/admin/cms/career-domains/adminCmsCareerDomains.module.js),
 * NOT src/modules/admin/cms/adminCmsGeneric.factory.js. The generic
 * factory's TABLE_MAP is a fixed list of five flat single-entity CMS
 * datasets (name/normalized_name/soft_deleted/status='active' shape) with
 * no notion of version-scoping, composite-FK relational integrity, or a
 * governed lifecycle — none of which curriculum_versions and its child
 * tables can be safely expressed as. Extending TABLE_MAP or its
 * allowedFields plumbing to cover this would either silently drop the
 * relational/lifecycle guarantees Phase 1 built at the DB layer, or turn
 * the factory into something it isn't. Per P2.2 instructions, this is
 * exactly the "genuinely required, narrowly scoped" exception — the
 * factory is left untouched.
 *
 * PERSISTENCE ONLY. No lifecycle decisions, no XOR/min-max/publish
 * validation here — that is ./adminCmsCurriculum.service.js's job. This
 * file only talks to Postgres, using the shared service-role client
 * (src/config/supabase.js), same as every other Admin CMS repository.
 *
 * LIFECYCLE WRITES ARE INTENTIONALLY THIN:
 * publishCurriculumVersion / archiveCurriculumVersion below do nothing
 * but a plain, optimistic `UPDATE ... SET status = ? WHERE id = ? AND
 * status = <expected-from-status>`. They do not re-implement any part of
 * the transition rules, structural-immutability checks, or audit writing
 * — trg_curriculum_versions_lifecycle_guard (BEFORE) and
 * trg_curriculum_version_audit_writer (AFTER), both already deployed in
 * 20260913020000/20260913040000, are the sole authority for all of that,
 * per P2.2 rules 7–9. The `AND status = <expected>` clause is an
 * optimistic-concurrency guard at this layer (so two concurrent publish
 * calls can't both believe they succeeded), not a duplicate of the
 * trigger's own transition validation — the trigger still runs and still
 * would reject an illegal transition even if this clause were removed.
 *
 * GOVERNANCE_VIOLATION ERRORS ARE NOT SWALLOWED:
 * Any Postgres error raised by the lifecycle guard (message prefixed
 * "GOVERNANCE_VIOLATION:", per fn_curriculum_version_lifecycle_guard) is
 * surfaced to the service layer as CurriculumGovernanceViolationError
 * (see ./adminCmsCurriculum.errors.js) rather than a generic repository
 * error, so the service/controller can map it to a meaningful HTTP
 * status without string-matching Postgres messages themselves.
 */

const logger = require('../../../../utils/logger');
const {
  CurriculumAdminRepositoryError,
  CurriculumGovernanceViolationError,
} = require('./adminCmsCurriculum.errors');

function getSupabase() {
  return require('../../../../config/supabase').supabase;
}

const GOVERNANCE_VIOLATION_PREFIX = 'GOVERNANCE_VIOLATION';

function isGovernanceViolation(error) {
  return typeof error?.message === 'string' && error.message.includes(GOVERNANCE_VIOLATION_PREFIX);
}

function throwFromSupabaseError(error, { op, table, metadata = {} }) {
  if (isGovernanceViolation(error)) {
    throw new CurriculumGovernanceViolationError(error.message, { op, table, ...metadata });
  }
  logger.error(`[AdminCmsCurriculum.repository] ${op} error [${table}]`, {
    error: error.message,
    ...metadata,
  });
  throw new CurriculumAdminRepositoryError(`${op} failed on ${table}: ${error.message}`, {
    op,
    table,
    ...metadata,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// academic_boards / board_region_map (read-only lookups used for validation)
// ─────────────────────────────────────────────────────────────────────────

async function getBoardById(boardId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('academic_boards')
    .select('id, board_code, board_name, board_type, is_active')
    .eq('id', boardId)
    .maybeSingle();
  if (error) throwFromSupabaseError(error, { op: 'getBoardById', table: 'academic_boards', metadata: { boardId } });
  return data;
}

/**
 * Whether an active board_region_map row exists for (boardId, regionId).
 * board_region_map is the existing taxonomy's own answer to "is this
 * region valid for this board" (its table comment: "Explicit region-aware
 * board compatibility mapping"), reused here rather than any new rule.
 */
async function hasActiveBoardRegionMapping(boardId, regionId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('board_region_map')
    .select('id')
    .eq('board_id', boardId)
    .eq('region_id', regionId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) {
    throwFromSupabaseError(error, {
      op: 'hasActiveBoardRegionMapping',
      table: 'board_region_map',
      metadata: { boardId, regionId },
    });
  }
  return Boolean(data);
}

// ─────────────────────────────────────────────────────────────────────────
// curriculum_versions
// ─────────────────────────────────────────────────────────────────────────

const CURRICULUM_VERSION_COLUMNS =
  'id, board_id, region_id, version_label, status, effective_from, effective_to, ' +
  'ncert_relationship, published_at, archived_at, created_by, notes, created_at, updated_at';

async function listCurriculumVersions({ boardId, status, limit = 50, offset = 0 } = {}) {
  const supabase = getSupabase();
  let query = supabase
    .from('curriculum_versions')
    .select(CURRICULUM_VERSION_COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (boardId) query = query.eq('board_id', boardId);
  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) throwFromSupabaseError(error, { op: 'listCurriculumVersions', table: 'curriculum_versions' });
  return { items: data ?? [], total: count ?? 0 };
}

async function getCurriculumVersionById(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('curriculum_versions')
    .select(CURRICULUM_VERSION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throwFromSupabaseError(error, { op: 'getCurriculumVersionById', table: 'curriculum_versions', metadata: { id } });
  }
  return data;
}

/**
 * Inserts a new curriculum_versions row. Deliberately never sets `status`
 * — the guard forces every INSERT to `status = 'draft'` regardless, and
 * omitting it here means this function cannot even attempt to bypass that
 * (there is no code path in this repository that would let a caller pass
 * a non-draft status through to INSERT).
 */
async function createDraftCurriculumVersion({ boardId, regionId, versionLabel, effectiveFrom, effectiveTo, ncertRelationship, notes, createdBy }) {
  const supabase = getSupabase();
  const payload = {
    board_id: boardId,
    region_id: regionId ?? null,
    version_label: versionLabel,
    effective_from: effectiveFrom,
    effective_to: effectiveTo ?? null,
    ncert_relationship: ncertRelationship ?? null,
    notes: notes ?? null,
    created_by: createdBy ?? null,
  };
  const { data, error } = await supabase
    .from('curriculum_versions')
    .insert(payload)
    .select(CURRICULUM_VERSION_COLUMNS)
    .single();
  if (error) throwFromSupabaseError(error, { op: 'createDraftCurriculumVersion', table: 'curriculum_versions' });
  return data;
}

const EDITABLE_DRAFT_METADATA_FIELDS = Object.freeze({
  regionId: 'region_id',
  versionLabel: 'version_label',
  effectiveFrom: 'effective_from',
  effectiveTo: 'effective_to',
  ncertRelationship: 'ncert_relationship',
  notes: 'notes',
});

/**
 * Updates draft metadata. Callers (service layer) are responsible for
 * confirming the row is actually still `draft` before calling this — the
 * guard trigger enforces immutability for locked rows regardless, but
 * that produces a 500-shaped Postgres error rather than a clean 409, so
 * the service checks status first to give a better error.
 */
async function updateCurriculumVersionMetadata(id, updates) {
  const supabase = getSupabase();
  const payload = {};
  for (const [key, column] of Object.entries(EDITABLE_DRAFT_METADATA_FIELDS)) {
    if (updates[key] !== undefined) payload[column] = updates[key];
  }
  if (Object.keys(payload).length === 0) {
    return getCurriculumVersionById(id);
  }
  const { data, error } = await supabase
    .from('curriculum_versions')
    .update(payload)
    .eq('id', id)
    .select(CURRICULUM_VERSION_COLUMNS)
    .single();
  if (error) {
    throwFromSupabaseError(error, {
      op: 'updateCurriculumVersionMetadata',
      table: 'curriculum_versions',
      metadata: { id },
    });
  }
  return data;
}

/**
 * Optimistic status transition: only succeeds if the row's current status
 * is still `fromStatus` at the moment of the UPDATE. Returns the updated
 * row, or null if no row matched (either the id doesn't exist, or the
 * status had already moved on — the service layer distinguishes those by
 * re-fetching).
 */
async function transitionCurriculumVersionStatus(id, fromStatus, toStatus) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('curriculum_versions')
    .update({ status: toStatus })
    .eq('id', id)
    .eq('status', fromStatus)
    .select(CURRICULUM_VERSION_COLUMNS)
    .maybeSingle();
  if (error) {
    throwFromSupabaseError(error, {
      op: 'transitionCurriculumVersionStatus',
      table: 'curriculum_versions',
      metadata: { id, fromStatus, toStatus },
    });
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────────────
// academic_streams (version-scoped rows only — curriculum_version_id NOT NULL)
// ─────────────────────────────────────────────────────────────────────────

const STREAM_COLUMNS =
  'id, board_id, curriculum_version_id, stream_code, stream_name, applicable_from_class, applicable_to_class, is_active, deprecated_at, created_at, updated_at';

async function listStreamsForVersion(curriculumVersionId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('academic_streams')
    .select(STREAM_COLUMNS)
    .eq('curriculum_version_id', curriculumVersionId)
    .order('stream_code', { ascending: true });
  if (error) throwFromSupabaseError(error, { op: 'listStreamsForVersion', table: 'academic_streams', metadata: { curriculumVersionId } });
  return data ?? [];
}

async function getStreamById(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('academic_streams').select(STREAM_COLUMNS).eq('id', id).maybeSingle();
  if (error) throwFromSupabaseError(error, { op: 'getStreamById', table: 'academic_streams', metadata: { id } });
  return data;
}

async function createStream({ boardId, curriculumVersionId, streamCode, streamName, applicableFromClass, applicableToClass }) {
  const supabase = getSupabase();
  const payload = {
    board_id: boardId,
    curriculum_version_id: curriculumVersionId,
    stream_code: streamCode,
    stream_name: streamName,
    applicable_from_class: applicableFromClass ?? null,
    applicable_to_class: applicableToClass ?? null,
  };
  const { data, error } = await supabase.from('academic_streams').insert(payload).select(STREAM_COLUMNS).single();
  if (error) throwFromSupabaseError(error, { op: 'createStream', table: 'academic_streams' });
  return data;
}

async function updateStream(id, updates) {
  const supabase = getSupabase();
  const payload = {};
  if (updates.streamName !== undefined) payload.stream_name = updates.streamName;
  if (updates.applicableFromClass !== undefined) payload.applicable_from_class = updates.applicableFromClass;
  if (updates.applicableToClass !== undefined) payload.applicable_to_class = updates.applicableToClass;
  if (updates.isActive !== undefined) payload.is_active = updates.isActive;
  const { data, error } = await supabase.from('academic_streams').update(payload).eq('id', id).select(STREAM_COLUMNS).single();
  if (error) throwFromSupabaseError(error, { op: 'updateStream', table: 'academic_streams', metadata: { id } });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────
// curriculum_pathways
// ─────────────────────────────────────────────────────────────────────────

const PATHWAY_COLUMNS =
  'id, stream_id, curriculum_version_id, pathway_code, pathway_name, external_reference, is_active, deprecated_at, created_at, updated_at';

async function listPathwaysForVersion(curriculumVersionId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('curriculum_pathways')
    .select(PATHWAY_COLUMNS)
    .eq('curriculum_version_id', curriculumVersionId)
    .order('pathway_code', { ascending: true });
  if (error) throwFromSupabaseError(error, { op: 'listPathwaysForVersion', table: 'curriculum_pathways', metadata: { curriculumVersionId } });
  return data ?? [];
}

async function getPathwayById(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('curriculum_pathways').select(PATHWAY_COLUMNS).eq('id', id).maybeSingle();
  if (error) throwFromSupabaseError(error, { op: 'getPathwayById', table: 'curriculum_pathways', metadata: { id } });
  return data;
}

async function createPathway({ streamId, curriculumVersionId, pathwayCode, pathwayName, externalReference }) {
  const supabase = getSupabase();
  const payload = {
    stream_id: streamId,
    curriculum_version_id: curriculumVersionId,
    pathway_code: pathwayCode,
    pathway_name: pathwayName,
    external_reference: externalReference ?? null,
  };
  const { data, error } = await supabase.from('curriculum_pathways').insert(payload).select(PATHWAY_COLUMNS).single();
  if (error) throwFromSupabaseError(error, { op: 'createPathway', table: 'curriculum_pathways' });
  return data;
}

async function updatePathway(id, updates) {
  const supabase = getSupabase();
  const payload = {};
  if (updates.pathwayName !== undefined) payload.pathway_name = updates.pathwayName;
  if (updates.externalReference !== undefined) payload.external_reference = updates.externalReference;
  if (updates.isActive !== undefined) payload.is_active = updates.isActive;
  const { data, error } = await supabase.from('curriculum_pathways').update(payload).eq('id', id).select(PATHWAY_COLUMNS).single();
  if (error) throwFromSupabaseError(error, { op: 'updatePathway', table: 'curriculum_pathways', metadata: { id } });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────
// subject_stream_map (version-scoped rows: curriculum_version_id set,
// exactly one of stream_id/pathway_id per chk_subject_stream_map_scope_xor)
// ─────────────────────────────────────────────────────────────────────────

const SUBJECT_MAPPING_COLUMNS =
  'id, subject_id, stream_id, pathway_id, curriculum_version_id, is_mandatory, is_active, created_at, updated_at';

async function listSubjectMappingsForVersion(curriculumVersionId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('subject_stream_map')
    .select(SUBJECT_MAPPING_COLUMNS)
    .eq('curriculum_version_id', curriculumVersionId);
  if (error) throwFromSupabaseError(error, { op: 'listSubjectMappingsForVersion', table: 'subject_stream_map', metadata: { curriculumVersionId } });
  return data ?? [];
}

async function createSubjectMapping({ subjectId, streamId, pathwayId, curriculumVersionId, isMandatory }) {
  const supabase = getSupabase();
  const payload = {
    subject_id: subjectId,
    stream_id: streamId ?? null,
    pathway_id: pathwayId ?? null,
    curriculum_version_id: curriculumVersionId,
    is_mandatory: Boolean(isMandatory),
  };
  const { data, error } = await supabase.from('subject_stream_map').insert(payload).select(SUBJECT_MAPPING_COLUMNS).single();
  if (error) throwFromSupabaseError(error, { op: 'createSubjectMapping', table: 'subject_stream_map' });
  return data;
}

async function updateSubjectMapping(id, updates) {
  const supabase = getSupabase();
  const payload = {};
  if (updates.isMandatory !== undefined) payload.is_mandatory = updates.isMandatory;
  if (updates.isActive !== undefined) payload.is_active = updates.isActive;
  const { data, error } = await supabase.from('subject_stream_map').update(payload).eq('id', id).select(SUBJECT_MAPPING_COLUMNS).single();
  if (error) throwFromSupabaseError(error, { op: 'updateSubjectMapping', table: 'subject_stream_map', metadata: { id } });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────
// subject_group_map + subject_group_members
// ─────────────────────────────────────────────────────────────────────────

const SUBJECT_GROUP_COLUMNS =
  'id, curriculum_version_id, stream_id, pathway_id, group_code, group_label, min_select, max_select, is_active, created_at, updated_at';

async function listSubjectGroupsForVersion(curriculumVersionId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('subject_group_map')
    .select(SUBJECT_GROUP_COLUMNS)
    .eq('curriculum_version_id', curriculumVersionId);
  if (error) throwFromSupabaseError(error, { op: 'listSubjectGroupsForVersion', table: 'subject_group_map', metadata: { curriculumVersionId } });
  return data ?? [];
}

async function getSubjectGroupById(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('subject_group_map').select(SUBJECT_GROUP_COLUMNS).eq('id', id).maybeSingle();
  if (error) throwFromSupabaseError(error, { op: 'getSubjectGroupById', table: 'subject_group_map', metadata: { id } });
  return data;
}

async function createSubjectGroup({ curriculumVersionId, streamId, pathwayId, groupCode, groupLabel, minSelect, maxSelect }) {
  const supabase = getSupabase();
  const payload = {
    curriculum_version_id: curriculumVersionId,
    stream_id: streamId ?? null,
    pathway_id: pathwayId ?? null,
    group_code: groupCode,
    group_label: groupLabel,
    min_select: minSelect,
    max_select: maxSelect,
  };
  const { data, error } = await supabase.from('subject_group_map').insert(payload).select(SUBJECT_GROUP_COLUMNS).single();
  if (error) throwFromSupabaseError(error, { op: 'createSubjectGroup', table: 'subject_group_map' });
  return data;
}

async function updateSubjectGroup(id, updates) {
  const supabase = getSupabase();
  const payload = {};
  if (updates.groupLabel !== undefined) payload.group_label = updates.groupLabel;
  if (updates.minSelect !== undefined) payload.min_select = updates.minSelect;
  if (updates.maxSelect !== undefined) payload.max_select = updates.maxSelect;
  if (updates.isActive !== undefined) payload.is_active = updates.isActive;
  const { data, error } = await supabase.from('subject_group_map').update(payload).eq('id', id).select(SUBJECT_GROUP_COLUMNS).single();
  if (error) throwFromSupabaseError(error, { op: 'updateSubjectGroup', table: 'subject_group_map', metadata: { id } });
  return data;
}

async function listGroupMembers(groupId) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('subject_group_members').select('group_id, subject_id, created_at').eq('group_id', groupId);
  if (error) throwFromSupabaseError(error, { op: 'listGroupMembers', table: 'subject_group_members', metadata: { groupId } });
  return data ?? [];
}

async function addGroupMember(groupId, subjectId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('subject_group_members')
    .insert({ group_id: groupId, subject_id: subjectId })
    .select('group_id, subject_id, created_at')
    .single();
  if (error) throwFromSupabaseError(error, { op: 'addGroupMember', table: 'subject_group_members', metadata: { groupId, subjectId } });
  return data;
}

/**
 * subject_group_members carries no soft-delete column and, per its
 * migration comment, deliberately has no no-physical-delete trigger
 * applied — "group membership must remain freely editable while its
 * parent group is a draft." A physical DELETE here is therefore the
 * correct operation, not a workaround.
 */
async function removeGroupMember(groupId, subjectId) {
  const supabase = getSupabase();
  const { error } = await supabase.from('subject_group_members').delete().eq('group_id', groupId).eq('subject_id', subjectId);
  if (error) throwFromSupabaseError(error, { op: 'removeGroupMember', table: 'subject_group_members', metadata: { groupId, subjectId } });
}

// ─────────────────────────────────────────────────────────────────────────
// academic_subjects (read-only lookup used by mapping/group validation)
// ─────────────────────────────────────────────────────────────────────────

async function listAcademicSubjectsByIds(ids) {
  if (!ids?.length) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase.from('academic_subjects').select('id, subject_code, subject_name, is_active').in('id', ids);
  if (error) throwFromSupabaseError(error, { op: 'listAcademicSubjectsByIds', table: 'academic_subjects' });
  return data ?? [];
}

module.exports = {
  getBoardById,
  hasActiveBoardRegionMapping,
  listCurriculumVersions,
  getCurriculumVersionById,
  createDraftCurriculumVersion,
  updateCurriculumVersionMetadata,
  transitionCurriculumVersionStatus,
  listStreamsForVersion,
  getStreamById,
  createStream,
  updateStream,
  listPathwaysForVersion,
  getPathwayById,
  createPathway,
  updatePathway,
  listSubjectMappingsForVersion,
  createSubjectMapping,
  updateSubjectMapping,
  listSubjectGroupsForVersion,
  getSubjectGroupById,
  createSubjectGroup,
  updateSubjectGroup,
  listGroupMembers,
  addGroupMember,
  removeGroupMember,
  listAcademicSubjectsByIds,
};
