'use strict';

/**
 * src/modules/dev/dev.route.js
 *
 * Development-only authentication routes.
 *
 * SECURITY:
 * This module must never be usable in production.
 * Even if server.js accidentally mounts it, the route
 * self-protects and refuses registration.
 */

const express = require('express');
const devController = require('./dev.controller');

const router = express.Router();

/**
 * Defense-in-depth production guard.
 * Prevent accidental exposure of dev login endpoints.
 */
if (process.env.NODE_ENV === 'production') {
  throw new Error(
    '[DevRoute] Refusing to register development routes in production.'
  );
}

/**
 * POST /dev/login
 * Returns Supabase access + refresh token for local development.
 */
router.post('/login', devController.generateDevToken);

module.exports = router;