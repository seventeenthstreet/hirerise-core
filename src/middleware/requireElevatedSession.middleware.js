'use strict';

/**
 * src/middleware/requireElevatedSession.middleware.js
 *
 * WP-ADMIN-02C — Enterprise Admin Step-Up Authentication (TOTP)
 *
 * Additive middleware, separate from requireAdmin.middleware.js (not a
 * redesign of it — this WP's Certified Foundations explicitly forbid
 * redesigning existing authorization). Run AFTER authenticate + requireAdmin
 * on routes that should require a completed TOTP step-up, in addition to
 * the existing role check.
 *
 * FEATURE FLAG — ADMIN_MFA_ENFORCEMENT_ENABLED:
 *   Defaults to OFF ('false'). When off, this middleware is a no-op —
 *   existing admin routes behave exactly as they did before this WP, so
 *   deploying this code cannot lock anyone out of /admin.
 *
 *   This is a deliberate, conservative rollout choice: MFA enrollment for
 *   the account currently used across this program has not yet been tested
 *   end-to-end in a real browser (this was implemented in a sandboxed
 *   environment with no live Supabase session — see the Phase deliverable
 *   report). Flip ADMIN_MFA_ENFORCEMENT_ENABLED=true only after you have
 *   personally completed enrollment via the UI and confirmed a subsequent
 *   login correctly prompts for and accepts a TOTP code.
 *
 * Client contract: the frontend sends the elevated session token via the
 * X-Admin-Elevated-Session header (see hooks/useMfa.ts).
 */

const mfaService = require('../modules/admin/mfa/mfa.service');
const logger = require('../utils/logger');

function isEnforcementEnabled() {
  return String(process.env.ADMIN_MFA_ENFORCEMENT_ENABLED || 'false').toLowerCase() === 'true';
}

async function requireElevatedSession(req, res, next) {
  if (!isEnforcementEnabled()) {
    return next();
  }

  try {
    const token = req.headers['x-admin-elevated-session'];
    const uid = req.user?.id;

    if (!uid) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    const result = await mfaService.touchElevatedSession(uid, token);

    if (!result.valid) {
      return res.status(428).json({
        success: false,
        error: 'Step-up authentication required.',
        code: 'MFA_STEP_UP_REQUIRED',
        reason: result.reason,
      });
    }

    next();
  } catch (err) {
    logger.error('[requireElevatedSession] error', { error: err.message });
    res.status(500).json({ success: false, error: 'Elevated session check failed.' });
  }
}

module.exports = { requireElevatedSession, isEnforcementEnabled };
