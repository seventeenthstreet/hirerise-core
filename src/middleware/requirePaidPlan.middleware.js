'use strict';

/**
 * requirePaidPlan.middleware.js
 *
 * MIGRATION: Removed require('../config/supabase'). The Supabase Admin client
 * for claim backfill was already inline in this file — consolidated it to use
 * the shared config/supabase singleton instead of spinning up a second client.
 *
 * DB change in the Supabase fallback path:
 *   OLD: db.collection('users').doc(req.user.uid).get()
 *        → userSnap.data()?.tier ?? userSnap.data()?.plan
 *   NEW: supabase.from('users').select('tier, plan').eq('id', uid).maybeSingle()
 *        → data?.tier ?? data?.plan
 *
 * Claim backfill change:
 *   OLD: separate createClient() inside this file
 *   NEW: shared supabase singleton (already has service-role key, same behaviour)
 */

const supabase          = require('../config/supabase');
const { normalizeTier } = require('./requireTier.middleware');
const logger            = require('../utils/logger');

const PAID_TIERS = new Set(['pro', 'elite', 'enterprise', 'premium']);

async function requirePaidPlan(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
    });
  }

  // Admin bypass — never blocked by tier gates.
  const isAdmin =
    req.user.admin === true ||
    ['admin', 'super_admin'].includes(req.user.role ?? '') ||
    (req.user.roles ?? []).includes('admin');

  if (isAdmin) return next();

  // Step 1: try JWT claim first (no DB hit)
  const jwtTier = normalizeTier(req.user.plan);

  if (PAID_TIERS.has(jwtTier)) {
    req.user.normalizedTier = jwtTier;
    return next();
  }

  // Step 2: JWT claim is absent/free — check Supabase users table as fallback.
  try {
    const { data, error } = await supabase
      .from('users')
      .select('tier, plan')
      .eq('id', req.user.uid)
      .maybeSingle();

    if (error) throw error;

    const firestoreTier = normalizeTier(data?.tier ?? data?.plan ?? null);

    if (PAID_TIERS.has(firestoreTier)) {
      logger.info('[requirePaidPlan] JWT claim missing — DB tier grants access', {
        uid:  req.user.uid,
        firestoreTier,
        path: req.originalUrl,
      });

      req.user.plan           = firestoreTier;
      req.user.normalizedTier = firestoreTier;

      // Backfill Supabase Auth app_metadata so future requests use the JWT fast path.
      // Fire-and-forget — don't block the request.
      supabase.auth.admin.updateUserById(req.user.uid, {
        app_metadata: { ...(req.user.customClaims ?? {}), plan: firestoreTier },
      }).catch(err =>
        logger.warn('[requirePaidPlan] Supabase claim backfill failed (non-fatal)', {
          uid: req.user.uid, error: err.message,
        })
      );

      return next();
    }
  } catch (err) {
    logger.warn('[requirePaidPlan] DB tier lookup failed — defaulting to blocked', {
      uid:   req.user.uid,
      error: err.message,
      path:  req.originalUrl,
    });
  }

  // Both JWT and DB show free — block.
  logger.warn('[requirePaidPlan] Free user blocked from paid endpoint', {
    uid:  req.user.uid,
    tier: jwtTier,
    path: req.originalUrl,
  });

  return res.status(403).json({
    success: false,
    error: {
      code:    'PLAN_UPGRADE_REQUIRED',
      message: 'This feature requires a paid plan. Please upgrade to continue.',
    },
  });
}

module.exports = { requirePaidPlan };








