'use strict';

const {
  CurriculumVersionResolver,
  resolveCurriculumVersion,
} = require('../resolver/curriculumVersion.resolver');
const {
  InvalidCurriculumResolutionInputError,
  CurriculumConfigurationMissingError,
} = require('../curriculum.errors');

const BOARD = 'board-cbse';
const OTHER_BOARD = 'board-icse';
const REGION = 'region-maharashtra';
const UNRELATED_REGION = 'region-never-used-with-board';

// A hand-built fixture that mirrors what the real repository would
// return: only published/archived rows (a 'draft' row is included here
// deliberately, exactly as it would never appear in a real repository
// response, to prove the resolver doesn't rely on ever seeing one — see
// test C).
const BOARD_WIDE_OLD = {
  id: 'v-board-wide-old',
  board_id: BOARD,
  region_id: null,
  version_label: 'CBSE 2020-21',
  status: 'archived',
  effective_from: '2020-01-01',
  effective_to: '2021-12-31',
  published_at: '2019-12-01T00:00:00.000Z',
  archived_at: '2022-01-01T00:00:00.000Z',
  ncert_relationship: 'prescribed',
  notes: null,
};

const BOARD_WIDE_CURRENT = {
  id: 'v-board-wide-current',
  board_id: BOARD,
  region_id: null,
  version_label: 'CBSE 2022-23',
  status: 'published',
  effective_from: '2022-01-01',
  effective_to: null,
  published_at: '2021-12-01T00:00:00.000Z',
  archived_at: null,
  ncert_relationship: 'prescribed',
  notes: null,
};

const REGION_SPECIFIC_CURRENT = {
  id: 'v-region-current',
  board_id: BOARD,
  region_id: REGION,
  version_label: 'CBSE Maharashtra 2022-23',
  status: 'published',
  effective_from: '2022-06-01',
  effective_to: null,
  published_at: '2022-05-01T00:00:00.000Z',
  archived_at: null,
  ncert_relationship: 'adapted',
  notes: null,
};

const DRAFT_NEVER_RETURNED_BY_REAL_REPOSITORY = {
  id: 'v-draft-should-never-appear',
  board_id: BOARD,
  region_id: null,
  version_label: 'CBSE 2023-24 draft',
  status: 'draft',
  effective_from: '2023-01-01',
  effective_to: null,
  published_at: null,
  archived_at: null,
  ncert_relationship: null,
  notes: null,
};

function fakeFind(rowsByBoard) {
  const calls = [];
  const fn = jest.fn(async (supabase, boardId) => {
    calls.push({ supabase, boardId });
    return rowsByBoard[boardId] ?? [];
  });
  fn.calls = calls;
  return fn;
}

function makeResolver(rowsByBoard) {
  const findResolvableCurriculumVersionsForBoard = fakeFind(rowsByBoard);
  const supabaseMarker = Object.freeze({}); // no methods — see test L
  const resolver = new CurriculumVersionResolver({
    supabase: supabaseMarker,
    findResolvableCurriculumVersionsForBoard,
  });
  return { resolver, findResolvableCurriculumVersionsForBoard, supabaseMarker };
}

