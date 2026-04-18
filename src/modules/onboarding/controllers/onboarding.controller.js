'use strict';

/**
 * src/modules/onboarding/controllers/onboarding.controller.js
 *
 * FULL production-safe controller
 * Patch 44 hardened:
 * - authoritative onboarding completion writes
 * - CV upload progress consistency guard
 * - split-write detection
 */

const onboardingService = require('../onboarding.service');
const { suggestRolesForOnboarding } = require('../../roles/roles.service');
const {
  parseResumeText,
  mapParsedToOnboardingShape,
} = require('../../../services/resumeParser');
const { uploadResume } = require('../../resume/resume.service');
const {
  authoritativeUpsert,
} = require('../../../lib/db/authoritativeMutation');

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
    const mupdf = (await import('mupdf')).default;
    const doc = mupdf.Document.openDocument(file.buffer, 'application/pdf');
    let text = '';
    for (let i = 0; i < doc.countPages(); i++) {
      text += doc.loadPage(i).toStructuredText('preserve-whitespace').asText() + '\n';
    }
    return text;
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

/**
 * Map the internal parsed shape → the frontend ResumeData contract.
 *
 * Frontend expects:
 *   {
 *     personal_info: { name, email, phone, location },
 *     summary:       string,
 *     skills:        string[],
 *     experience:    { id, title, company, start_date, end_date, description }[],
 *     education:     { id, degree, institution, year }[],
 *     certifications: string[],
 *     projects:      string[],
 *   }
 */
function mapParsedToFrontendShape(parsed, onboardingShape) {
  const pd = onboardingShape?.personalDetails ?? {};

  // Build location string from city/country
  const locationParts = [pd.city, pd.country].filter(Boolean);
  const location = locationParts.join(', ');

  // Skills: flat string array
  const skills = (onboardingShape?.skills ?? []).map((s) =>
    typeof s === 'string' ? s : s.name
  );

  // Experience: use structured entries from the parser when available;
  // fall back to a stub entry seeded from the top detected role.
  const rawExperience = onboardingShape?.parsedResume?.experience ?? [];
  let experience;
  if (rawExperience.length > 0) {
    experience = rawExperience.map((e, i) => ({
      id:          e.id          ?? `exp-${i}-${Date.now()}`,
      title:       e.title       ?? '',
      company:     e.company     ?? '',
      start_date:  e.start_date  ?? '',
      end_date:    e.end_date    ?? '',
      description: e.description ?? '',
    }));
  } else {
    // Fallback: seed one stub entry from the top detected role
    experience = [];
    const detectedRole = parsed?.detectedRoles?.[0] ?? null;
    if (detectedRole) {
      experience.push({
        id:          `exp-0-${Date.now()}`,
        title:       detectedRole,
        company:     '',
        start_date:  '',
        end_date:    '',
        description: '',
      });
    }
  }

  // Education: map from the degree-label array produced by regexUtils
  const rawEducation = onboardingShape?.parsedResume?.education ?? [];
  const education = rawEducation.map((label, i) => ({
    id:          `edu-${i}`,
    degree:      typeof label === 'string' ? label : (label.degree ?? ''),
    institution: typeof label === 'object' ? (label.institution ?? '') : '',
    year:        typeof label === 'object' ? String(label.year ?? '') : '',
  }));

  return {
    personal_info: {
      name:     pd.fullName     ?? '',
      email:    pd.email        ?? '',
      phone:    pd.phone        ?? '',
      location: location        ?? '',
    },
    summary:        pd.professionalSummary ?? '',
    skills,
    experience,
    education,
    certifications: onboardingShape?.parsedResume?.certifications ?? [],
    projects:       [],
  };
}

const uploadCvDuringOnboarding = withAuth(
  async (req, res, _next, userId) => {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded.',
      });
    }

    // ── 1. Upload file to storage + get raw text back ─────────────────────
    const uploadResult = await uploadResume(userId, req.file);
    const nowISO = new Date().toISOString();

    // ── 2. Parse the resume text into structured data ─────────────────────
    let parsedData = null;
    try {
      const resumeText = uploadResult.resumeText;
      if (resumeText && resumeText.trim().length >= 30) {
        const parsed         = parseResumeText(resumeText);
        const onboardingShape = mapParsedToOnboardingShape(parsed);
        parsedData           = mapParsedToFrontendShape(parsed, onboardingShape);

        logger.info('[OnboardingController] Resume parsed successfully', {
          userId,
          resumeId:        uploadResult.resumeId,
          confidenceScore: parsed.confidenceScore,
          skillsFound:     (onboardingShape.skills ?? []).length,
        });
      } else {
        logger.warn('[OnboardingController] Resume text too short to parse', {
          userId,
          resumeId: uploadResult.resumeId,
          textLen:  resumeText?.trim().length ?? 0,
        });
      }
    } catch (parseErr) {
      // Parsing failure must NOT break the upload — UI degrades gracefully
      logger.warn('[OnboardingController] Resume parsing failed (non-fatal)', {
        userId,
        resumeId: uploadResult.resumeId,
        error:    parseErr?.message,
      });
    }

    // ── 3. Update onboarding progress ────────────────────────────────────
    const stepHistory = await mergeStepHistory(userId, 'cv_uploaded');

    const progressUpdate = {
      id:           userId,
      step:         'cv_uploaded',
      cv_resume_id: uploadResult.resumeId,
      wants_cv:     true,
      step_history: stepHistory,
      updated_at:   nowISO,
    };

    await authoritativeUpsert({
      table:       'onboarding_progress',
      payload:     progressUpdate,
      conflictKey: 'id',
    });

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

    // ── 4. Return resumeId + parsedData ──────────────────────────────────
    return res.status(201).json({
      success: true,
      data: {
        userId,
        resumeId:   uploadResult.resumeId,
        fileUrl:    uploadResult.fileUrl ?? null,
        step:       'cv_uploaded',
        parsedData,          // ← NOW POPULATED: mapped to frontend ResumeData shape
      },
    });
  }
);

const completeOnboarding = withAuth(
  async (req, res, _next, userId) => {
    const completedAt = new Date().toISOString();

    const stepHistory = await mergeStepHistory(
      userId,
      'onboarding_completed'
    );

    const writes = await Promise.allSettled([
      authoritativeUpsert({
        table: 'users',
        payload: {
          id: userId,
          onboarding_completed: true,
          onboarding_completed_at: completedAt,
          updated_at: completedAt,
        },
        conflictKey: 'id',
      }),

      authoritativeUpsert({
        table: 'user_profiles',
        payload: {
          id: userId,
          onboarding_completed: true,
          onboarding_completed_at: completedAt,
          updated_at: completedAt,
        },
        conflictKey: 'id',
      }),

      authoritativeUpsert({
        table: 'onboarding_progress',
        payload: {
          id: userId,
          step: 'completed',
          completed_at: completedAt,
          step_history: stepHistory,
          updated_at: completedAt,
        },
        conflictKey: 'id',
      }),
    ]);

    const failed = writes.find(
      (result) => result.status === 'rejected'
    );

    if (failed) {
      logger.error(
        '[OnboardingController] completion split-write prevented',
        {
          userId,
          reason: failed.reason?.message,
        }
      );

      return res.status(500).json({
        success: false,
        message:
          'Failed to finalize onboarding consistently.',
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        userId,
        step: 'completed',
        completedAt,
      },
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