'use strict';

jest.mock('../adminCmsCurriculum.repository');

const repo = require('../adminCmsCurriculum.repository');
const service = require('../adminCmsCurriculum.service');
const {
  CurriculumNotFoundError,
  CurriculumNotEditableError,
  CurriculumAdminValidationError,
  CurriculumDraftInvalidError,
} = require('../adminCmsCurriculum.errors');

function draftVersion(overrides = {}) {
  return {
    id: 'v1',
    board_id: 'board-1',
    region_id: null,
    version_label: 'Test Version',
    status: 'draft',
    effective_from: '2026-06-01',
    effective_to: null,
    ncert_relationship: null,
    published_at: null,
    archived_at: null,
    notes: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── B. Create draft version ────────────────────────────────────────────────
describe('createDraftVersion', () => {
  test('2: creates a draft version when board is valid and required fields present', async () => {
    repo.getBoardById.mockResolvedValue({ id: 'board-1', is_active: true });
    repo.createDraftCurriculumVersion.mockResolvedValue(draftVersion());

    const result = await service.createDraftVersion(
      { boardId: 'board-1', versionLabel: 'Test Version', effectiveFrom: '2026-06-01' },
      'admin-1',
    );

    expect(repo.createDraftCurriculumVersion).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: 'board-1', versionLabel: 'Test Version', createdBy: 'admin-1' }),
    );
    expect(result.status).toBe('draft');
  });

  test('rejects when boardId does not reference an active board', async () => {
    repo.getBoardById.mockResolvedValue(null);

    await expect(
      service.createDraftVersion({ boardId: 'nope', versionLabel: 'X', effectiveFrom: '2026-06-01' }, 'admin-1'),
    ).rejects.toThrow(CurriculumAdminValidationError);
    expect(repo.createDraftCurriculumVersion).not.toHaveBeenCalled();
  });

  test('rejects an ncertRelationship outside the locked vocabulary', async () => {
    repo.getBoardById.mockResolvedValue({ id: 'board-1', is_active: true });

    await expect(
      service.createDraftVersion(
        { boardId: 'board-1', versionLabel: 'X', effectiveFrom: '2026-06-01', ncertRelationship: 'made_up_value' },
        'admin-1',
      ),
    ).rejects.toThrow(CurriculumAdminValidationError);
  });

  test('rejects a regionId with no active board_region_map row', async () => {
    repo.getBoardById.mockResolvedValue({ id: 'board-1', is_active: true });
    repo.hasActiveBoardRegionMapping.mockResolvedValue(false);

    await expect(
      service.createDraftVersion(
        { boardId: 'board-1', regionId: 'region-x', versionLabel: 'X', effectiveFrom: '2026-06-01' },
        'admin-1',
      ),
    ).rejects.toThrow(CurriculumAdminValidationError);
  });
});

// ── C. Edit draft metadata / 3-4-5 ─────────────────────────────────────────
describe('updateDraftVersionMetadata', () => {
  test('5: draft metadata can be updated', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.updateCurriculumVersionMetadata.mockResolvedValue(draftVersion({ notes: 'updated' }));

    const result = await service.updateDraftVersionMetadata('v1', { notes: 'updated' });

    expect(repo.updateCurriculumVersionMetadata).toHaveBeenCalledWith('v1', { notes: 'updated' });
    expect(result.notes).toBe('updated');
  });

  test('3: a published version cannot be structurally edited — rejected before any DB write', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion({ status: 'published' }));

    await expect(service.updateDraftVersionMetadata('v1', { versionLabel: 'x' })).rejects.toThrow(
      CurriculumNotEditableError,
    );
    expect(repo.updateCurriculumVersionMetadata).not.toHaveBeenCalled();
  });

  test('4: an archived version cannot be structurally edited — rejected before any DB write', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion({ status: 'archived' }));

    await expect(service.updateDraftVersionMetadata('v1', { versionLabel: 'x' })).rejects.toThrow(
      CurriculumNotEditableError,
    );
    expect(repo.updateCurriculumVersionMetadata).not.toHaveBeenCalled();
  });

  test('throws CurriculumNotFoundError for a nonexistent version', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(null);
    await expect(service.updateDraftVersionMetadata('missing', {})).rejects.toThrow(CurriculumNotFoundError);
  });
});

