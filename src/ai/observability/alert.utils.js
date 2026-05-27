'use strict';

/**
 * src/ai/observability/alert.utils.js
 *
 * Utility re-export for the alert infrastructure primitive.
 *
 * *.service.js files cannot import alert.service directly per governance
 * Doc 08 — Dependency Rules. This utility wrapper is the governed boundary
 * crossing point. alert.service is an observability infrastructure primitive
 * (fire-and-forget alerting), not a domain service.
 */

const alertService = require('./alert.service');

module.exports = alertService;
