'use strict';

// FIX: redisClient exports named functions (get, set, del, etc.), not a { redis } object.
// Importing { redis } previously yielded undefined, silently breaking all cache calls.
const redisClient = require('../config/redisClient');
const logger = require('./logger');

const DEFAULT_TTL = 300; // 5 minutes

async function getCache(key) {
  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.warn('[Cache] Get failed', { key, error: err.message });
    return null;
  }
}

async function setCache(key, value, ttl = DEFAULT_TTL) {
  try {
    // redisClient.set(key, value, ttlSeconds) — matches the unified API in redisClient.js
    await redisClient.set(key, value, ttl);
  } catch (err) {
    logger.warn('[Cache] Set failed', { key, error: err.message });
  }
}

module.exports = {
  getCache,
  setCache,
};
