'use strict';

/**
 * src/modules/onboarding/controllers/onboarding.controller.js
 *
 * Production-ready Supabase-first controller.
 *
 * Improvements:
 * - Removed remaining lazy Firebase-era patterns and hidden Firestore assumptions
 * - Centralized Supabase + logger imports for connection reuse
 * - Added reusable auth guard + async controller wrapper
 * - Improved null safety around parsed CV data
 * - Reduced duplicate require() calls in hot paths
 * - Safer upsert error handling for multi-table writes
 * - Preserved all route contracts and response shapes
 */

const onboardingService = require('../onboarding.service');
const { suggestRolesForOnboarding } = require('../../roles/roles.service');
const { parseResumeText, mapParsedToOnboardingShape } = require('../../../services/resumeParser');
const { uploadResume } = require('../../resume/resume.service');
// NOTE: keep lazy-loaded inside endpoints because the classifier lives under the onboarding module service layer.
// This avoids boot-time MODULE_NOT_FOUND if service path differs across environments.
let classifyDocument = null;
function getCvClassifier() {
  if (classifyDocument) return classifyDocument;
  ({ classifyDocument } = require('../services/cvClassifier.service'));
  return classifyDocument;
}
const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const { mergeStepHistory, persistCompletionIfReady } = require('../onboarding.service');

function safeUserId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

function unauthorized(res) {
  return res.status(401).json({ success: false, message: 'Unauthorized' });
}

function withAuth(handler) {
  return async function wrapped(req, res, next) {
    try {
      const userId = safeUserId(req);
      if (!userId) return unauthorized(res);
      return await handler(req, res, next, userId);
    } catch (err) {
      return next(err);
    }
  };
}

async function extractTextFromUpload(file) {
  const ext = (file?.originalname || '').split('.').pop()?.toLowerCase();

  if (ext === 'pdf' || file?.mimetype === 'application/pdf') {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(file.buffer);
    return parsed?.text || '';
  }

  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer: file.buffer });
  return result?.value || '';
}

const AI_FALLBACK_PROMPT = `You are a precise CV data extractor.
Given raw CV/resume text, extract the MISSING fields only (marked null below).
Return ONLY valid JSON. No preamble, no markdown, no explanation.

Improve only: fullName, email, phone, city, country, linkedInUrl, portfolioUrl,
languages (spoken, not programming), professionalSummary, currentJobTitle, currentCompany, yearsOfExperience.

Return the same structure — null for fields you cannot confidently determine.`;

async function extractCvPersonalDetails(resumeText, userId) {
  let parsed;
  let onboardingShape;

  try {
    parsed = parseResumeText(resumeText);
    onboardingShape = mapParsedToOnboardingShape(parsed);

    logger.info('[OnboardingController] Local CV parser complete', {
      userId,
      confidenceScore: parsed.confidenceScore,
      needsAIParsing: parsed.needsAIParsing,
      skillsFound: parsed.skills?.length || 0,
      rolesFound: parsed.detectedRoles?.length || 0,
      hasEmail: !!parsed.email,
      hasName: !!parsed.name,
    });
  } catch (error) {
    logger.warn('[OnboardingController] Local CV parser failed', {
      userId,
      error: error.message,
    });
    return null;
  }

  const aiEnabled = process.env.ENABLE_AI_CV_FALLBACK === 'true';

  if (parsed?.needsAIParsing && aiEnabled && process.env.NODE_ENV !== 'test') {
    try {
      const anthropic = require('../../../config/anthropic.client');
      const sample = String(resumeText || '').trim().slice(0, 5000);
      const pd = onboardingShape?.personalDetails || {};

      const partialResult = JSON.stringify({
        fullName: pd.fullName || null,
        email: pd.email || null,
        phone: pd.phone || null,
        city: pd.city || null,
        country: pd.country || null,
        linkedInUrl: pd.linkedInUrl || null,
        portfolioUrl: pd.portfolioUrl || null,
        languages: [],
        professionalSummary: pd.professionalSummary || null,
        currentJobTitle: parsed.detectedRoles?.[0] || null,
        currentCompany: null,
        yearsOfExperience: parsed.yearsExperience || null,
      });

      const response = await anthropic.messages.create({
        model: process.env.CV_EXTRACT_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: AI_FALLBACK_PROMPT,
        messages: [{
          role: 'user',
          content: `CV Text:\n${sample}\n\nCurrent extraction (improve nulls only):\n${partialResult}`,
        }],
      });

      const rawText = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

      const clean = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      const aiParsed = JSON.parse(clean);
      const existing = onboardingShape.personalDetails || {};

      onboardingShape.personalDetails = {
        fullName: existing.fullName || aiParsed.fullName || null,
        email: existing.email || aiParsed.email || null,
        phone: existing.phone || aiParsed.phone || null,
        city: existing.city || aiParsed.city || null,
        country: existing.country || aiParsed.country || null,
        linkedInUrl: existing.linkedInUrl || aiParsed.linkedInUrl || null,
        portfolioUrl: existing.portfolioUrl || aiParsed.portfolioUrl || null,
        languages: existing.languages?.length ? existing.languages : (aiParsed.languages || []),
        professionalSummary: existing.professionalSummary || aiParsed.professionalSummary || null,
      };

      if (!parsed.yearsExperience && aiParsed.yearsOfExperience) {
        onboardingShape.parsedResume.yearsExperience = aiParsed.yearsOfExperience;
      }
    } catch (error) {
      logger.warn('[OnboardingController] AI fallback failed', { userId, error: error.message });
    }
  }

  const pd = onboardingShape.personalDetails || {};
  return {
    fullName: pd.fullName || null,
    email: pd.email || null,
    phone: pd.phone || null,
    city: pd.city || null,
    country: pd.country || null,
    linkedInUrl: pd.linkedInUrl || null,
    portfolioUrl: pd.portfolioUrl || null,
    languages: pd.languages || [],
    professionalSummary: pd.professionalSummary || null,
    skills: (onboardingShape.skills || []).map(s => s.name),
    currentJobTitle: parsed.detectedRoles?.[0] || null,
    currentCompany: null,
    yearsOfExperience: parsed.yearsExperience || onboardingShape.parsedResume?.yearsExperience || null,
    industry: parsed.industry || null,
    educationLevel: parsed.educationLevel || null,
    _parsedResume: onboardingShape.parsedResume || {},
  };
}

