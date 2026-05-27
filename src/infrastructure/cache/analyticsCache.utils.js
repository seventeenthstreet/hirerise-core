'use strict';

/**
 * src/infrastructure/cache/analyticsCache.utils.js
 *
 * Utility re-export for analyticsCache infrastructure primitive.
 *
 * *.service.js files cannot import analyticsCache.service directly per
 * governance Doc 08 — Dependency Rules. This utility wrapper is the
 * governed boundary crossing point for all service consumers.
 *
 * analyticsCache.service is an infrastructure primitive (Redis key-value
 * cache facade), not a domain service. This wrapper makes that explicit.
 */

const analyticsCache = require('./analyticsCache.service');

module.exports = analyticsCache;
