'use strict';

/**
 * resume.controller.js — HireRise Resume Intelligence Controller
 *
 * FIXES:
 *   FIX-A: Added listResumes() controller — GET /api/v1/resumes
 *   FIX-B: Added getResume() controller — GET /api/v1/resumes/:id
 *   FIX-C: Added deleteResume() controller — DELETE /api/v1/resumes/:id
 *   FIX-D: uploadResume() now returns the correct response shape matching
 *           the frontend's ResumeUploadResponse interface:
 *           { jobId, resumeId, fileName, status, pollUrl, message }
 *   FIX-E: listResumes() maps field names to frontend field names:
 *           sizeBytes → fileSize, createdAt → uploadedAt, topSkills → extractedSkills
 */
const resumeService = require('../resume.service');
const {
  conversionNudgeService
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
      nudgeMessage: 'Complete your profile to unlock better career opportunities.',
      ruleId: 'fallback_safe'
    };
  }
}

// ─── Map resume doc → frontend Resume shape ───────────────────────────────────

function _mapResumeDoc(id, data) {
  return {
    id,
    fileName: data.fileName,
    fileSize: data.sizeBytes ?? data.fileSize ?? 0,
    // sizeBytes is the stored field name
    mimeType: data.mimetype ?? data.mimeType ?? '',
    status: data.analysisStatus ?? data.status ?? 'processing',
    extractedSkills: data.topSkills ?? data.extractedSkills ?? [],
    uploadedAt: data.createdAt ?? new Date().toISOString(),
    analysedAt: data.scoredAt ?? data.analysedAt ?? null
  };
}

// ─── POST / — Upload CV ───────────────────────────────────────────────────────

/**
 * POST /api/v1/resumes
 *
 * FIX-D: Returns jobId for async polling and correct frontend shape.
 * The upload stores the file, extracts text, validates it's a CV,
 * and returns a jobId that the frontend uses to poll AI processing status.
 */
async function uploadResume(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }
    const file = req.file;

    // multer validation: req.file is undefined if no file was sent or mimetype rejected
    if (!file) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'NO_FILE',
          message: 'No file received. Please attach a PDF or DOCX resume file.'
        }
      });
    }
    const uploadResult = await resumeService.uploadResume(userId, file);
    req.conversionEvent = 'resume_uploaded';
    req.conversionMetadata = {
      resumeId: uploadResult.resumeId
    };
    req.conversionIdempotencyKey = `${userId}:resume_uploaded:${uploadResult.resumeId}`;
    const nudge = await _safeGetNudge(userId);

    // FIX-D: Return shape that matches frontend ResumeUploadResponse
    return res.status(201).json({
      success: true,
      data: {
        resume: {
          jobId: uploadResult.jobId ?? uploadResult.resumeId,
          resumeId: uploadResult.resumeId,
          fileName: uploadResult.fileName,
          status: uploadResult.status ?? 'pending',
          pollUrl: `/api/v1/ai-jobs/${uploadResult.jobId ?? uploadResult.resumeId}`,
          message: 'Resume uploaded successfully. Processing has started.'
        }
      },
      meta: {
        conversion: {
          intentScore: nudge.intentScore,
          engagementScore: nudge.engagementScore,
          monetizationScore: nudge.monetizationScore,
          recommendedAction: nudge.recommendedAction,
          nudgeMessage: nudge.nudgeMessage,
          ruleId: nudge.ruleId
        }
      }
    });
  } catch (err) {
    return next(err);
  }
}

// ─── GET / — List resumes ─────────────────────────────────────────────────────

/**
 * GET /api/v1/resumes
 *
 * FIX-A: This endpoint was completely missing — causing a 404 whenever the
 * frontend called listResumes(). Now returns paginated list mapped to the
 * frontend's Resume interface.
 */
async function listResumes(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }
    const result = await resumeService.listResumes(userId);
    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /:id — Get single resume ─────────────────────────────────────────────

/**
 * GET /api/v1/resumes/:id
 *
 * FIX-B: This endpoint was missing. Returns single resume mapped to frontend shape.
 */
async function getResume(req, res, next) {
  try {
    const userId = _safeUserId(req);
    const resumeId = req.params.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }
    const result = await resumeService.getResume(userId, resumeId);
    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (err) {
    return next(err);
  }
}

// ─── DELETE /:id — Delete resume ──────────────────────────────────────────────