const saveConsent = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.saveConsent(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const saveQuickStart = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.saveQuickStart(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const saveEducationAndExperience = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.saveEducationAndExperience(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const saveDraft = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.saveDraft(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const generateCareerReport = withAuth(async (req, res, _next, userId) => {
  const idempotencyKey = req.headers['idempotency-key'] || null;
  const userTier = req.user?.normalizedTier ?? req.user?.plan ?? 'free';
  const result = await onboardingService.generateCareerReport(userId, req.creditCost, idempotencyKey, userTier);
  return res.status(200).json({ success: true, data: result });
});

const savePersonalDetails = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.savePersonalDetails(userId, req.body, req.user?.email || null);
  return res.status(200).json({ success: true, data: result });
});

const getCvPreview = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.getCvPreview(userId);
  return res.status(200).json({ success: true, data: result });
});

const generateCV = withAuth(async (req, res, _next, userId) => {
  const idempotencyKey = req.headers['idempotency-key'] || null;
  const userTier = req.user?.normalizedTier ?? req.user?.plan ?? 'free';
  const result = await onboardingService.generateCV(userId, req.creditCost, idempotencyKey, userTier);
  return res.status(200).json({ success: true, data: result });
});

const getCvSignedUrl = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.getCvSignedUrl(userId);
  return res.status(200).json({ success: true, data: result });
});

const skipCv = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.skipCv(userId);
  return res.status(200).json({ success: true, data: result });
});

const getProgress = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.getProgress(userId, req.user?.plan ?? 'free');
  return res.status(200).json({ success: true, data: result });
});

const getChiExplainer = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.getChiExplainer(userId);
  return res.status(200).json({ success: true, data: result });
});

const saveCareerIntent = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.saveCareerIntent(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const validateCvFileEndpoint = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    let text = '';
    try {
      text = await extractTextFromUpload(req.file);
    } catch (error) {
      logger.warn('[validateCvFileEndpoint] text extraction failed', { error: error.message });
      return res.json({ success: true, data: { is_cv: false, confidence: 80, document_type: 'other', reason: 'Could not extract text from this file.', detected_sections: [] } });
    }

    if (!text.trim() || text.trim().length < 40) {
      return res.json({ success: true, data: { is_cv: false, confidence: 85, document_type: 'other', reason: 'File contains no readable text.', detected_sections: [] } });
    }

    const result = await getCvClassifier()(text);
    return res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
};

