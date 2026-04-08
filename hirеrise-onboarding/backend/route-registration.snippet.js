'use strict';

/**
 * route-registration.snippet.js
 * ==================================================
 * Central API route registration
 * Supabase-native + JWT auth middleware
 *
 * Responsibilities:
 * - Register versioned API routes
 * - Reuse central requireAuth middleware
 * - Keep boot logic deterministic
 * - Preserve backward compatibility with existing imports
 */

const express = require('express');
const { requireAuth } = require('./middleware/auth.middleware');

// Route modules
const usersRoutes = require('./routes/users.routes');
const studentOnboardingRoutes = require('./routes/student-onboarding.routes');
const careerOnboardingRoutes = require('./routes/career-onboarding.routes');
const onboardingRoutes = require('./routes/onboarding.routes');

/**
 * Register all application routes.
 *
 * @param {import('express').Application} app
 */
function registerRoutes(app) {
  if (!app || typeof app.use !== 'function') {
    throw new TypeError('A valid Express app instance is required');
  }

  const apiV1Router = express.Router();

  // ─────────────────────────────────────────────────────────────
  // AUTHENTICATED ROUTES
  // ─────────────────────────────────────────────────────────────

  apiV1Router.use('/users', requireAuth, usersRoutes);

  apiV1Router.use('/onboarding', requireAuth, onboardingRoutes);

  // Dual onboarding system
  apiV1Router.use(
    '/student-onboarding',
    requireAuth,
    studentOnboardingRoutes
  );

  apiV1Router.use(
    '/career-onboarding',
    requireAuth,
    careerOnboardingRoutes
  );

  // Mount API v1
  app.use('/api/v1', apiV1Router);
}

module.exports = {
  registerRoutes,
};