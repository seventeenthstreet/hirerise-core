'use strict';

/**
 * src/routes/users.routes.js
 *
 * Fully Supabase-native
 * Production-hardened
 *
 * PATCH: Early-304 short-circuit for GET /me
 *
 *   Before this patch:
 *     authenticate → full users query → subscriptions query → getRemainingQuota()
 *     → normalizeUser() → res.json() → Express hashes body → 304
 *     (all expensive work executed even for unchanged data)
 *
 *   After this patch:
 *     authenticate → lightweight metadata query (updated_at + subscription_status
 *     + tier + onboarding flags) → build ETag → compare If-None-Match
 *     → return 304 immediately if matched
 *     → ONLY THEN perform full hydration queries
 *
 *   ETag freshness token:
 *     `v1:${updated_at}:${subscription_status}:${tier}:${onboarding_completed}`
 *     - updated_at     — covers all PATCH /me writes (profile changes)
 *     - subscription_status / tier — covers plan upgrades / downgrades
 *     - onboarding_completed — covers onboarding completion events
 *     Deterministic and cheap: one Supabase query with 6 columns only.
 */

const express = require('express');
const crypto  = require('crypto');
const { body } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const { asyncHandler } = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const { updateUserProfile } = require('../services/users.service');
const { getRemainingUses } = require('../modules/analysis/analysis.constants');
const { getRemainingQuota } = require('../middleware/tierquota.middleware');
const supabase = require('../lib/supabaseClient');
const logger = require('../utils/logger');
const freshnessCache = require('../utils/freshnessCache');

const router = express.Router();

function getUserId(req) {
  const userId =
    req.user?.id ||
    req.user?.sub ||
    req.user?.uid ||
    req.auth?.userId ||
    req.user?.user_id ||
    null;
  if (!userId || typeof userId !== 'string') return null;
  return userId;
}

function buildDefaultProfile(reqUser, userId) {
  return {
    id: userId,
    email: reqUser.email || '',
    display_name: reqUser.name || null,
    tier: 'free',
    plan_amount: null,
    role: 'user',
    user_type: null,
    career_goal: null,
    target_role: null,
    location: null,
    experience_years: null,
    onboarding_completed: false,
    report_unlocked: false,
    resume_uploaded: false,
    subscription_status: 'inactive',
    subscription_provider: null,
    subscription_id: null,
    student_onboarding_complete: false,
    professional_onboarding_complete: false,
  };
}

function normalizeUser(row, reqUser, userId) {
  return {
    ...row,
    uid: row.id ?? userId,
    plan: reqUser.plan ?? row.tier ?? 'free',
    role: reqUser.role ?? row.role ?? null,
    admin: reqUser.admin ?? false,
    displayName: row.display_name ?? null,
    onboarding_completed: row.onboarding_completed ?? false,
    onboardingCompleted: row.onboarding_completed ?? false,
    reportUnlocked: row.report_unlocked ?? false,
    resumeUploaded: row.resume_uploaded ?? false,
    subscriptionStatus: row.subscription_status ?? 'inactive',
    subscriptionProvider: row.subscription_provider ?? null,
    subscriptionId: row.subscription_id ?? null,
    planAmount: row.plan_amount ?? null,
    targetRole: row.target_role ?? null,
    experienceYears: row.experience_years ?? null,
    careerGoal: row.career_goal ?? null,
    aiCreditsRemaining: 0,
    chiScore: null,
  };
}

// ─────────────────────────────────────────────────────────────
// ETag helpers  ── NEW
// ─────────────────────────────────────────────────────────────

/**
 * Fetch ONLY the lightweight metadata columns needed to build a freshness
 * token.  Deliberately narrow: must stay cheap because it runs on every
 * GET /me request including cache-hit (304) paths.
 *
 * Returns null when the row does not exist yet (first-login) or on any
 * transient DB error.  The caller falls through to full hydration in those
 * cases, which is safe.
 */
async function fetchUserFreshnessMetadata(userId, bypassCache = false) {
  const cacheKey = `user-me:${userId}`;

  // Phase 2 warm-path: check bounded in-memory cache before Supabase query.
  // Skip the cache when bypassCache=true (sent by clients with Cache-Control: no-cache).
  // This ensures post-login fetches always get a fresh response body, not a 304.
  if (!bypassCache) {
    const cached = freshnessCache.get(cacheKey);
    if (cached !== null) {
      return cached;
    }
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('updated_at,subscription_status,tier,onboarding_completed,student_onboarding_complete,professional_onboarding_complete')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      logger.warn('[UsersRoute] Freshness metadata query failed', { userId, err: error.message });
      return null;
    }

    // Only cache a valid non-null result — failed / empty queries must not
    // poison the cache.
    if (data !== null && data !== undefined) {
      freshnessCache.set(cacheKey, data);
    }

    return data ?? null;
  } catch (err) {
    logger.warn('[UsersRoute] Freshness metadata exception', { userId, err: err.message });
    return null;
  }
}

