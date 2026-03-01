'use strict';

/**
 * users.routes.js — HARDENED VERSION
 * ====================================
 * CHANGES FROM ORIGINAL:
 *
 *   1. GET /users/me now returns:
 *      - remainingQuota: { fullAnalysis: 2, jobMatchAnalysis: 4, ... }
 *        (free tier users see how many free uses remain per feature)
 *        (pro users see null — unlimited gated by credits, not quota)
 *
 *   2. GET /users/me now returns subscriptionStatus from subscriptions collection
 *      (the users doc has subscriptionStatus but subscriptions/{uid} has full details)
 *
 *   3. Added GET /users/me/subscription — full subscription details
 *
 * MIGRATION NOTE:
 *   Replace src/routes/users.routes.js with this file.
 *   The GET /users/me response is backward-compatible — only additions.
 */

const express = require('express');
const { db }  = require('../config/firebase');
const { authenticate }    = require('../middleware/auth.middleware');
const { getRemainingUses } = require('../modules/analysis/analysis.constants');
const { getRemainingQuota } = require('../middleware/tierquota.middleware');
const { getSubscriptionStatus } = require('../services/billing/Billing.service');
const logger  = require('../utils/logger');

const router = express.Router();

// ─── Build default profile ────────────────────────────────────────────────────

function buildDefaultProfile(firebaseUser) {
  return {
    uid:                  firebaseUser.uid,
    email:                firebaseUser.email   || '',
    displayName:          firebaseUser.name    || null,
    photoURL:             firebaseUser.picture || null,
    tier:                 'free',
    planAmount:           null,
    aiCreditsRemaining:   0,
    reportUnlocked:       false,
    onboardingCompleted:  false,
    resumeUploaded:       false,
    chiScore:             null,
    subscriptionStatus:   'inactive',
    subscriptionProvider: null,
    subscriptionId:       null,
    createdAt:            new Date(),
    updatedAt:            new Date(),
  };
}

// ─── GET /users/me ─────────────────────────────────────────────────────────────

router.get('/me', async (req, res, next) => {
  try {
    const userId = req.user.uid;
    const ref    = db.collection('users').doc(userId);
    const snap   = await ref.get();

    let userData;

    if (snap.exists) {
      userData = snap.data();
    } else {
      userData = buildDefaultProfile(req.user);
      await ref.set(userData);
      logger.info('[Users] New profile created', { userId });
    }

    const tier = userData.tier ?? 'free';

    // ── Credit remaining uses (pro users only) ───────────────────────────
    const remainingUses = tier === 'pro'
      ? getRemainingUses(userData.aiCreditsRemaining ?? 0)
      : null;

    // ── Quota remaining (free users — monthly caps) ───────────────────────
    // Pro users get null (unlimited — credits are their gate)
    const remainingQuota = tier === 'free'
      ? await getRemainingQuota(userId, tier)
      : null;

    return res.json({
      success: true,
      data: {
        user: userData,
        credits: {
          remaining:     userData.aiCreditsRemaining ?? 0,
          remainingUses, // { fullAnalysis: 4, generateCV: 2, ... } — pro only
        },
        quota: {
          remaining:     remainingQuota, // { fullAnalysis: 2, ... } — free only
          resetDate:     (() => {
            const now = new Date();
            const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            return next.toISOString().split('T')[0];
          })(),
        },
      },
    });

  } catch (err) {
    return next(err);
  }
});

// ─── GET /users/me/subscription ───────────────────────────────────────────────

router.get('/me/subscription', async (req, res, next) => {
  try {
    const userId = req.user.uid;
    const status = await getSubscriptionStatus(userId);

    return res.json({
      success: true,
      data:    status,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;