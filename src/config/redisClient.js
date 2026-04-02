'use strict';

const { createClient } = require('redis');
const logger = require('../utils/logger');

const client = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

client.on('error', (err) => {
  logger.error('[Redis] Error', { error: err.message });
});

client.on('connect', () => {
  logger.info('[Redis] Connected');
});

async function connectRedis() {
  if (!client.isOpen) {
    await client.connect();
  }
}

module.exports = {
  redis: client,
  connectRedis,
};