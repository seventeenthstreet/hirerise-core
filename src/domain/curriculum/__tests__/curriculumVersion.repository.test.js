'use strict';

const {
  findResolvableCurriculumVersionsForBoard,
  RESOLVABLE_STATUSES,
} = require('../repository/curriculumVersion.repository');
const { CurriculumVersionRepositoryError } = require('../curriculum.errors');

function buildFakeSupabase({ data, error = null }) {
  const in_ = jest.fn().mockResolvedValue({ data, error });
  const eq = jest.fn().mockReturnValue({ in: in_ });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  return { from, select, eq, in: in_ };
}

describe('curriculumVersion.repository', () => {
  it('queries curriculum_versions scoped by board_id and status in (published, archived)', async () => {
    const rows = [{ id: '1', board_id: 'b1', region_id: null, status: 'published' }];
    const fakeSupabase = buildFakeSupabase({ data: rows });

    const result = await findResolvableCurriculumVersionsForBoard(fakeSupabase, 'b1');

    expect(result).toEqual(rows);
    expect(fakeSupabase.from).toHaveBeenCalledWith('curriculum_versions');
    expect(fakeSupabase.eq).toHaveBeenCalledWith('board_id', 'b1');
    expect(fakeSupabase.in).toHaveBeenCalledWith('status', ['published', 'archived']);
  });

  it('never includes draft in the resolvable status allow-list', () => {
    expect(RESOLVABLE_STATUSES).toEqual(['published', 'archived']);
    expect(RESOLVABLE_STATUSES).not.toContain('draft');
  });

  it('returns an empty array when there are no matching rows', async () => {
    const fakeSupabase = buildFakeSupabase({ data: null });

    const result = await findResolvableCurriculumVersionsForBoard(fakeSupabase, 'nonexistent-board');

    expect(result).toEqual([]);
  });

  it('wraps a Supabase error as CurriculumVersionRepositoryError rather than letting it escape raw', async () => {
    const fakeSupabase = buildFakeSupabase({ data: null, error: { message: 'db down' } });

    await expect(findResolvableCurriculumVersionsForBoard(fakeSupabase, 'b1')).rejects.toThrow(
      CurriculumVersionRepositoryError,
    );
  });
});
