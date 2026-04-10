'use strict';

require('dotenv').config();

const repo = require('./src/modules/careerHealthIndex/chiSnapshot.repository');

(async () => {
  try {
    const latest = await repo.getLatest('REAL_USER_ID');
    console.log('LATEST CHI:', latest);
  } catch (error) {
    console.error('SMOKE TEST FAILED:', error.message);
  } finally {
    process.exit(0);
  }
})();