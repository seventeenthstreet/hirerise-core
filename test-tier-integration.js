// test-tier-integration.js
const request  = require('supertest');
const app      = require('./src/server');

process.env.NODE_ENV  = 'test';

async function run() {

  console.log('\n── FREE ──────────────────────────────');
  process.env.TEST_PLAN = 'free';
  const free = await request(app)
    .get('/api/v1/career-health/latest')
    .set('Authorization', 'Bearer dummy');

  console.log('Status:', free.status);
  console.log(JSON.stringify(free.body, null, 2));

  console.log('\n── PRO ───────────────────────────────');
  process.env.TEST_PLAN = 'pro';
  const pro = await request(app)
    .get('/api/v1/career-health/latest')
    .set('Authorization', 'Bearer dummy');

  console.log('Status:', pro.status);
  console.log(JSON.stringify(pro.body, null, 2));

  console.log('\n── PREMIUM ───────────────────────────');
  process.env.TEST_PLAN = 'premium';
  const premium = await request(app)
    .get('/api/v1/career-health/latest')
    .set('Authorization', 'Bearer dummy');

  console.log('Status:', premium.status);
  console.log(JSON.stringify(premium.body, null, 2));
}

run().catch(console.error);