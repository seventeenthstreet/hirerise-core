'use strict';

/**
 * src/core/infrastructure/locking/lock.utils.js
 *
 * Utility re-export for the distributed lock infrastructure primitive.
 *
 * *.service.js files cannot import lock.service directly per governance
 * Doc 08 — Dependency Rules. lock.service is an infrastructure primitive
 * (distributed locking), not a domain service.
 */

const lockService = require('./lock.service');

module.exports = lockService;
