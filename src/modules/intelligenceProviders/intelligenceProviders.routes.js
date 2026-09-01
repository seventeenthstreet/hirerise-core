'use strict';

/**
 * @file src/modules/intelligenceProviders/intelligenceProviders.routes.js
 *
 * WP-ADMIN-INTEL-06 — "Add Provider" administration routes.
 *
 * Security:
 * - Mounted behind `authenticate, requireMasterAdmin` in server.js — same
 *   hardened boundary as /admin/intelligence/secrets and
 *   /admin/intelligence/config. Not re-declared here, matching those
 *   routers' own convention (auth applied once, at mount).
 * - Mutating routes (POST, PATCH, DELETE) apply
 *   `intelligenceProviderMutationRateLimit` (10/hour/admin UID) — same
 *   conservative precedent as secretsMutationRateLimit /
 *   intelligenceConfigMutationRateLimit.
 * - `:providerKey` is validated server-side (intelligenceProviders
 *   .definitions.js's PROVIDER_KEY_REGEX + the BUILTIN_PROVIDER_KEYS
 *   exclusion) — never used to construct an arbitrary secret name or
 *   database key beyond that fixed shape.
 * - POST /:providerKey/credential never returns the submitted value —
 *   mirrors intelligenceSecrets.routes.js's POST /:provider exactly.
 */

const express = require('express');
const router = express.Router();

const controller = require('./intelligenceProviders.controller');
const { intelligenceProviderMutationRateLimit } = require('../../middleware/adminRateLimit.middleware');

router.get('/', controller.list);
router.get('/:providerKey', controller.getOne);
router.post('/', intelligenceProviderMutationRateLimit, controller.create);
router.patch('/:providerKey', intelligenceProviderMutationRateLimit, controller.update);
router.post('/:providerKey/credential', intelligenceProviderMutationRateLimit, controller.setCredential);
router.delete('/:providerKey', intelligenceProviderMutationRateLimit, controller.remove);

module.exports = router;
