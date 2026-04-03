'use strict';

/**
 * src/modules/resume/controllers/resume.controller.js
 *
 * Production-ready Supabase-first controller.
 *
 * Improvements:
 * - Fully removes lazy per-request Supabase imports
 * - Eliminates Firestore-style batch update legacy pattern
 * - Replaces N+1 resume activation loop with 2 SQL updates
 * - Standardized auth/error responses
 * - Better null safety + payload validation
 * - Consistent conversion metadata flow
 * - Cleaner controller architecture
 * - Better production maintainability
 */

const { supabase } = require('../../../config/supabase');
const resumeService = require('../resume.service');
const { conversionNudgeService } = require('../../conversion');

function getUserId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

function unauthorized(res) {
  return res.status(401).json({
    success: false,
    message: 'Unauthorized'
  });
}

function badRequest(res, message) {
  return res.status(400).json({
    success: false,
    message
  });
}

async function safeGetNudge(userId) {
  try {
    return await conversionNudgeService.getNudge(userId);
  } catch (_) {
    return {
      intentScore: 0,
      engagementScore: 0,
      monetizationScore: 0,
      recommendedAction: 'show_profile_completion_prompt',
      nudgeMessage:
        'Complete your profile to unlock better career opportunities.',
      ruleId: 'fallback_safe'
    };
  }
}

function attachConversion(req, event, userId, metadata = {}) {
  req.conversionEvent = event;
  req.conversionMetadata = metadata;

  const uniquePart =
    metadata.resumeId ??
    metadata.jobId ??
    metadata.targetRole ??
    'unknown';

  req.conversionIdempotencyKey = `${userId}:${event}:${uniquePart}`;
}

/**
 * POST /api/v1/resumes
 */
async function uploadResume(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const file = req.file;
    if (!file) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'NO_FILE',
          message:
            'No file received. Please attach a PDF or DOCX resume file.'
        }
      });
    }

    const uploadResult = await resumeService.uploadResume(userId, file);

    attachConversion(req, 'resume_uploaded', userId, {
      resumeId: uploadResult.resumeId
    });

    const nudge = await safeGetNudge(userId);
    const jobId = uploadResult.jobId ?? uploadResult.resumeId;

    return res.status(201).json({
      success: true,
      data: {
        resume: {
          jobId,
          resumeId: uploadResult.resumeId,
          fileName: uploadResult.fileName,
          status: uploadResult.status ?? 'pending',
          pollUrl: `/api/v1/ai-jobs/${jobId}`,
          message:
            'Resume uploaded successfully. Processing has started.'
        }
      },
      meta: {
        conversion: nudge
      }
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/v1/resumes
 */
async function listResumes(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const result = await resumeService.listResumes(userId);

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/v1/resumes/:id
 */
async function getResume(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const resumeId = req.params?.id;
    if (!resumeId) return badRequest(res, 'resumeId is required');

    const result = await resumeService.getResume(userId, resumeId);

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * DELETE /api/v1/resumes/:id
 */
async function deleteResume(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const resumeId = req.params?.id;
    if (!resumeId) return badRequest(res, 'resumeId is required');

    await resumeService.deleteResume(userId, resumeId);

    return res.status(200).json({
      success: true,
      data: null
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/v1/resumes/score
 */
async function scoreResume(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const { resumeId } = req.body || {};
    if (!resumeId) return badRequest(res, 'resumeId is required');

    const scoreResult = await resumeService.scoreResume(
      userId,
      resumeId
    );

    attachConversion(req, 'resume_scored', userId, {
      resumeId,
      score: scoreResult?.score
    });

    const nudge = await safeGetNudge(userId);

    return res.status(200).json({
      success: true,
      data: {
        resume: scoreResult
      },
      meta: {
        conversion: nudge
      }
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/v1/resumes/growth
 */
async function analyzeResumeGrowth(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const { resumeId, targetRole } = req.body || {};
    if (!resumeId) return badRequest(res, 'resumeId is required');

    const result = await resumeService.analyzeResumeGrowth(userId, {
      resumeId,
      targetRole
    });

    attachConversion(req, 'resume_growth_analysed', userId, {
      resumeId,
      targetRole
    });

    const nudge = await safeGetNudge(userId);

    return res.status(200).json({
      success: true,
      data: {
        growth: result
      },
      meta: {
        conversion: nudge
      }
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/v1/resumes/:resumeId/refresh-url
 */
async function refreshSignedUrl(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const resumeId = req.params?.resumeId;
    if (!resumeId) return badRequest(res, 'resumeId is required');

    const result = await resumeService.refreshSignedUrl(
      userId,
      resumeId
    );

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/v1/resumes/set-active
 *
 * Supabase-optimized:
 * - No per-row Promise.all loop
 * - Uses 2 SQL updates only
 * - Much faster at scale
 */
async function setActiveResume(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const { resumeId } = req.body || {};
    if (!resumeId) return badRequest(res, 'resumeId is required');

    const { data: resumeRow, error: resumeError } = await supabase
      .from('resumes')
      .select('id')
      .eq('id', resumeId)
      .eq('userId', userId)
      .eq('softDeleted', false)
      .maybeSingle();

    if (resumeError) throw resumeError;

    if (!resumeRow) {
      return res.status(404).json({
        success: false,
        message: 'Resume not found'
      });
    }

    // deactivate all
    const { error: deactivateError } = await supabase
      .from('resumes')
      .update({
        isActive: false,
        updatedAt: new Date().toISOString()
      })
      .eq('userId', userId)
      .eq('softDeleted', false);

    if (deactivateError) throw deactivateError;

    // activate selected
    const { error: activateError } = await supabase
      .from('resumes')
      .update({
        isActive: true,
        updatedAt: new Date().toISOString()
      })
      .eq('id', resumeId)
      .eq('userId', userId);

    if (activateError) throw activateError;

    // update profile pointer
    const { error: userError } = await supabase
      .from('users')
      .update({
        latestResumeId: resumeId,
        updatedAt: new Date().toISOString()
      })
      .eq('id', userId);

    if (userError) throw userError;

    return res.status(200).json({
      success: true,
      data: {
        resumeId,
        message: 'Active resume updated successfully.'
      }
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/v1/resumes/:resumeId/rescore
 */
async function rescoreResume(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const resumeId = req.params?.resumeId;
    if (!resumeId) return badRequest(res, 'resumeId is required');

    const scoreResult = await resumeService.scoreResume(
      userId,
      resumeId
    );

    return res.status(200).json({
      success: true,
      data: {
        resume: scoreResult
      }
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  uploadResume,
  listResumes,
  getResume,
  deleteResume,
  scoreResume,
  rescoreResume,
  analyzeResumeGrowth,
  refreshSignedUrl,
  setActiveResume
};