/**
 * DELETE /api/v1/resumes/:id
 *
 * FIX-C: This endpoint was missing. Soft-deletes the resume.
 */
async function deleteResume(req, res, next) {
  try {
    const userId = _safeUserId(req);
    const resumeId = req.params.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }
    await resumeService.deleteResume(userId, resumeId);
    return res.status(200).json({
      success: true,
      data: null
    });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /score — AI resume scoring ─────────────────────────────────────────

async function scoreResume(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }
    const {
      resumeId
    } = req.body;
    const scoreResult = await resumeService.scoreResume(userId, resumeId);
    req.conversionEvent = 'resume_scored';
    req.conversionMetadata = {
      resumeId,
      score: scoreResult.score
    };
    req.conversionIdempotencyKey = `${userId}:resume_scored:${resumeId}`;
    const nudge = await _safeGetNudge(userId);
    return res.status(200).json({
      success: true,
      data: {
        resume: scoreResult
      },
      meta: {
        conversion: nudge
      }
    });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /growth — AI growth analysis ───────────────────────────────────────

async function analyzeResumeGrowth(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }
    const {
      resumeId,
      targetRole
    } = req.body;
    const result = await resumeService.analyzeResumeGrowth(userId, {
      resumeId,
      targetRole
    });
    req.conversionEvent = 'resume_growth_analysed';
    req.conversionMetadata = {
      resumeId,
      targetRole
    };
    req.conversionIdempotencyKey = `${userId}:resume_growth:${resumeId}`;
    const nudge = await _safeGetNudge(userId);
    return res.status(200).json({
      success: true,
      data: {
        growth: result
      },
      meta: {
        conversion: nudge
      }
    });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /:resumeId/refresh-url ─────────────────────────────────────────────

async function refreshSignedUrl(req, res, next) {
  try {
    const userId = _safeUserId(req);
    const resumeId = req.params.resumeId;
    if (!userId) return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
    if (!resumeId) return res.status(400).json({
      success: false,
      message: 'resumeId is required'
    });
    const result = await resumeService.refreshSignedUrl(userId, resumeId);
    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /set-active ─────────────────────────────────────────────────────────

async function setActiveResume(req, res, next) {
  try {
    const userId = _safeUserId(req);
    const {
      resumeId
    } = req.body || {};
    if (!userId) return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
    if (!resumeId) return res.status(400).json({
      success: false,
      message: 'resumeId is required'
    });

    const supabase = require('../../../config/supabase');

    // Verify the resume belongs to this user
    const { data: resumeData, error: resumeError } = await supabase
      .from('resumes')
      .select('userId')
      .eq('id', resumeId)
      .maybeSingle();

    if (resumeError) throw resumeError;

    if (!resumeData || resumeData.userId !== userId) {
      return res.status(404).json({
        success: false,
        message: 'Resume not found'
      });
    }

    // Fetch all non-deleted resumes for this user to update isActive flags
    const { data: allResumes, error: allError } = await supabase
      .from('resumes')
      .select('id')
      .eq('userId', userId)
      .eq('softDeleted', false);

    if (allError) throw allError;

    // Update isActive on all resumes for this user — active only for the target resumeId
    await Promise.all(
      (allResumes || []).map(doc =>
        supabase
          .from('resumes')
          .update({
            isActive: doc.id === resumeId,
            updatedAt: new Date().toISOString()
          })
          .eq('id', doc.id)
      )
    );

    // Update users table with new active resume
    const { error: userError } = await supabase
      .from('users')
      .upsert({
        id: userId,
        latestResumeId: resumeId,
        updatedAt: new Date().toISOString()
      });

    if (userError) throw userError;

    return res.status(200).json({
      success: true,
      data: {
        resumeId,
        message: 'Active resume updated successfully.'
      }
    });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /:resumeId/rescore — Retrigger scoring for a stuck resume ────────────

/**
 * POST /api/v1/resumes/:resumeId/rescore
 *
 * Triggers AI scoring for a pending/stuck resume.
 * No plan gate — any authenticated user can rescore their own resume.
 * Needed for onboarding-path CVs that were never scored.
 */
async function rescoreResume(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
    const resumeId = req.params.resumeId;
    if (!resumeId) {
      return res.status(400).json({
        success: false,
        message: 'resumeId is required'
      });
    }
    const scoreResult = await resumeService.scoreResume(userId, resumeId);
    return res.status(200).json({
      success: true,
      data: {
        resume: scoreResult
      }
    });
  } catch (err) {
    return next(err);
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