// ── D. Streams — 6 ──────────────────────────────────────────────────────────
describe('stream configuration is version-scoped (6)', () => {
  test('createDraftStream scopes the new stream to the parent draft version', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.createStream.mockResolvedValue({ id: 's1', curriculum_version_id: 'v1' });

    await service.createDraftStream('v1', { streamCode: 'SCI', streamName: 'Science' });

    expect(repo.createStream).toHaveBeenCalledWith(
      expect.objectContaining({ curriculumVersionId: 'v1', boardId: 'board-1' }),
    );
  });

  test('createDraftStream rejects when the parent version is not draft', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion({ status: 'published' }));
    await expect(service.createDraftStream('v1', { streamCode: 'SCI', streamName: 'Science' })).rejects.toThrow(
      CurriculumNotEditableError,
    );
  });

  test('updateDraftStream rejects a stream belonging to a different curriculum version', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.getStreamById.mockResolvedValue({ id: 's1', curriculum_version_id: 'v-other' });

    await expect(service.updateDraftStream('v1', 's1', { streamName: 'x' })).rejects.toThrow(CurriculumNotFoundError);
    expect(repo.updateStream).not.toHaveBeenCalled();
  });
});

// ── E. Pathways — 7 ──────────────────────────────────────────────────────────
describe('pathway configuration is version-scoped (7)', () => {
  test('createDraftPathway rejects a streamId from a different version', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.getStreamById.mockResolvedValue({ id: 's1', curriculum_version_id: 'v-other' });

    await expect(
      service.createDraftPathway('v1', { streamId: 's1', pathwayCode: 'BM', pathwayName: 'Bio-Maths' }),
    ).rejects.toThrow(CurriculumAdminValidationError);
    expect(repo.createPathway).not.toHaveBeenCalled();
  });

  test('createDraftPathway succeeds when the stream belongs to the same version', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.getStreamById.mockResolvedValue({ id: 's1', curriculum_version_id: 'v1' });
    repo.createPathway.mockResolvedValue({ id: 'p1' });

    await service.createDraftPathway('v1', { streamId: 's1', pathwayCode: 'BM', pathwayName: 'Bio-Maths' });
    expect(repo.createPathway).toHaveBeenCalledWith(expect.objectContaining({ streamId: 's1', curriculumVersionId: 'v1' }));
  });
});

// ── F. Subject mappings — 8 ──────────────────────────────────────────────────
describe('subject mapping respects the stream/pathway XOR (8)', () => {
  test('rejects when both streamId and pathwayId are given', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    await expect(
      service.createDraftSubjectMapping('v1', { subjectId: 'subj-1', streamId: 's1', pathwayId: 'p1' }),
    ).rejects.toThrow(CurriculumAdminValidationError);
  });

  test('rejects when neither streamId nor pathwayId is given', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    await expect(service.createDraftSubjectMapping('v1', { subjectId: 'subj-1' })).rejects.toThrow(
      CurriculumAdminValidationError,
    );
  });

  test('accepts stream-only scope and creates the mapping', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.getStreamById.mockResolvedValue({ id: 's1', curriculum_version_id: 'v1' });
    repo.listAcademicSubjectsByIds.mockResolvedValue([{ id: 'subj-1', is_active: true }]);
    repo.createSubjectMapping.mockResolvedValue({ id: 'm1' });

    await service.createDraftSubjectMapping('v1', { subjectId: 'subj-1', streamId: 's1' });
    expect(repo.createSubjectMapping).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 's1', pathwayId: null }),
    );
  });
});

