const request = require('supertest');
const app = require('../server');

describe('Jobs API', () => {
  test('health endpoint should work', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.statusCode).toBe(200);
  });
});