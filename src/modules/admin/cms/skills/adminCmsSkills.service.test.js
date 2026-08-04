'use strict';

/**
 * @file adminCmsSkills.service.test.js
 * @description
 * WP-ADMIN-BE-01 — CMS Skills API Completion.
 *
 * Regression test for the listSkills bug (service called the non-existent
 * `skillsRepo.find(...)`, so GET /admin/cms/skills threw a TypeError on
 * every request), plus coverage for the newly-wired getSkill/deleteSkill
 * paths and search/offset pass-through.
 */

jest.mock('./adminCmsSkills.repository', () => ({
  list:       jest.fn(),
  findById:   jest.fn(),
  softDelete: jest.fn(),
  findByNormalizedName: jest.fn(),
}));

const skillsRepo = require('./adminCmsSkills.repository');
const {
  listSkills,
  getSkill,
  deleteSkill,
} = require('./adminCmsSkills.service');

describe('adminCmsSkills.service', () => {
  describe('listSkills', () => {
    test('calls repository.list (not the non-existent .find) and returns { skills, total }', async () => {
      skillsRepo.list.mockResolvedValue({
        items: [{ id: 's1', name: 'React' }],
        total: 1,
      });

      const result = await listSkills({ limit: 50, offset: 0, category: 'technical', search: 'react' });

      expect(skillsRepo.list).toHaveBeenCalledWith({
        category: 'technical',
        search:   'react',
        limit:    50,
        offset:   0,
      });
      expect(result).toEqual({ skills: [{ id: 's1', name: 'React' }], total: 1 });
    });

    test('does not throw a TypeError (previously: skillsRepo.find is not a function)', async () => {
      skillsRepo.list.mockResolvedValue({ items: [], total: 0 });
      await expect(listSkills()).resolves.toEqual({ skills: [], total: 0 });
    });
  });

  describe('getSkill', () => {
    test('returns the skill when found and not soft-deleted', async () => {
      skillsRepo.findById.mockResolvedValue({ id: 's1', name: 'React', softDeleted: false });
      const result = await getSkill('s1');
      expect(result).toEqual({ id: 's1', name: 'React', softDeleted: false });
    });

    test('throws a 404 AppError when the skill does not exist', async () => {
      skillsRepo.findById.mockResolvedValue(null);
      await expect(getSkill('missing')).rejects.toMatchObject({ statusCode: 404 });
    });

    test('throws a 404 AppError when the skill is soft-deleted', async () => {
      skillsRepo.findById.mockResolvedValue({ id: 's1', softDeleted: true });
      await expect(getSkill('s1')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('deleteSkill', () => {
    test('soft-deletes an existing skill', async () => {
      skillsRepo.findById.mockResolvedValue({ id: 's1', softDeleted: false });
      skillsRepo.softDelete.mockResolvedValue(undefined);

      await deleteSkill('s1', 'admin-1');

      expect(skillsRepo.softDelete).toHaveBeenCalledWith('s1', 'admin-1');
    });

    test('throws a 404 AppError instead of soft-deleting when the skill is missing', async () => {
      skillsRepo.findById.mockResolvedValue(null);
      await expect(deleteSkill('missing', 'admin-1')).rejects.toMatchObject({ statusCode: 404 });
      expect(skillsRepo.softDelete).not.toHaveBeenCalled();
    });

    test('throws a 404 AppError instead of re-deleting an already-deleted skill', async () => {
      skillsRepo.findById.mockResolvedValue({ id: 's1', softDeleted: true });
      await expect(deleteSkill('s1', 'admin-1')).rejects.toMatchObject({ statusCode: 404 });
      expect(skillsRepo.softDelete).not.toHaveBeenCalled();
    });
  });
});