// ── G. Subject groups — 9, 10, 11 ─────────────────────────────────────────
describe('subject groups are version-scoped (9), group membership respects scope (10), min/max validated (11)', () => {
  test('11: rejects maxSelect < minSelect', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    await expect(
      service.createDraftSubjectGroup('v1', { streamId: 's1', groupCode: 'G1', groupLabel: 'Group 1', minSelect: 2, maxSelect: 1 }),
    ).rejects.toThrow(CurriculumAdminValidationError);
  });

  test('11: rejects a negative minSelect', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    await expect(
      service.createDraftSubjectGroup('v1', { streamId: 's1', groupCode: 'G1', groupLabel: 'Group 1', minSelect: -1, maxSelect: 1 }),
    ).rejects.toThrow(CurriculumAdminValidationError);
  });

  test('9: creates a subject group scoped to the parent version, XOR-scoped to a stream', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.getStreamById.mockResolvedValue({ id: 's1', curriculum_version_id: 'v1' });
    repo.createSubjectGroup.mockResolvedValue({ id: 'g1' });

    await service.createDraftSubjectGroup('v1', { streamId: 's1', groupCode: 'G1', groupLabel: 'Group 1', minSelect: 1, maxSelect: 2 });
    expect(repo.createSubjectGroup).toHaveBeenCalledWith(
      expect.objectContaining({ curriculumVersionId: 'v1', streamId: 's1', pathwayId: null }),
    );
  });

  test('10: addDraftGroupMember rejects a group that does not belong to the given version', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.getSubjectGroupById.mockResolvedValue({ id: 'g1', curriculum_version_id: 'v-other' });

    await expect(service.addDraftGroupMember('v1', 'g1', 'subj-1')).rejects.toThrow(CurriculumNotFoundError);
    expect(repo.addGroupMember).not.toHaveBeenCalled();
  });

  test('10: addDraftGroupMember succeeds for a group in-scope with an active subject', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.getSubjectGroupById.mockResolvedValue({ id: 'g1', curriculum_version_id: 'v1' });
    repo.listAcademicSubjectsByIds.mockResolvedValue([{ id: 'subj-1', is_active: true }]);
    repo.addGroupMember.mockResolvedValue({ group_id: 'g1', subject_id: 'subj-1' });

    await service.addDraftGroupMember('v1', 'g1', 'subj-1');
    expect(repo.addGroupMember).toHaveBeenCalledWith('g1', 'subj-1');
  });
});

// ── H. Pre-publish validation / 12 ─────────────────────────────────────────
describe('validateDraftConfiguration (H) / invalid publish configuration rejected (12)', () => {
  test('flags a subject_group_map row whose max_select exceeds its member count', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.hasActiveBoardRegionMapping.mockResolvedValue(true);
    repo.listStreamsForVersion.mockResolvedValue([{ id: 's1' }]);
    repo.listPathwaysForVersion.mockResolvedValue([]);
    repo.listSubjectMappingsForVersion.mockResolvedValue([]);
    repo.listSubjectGroupsForVersion.mockResolvedValue([
      { id: 'g1', stream_id: 's1', pathway_id: null, min_select: 1, max_select: 2 },
    ]);
    repo.listGroupMembers.mockResolvedValue([{ group_id: 'g1', subject_id: 'subj-1' }]); // only 1 member, max_select is 2

    const { valid, errors } = await service.validateDraftConfiguration('v1');

    expect(valid).toBe(false);
    expect(errors.some((e) => e.code === 'GROUP_MAX_SELECT_EXCEEDS_MEMBERS')).toBe(true);
  });

  test('flags a pathway referencing a stream outside this version', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.listStreamsForVersion.mockResolvedValue([]); // no streams in this version at all
    repo.listPathwaysForVersion.mockResolvedValue([{ id: 'p1', stream_id: 'orphan-stream' }]);
    repo.listSubjectMappingsForVersion.mockResolvedValue([]);
    repo.listSubjectGroupsForVersion.mockResolvedValue([]);

    const { valid, errors } = await service.validateDraftConfiguration('v1');

    expect(valid).toBe(false);
    expect(errors.some((e) => e.code === 'INVALID_PATHWAY_STREAM')).toBe(true);
  });

  test('12: publishVersion rejects an invalid draft with CurriculumDraftInvalidError, without transitioning', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.listStreamsForVersion.mockResolvedValue([]);
    repo.listPathwaysForVersion.mockResolvedValue([{ id: 'p1', stream_id: 'missing' }]);
    repo.listSubjectMappingsForVersion.mockResolvedValue([]);
    repo.listSubjectGroupsForVersion.mockResolvedValue([]);

    await expect(service.publishVersion('v1')).rejects.toThrow(CurriculumDraftInvalidError);
    expect(repo.transitionCurriculumVersionStatus).not.toHaveBeenCalled();
  });

  test('a fully valid, minimal draft (no streams/pathways/groups at all) passes validation', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.listStreamsForVersion.mockResolvedValue([]);
    repo.listPathwaysForVersion.mockResolvedValue([]);
    repo.listSubjectMappingsForVersion.mockResolvedValue([]);
    repo.listSubjectGroupsForVersion.mockResolvedValue([]);

    const { valid, errors } = await service.validateDraftConfiguration('v1');
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });
});

