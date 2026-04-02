'use strict';

const { redis } = require('../config/redisClient');
const logger = require('./logger');

const DEFAULT_TTL = 300; // 5 minutes

async function getCache(key) {
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.warn('[Cache] Get failed', { key, error: err.message });
    return null;
  }
}

async function setCache(key, value, ttl = DEFAULT_TTL) {
  try {
    await redis.setEx(key, ttl, JSON.stringify(value));
  } catch (err) {
    logger.warn('[Cache] Set failed', { key, error: err.message });
  }
}

module.exports = {
  getCache,
  setCache,
};