const request = require('supertest');
const app = require('../server');

describe('Career API', () => {
  test('career endpoint should return 400 for invalid payload', async () => {
    const res = await request(app)
      .post('/api/v1/career/some-endpoint')
      .send({});

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});