// ── I. Publish — 13, 14 ─────────────────────────────────────────────────────
describe('publishVersion (13, 14)', () => {
  test('13/14: a valid draft publishes via the governed transition call', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion());
    repo.listStreamsForVersion.mockResolvedValue([]);
    repo.listPathwaysForVersion.mockResolvedValue([]);
    repo.listSubjectMappingsForVersion.mockResolvedValue([]);
    repo.listSubjectGroupsForVersion.mockResolvedValue([]);
    repo.transitionCurriculumVersionStatus.mockResolvedValue(draftVersion({ status: 'published' }));

    const result = await service.publishVersion('v1');

    expect(repo.transitionCurriculumVersionStatus).toHaveBeenCalledWith('v1', 'draft', 'published');
    expect(result.status).toBe('published');
  });

  test('rejects publishing a version that is not draft, without calling the repository transition', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion({ status: 'published' }));
    await expect(service.publishVersion('v1')).rejects.toThrow(CurriculumNotEditableError);
    expect(repo.transitionCurriculumVersionStatus).not.toHaveBeenCalled();
  });
});

// ── J. Archive ───────────────────────────────────────────────────────────
describe('archiveVersion', () => {
  test('archives a published version via the governed transition call', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion({ status: 'published' }));
    repo.transitionCurriculumVersionStatus.mockResolvedValue(draftVersion({ status: 'archived' }));

    const result = await service.archiveVersion('v1');

    expect(repo.transitionCurriculumVersionStatus).toHaveBeenCalledWith('v1', 'published', 'archived');
    expect(result.status).toBe('archived');
  });

  test('rejects archiving a draft version', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion({ status: 'draft' }));
    await expect(service.archiveVersion('v1')).rejects.toThrow(CurriculumNotEditableError);
    expect(repo.transitionCurriculumVersionStatus).not.toHaveBeenCalled();
  });

  test('rejects archiving an already-archived version', async () => {
    repo.getCurriculumVersionById.mockResolvedValue(draftVersion({ status: 'archived' }));
    await expect(service.archiveVersion('v1')).rejects.toThrow(CurriculumNotEditableError);
    expect(repo.transitionCurriculumVersionStatus).not.toHaveBeenCalled();
  });
});

// ── 19/20: reuses canonical taxonomy, no second taxonomy ───────────────────
describe('canonical taxonomy reuse (19, 20)', () => {
  test('the repository module never references a second/duplicate taxonomy table', () => {
    // eslint-disable-next-line global-require
    const repoSource = require('fs').readFileSync(
      require.resolve('../adminCmsCurriculum.repository'),
      'utf8',
    );
    const referencedTables = [...repoSource.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]);
    const allowList = new Set([
      'academic_boards', 'board_region_map', 'curriculum_versions',
      'academic_streams', 'curriculum_pathways', 'subject_stream_map',
      'subject_group_map', 'subject_group_members', 'academic_subjects',
    ]);
    for (const table of referencedTables) {
      expect(allowList.has(table)).toBe(true);
    }
    expect(referencedTables.length).toBeGreaterThan(0);
  });
});