describe('CurriculumVersionResolver — resolve_curriculum_version', () => {
  // A. published board-wide version resolves
  it('A: resolves a published board-wide version', async () => {
    const { resolver } = makeResolver({ [BOARD]: [BOARD_WIDE_CURRENT] });

    const result = await resolver.resolve({ boardId: BOARD, asOfDate: '2022-07-01' });

    expect(result.id).toBe('v-board-wide-current');
    expect(result.matchedRegionSpecific).toBe(false);
  });

  // B. published region-specific version wins over board-wide
  it('B: a region-specific version wins over a board-wide version, both effective', async () => {
    const { resolver } = makeResolver({
      [BOARD]: [BOARD_WIDE_CURRENT, REGION_SPECIFIC_CURRENT],
    });

    const result = await resolver.resolve({ boardId: BOARD, regionId: REGION, asOfDate: '2022-07-01' });

    expect(result.id).toBe('v-region-current');
    expect(result.matchedRegionSpecific).toBe(true);
  });

  // C. draft version never resolves
  it('C: a draft row is never selected, even if the underlying data source incorrectly returns one', async () => {
    const { resolver } = makeResolver({
      [BOARD]: [DRAFT_NEVER_RETURNED_BY_REAL_REPOSITORY, BOARD_WIDE_CURRENT],
    });

    // Both rows' effective windows cover 2023-06-01 (BOARD_WIDE_CURRENT is
    // open-ended, the draft has effective_from 2023-01-01) and the draft
    // has the later effective_from, so if status were not independently
    // re-checked here the draft would win on the "latest applicable"
    // tie-break. It doesn't: the resolver filters by RESOLVABLE_STATUSES
    // itself (see file header), on top of the repository already never
    // returning draft rows in real usage (proven separately by
    // curriculumVersion.repository.test.js's RESOLVABLE_STATUSES
    // assertion). This test exercises the resolver's own guarantee in
    // isolation, independent of whether the repository layer is trusted.
    const result = await resolver.resolve({ boardId: BOARD, asOfDate: '2023-06-01' });

    expect(result.id).toBe('v-board-wide-current');
    expect(result.status).not.toBe('draft');
  });

  // D. version before effective_from does not resolve
  it('D: a version does not resolve before its effective_from', async () => {
    const { resolver } = makeResolver({ [BOARD]: [BOARD_WIDE_CURRENT] });

    await expect(resolver.resolve({ boardId: BOARD, asOfDate: '2021-12-31' })).rejects.toThrow(
      CurriculumConfigurationMissingError,
    );
  });

  // E. version after effective_to does not resolve
  it('E: a version does not resolve after its effective_to', async () => {
    const { resolver } = makeResolver({ [BOARD]: [BOARD_WIDE_OLD] });

    await expect(resolver.resolve({ boardId: BOARD, asOfDate: '2022-01-01' })).rejects.toThrow(
      CurriculumConfigurationMissingError,
    );
  });

  // F. open-ended effective_to works
  it('F: an open-ended (null effective_to) version resolves far in the future', async () => {
    const { resolver } = makeResolver({ [BOARD]: [BOARD_WIDE_CURRENT] });

    const result = await resolver.resolve({ boardId: BOARD, asOfDate: '2099-01-01' });

    expect(result.id).toBe('v-board-wide-current');
  });

  // G. latest applicable version is selected deterministically
  it('G: selects the latest applicable version when multiple board-wide rows are effective', async () => {
    const middle = {
      ...BOARD_WIDE_CURRENT,
      id: 'v-board-wide-middle',
      effective_from: '2021-06-01',
      effective_to: '2021-12-31',
      published_at: '2021-05-01T00:00:00.000Z',
    };
    const { resolver } = makeResolver({ [BOARD]: [BOARD_WIDE_OLD, middle] });

    const result = await resolver.resolve({ boardId: BOARD, asOfDate: '2021-07-01' });

    expect(result.id).toBe('v-board-wide-middle');
  });

  it('G (repeatability): resolving the same input twice gives the same deterministic result', async () => {
    const { resolver } = makeResolver({
      [BOARD]: [BOARD_WIDE_OLD, BOARD_WIDE_CURRENT, REGION_SPECIFIC_CURRENT],
    });

    const first = await resolver.resolve({ boardId: BOARD, regionId: REGION, asOfDate: '2022-07-01' });
    const second = await resolver.resolve({ boardId: BOARD, regionId: REGION, asOfDate: '2022-07-01' });

    expect(first).toEqual(second);
  });

  // H. no applicable version returns controlled missing-configuration result
  it('H: throws CurriculumConfigurationMissingError, not a silent fallback, when nothing applies', async () => {
    const { resolver } = makeResolver({ [BOARD]: [] });

    await expect(resolver.resolve({ boardId: BOARD, asOfDate: '2022-07-01' })).rejects.toThrow(
      CurriculumConfigurationMissingError,
    );
  });

  // I. invalid/nonexistent board/region input is handled safely
  it('I: an empty boardId is rejected as invalid input, not a DB call', async () => {
    const { resolver, findResolvableCurriculumVersionsForBoard } = makeResolver({});

    await expect(resolver.resolve({ boardId: '', asOfDate: '2022-07-01' })).rejects.toThrow(
      InvalidCurriculumResolutionInputError,
    );
    expect(findResolvableCurriculumVersionsForBoard).not.toHaveBeenCalled();
  });

  it('I: a non-date asOfDate is rejected as invalid input', async () => {
    const { resolver } = makeResolver({ [BOARD]: [BOARD_WIDE_CURRENT] });

    await expect(resolver.resolve({ boardId: BOARD, asOfDate: 'not-a-date' })).rejects.toThrow(
      InvalidCurriculumResolutionInputError,
    );
  });

  it('I: a nonexistent board resolves to a controlled missing-configuration error, not a crash', async () => {
    const { resolver } = makeResolver({ [BOARD]: [BOARD_WIDE_CURRENT] });

    await expect(
      resolver.resolve({ boardId: 'board-does-not-exist', asOfDate: '2022-07-01' }),
    ).rejects.toThrow(CurriculumConfigurationMissingError);
  });

  // J. region not belonging to board is rejected/handled according to
  // existing taxonomy conventions (no board<->region ownership table
  // exists — see file header — so an unmatched regionId simply yields no
  // region-specific candidates and falls through to board-wide)
  it('J: a regionId never associated with this board falls back to the board-wide version', async () => {
    const { resolver } = makeResolver({
      [BOARD]: [BOARD_WIDE_CURRENT, REGION_SPECIFIC_CURRENT],
    });

    const result = await resolver.resolve({
      boardId: BOARD,
      regionId: UNRELATED_REGION,
      asOfDate: '2022-07-01',
    });

    expect(result.id).toBe('v-board-wide-current');
    expect(result.matchedRegionSpecific).toBe(false);
  });

  // K. archived version behavior follows the Phase 1 contract
  it('K: an archived version resolves for a historical asOfDate within its window', async () => {
    const { resolver } = makeResolver({ [BOARD]: [BOARD_WIDE_OLD, BOARD_WIDE_CURRENT] });

    const result = await resolver.resolve({ boardId: BOARD, asOfDate: '2020-06-01' });

    expect(result.id).toBe('v-board-wide-old');
    expect(result.status).toBe('archived');
  });

  it('K: an archived version does not resolve once superseded by a later effective version', async () => {
    const { resolver } = makeResolver({ [BOARD]: [BOARD_WIDE_OLD, BOARD_WIDE_CURRENT] });

    const result = await resolver.resolve({ boardId: BOARD, asOfDate: '2022-07-01' });

    expect(result.id).toBe('v-board-wide-current');
  });

  // L. no legacy board_type inference occurs
  it('L: only boardId is passed to the repository lookup — no other table/legacy field is consulted', async () => {
    const { resolver, findResolvableCurriculumVersionsForBoard, supabaseMarker } = makeResolver({
      [BOARD]: [BOARD_WIDE_CURRENT],
    });

    await resolver.resolve({ boardId: BOARD, regionId: REGION, classLabel: 'Class 10', asOfDate: '2022-07-01' });

    expect(findResolvableCurriculumVersionsForBoard).toHaveBeenCalledTimes(1);
    expect(findResolvableCurriculumVersionsForBoard).toHaveBeenCalledWith(supabaseMarker, BOARD);
    // classLabel is accepted (no throw above) but never reaches the
    // repository call — confirms it plays no role in resolution, per the
    // file header's documented rationale.
  });

  it('L: classLabel is optional and unused, but rejected if given as an empty string', async () => {
    const { resolver } = makeResolver({ [BOARD]: [BOARD_WIDE_CURRENT] });

    await expect(
      resolver.resolve({ boardId: BOARD, classLabel: '', asOfDate: '2022-07-01' }),
    ).rejects.toThrow(InvalidCurriculumResolutionInputError);
  });

  it('multiple boards never cross-contaminate results', async () => {
    const { resolver, findResolvableCurriculumVersionsForBoard } = makeResolver({
      [BOARD]: [BOARD_WIDE_CURRENT],
      [OTHER_BOARD]: [],
    });

    const result = await resolver.resolve({ boardId: BOARD, asOfDate: '2022-07-01' });
    expect(result.id).toBe('v-board-wide-current');

    await expect(resolver.resolve({ boardId: OTHER_BOARD, asOfDate: '2022-07-01' })).rejects.toThrow(
      CurriculumConfigurationMissingError,
    );
    expect(findResolvableCurriculumVersionsForBoard).toHaveBeenCalledWith(expect.anything(), OTHER_BOARD);
  });

  describe('resolveCurriculumVersion() convenience function', () => {
    it('delegates to an injected resolver-equivalent dependency set', async () => {
      const findResolvableCurriculumVersionsForBoard = fakeFind({ [BOARD]: [BOARD_WIDE_CURRENT] });

      const result = await resolveCurriculumVersion(
        { boardId: BOARD, asOfDate: '2022-07-01' },
        { supabase: {}, findResolvableCurriculumVersionsForBoard },
      );

      expect(result.id).toBe('v-board-wide-current');
    });
  });
});
