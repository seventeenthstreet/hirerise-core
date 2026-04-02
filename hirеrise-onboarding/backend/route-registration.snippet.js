'use strict';

/**
 * route-registration.snippet.js (Firebase REMOVED)
 * ================================================
 *
 * This version uses your central auth middleware (Supabase / JWT based).
 *
 * Replace ALL Firebase auth usage with:
 *   requireAuth
 *
 * Ensure this middleware validates:
 *   - JWT access token
 *   - user session
 *   - attaches req.user
 */

// Import your auth middleware (adjust path if needed)
const { requireAuth } = require('./middleware/auth.middleware');

// --- EXISTING ROUTES ---
// app.use('/api/v1/onboarding', requireAuth, onboardingRoutes);
// ... other existing routes ...

// --- UPDATED USERS ROUTE ---
app.use('/api/v1/users', requireAuth, require('./routes/users.routes'));

// --- NEW: Dual Onboarding System ---
app.use('/api/v1/student-onboarding', requireAuth, require('./routes/student-onboarding.routes'));
app.use('/api/v1/career-onboarding', requireAuth, require('./routes/career-onboarding.routes'));