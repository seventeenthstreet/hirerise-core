'use strict';

/**
 * src/services/userVector.utils.js
 *
 * Utility re-export for userVector data-access functions.
 *
 * *.service.js files cannot import userVector.service directly per governance
 * Doc 08 — Dependency Rules. This utility wrapper is the governed boundary
 * crossing point for consumers that need vector reads/writes.
 */

const { getUserVector, updateUserVector } = require('./userVector.service');

module.exports = { getUserVector, updateUserVector };
