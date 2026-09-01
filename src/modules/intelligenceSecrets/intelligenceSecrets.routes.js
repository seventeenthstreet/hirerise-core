'use strict';

/**
 * @file src/modules/intelligenceSecrets/intelligenceSecrets.routes.js
 *
 * WP-ADMIN-INTEL-03 — Intelligence provider secret administration routes.
 *
 * Security:
 * - Mounted behind `authenticate, requireMasterAdmin` in server.js — same
 *   hardened boundary (WP-ADMIN-INTEL-02) as /admin/secrets and
 *   /admin/market-intelligence. Not re-declared here, matching the
 *   existing secrets.routes.js convention (auth applied once, at mount).
 * - Mutating routes (POST, DELETE) reuse the existing
 *   `secretsMutationRateLimit` (10/hour/admin UID) — the same limiter the
 *   canonical Secrets Manager's own mutation routes use — rather than
 *   introducing a second rate-limiting instance for what is, underneath,
 *   the same kind of write (an admin_secrets upsert/delete).
 * - `:provider` is validated server-side against a fixed registry
 *   (intelligenceSecrets.config.js) — never used to construct an arbitrary
 *   secret name.
 */

const express = require('express');
const router = express.Router();

const controller = require('./intelligenceSecrets.controller');
const { secretsMutationRateLimit } = require('../../middleware/adminRateLimit.middleware');

router.get('/', controller.list);
router.get('/:provider/status', controller.getStatus);
router.post('/:provider', secretsMutationRateLimit, controller.createOrUpdate);
router.delete('/:provider', secretsMutationRateLimit, controller.deleteProvider);

module.exports = router;
