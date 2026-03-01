'use strict';

/**
 * resume.controller.js
 *
 * Integration with Conversion Intelligence Layer.
 *
 * Rules:
 *  - Business logic lives in resumeService.
 *  - Controller sets req.conversionEvent.
 *  - Middleware handles recording after response.
 *  - Nudge failures never block resume functionality.
 */

const resumeService = require('../resume.service');
const {
  conversionNudgeService,
} = require('../../conversion');

function _safeUserId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

async function _safeGetNudge(userId) {
  try {
    return await conversionNudgeService.getNudge(userId);
  } catch {
    return {
      intentScore: 0,
      engagementScore: 0,
      monetizationScore: 0,
      recommendedAction: 'show_profile_completion_prompt',
      nudgeMessage:
        'Complete your profile to unlock better career opportunities.',
      ruleId: 'fallback_safe',
    };
  }
}

/**
 * POST /api/resume/score
 */
async function scoreResume(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { resumeId } = req.body;

    const scoreResult = await resumeService.scoreResume(userId, resumeId);

    // Inject conversion metadata for middleware
    req.conversionEvent = 'resume_scored';
    req.conversionMetadata = {
      resumeId,
      score: scoreResult.score,
    };
    req.conversionIdempotencyKey =
      `${userId}:resume_scored:${resumeId}`;

    const nudge = await _safeGetNudge(userId);

    return res.status(200).json({
      success: true,
      data: { resume: scoreResult },
      meta: {
        conversion: {
          intentScore: nudge.intentScore,
          engagementScore: nudge.engagementScore,
          monetizationScore: nudge.monetizationScore,
          recommendedAction: nudge.recommendedAction,
          nudgeMessage: nudge.nudgeMessage,
          ruleId: nudge.ruleId,
        },
      },
    });

  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/resume/upload
 */
async function uploadResume(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const file = req.file;

    const uploadResult = await resumeService.uploadResume(userId, file);

    req.conversionEvent = 'resume_uploaded';
    req.conversionMetadata = {
      resumeId: uploadResult.resumeId,
    };
    req.conversionIdempotencyKey =
      `${userId}:resume_uploaded:${uploadResult.resumeId}`;

    const nudge = await _safeGetNudge(userId);

    return res.status(201).json({
      success: true,
      data: { resume: uploadResult },
      meta: {
        conversion: {
          intentScore: nudge.intentScore,
          engagementScore: nudge.engagementScore,
          monetizationScore: nudge.monetizationScore,
          recommendedAction: nudge.recommendedAction,
          nudgeMessage: nudge.nudgeMessage,
          ruleId: nudge.ruleId,
        },
      },
    });

  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/resumes/growth
 */
async function analyzeResumeGrowth(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { resumeId, targetRole } = req.body;

    const result = await resumeService.analyzeResumeGrowth(userId, { resumeId, targetRole });

    req.conversionEvent            = 'resume_growth_analysed';
    req.conversionMetadata         = { resumeId, targetRole };
    req.conversionIdempotencyKey   = `${userId}:resume_growth:${resumeId}`;

    const nudge = await _safeGetNudge(userId);

    return res.status(200).json({
      success: true,
      data: { growth: result },
      meta: {
        conversion: {
          intentScore:       nudge.intentScore,
          engagementScore:   nudge.engagementScore,
          monetizationScore: nudge.monetizationScore,
          recommendedAction: nudge.recommendedAction,
          nudgeMessage:      nudge.nudgeMessage,
          ruleId:            nudge.ruleId,
        },
      },
    });

  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/resumes/:resumeId/refresh-url
 *
 * FIX G-03: Refreshes an expired or soon-to-expire Firebase Storage signed URL.
 *
 * The frontend should call this endpoint when:
 *   a) signedUrlExpiresAt is within 1 hour of expiry (proactive refresh)
 *   b) The CV download link returns 403 (reactive recovery)
 *   c) signedUrlExpiresAt field is missing (old documents pre-G-03 patch)
 *
 * Returns the new URL immediately. Safe to call when URL is still valid —
 * the service will no-op and return the existing URL.
 */
async function refreshSignedUrl(req, res, next) {
  try {
    const userId   = _safeUserId(req);
    const resumeId = req.params.resumeId;

    if (!userId)   return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (!resumeId) return res.status(400).json({ success: false, message: 'resumeId is required' });

    const result = await resumeService.refreshSignedUrl(userId, resumeId);

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  scoreResume,
  uploadResume,
  analyzeResumeGrowth,
  refreshSignedUrl,
};