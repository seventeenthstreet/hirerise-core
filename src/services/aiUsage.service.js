'use strict';

/**
 * aiUsage.service.js
 *
 * Monthly AI usage metering and hard-cap enforcement.
 *
 * Limits (total monthly AI calls, all features combined):
 *   free:  5
 *   pro:   100
 *   elite: 500
 *
 * Fields managed on userProfiles/{userId}:
 *   monthlyAiUsageCount  {number}             — current month's call count
 *   aiUsageResetDate     {Firestore Timestamp} — date when counter resets
 *
 * Both fields are written server-side only. Firestore security rules
 * must block client writes to userProfiles.
 *
 * CALL PATTERN in route handlers:
 *   // Before the AI call:
 *   await aiUsageService.checkAndIncrement(userId, tier);
 *
 *   // After the AI call completes (fire-and-forget):
 *   aiUsageService.logAiCall({ userId, feature, model, success, errorCode }).catch(() => {});
 */
const {
  db,
  FieldValue,
  Timestamp
} = require('../config/supabase');
const {
  AppError
} = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// ─── Monthly limits per tier ────────────────────────────────────────────────

const MONTHLY_LIMITS = {
  free: 5,
  pro: 100,
  elite: 500,
  enterprise: 500 // same cap as elite; override per-account if needed
};
const DEFAULT_LIMIT = 5; // used for any unknown tier

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Return midnight UTC on the first day of the month AFTER the given date.
 */
function nextResetDate(from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  return d;
}
function limitForTier(tier) {
  return MONTHLY_LIMITS[tier] ?? DEFAULT_LIMIT;
}

// ─── Core: check + increment (atomic Firestore transaction) ─────────────────

/**
 * checkAndIncrement(userId, tier)
 *
 * Must be called BEFORE the AI call.
 * Atomically:
 *   1. Reads userProfiles/{userId}
 *   2. If now >= aiUsageResetDate  → resets counter to 0 and advances date
 *   3. If count >= limit           → throws 429 AppError
 *   4. Increments counter by 1
 *
 * Fails OPEN on Firestore error — metering failure must not block users.
 */
async function checkAndIncrement(userId, tier) {
  // TODO: MANUAL MIGRATION REQUIRED — unrecognised chain: collection.doc
  const ref = db.collection('userProfiles').doc(userId);
  const limit = limitForTier(tier);
  const now = new Date();
  try {
    await db.runTransaction(async txn => {
      const snap = await txn.get(ref);
      let currentCount;
      let resetDate;
      if (!snap.exists) {
        currentCount = 0;
        resetDate = null;
      } else {
        const data = snap.data();
        currentCount = data.monthlyAiUsageCount ?? 0;
        resetDate = data.aiUsageResetDate ? typeof data.aiUsageResetDate === "string" ? new Date(data.aiUsageResetDate) : typeof data.aiUsageResetDate?.toDate === "function" ? data.aiUsageResetDate.toDate() : new Date(data.aiUsageResetDate) : null;
      }
      const needsReset = !resetDate || now >= resetDate;
      if (needsReset) {
        currentCount = 0;
      }
      if (currentCount >= limit) {
        const resetAt = resetDate ? resetDate.toISOString() : nextResetDate(now).toISOString();
        throw new AppError(`Monthly AI usage limit reached for your ${tier} plan. Resets on ${resetAt.slice(0, 10)}.`, 429, {
          monthlyLimit: limit,
          currentCount,
          tier,
          resetsAt: resetAt
        }, 'QUOTA_EXCEEDED');
      }
      const newCount = currentCount + 1;
      const newReset = needsReset ? Timestamp.fromDate(nextResetDate(now)) : snap.exists ? snap.data().aiUsageResetDate : Timestamp.fromDate(nextResetDate(now));
      const update = {
        monthlyAiUsageCount: newCount,
        aiUsageResetDate: newReset,
        updatedAt: FieldValue.serverTimestamp()
      };
      if (!snap.exists) {
        txn.set(ref, update, {
          merge: true
        });
      } else {
        txn.update(ref, update);
      }
    });
  } catch (err) {
    if (err instanceof AppError || err.errorCode === 'QUOTA_EXCEEDED') {
      throw err;
    }
    // Firestore failure — fail open, log loudly
    logger.error('[AiUsage] checkAndIncrement failed — failing open', {
      userId,
      tier,
      error: err.message
    });
  }
}

// ─── Fire-and-forget: log to ai_usage_logs collection ───────────────────────

/**
 * logAiCall(params)
 *
 * Non-blocking. Call without await. Swallows all errors silently.
 */
async function logAiCall({
  userId,
  feature,
  model,
  success,
  errorCode = null
}) {
  try {
    await supabase.from('ai_usage_logs').insert({
      userId,
      feature: feature ?? 'unknown',
      model: model ?? 'unknown',
      success: success ?? true,
      errorCode: errorCode ?? null,
      createdAt: FieldValue.serverTimestamp()
    });
  } catch (_err) {
    // Intentionally silent — logging must never affect main flow
  }
}
module.exports = {
  checkAndIncrement,
  logAiCall,
  limitForTier,
  MONTHLY_LIMITS
};