const uploadCvDuringOnboarding = withAuth(async (req, res, _next, userId) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded.' });
  }

  let cvText = '';
  try {
    cvText = await extractTextFromUpload(req.file);
    if (cvText.trim().length >= 40) {
      const classification = await getCvClassifier()(cvText, { skipAi: false });
      if (!classification.is_cv && classification.confidence >= 75) {
        return res.status(400).json({ success: false, message: 'This file does not appear to be a valid CV or resume.', classification });
      }
    }
  } catch (error) {
    logger.warn('[uploadCvDuringOnboarding] classifier failed, continuing', { userId, error: error.message });
  }

  const uploadResult = await uploadResume(userId, req.file);
  let extractedDetails = null;
  let extractedSkills = [];

  const resumeText = uploadResult.resumeText || cvText;
  if (resumeText?.trim()?.length > 50) {
    extractedDetails = await extractCvPersonalDetails(resumeText, userId);
    extractedSkills = (extractedDetails?.skills || []).slice(0, 20).map(name => ({
      name: String(name).trim(),
      proficiency: 'intermediate',
    }));
  }

  const nowISO = new Date().toISOString();
  const stepHistory = await mergeStepHistory(userId, 'cv_uploaded');

  const progressUpdate = {
    id: userId,
    step: 'cv_uploaded',
    cvResumeId: uploadResult.resumeId,
    wantsCv: true,
    stepHistory,
    updatedAt: nowISO,
    ...(extractedSkills.length ? { skills: extractedSkills } : {}),
    ...(extractedDetails ? {
      personalDetails: {
        fullName: extractedDetails.fullName,
        email: extractedDetails.email,
        phone: extractedDetails.phone,
        city: extractedDetails.city,
        country: extractedDetails.country,
        linkedInUrl: extractedDetails.linkedInUrl,
        portfolioUrl: extractedDetails.portfolioUrl,
        languages: extractedDetails.languages || [],
        professionalSummary: extractedDetails.professionalSummary,
      },
    } : {}),
  };

  const { error } = await supabase.from('onboardingProgress').upsert(progressUpdate);
  if (error) throw error;

  const [{ data: progressRow }, { data: profileRow }] = await Promise.all([
    supabase.from('onboardingProgress').select('*').eq('id', userId).maybeSingle(),
    supabase.from('userProfiles').select('*').eq('id', userId).maybeSingle(),
  ]);

  await persistCompletionIfReady(userId, progressRow || {}, profileRow || {});

  return res.status(201).json({
    success: true,
    data: {
      userId,
      resumeId: uploadResult.resumeId,
      fileUrl: uploadResult.fileUrl ?? null,
      step: 'cv_uploaded',
      message: 'Your CV has been uploaded. Career Health Index will generate shortly.',
      extractedDetails,
    },
  });
});

const importLinkedIn = withAuth(async (req, res, _next, userId) => {
  let payload = req.body;

  if (req.file?.buffer) {
    payload = JSON.parse(req.file.buffer.toString('utf8'));
  }

  const result = await onboardingService.importLinkedIn(userId, payload);
  return res.status(200).json({ success: true, data: result });
});

const suggestRoles = async (req, res, next) => {
  try {
    const { q, limit } = req.query;
    const parsedLimit = limit ? Math.min(parseInt(limit, 10) || 5, 10) : 5;

    if (!q || !String(q).trim()) {
      return res.status(200).json({ success: true, data: { suggestions: [], total: 0 } });
    }

    const result = await suggestRolesForOnboarding({
      jobTitle: String(q).trim(),
      limit: parsedLimit,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
};

const getTeaserChi = async (req, res, next) => {
  try {
    const result = await onboardingService.getTeaserChi(req.query.jobFamilyId || null);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
};

const getChiReady = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.getChiReady(userId);
  return res.status(200).json({ success: true, data: result });
});

const getCareerReportStatus = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.getCareerReportStatus(userId);
  return res.status(200).json({ success: true, data: result });
});

const confirmLinkedInImport = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.confirmLinkedInImport(userId);
  return res.status(200).json({ success: true, data: result });
});

const getDraft = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.getDraft(userId);
  return res.status(200).json({ success: true, data: result });
});

const saveCvDraft = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.saveCvDraft(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const getFunnelAnalytics = async (req, res, next) => {
  try {
    const { from, to, after } = req.query;
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 500, 2000) : 500;

    if (!from || !to) {
      return res.status(400).json({ success: false, error: 'Query params "from" and "to" are required.' });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid ISO date format.' });
    }

    const result = await onboardingService.getFunnelAnalytics({ limit, after: after || null, fromDate, toDate });
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
};

const completeOnboarding = withAuth(async (req, res, _next, userId) => {
  const now = new Date().toISOString();
  const stepHistory = await mergeStepHistory(userId, 'onboarding_completed');

  const writes = await Promise.all([
    supabase.from('users').upsert({ id: userId, onboardingCompleted: true, onboardingCompletedAt: now, updatedAt: now }),
    supabase.from('userProfiles').upsert({ id: userId, onboardingCompleted: true, onboardingCompletedAt: now, updatedAt: now }),
    supabase.from('onboardingProgress').upsert({ id: userId, step: 'completed', completedAt: now, stepHistory, updatedAt: now }),
  ]);

  const failed = writes.find(result => result.error);
  if (failed?.error) throw failed.error;

  logger.info('[OnboardingController] completeOnboarding success', { userId });

  return res.status(200).json({
    success: true,
    data: { userId, step: 'completed', message: 'Onboarding complete.' },
  });
});

module.exports = {
  saveConsent,
  saveQuickStart,
  saveEducationAndExperience,
  saveDraft,
  getDraft,
  generateCareerReport,
  savePersonalDetails,
  getCvPreview,
  saveCvDraft,
  generateCV,
  getCvSignedUrl,
  skipCv,
  getProgress,
  getChiExplainer,
  saveCareerIntent,
  uploadCvDuringOnboarding,
  validateCvFileEndpoint,
  importLinkedIn,
  confirmLinkedInImport,
  suggestRoles,
  getTeaserChi,
  getChiReady,
  getCareerReportStatus,
  getFunnelAnalytics,
  completeOnboarding,
};
