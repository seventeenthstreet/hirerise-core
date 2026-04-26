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
const logger = require('../../../utils/logger');

// FIX: auth.middleware sets req.user.id as the canonical Supabase UID and
// req.user.uid as a legacy alias pointing to the same value.
// Prefer id first to match the canonical field; uid is a fallback for
// any legacy consumers that haven't migrated yet.
const { sendSuccess, sendError } = require('../../../shared/response');

function getUserId(req) {
  return req?.user?.id ?? req?.user?.uid ?? null;
}

// BEFORE: { success:false, message:'Unauthorized' }
// AFTER:  { success:false, error:'Unauthorized', message:'Unauthorized', code:'UNAUTHORIZED', meta:{...} }
function unauthorized(res) {
  return sendError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
}

// BEFORE: { success:false, message }
// AFTER:  { success:false, error:message, message, code:'VALIDATION_ERROR', meta:{...} }
function badRequest(res, message) {
  return sendError(res, 400, message, 'VALIDATION_ERROR');
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

    logger.info('[ResumeController] upload-cv request received', {
      userId,
      hasFile:      !!req.file,
      fileName:     req.file?.originalname ?? null,
      mimeType:     req.file?.mimetype     ?? null,
      sizeBytes:    req.file?.size         ?? null,
      contentType:  req.headers['content-type'],
    });

    const file = req.file;
    if (!file) {
      logger.warn('[ResumeController] No file in request', { userId });
      // BEFORE: { success:false, error:{ code, message } }
      // AFTER:  { success:false, error:'No resume file provided.', message:'...', code:'NO_FILE', meta:{...} }
      return sendError(res, 400, 'No resume file provided.', 'NO_FILE');
    }

    const uploadResult = await resumeService.uploadResume(userId, file);
    logger.info('[ResumeController] storage upload success', { userId, resumeId: uploadResult.resumeId, fileUrl: uploadResult.fileUrl });

    attachConversion(req, 'resume_uploaded', userId, {
      resumeId: uploadResult.resumeId
    });

    const nudge = await safeGetNudge(userId);
    const jobId = uploadResult.jobId ?? uploadResult.resumeId;

    logger.info('[ResumeController] response sent', { userId, resumeId: uploadResult.resumeId, jobId });

    return res.status(201).json({
      success: true,
      data: {
        resume: {
          // Task 2: explicit mode field — consumers must poll for results
          mode:     'async',
          jobId,
          resumeId: uploadResult.resumeId,
          fileName: uploadResult.fileName,
          status:   uploadResult.status ?? 'pending',
          // Task 5: explicit next-step instruction (additive — no existing fields removed)
          nextStep: `Poll GET /api/v1/resumes/${uploadResult.resumeId} for processing status and results.`,
          // CANONICAL polling URL — frontend MUST use this.
          // Always resolves by resumeId (stable, user-scoped).
          pollUrl:  `/api/v1/resumes/${uploadResult.resumeId}`,
          // @deprecated — retained for backward compatibility only.
          // This job-based URL is INTERNAL and must NOT be used by frontend.
          // It will be removed in a future release.
          // Use pollUrl (resume-based) instead.
          _legacyJobPollUrl: `/api/v1/ai-jobs/${jobId}`,
          message:  'Resume uploaded successfully. Processing has started.',
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
        resume: {
          // MODE CONTRACT: mode always present so frontend never infers flow from endpoint name
          mode: 'async',
          ...scoreResult,
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
      // BEFORE: { success:false, message:'Resume not found' }
      // AFTER:  { success:false, error:'Resume not found', message:'Resume not found', code:'NOT_FOUND', meta:{...} }
      return sendError(res, 404, 'Resume not found', 'NOT_FOUND', {
        message: 'Resume not found', // backward compat
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

    // BEFORE: { success:true, data:{ resumeId, message } }
    // AFTER:  { success:true, data:{ resumeId, message }, meta:{ timestamp, requestId } }
    return sendSuccess(res, { resumeId, message: 'Active resume updated successfully.' });
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
        resume: {
          // MODE CONTRACT: mode always present so frontend never infers flow from endpoint name
          mode: 'async',
          ...scoreResult,
        }
      }
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/v1/resumes/:resumeId/status
 *
 * Polling endpoint for async resume processing.
 * Frontend calls this after receiving mode === 'async' from uploadResume.
 *
 * Response shape (status: done):
 * { success:true, data:{ resume:{ mode:'async', resumeId, status:'done', result:{...}, updatedAt } } }
 *
 * Response shape (status: pending|processing):
 * { success:true, data:{ resume:{ mode:'async', resumeId, status, updatedAt } } }
 *
 * Response shape (status: failed):
 * { success:true, data:{ resume:{ mode:'async', resumeId, status:'failed', error:{code,message}, updatedAt } } }
 */
async function getResumeStatus(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const resumeId = req.params?.resumeId ?? req.params?.id;
    if (!resumeId) return badRequest(res, 'resumeId is required');

    const { data: record, error: fetchError } = await supabase
      .from('resumes')
      .select('id, status, score, processing_result, processing_error, updated_at')
      .eq('id', resumeId)
      .eq('userId', userId)
      .eq('softDeleted', false)
      .maybeSingle();

    if (fetchError) throw fetchError;

    if (!record) {
      return sendError(res, 404, 'Resume not found', 'NOT_FOUND');
    }

    const status = record.status ?? 'pending';

    return res.status(200).json({
      success: true,
      data: {
        resume: {
          // MODE CONTRACT: mode always present on polling endpoint —
          // frontend uses this to confirm it is in the async flow.
          mode:     'async',
          resumeId: record.id,
          status,
          // result only present when processing completed successfully
          ...(status === 'done'   && { result: record.processing_result ?? { score: record.score } }),
          // error only present when processing failed
          ...(status === 'failed' && { error: record.processing_error  ?? { code: 'PROCESSING_FAILED', message: 'Resume processing failed.' } }),
          updatedAt: record.updated_at,
        },
      },
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
  setActiveResume,
  getResumeStatus,   // NEW: polling endpoint handler (register on GET /api/v1/resumes/:resumeId/status)
};