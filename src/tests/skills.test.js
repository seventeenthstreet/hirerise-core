const request = require('supertest');
const app = require('../server');

describe('Skills API', () => {
  test('should reject more than 200 user skills', async () => {
    const skills = Array.from({ length: 201 }, (_, i) => ({
      name: `skill_${i}`,
      level: 3,
    }));

    const res = await request(app)
      .post('/api/v1/skills/gap-analysis')
      .send({
        targetRoleId: 'software-engineer',
        userSkills: skills,
      });

    expect(res.statusCode).toBe(400);
  });
});








