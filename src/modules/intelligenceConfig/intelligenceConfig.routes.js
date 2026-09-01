'use strict';

/**
 * @file src/modules/intelligenceConfig/intelligenceConfig.routes.js
 *
 * WP-ADMIN-INTEL-04 — ordinary, non-secret Intelligence configuration
 * administration routes.
 *
 * Security:
 * - Mounted behind `authenticate, requireMasterAdmin` in server.js — the
 *   same hardened boundary (WP-ADMIN-INTEL-02) as
 *   /admin/intelligence/secrets, /admin/secrets, and
 *   /admin/market-intelligence. Not re-declared here, matching those
 *   routers' own convention (auth applied once, at mount).
 * - Mutating routes (PUT, DELETE) apply `intelligenceConfigMutationRateLimit`
 *   (10/hour/admin UID) — mirrors the secretsMutationRateLimit precedent
 *   WP-ADMIN-INTEL-03 established for admin-driven Intelligence writes.
 * - `:key` is validated server-side against a fixed definitions registry
 *   (intelligenceConfig.definitions.js) — never used to read/write an
 *   arbitrary configuration key or table row.
 * - This router never returns a secret value; it only ever reads/writes
 *   public.intelligence_config_overrides, which cannot hold
 *   secret-classified settings (see that table's migration doc comment).
 */

const express = require('express');
const router = express.Router();

const controller = require('./intelligenceConfig.controller');
const { intelligenceConfigMutationRateLimit } = require('../../middleware/adminRateLimit.middleware');

router.get('/', controller.list);
router.get('/:key', controller.getOne);
router.put('/:key', intelligenceConfigMutationRateLimit, controller.update);
router.delete('/:key', intelligenceConfigMutationRateLimit, controller.reset);

module.exports = router;
