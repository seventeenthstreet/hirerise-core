'use strict';

/**
 * jobMatch.service.js
 *
 * Changes in this version:
 *
 *   [1] saveJobMatchSnapshot() is now truly fire-and-forget.
 *       Previous version called `await saveJobMatchSnapshot(...)` — blocking the
 *       response on a non-fatal write that the comment itself said shouldn't block.
 *       Fixed: snapshot is now kicked off without await. Errors still logged.
 *       API response returns immediately after engine completes.
 *
 *   [2] Free-tier operationType normalisation.
 *       If a free user sends operationType='jobSpecificCV', the service now
 *       explicitly runs the free engine (ignoring operationType entirely for free tier).
 *       This was implicitly safe before but is now explicit and documented.
 *       Free engine output shape always matches — premium fields are null regardless.
 *
 *   Everything else is unchanged from previous version.
 */

const { db }     = require('../../config/firebase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger     = require('../../utils/logger');

const { runJobMatchFree }                      = require('./engines/jobMatchFreeEngine');
const { runJobMatchAnalysis, runJobSpecificCV } = require('./engines/jobMatchPremiumEngine');
const { CREDIT_COSTS, isValidOperation }        = require('./analysis.constants');

// ─── Job title extractor ──────────────────────────────────────
// Lightweight heuristic — no AI, no external calls.
// Returns null cleanly if nothing found.

function extractJobTitle(jobDescription) {
  if (!jobDescription) return null;

  const text  = jobDescription.trim();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Pattern 1: First short line that isn't boilerplate
  if (lines[0] && lines[0].length > 3 && lines[0].length < 80) {
    const isBoilerplate = /^(we are|about us|job description|position|overview|role)/i.test(lines[0]);
    if (!isBoilerplate) return lines[0];
  }

  // Pattern 2: Explicit label — "Job Title: Senior Engineer"
  const labelMatch = text.match(/(?:role|position|job title|title)\s*[:\-]\s*(.{3,60})/i);
  if (labelMatch) return labelMatch[1].trim();

  // Pattern 3: Title-like keyword phrase in opening 300 chars
  const head    = text.slice(0, 300);
  const titleRe = /\b(Senior|Junior|Lead|Principal|Staff|Head of|Director of|Manager|Engineer|Developer|Analyst|Consultant|Specialist|Designer|Architect)\b.{0,40}/i;
  const kwMatch = head.match(titleRe);
  if (kwMatch) return kwMatch[0].trim().slice(0, 60);

  return null;
}

// ─── Lightweight snapshot save (fire-and-forget) ─────────────
// Stores ONLY dashboard-required fields. Full result stays in API response.
//
// FIRE-AND-FORGET: called without await — does not block API response.
// Errors are logged but cannot propagate to the caller.
// Snapshot is convenience data for dashboard — its absence never
// breaks the analysis flow. hasAnalyzedBefore simply stays false
// until the next successful write.

function saveJobMatchSnapshot(userId, result, jobDescription) {
  const jobTitle = extractJobTitle(jobDescription);

  db.collection('jobMatchAnalyses').add({
    userId,
    matchScore: result.matchScore ?? null,
    jobTitle,                        // null if not extractable — acceptable
    engine:     result.engine,
    analyzedAt: new Date(),          // field name matches dashboard query order
  }).then(() => {
    logger.debug('[JobMatchService] Snapshot saved', {
      userId, matchScore: result.matchScore, jobTitle,
    });
  }).catch(err => {
    // Non-fatal — log only, never rethrow
    logger.warn('[JobMatchService] Snapshot save failed (non-fatal)', {
      userId, error: err.message,
    });
  });
  // No return — intentionally fire-and-forget
}

// ─── Fetch and validate resume ────────────────────────────────

async function fetchResume(userId, resumeId) {
  const doc = await db.collection('resumes').doc(resumeId).get();

  if (!doc.exists) {
    throw new AppError('Resume not found.', 404, { resumeId }, ErrorCodes.NOT_FOUND);
  }

  const data = doc.data();

  if (data.userId !== userId) {
    throw new AppError('Unauthorized.', 403, { resumeId }, ErrorCodes.UNAUTHORIZED);
  }

  if (!data.resumeText || data.resumeText.trim().length < 50) {
    throw new AppError(
      'Resume text is too short or missing.',
      422, { resumeId }, ErrorCodes.VALIDATION_ERROR
    );
  }

  return data;
}

// ─── Atomic credit deduction ──────────────────────────────────
// Throws AppError(402) inside transaction if credits insufficient.
// Returns { creditsRemaining } from inside the committed transaction —
// no second read needed.

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

  logger.info('[JobMatchService] Credits deducted', { userId, amount, creditsAfter });
  return { creditsRemaining: creditsAfter };
}

