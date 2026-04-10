'use strict';

/**
 * src/modules/onboarding/controllers/onboarding.controller.js
 *
 * FULL production-safe controller
 * ✅ All original handlers preserved
 * ✅ Supabase snake_case aligned
 * ✅ No route export breakage
 */

const onboardingService = require('../onboarding.service');
const { suggestRolesForOnboarding } = require('../../roles/roles.service');
const {
  parseResumeText,
  mapParsedToOnboardingShape,
} = require('../../../services/resumeParser');
const { uploadResume } = require('../../resume/resume.service');

let classifyDocument = null;
function getCvClassifier() {
  if (classifyDocument) return classifyDocument;
  ({ classifyDocument } = require('../services/cvClassifier.service'));
  return classifyDocument;
}

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const {
  mergeStepHistory,
  persistCompletionIfReady,
} = require('../onboarding.service');

function safeUserId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

function unauthorized(res) {
  return res
    .status(401)
    .json({ success: false, message: 'Unauthorized' });
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
  const ext = (file?.originalname || '')
    .split('.')
    .pop()
    ?.toLowerCase();

  if (ext === 'pdf' || file?.mimetype === 'application/pdf') {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(file.buffer);
    return parsed?.text || '';
  }

  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({
    buffer: file.buffer,
  });

  return result?.value || '';
}

async function extractCvPersonalDetails(resumeText, userId) {
  let parsed;
  let onboardingShape;

  try {
    parsed = parseResumeText(resumeText);
    onboardingShape = mapParsedToOnboardingShape(parsed);
  } catch (error) {
    logger.warn('[OnboardingController] Local CV parser failed', {
      userId,
      error: error.message,
    });
    return null;
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
    skills: (onboardingShape.skills || []).map((s) => s.name),
    currentJobTitle: parsed.detectedRoles?.[0] || null,
    currentCompany: null,
    yearsOfExperience:
      parsed.yearsExperience ||
      onboardingShape.parsedResume?.yearsExperience ||
      null,
  };
}

/* ---------------- core handlers ---------------- */

const saveConsent = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.saveConsent(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const saveQuickStart = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.saveQuickStart(
    userId,
    req.body
  );
  return res.status(200).json({ success: true, data: result });
});

const saveEducationAndExperience = withAuth(
  async (req, res, _next, userId) => {
    const result =
      await onboardingService.saveEducationAndExperience(
        userId,
        req.body
      );

    return res.status(200).json({ success: true, data: result });
  }
);

const saveDraft = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.saveDraft(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const getDraft = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.getDraft(userId);
  return res.status(200).json({ success: true, data: result });
});

const generateCareerReport = withAuth(
  async (req, res, _next, userId) => {
    const result =
      await onboardingService.generateCareerReport(
        userId,
        req.creditCost,
        req.headers['idempotency-key'] || null,
        req.user?.plan ?? 'free'
      );

    return res.status(200).json({ success: true, data: result });
  }
);

const savePersonalDetails = withAuth(
  async (req, res, _next, userId) => {
    const result =
      await onboardingService.savePersonalDetails(
        userId,
        req.body,
        req.user?.email || null
      );

    return res.status(200).json({ success: true, data: result });
  }
);

const getCvPreview = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.getCvPreview(userId);
  return res.status(200).json({ success: true, data: result });
});

const saveCvDraft = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.saveCvDraft(
    userId,
    req.body
  );
  return res.status(200).json({ success: true, data: result });
});

const generateCV = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.generateCV(
    userId,
    req.creditCost,
    req.headers['idempotency-key'] || null,
    req.user?.plan ?? 'free'
  );

  return res.status(200).json({ success: true, data: result });
});

const getCvSignedUrl = withAuth(
  async (req, res, _next, userId) => {
    const result = await onboardingService.getCvSignedUrl(userId);
    return res.status(200).json({ success: true, data: result });
  }
);

const skipCv = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.skipCv(userId);
  return res.status(200).json({ success: true, data: result });
});

const getProgress = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.getProgress(userId);
  return res.status(200).json({ success: true, data: result });
});

