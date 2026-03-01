'use strict';

/**
 * careerHealthIndex.controller.js
 *
 * CHANGE LOG:
 *   - Imported applyTierFilter and applyHistoryTierFilter from tier.filter.js
 *   - Each handler reads req.user.plan and filters the service result
 *     before sending to the client.
 *   - Service layer, AI calls, and Firestore writes are completely unchanged.
 *   - Full snapshot is still persisted — filtering is response-only.
 */

const chiService = require('../careerHealthIndex.service');
const { applyTierFilter, applyHistoryTierFilter } = require('../../../utils/tier.filter'); // adjust path if needed

function _safeUserId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

function _userPlan(req) {
  return req?.user?.plan ?? 'free'; // defensive default
}

// POST /api/v1/career-health/calculate
async function calculateChi(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { resumeId } = req.body;
    const result = await chiService.calculateChi(userId, resumeId || null);

    // ── Tier filter ─────────────────────────────────────────────────────────
    const filtered = applyTierFilter(result, _userPlan(req));

    return res.status(200).json({ success: true, data: { careerHealth: filtered } });
  } catch (err) { return next(err); }
}

// GET /api/v1/career-health/latest
async function getLatestChi(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const result = await chiService.getLatestChi(userId);

    // ── Tier filter ─────────────────────────────────────────────────────────
    const filtered = applyTierFilter(result, _userPlan(req));

    return res.status(200).json({ success: true, data: { careerHealth: filtered } });
  } catch (err) { return next(err); }
}

// GET /api/v1/career-health/history
async function getChiHistory(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const limit  = parseInt(req.query.limit || '6', 10);
    const result = await chiService.getChiHistory(userId, limit);

    // ── Tier filter — applied per history entry ─────────────────────────────
    const plan           = _userPlan(req);
    const filteredHistory = result.history.map(entry =>
      applyHistoryTierFilter(entry, plan)
    );

    return res.status(200).json({
      success: true,
      data: {
        ...result,
        history: filteredHistory,
        _plan: plan,
      },
    });
  } catch (err) { return next(err); }
}

// GET /api/v1/career-health/provisional
// Returns the latest CHI snapshot with analysisSource === 'provisional'.
// Used by the frontend to differentiate "based on your profile" (provisional)
// from "based on your resume" (full analysis).
async function getProvisionalChi(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { db } = require('../../../config/firebase');
    const snap = await db.collection('careerHealthIndex')
      .where('userId',         '==', userId)
      .where('analysisSource', '==', 'provisional')
      .where('softDeleted',    '==', false)
      .orderBy('generatedAt', 'desc')
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ success: false, message: 'No provisional CHI found.' });
    }

    const filtered = applyTierFilter(snap.docs[0].data(), _userPlan(req));
    return res.status(200).json({ success: true, data: { careerHealth: filtered } });
  } catch (err) { return next(err); }
}

module.exports = { calculateChi, getLatestChi, getChiHistory, getProvisionalChi };