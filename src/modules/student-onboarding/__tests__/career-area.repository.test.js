'use strict';

const { fetchGovernedCareerAreaKeys } = require('../repositories/career-area.repository');

function buildFakeSupabase({ data, error = null }) {
  const not = jest.fn().mockResolvedValue({ data, error });
  const eq = jest.fn().mockReturnValue({ not });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  return { from, select, eq, not };
}

describe('career-area.repository', () => {
  it('returns the active governed canonical_key values', async () => {
    const fakeSupabase = buildFakeSupabase({
      data: [
        { canonical_key: 'technology' },
        { canonical_key: 'engineering' },
        { canonical_key: 'natural_sciences' },
      ],
    });

    const keys = await fetchGovernedCareerAreaKeys(fakeSupabase);

    expect(keys).toEqual(['technology', 'engineering', 'natural_sciences']);
    expect(fakeSupabase.from).toHaveBeenCalledWith('cms_career_domains');
    expect(fakeSupabase.eq).toHaveBeenCalledWith('soft_deleted', false);
  });

  it('filters out null/empty canonical_key values defensively', async () => {
    const fakeSupabase = buildFakeSupabase({
      data: [{ canonical_key: 'technology' }, { canonical_key: null }, { canonical_key: '' }],
    });

    const keys = await fetchGovernedCareerAreaKeys(fakeSupabase);

    expect(keys).toEqual(['technology']);
  });

  it('returns an empty array when no rows exist', async () => {
    const fakeSupabase = buildFakeSupabase({ data: [] });

    const keys = await fetchGovernedCareerAreaKeys(fakeSupabase);

    expect(keys).toEqual([]);
  });

  it('returns an empty array when data is null', async () => {
    const fakeSupabase = buildFakeSupabase({ data: null });

    const keys = await fetchGovernedCareerAreaKeys(fakeSupabase);

    expect(keys).toEqual([]);
  });

  it('propagates a Supabase error', async () => {
    const fakeSupabase = buildFakeSupabase({ data: null, error: new Error('db down') });

    await expect(fetchGovernedCareerAreaKeys(fakeSupabase)).rejects.toThrow('db down');
  });
});