const getChiExplainer = withAuth(
  async (req, res, _next, userId) => {
    const result = await onboardingService.getChiExplainer(
      userId
    );
    return res.status(200).json({ success: true, data: result });
  }
);

const saveCareerIntent = withAuth(
  async (req, res, _next, userId) => {
    const result = await onboardingService.saveCareerIntent(
      userId,
      req.body
    );
    return res.status(200).json({ success: true, data: result });
  }
);

const validateCvFileEndpoint = async (req, res) => {
  return res.status(200).json({ success: true });
};

const importLinkedIn = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.importLinkedIn(
    userId,
    req.body
  );
  return res.status(200).json({ success: true, data: result });
});

const confirmLinkedInImport = withAuth(
  async (req, res, _next, userId) => {
    const result =
      await onboardingService.confirmLinkedInImport(userId);
    return res.status(200).json({ success: true, data: result });
  }
);

const suggestRoles = async (req, res, next) => {
  try {
    const result = await suggestRolesForOnboarding({
      jobTitle: String(req.query.q || '').trim(),
      limit: 5,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
};

const getTeaserChi = async (req, res, next) => {
  try {
    const result = await onboardingService.getTeaserChi(
      req.query.jobFamilyId || null
    );

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
};

const getChiReady = withAuth(async (req, res, _next, userId) => {
  const result = await onboardingService.getChiReady(userId);
  return res.status(200).json({ success: true, data: result });
});

const getCareerReportStatus = withAuth(
  async (req, res, _next, userId) => {
    const result =
      await onboardingService.getCareerReportStatus(userId);

    return res.status(200).json({ success: true, data: result });
  }
);

const getFunnelAnalytics = async (req, res, next) => {
  try {
    const result =
      await onboardingService.getFunnelAnalytics(req.query);

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
};

const uploadCvDuringOnboarding = withAuth(
  async (req, res, _next, userId) => {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded.',
      });
    }

    const uploadResult = await uploadResume(userId, req.file);
    const nowISO = new Date().toISOString();

    const stepHistory = await mergeStepHistory(
      userId,
      'cv_uploaded'
    );

    const progressUpdate = {
      id: userId,
      step: 'cv_uploaded',
      cv_resume_id: uploadResult.resumeId,
      wants_cv: true,
      step_history: stepHistory,
      updated_at: nowISO,
    };

    const { error } = await supabase
      .from('onboarding_progress')
      .upsert(progressUpdate);

    if (error) throw error;

    const [{ data: progressRow }, { data: profileRow }] =
      await Promise.all([
        supabase
          .from('onboarding_progress')
          .select('*')
          .eq('id', userId)
          .maybeSingle(),
        supabase
          .from('user_profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle(),
      ]);

    await persistCompletionIfReady(
      userId,
      progressRow || {},
      profileRow || {}
    );

    return res.status(201).json({
      success: true,
      data: {
        userId,
        resumeId: uploadResult.resumeId,
        fileUrl: uploadResult.fileUrl ?? null,
        step: 'cv_uploaded',
      },
    });
  }
);

const completeOnboarding = withAuth(
  async (req, res, _next, userId) => {
    const now = new Date().toISOString();
    const stepHistory = await mergeStepHistory(
      userId,
      'onboarding_completed'
    );

    const writes = await Promise.all([
      supabase.from('users').upsert({
        id: userId,
        onboarding_completed: true,
        onboarding_completed_at: now,
        updated_at: now,
      }),

      supabase.from('user_profiles').upsert({
        id: userId,
        onboarding_completed: true,
        onboarding_completed_at: now,
        updated_at: now,
      }),

      supabase.from('onboarding_progress').upsert({
        id: userId,
        step: 'completed',
        completed_at: now,
        step_history: stepHistory,
        updated_at: now,
      }),
    ]);

    const failed = writes.find((r) => r.error);
    if (failed?.error) throw failed.error;

    return res.status(200).json({
      success: true,
      data: { userId, step: 'completed' },
    });
  }
);

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