/**
 * Build a deterministic, opaque ETag from freshness metadata.
 *
 * The 'v' version key lets us rotate the schema by bumping it — all
 * outstanding client ETags with the old version will immediately miss.
 *
 * Returns a quoted ETag string e.g.  `"v1:a3f8c0d21b7e4f91"`
 */
function buildUserETag(meta) {
  const canonical = JSON.stringify({
    v: 1,
    u: meta.updated_at ?? '',
    s: meta.subscription_status ?? '',
    t: meta.tier ?? '',
    o: meta.onboarding_completed ?? false,
    so: meta.student_onboarding_complete ?? false,
    po: meta.professional_onboarding_complete ?? false,
  });
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `"v1:${hash}"`;
}

/**
 * Returns true when the client's If-None-Match header matches the
 * generated ETag — i.e. the resource is fresh and a 304 is correct.
 * Handles the W/ weak-validator prefix transparently.
 */
function isETagMatch(generatedETag, ifNoneMatchHeader) {
  if (!ifNoneMatchHeader) return false;
  return ifNoneMatchHeader.replace(/^W\//, '').trim() === generatedETag;
}

// ─────────────────────────────────────────────────────────────
// GET /me
// ─────────────────────────────────────────────────────────────
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required. Provide a valid Bearer token.',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    // ── EARLY-304 SHORT-CIRCUIT ────────────────────────────────────────
    // Auth already verified above.  Now: cheap metadata query → ETag compare
    // → immediate 304 if unchanged, skipping all expensive hydration below.
    //
    // null means first-login (no row yet) or transient error — both fall
    // through safely to full hydration.
    // CACHE-BYPASS FIX: When the client sends Cache-Control: no-cache (set by
    // fetchUser on 'initial'/'login' sources), skip both the in-memory
    // freshnessCache AND the ETag/304 path. This guarantees a full 200 response
    // body after login — the browser's cached ETag must not produce a 304 that
    // fetchUser misinterprets as "no user profile", which would null the user
    // state and loop the app back to /direction even for users with a type set.
    const bypassCache = req.headers['cache-control'] === 'no-cache';

    const meta = await fetchUserFreshnessMetadata(userId, bypassCache);

    if (!bypassCache && meta !== null) {
      const etag = buildUserETag(meta);

      if (isETagMatch(etag, req.headers['if-none-match'])) {
        logger.debug('[UsersRoute] GET /me early 304', { userId });
        res.set('ETag', etag);
        return res.status(304).end();
      }

      // ETag mismatch → attach to 200 response built below.
      res.set('ETag', etag);
    }
    // ── END EARLY-304 ─────────────────────────────────────────────────

    // ── FULL HYDRATION (only runs when data has actually changed) ──────

    let { data: row, error } = await supabase
      .from('users')
      .select(`
        id,email,display_name,role,user_type,career_goal,
        onboarding_completed,target_role,experience_years,location,
        tier,plan_amount,report_unlocked,resume_uploaded,
        subscription_id,subscription_provider,subscription_status,
        student_onboarding_complete,professional_onboarding_complete,
        created_at,updated_at
      `)
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      throw new AppError(error.message, ErrorCodes.INTERNAL_ERROR, 500, { code: error.code });
    }

    if (!row) {
      logger.info('[UsersRoute] First login — creating default profile', { userId });
      const defaultProfile = buildDefaultProfile(req.user, userId);

      const { data: newRow, error: upsertErr } = await supabase
        .from('users')
        .upsert(defaultProfile, { onConflict: 'id', ignoreDuplicates: false })
        .select(`
          id,email,display_name,role,user_type,career_goal,
          onboarding_completed,target_role,experience_years,location,
          tier,plan_amount,report_unlocked,resume_uploaded,
          subscription_id,subscription_provider,subscription_status,
          student_onboarding_complete,professional_onboarding_complete,
          created_at,updated_at
        `)
        .maybeSingle();

      if (upsertErr) {
        const isDuplicateEmail =
          upsertErr.code === '23505' &&
          upsertErr.message?.includes('users_email_key');

        if (isDuplicateEmail && defaultProfile.email) {
          logger.warn('[UsersRoute] Duplicate email on upsert — repairing stale ID to match Auth UUID', {
            userId, email: defaultProfile.email,
          });

          // The users table has a row for this email but with a different UUID
          // (stale from a previous signup). Update the ID to match the current
          // Supabase Auth UUID so all subsequent lookups by userId resolve correctly.
          const { data: repairedRow, error: repairErr } = await supabase
            .from('users')
            .update({ id: userId, updated_at: new Date().toISOString() })
            .eq('email', defaultProfile.email)
            .select(`
              id,email,display_name,role,user_type,career_goal,
              onboarding_completed,target_role,experience_years,location,
              tier,plan_amount,report_unlocked,resume_uploaded,
              subscription_id,subscription_provider,subscription_status,
              student_onboarding_complete,professional_onboarding_complete,
              created_at,updated_at
            `)
            .maybeSingle();

          if (repairErr || !repairedRow) {
            // Repair failed — fall back to read-only fetch so the user can
            // still log in, but log loudly so the data issue is visible.
            logger.error('[UsersRoute] ID repair failed — falling back to fetch by email', {
              userId, email: defaultProfile.email, error: repairErr?.message,
            });
            const { data: existingRow, error: fetchErr } = await supabase
              .from('users')
              .select(`
                id,email,display_name,role,user_type,career_goal,
                onboarding_completed,target_role,experience_years,location,
                tier,plan_amount,report_unlocked,resume_uploaded,
                subscription_id,subscription_provider,subscription_status,
                student_onboarding_complete,professional_onboarding_complete,
                created_at,updated_at
              `)
              .eq('email', defaultProfile.email)
              .maybeSingle();
            if (fetchErr || !existingRow) {
              throw new AppError(upsertErr.message, ErrorCodes.INTERNAL_ERROR, 500, { code: upsertErr.code });
            }
            row = existingRow;
          } else {
            logger.info('[UsersRoute] Stale ID repaired successfully', { userId, email: defaultProfile.email });
            row = repairedRow;
          }
        } else {
          throw new AppError(upsertErr.message, ErrorCodes.INTERNAL_ERROR, 500, { code: upsertErr.code });
        }
      } else {
        row = newRow ?? defaultProfile;
      }
    }

    if (!row) {
      logger.error('[UsersRoute] row is null after fetch/upsert — returning minimal profile', { userId });
      row = buildDefaultProfile(req.user, userId);
    }

    const userDoc = normalizeUser(row, req.user, userId);
    let subscriptionStatus = row.subscription_status ?? 'inactive';

    try {
      const { data: subRow } = await supabase
        .from('subscriptions')
        .select('status, tier')
        .eq('user_id', userId)
        .maybeSingle();
      if (subRow?.status) subscriptionStatus = subRow.status;
    } catch (err) {
      logger.warn('[UsersRoute] Subscription table query failed', { userId, reason: err.message });
    }

    let quota = null;
    try {
      quota = await Promise.race([
        Promise.resolve(getRemainingQuota(userId, req.user.plan)).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
    } catch {
      quota = null;
    }

    return res.json({
      success: true,
      data: {
        user: { ...userDoc, subscriptionStatus },
        credits: {
          remaining: 0,
          remainingUses: getRemainingUses(userDoc) ?? null,
        },
        quota: {
          remaining: quota,
          resetDate: null,
        },
      },
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// PATCH /me
// ─────────────────────────────────────────────────────────────
const PATCH_ALLOWED_KEYS = new Set([
  'name', 'location', 'experienceYears', 'targetRole',
  'bio', 'user_type', 'careerGoal',
]);

router.patch(
  '/me',
  validate([
    body().custom((payload) => {
      const unknown = Object.keys(payload).filter((k) => !PATCH_ALLOWED_KEYS.has(k));
      if (unknown.length) throw new Error(`Unknown field(s): ${unknown.join(', ')}`);
      return true;
    }),
    body('name').optional().isString().trim().isLength({ max: 100 }),
    body('location').optional().isString().trim().isLength({ max: 100 }),
    body('experienceYears').optional().isFloat({ min: 0, max: 50 }).toFloat(),
    body('targetRole').optional().isString().trim().isLength({ max: 100 }),
    body('bio').optional().isString().trim().isLength({ max: 500 }),
    body('careerGoal').optional().isString().trim().isLength({ max: 200 }),
    body('user_type').optional().isIn(['student', 'professional']),
  ]),
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required. Provide a valid Bearer token.' },
        meta: { timestamp: new Date().toISOString() },
      });
    }
    logger.info('[UsersRoute] PATCH /me', { userId, fields: Object.keys(req.body) });
    const updatedUser = await updateUserProfile(userId, req.body);
    // Phase 2: invalidate freshness cache so the next GET /me sees updated data.
    freshnessCache.del(`user-me:${userId}`);
    freshnessCache.del(`app-entry:${userId}`);
    return res.json({ success: true, data: updatedUser });
  }),
);

// ─────────────────────────────────────────────────────────────
// GET /me/subscription
// ─────────────────────────────────────────────────────────────
router.get(
  '/me/subscription',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required. Provide a valid Bearer token.' },
        meta: { timestamp: new Date().toISOString() },
      });
    }
    const { data, error } = await supabase
      .from('subscriptions').select('*').eq('user_id', userId).maybeSingle();
    if (error) {
      throw new AppError(error.message, ErrorCodes.INTERNAL_ERROR, 500, { code: error.code });
    }
    return res.json({ success: true, data: data ?? null });
  }),
);

module.exports = router;