// ─── Safe refund ──────────────────────────────────────────────
// Only called when deductionSucceeded === true.
// Transactional. Failure logged as CRITICAL for manual reconciliation.

async function refundCredits(userId, amount) {
  try {
    const ref = db.collection('users').doc(userId);
    await db.runTransaction(async (txn) => {
      const doc = await txn.get(ref);
      if (!doc.exists) return;
      const current = doc.data().aiCreditsRemaining ?? 0;
      txn.update(ref, { aiCreditsRemaining: current + amount, updatedAt: new Date() });
    });
    logger.info('[JobMatchService] Credits refunded', { userId, amount });
  } catch (err) {
    logger.error('[JobMatchService] CRITICAL: Refund failed — manual reconciliation required', {
      userId, amount, error: err.message,
    });
  }
}

// ─── Main orchestrator ────────────────────────────────────────

async function runJobMatch({ userId, resumeId, jobDescription, operationType, personalDetails }) {

  if (!jobDescription || jobDescription.trim().length < 50) {
    throw new AppError(
      'Job description is too short. Paste the full JD for accurate analysis.',
      400, {}, ErrorCodes.VALIDATION_ERROR
    );
  }

  logger.info('[JobMatchService] Start', { userId, resumeId, operationType });

  const [user, resumeData] = await Promise.all([
    db.collection('users').doc(userId).get().then(d => {
      if (!d.exists) throw new AppError('User not found.', 404, {}, ErrorCodes.NOT_FOUND);
      return d.data();
    }),
    fetchResume(userId, resumeId),
  ]);

  // ── Free tier ─────────────────────────────────────────────
  // operationType is IGNORED for free users — always runs free engine.
  // Free engine returns premium fields as null for frontend blurring.
  // Never calls Claude. Never deducts credits.

  if (user.tier === 'free') {
    logger.info('[JobMatchService] Free engine (operationType ignored for free tier)', { userId });

    const result = runJobMatchFree({
      resumeText:     resumeData.resumeText,
      jobDescription,
    });

    saveJobMatchSnapshot(userId, result, jobDescription); // fire-and-forget
    return result;
  }

  // ── Pro tier ──────────────────────────────────────────────
  // Validate operation type before touching credits
  if (!isValidOperation(operationType)) {
    throw new AppError(
      `Invalid operationType: ${operationType}`,
      400, {}, ErrorCodes.VALIDATION_ERROR
    );
  }

  const creditCost       = CREDIT_COSTS[operationType];
  let deductionSucceeded = false;
  let creditsRemaining;

  // Deduct BEFORE calling Claude — atomic, concurrency-safe
  const deduction    = await deductCredits(userId, creditCost);
  creditsRemaining   = deduction.creditsRemaining;
  deductionSucceeded = true;

  let result;
  try {
    result = operationType === 'jobMatchAnalysis'
      ? await runJobMatchAnalysis({
          resumeText: resumeData.resumeText,
          jobDescription,
        })
      : await runJobSpecificCV({
          resumeText:      resumeData.resumeText,
          jobDescription,
          personalDetails: personalDetails ?? resumeData.personalDetails ?? {},
        });
  } catch (engineErr) {
    if (deductionSucceeded) await refundCredits(userId, creditCost);
    throw engineErr;
  }

  saveJobMatchSnapshot(userId, result, jobDescription); // fire-and-forget

  logger.info('[JobMatchService] Complete', {
    userId, operationType, creditsRemaining, matchScore: result.matchScore,
  });

  return { ...result, creditsRemaining };
}

module.exports = { runJobMatch };