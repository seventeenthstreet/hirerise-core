'use strict';

/**
 * coverLetter.service.js
 *
 * Orchestrates cover letter generation.
 *
 * CREDIT FLOW (mirrors jobMatch.service.js exactly):
 *   1. Verify tier — free users blocked at service level (route also blocks them)
 *   2. Deduct credits BEFORE calling Claude
 *   3. Call engine — refund on ANY failure
 *   4. Save to Firestore (non-fatal if save fails)
 *   5. Log usage to usageLogs (fire-and-forget, never blocks)
 *
 * FEATURE IDENTIFIER: 'cover_letter'
 * CREDIT COST: 2 credits (same as fullAnalysis — similar token usage)
 */

const { db }                   = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger                   = require('../../utils/logger');
const { generateCoverLetter }  = require('./engine/coverLetter.engine');

// Lazy require — safe if admin services not yet deployed
function getLogUsage() {
  try {
    return require('../services/admin/logUsageToFirestore').logUsageToFirestore;
  } catch {
    return async () => {}; // no-op fallback
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FEATURE_ID   = 'cover_letter';
const CREDIT_COST  = 2;
const FREE_TIERS   = new Set(['free']);

// ─── Credit helpers (identical pattern to jobMatch.service.js) ────────────────

async function deductCredits(userId, amount) {
  const ref = db.collection('users').doc(userId);
  let creditsAfter;

  await db.runTransaction(async (txn) => {
    const doc = await txn.get(ref);
    if (!doc.exists) throw new AppError('User not found.', 404, {}, ErrorCodes.NOT_FOUND);

    const current = doc.data().aiCreditsRemaining ?? 0;
    if (current < amount) {
      throw new AppError(
        'Insufficient AI credits. Please purchase a new plan.',
        402,
        { creditsRequired: amount, creditsAvailable: current },
        ErrorCodes.PAYMENT_REQUIRED
      );
    }

    creditsAfter = current - amount;
    txn.update(ref, { aiCreditsRemaining: creditsAfter, updatedAt: new Date() });
  });

  logger.debug('[CoverLetterService] Credits deducted', { userId, amount, creditsAfter });
  return { creditsRemaining: creditsAfter };
}

async function refundCredits(userId, amount) {
  try {
    const ref = db.collection('users').doc(userId);
    await db.runTransaction(async (txn) => {
      const doc     = await txn.get(ref);
      if (!doc.exists) return;
      const current = doc.data().aiCreditsRemaining ?? 0;
      txn.update(ref, { aiCreditsRemaining: current + amount, updatedAt: new Date() });
    });
    logger.debug('[CoverLetterService] Credits refunded', { userId, amount });
  } catch (err) {
    logger.error('[CoverLetterService] CRITICAL: Refund failed — manual reconciliation required', {
      userId, amount, error: err.message,
    });
  }
}

// ─── Save to Firestore ────────────────────────────────────────────────────────

async function saveCoverLetter(userId, payload, content) {
  try {
    const ref = await db.collection('coverLetters').add({
      userId,
      companyName:    payload.companyName,
      jobTitle:       payload.jobTitle,
      jobDescription: payload.jobDescription,
      tone:           payload.tone ?? 'professional',
      content,
      createdAt:      new Date(),
    });
    logger.debug('[CoverLetterService] Saved to Firestore', { userId, docId: ref.id });
    return ref.id;
  } catch (err) {
    // Non-fatal — user gets their cover letter even if save fails
    logger.warn('[CoverLetterService] Save failed (non-fatal)', { userId, error: err.message });
    return null;
  }
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

/**
 * generateCoverLetterForUser({ userId, tier, planAmount, companyName, jobTitle, jobDescription, tone })
 *
 * @returns {{ content: string, coverLetterId: string|null, creditsRemaining: number }}
 */
async function generateCoverLetterForUser({ userId, tier, planAmount, companyName, jobTitle, jobDescription, tone }) {

  // ── Tier gate — free users blocked ───────────────────────────────────────
  // Route's requirePaidTier middleware catches this first,
  // but service enforces it too as a safety net.
  if (FREE_TIERS.has(tier)) {
    throw new AppError(
      'Cover letter generation is a Pro feature. Upgrade your plan to access it.',
      403,
      { upgradeUrl: process.env.UPGRADE_URL ?? '/pricing' },
      ErrorCodes.FORBIDDEN
    );
  }

  logger.debug('[CoverLetterService] Start', { userId, companyName, jobTitle, tone });

  // ── Deduct credits BEFORE calling Claude ─────────────────────────────────
  let creditsRemaining;
  let deductionSucceeded = false;

  try {
    const deduction    = await deductCredits(userId, CREDIT_COST);
    creditsRemaining   = deduction.creditsRemaining;
    deductionSucceeded = true;
  } catch (err) {
    throw err; // PAYMENT_REQUIRED or NOT_FOUND — propagate as-is
  }

  // ── Call engine — refund on failure ──────────────────────────────────────
  let engineResult;
  try {
    engineResult = await generateCoverLetter({ userId, companyName, jobTitle, jobDescription, tone });
  } catch (err) {
    if (deductionSucceeded) await refundCredits(userId, CREDIT_COST);
    throw err;
  }

  // ── Save result (non-fatal) ───────────────────────────────────────────────
  const coverLetterId = await saveCoverLetter(userId, { companyName, jobTitle, jobDescription, tone }, engineResult.content);

  // ── Log usage — fire-and-forget, never blocks response ───────────────────
  const logUsage = getLogUsage();
  logUsage({
    userId,
    feature:      FEATURE_ID,
    tier,
    model:        engineResult.model,
    inputTokens:  engineResult.inputTokens,
    outputTokens: engineResult.outputTokens,
    planAmount:   planAmount ?? null,
  }).catch(() => {});

  logger.debug('[CoverLetterService] Complete', { userId, coverLetterId, creditsRemaining });

  return {
    content:        engineResult.content,
    coverLetterId,
    creditsRemaining,
  };
}

module.exports = { generateCoverLetterForUser, CREDIT_COST, FEATURE_ID };









