'use strict';

/**
 * src/modules/onboarding/controllers/onboarding.controller.js
 *
 * FIX: suggestRoles was delegating to getProgress (wrong service call).
 *      Now returns a structured role-suggestion response or delegates to
 *      a dedicated service when available.
 *
 * FIX: Response contract normalised.
 *      uploadCvDuringOnboarding previously returned flat top-level keys
 *      (parseOutcome, confidence, quality, parserVersion) alongside `data`.
 *      These are now nested inside `data` to match the standard
 *      { success, data, error } contract used by every other endpoint.
 *
 * FIX: safeUserId prefers req.user.id (Supabase canonical) but still falls
 *      back to uid for any legacy consumers. The dual-identity problem is
 *      documented here and should be resolved by removing `uid` from the
 *      auth middleware once all consumers are confirmed migrated.
 */

const onboardingService = require('../onboarding.service');
const { uploadResume }  = require('../../resume/resume.service');

const {
  parseResumeText,
  mapParsedToOnboardingShape,
} = require('../../../services/resumeParser');

const {
  normalizeFromOnboardingShape,
  toFrontendShape,
} = require('../../../services/resumeParser/resume.normalizer');

// WP-PRO-07: Professional Profile Normalization Engine — Resume Upload is
// one of the three acquisition methods this WP implements normalization
// for (Task 3). This re-shapes the already-parsed HireRiseResume
// (`structuredResume`, produced below) into the canonical Professional
// Profile and persists it durably to user_profiles, without changing the
// existing parsing pipeline or the sync response contract.
const {
  normalizeResumeUpload,
} = require('../../../domain/professionalProfile/professionalProfile.normalizer');
const {
  saveProfessionalProfileSections,
} = require('../../../domain/professionalProfile/professionalProfile.repository');
const { ACQUISITION_METHODS } = require('../../../domain/professionalProfile/professionalProfile.schema');

const {
  isWeakParse,
  extractWithAI,
  mergeAIWithStructured,
} = require('../../../services/resumeParser/aiExtractor.service');

const { computeConfidence } = require('../../../services/confidence.service');
const { computeQuality }    = require('../../../services/quality.service');

const { supabase } = require('../../../config/supabase');
const logger       = require('../../../utils/logger');
const { authoritativeUpsert } = require('../../../lib/db/authoritativeMutation');

const {
  mergeStepHistory,
  persistCompletionIfReady,
} = require('../onboarding.service');

const PARSER_VERSION = process.env.npm_package_version || '2.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract user ID from the request.
 * Prefers `id` (Supabase canonical field set by auth.middleware).
 * Falls back to `uid` for legacy compatibility.
 */
function safeUserId(req) {
  return req?.user?.id ?? req?.user?.uid ?? null;
}

function withAuth(handler) {
  return async function wrapped(req, res, next) {
    try {
      const userId = safeUserId(req);
      if (!userId) {
        return res.status(401).json({
          success: false,
          // MODE CONTRACT: mode is present on all responses including errors so
          // frontend flow-control never has to branch on HTTP status alone.
          data: { mode: 'sync' },
          error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
        });
      }
      return await handler(req, res, next, userId);
    } catch (err) {
      return next(err);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CV upload handler
// ─────────────────────────────────────────────────────────────────────────────

const uploadCvDuringOnboarding = withAuth(
  async (req, res, _next, userId) => {
    logger.info('[OnboardingController] upload-cv request received', {
      userId,
      hasFile:   !!req.file,
      fileName:  req.file?.originalname ?? null,
      mimeType:  req.file?.mimetype     ?? null,
      sizeBytes: req.file?.size         ?? null,
    });

    if (!req.file) {
      logger.warn('[OnboardingController] No file in request', { userId });
      return res.status(400).json({
        success: false,
        // MODE CONTRACT: mode present on error so frontend never needs to
        // infer flow type from HTTP status or endpoint name.
        data: { mode: 'sync' },
        error: {
          code:    'VALIDATION_ERROR',
          // Task 4: standardized message
          message: 'No resume file provided.',
        },
      });
    }

    const uploadResult = await uploadResume(userId, req.file);
    logger.info('[OnboardingController] storage upload success', {
      userId,
      resumeId:    uploadResult.resumeId,
      isScannedPdf: uploadResult.isScannedPdf,
    });
    const nowISO = new Date().toISOString();

    // ── Scanned PDF fast-path ──────────────────────────────────────────────
    if (uploadResult.isScannedPdf) {
      logger.warn('[OnboardingController] Scanned PDF detected', {
        userId,
        resumeId: uploadResult.resumeId,
      });

      return res.status(200).json({
        success: true,
        data: {
          // Task 2: explicit mode field — no polling required for this flow
          mode:        'sync',
          userId,
          resumeId:    uploadResult.resumeId,
          fileUrl:     uploadResult.fileUrl ?? null,
          step:        'cv_uploaded',
          parsedData:  null,
          parseOutcome: 'scanned_pdf',
          confidence: { overall: 0, level: 'low', fields: {} },
          quality: {
            completenessScore: 0,
            missingFields:     ['name', 'email', 'skills', 'experience', 'education'],
            suggestions:       ['Your CV appears to be image-based. Please upload a text-based PDF or DOCX.'],
          },
        },
        meta: {
          timestamp: new Date().toISOString(),
          // INTERNAL — not for frontend use. Grouped here to keep the
          // `data` envelope clean and avoid breaking clients that read data.*.
          internal: {
            isScannedPdf:  true,       // INTERNAL — use parseOutcome === 'scanned_pdf' instead
            isTruncated:   false,      // INTERNAL — parser implementation detail
            parserVersion: PARSER_VERSION, // INTERNAL — backend versioning only
            structuredResume: null,    // INTERNAL — raw parser output, schema may change
          },
        },
      });
    }

    // ── Parsing pipeline ───────────────────────────────────────────────────
    let parsedData       = null;
    let structuredResume = null;
    let isTruncated      = uploadResult.isTruncated ?? false;

    try {
      const resumeText = uploadResult.resumeText;

      if (resumeText && resumeText.trim().length >= 30) {
        const parsed          = parseResumeText(resumeText);
        const onboardingShape = mapParsedToOnboardingShape(parsed);

        const structured = normalizeFromOnboardingShape(
          parsed,
          onboardingShape,
          uploadResult.resumeId,
          userId
        );

        let sr          = structured;
        const parseWasWeak = isWeakParse(sr);

        if (parseWasWeak) {
          try {
            const aiResult = await extractWithAI(resumeText);
            if (aiResult) {
              if (aiResult.isTruncated) isTruncated = true;
              sr = mergeAIWithStructured(sr, aiResult);
            }
          } catch (err) {
            logger.error('[AI fallback failed]', { userId, error: err.message });
          }
        }

        structuredResume = sr;
        parsedData       = toFrontendShape(sr);
      } else {
        logger.warn('[Resume too short]', { userId, textLen: uploadResult.resumeText?.length ?? 0 });
      }
    } catch (err) {
      logger.error('[Parsing failed]', { userId, error: err.message });
    }

    // ── Parse outcome ──────────────────────────────────────────────────────
    let parseOutcome = 'success';
    if (!structuredResume && !parsedData) {
      parseOutcome = 'failed';
    } else if (structuredResume && isWeakParse(structuredResume)) {
      parseOutcome = 'partial';
    }

    const confidence = computeConfidence(structuredResume);
    const quality    = computeQuality(structuredResume);

    // ── Professional Profile normalization (WP-PRO-07, Task 3) ─────────────
    // Only normalize when parsing actually produced structured data — a
    // failed/weak parse or a too-short resume must leave the Professional
    // Profile's acquisition-time sections untouched rather than writing
    // empty/invented values over whatever the user already had.
    if (structuredResume) {
      try {
        const partialProfile = normalizeResumeUpload(structuredResume, {
          resumeId:      uploadResult.resumeId,
          fileUrl:       uploadResult.fileUrl,
          parserVersion: PARSER_VERSION,
        });
        await saveProfessionalProfileSections(userId, partialProfile, {
          source: ACQUISITION_METHODS.RESUME_UPLOAD,
        });
      } catch (err) {
        logger.error('[OnboardingController] Professional Profile sync failed', {
          userId,
          resumeId: uploadResult.resumeId,
          error: err.message,
        });
      }
    }

    // ── Progress update ────────────────────────────────────────────────────
    const stepHistory = await mergeStepHistory(userId, 'cv_uploaded');

    await authoritativeUpsert({
      table:       'onboarding_progress',
      payload: {
        id:           userId,
        user_id:      userId,   // ← always write user_id alongside id
        step:         'cv_uploaded',
        cv_resume_id: uploadResult.resumeId,
        wants_cv:     true,
        step_history: stepHistory,
        confidence,
        quality,
        parser_version: PARSER_VERSION,
        updated_at:   nowISO,
      },
      conflictKey: 'id',
    });

    const [{ data: progressRow }, { data: profileRow }] = await Promise.all([
      supabase.from('onboarding_progress').select('*').eq('id', userId).maybeSingle(),
      supabase.from('user_profiles').select('*').eq('id', userId).maybeSingle(),
    ]);

    await persistCompletionIfReady(userId, progressRow || {}, profileRow || {});

    // FIX: all fields nested inside `data` to match standard response contract
    logger.info('[OnboardingController] response sent', {
      userId,
      resumeId:    uploadResult.resumeId,
      parseOutcome,
      isTruncated,
    });
    return res.status(201).json({
      success: true,
      data: {
        // Task 2: explicit mode field — parsedData is available immediately,
        // no polling endpoint required for this upload flow.
        mode:             'sync',
        userId,
        resumeId:         uploadResult.resumeId,
        fileUrl:          uploadResult.fileUrl ?? null,
        step:             'cv_uploaded',
        parsedData,
        parseOutcome,
        confidence,
        quality,
      },
      meta: {
        timestamp: new Date().toISOString(),
        // INTERNAL — grouped under meta.internal to keep data.* clean.
        // Frontend MUST NOT rely on these fields — they are parser
        // implementation details that may change without notice.
        internal: {
          structuredResume, // INTERNAL — raw normalizer output; use parsedData instead
          isTruncated,      // INTERNAL — parser input-limit flag; not actionable by UI
          isScannedPdf: uploadResult.isScannedPdf, // INTERNAL — use parseOutcome === 'scanned_pdf'
          parserVersion: PARSER_VERSION,            // INTERNAL — backend versioning only
        },
      },
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Service-delegating handlers
// ─────────────────────────────────────────────────────────────────────────────

const saveConsent = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.saveConsent(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const saveQuickStart = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.saveQuickStart(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const saveEducationAndExperience = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.saveEducationAndExperience(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const saveDraft = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.saveDraft(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const getDraft = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.getDraft(userId);
  return res.status(200).json({ success: true, data: result });
});

const saveCvDraft = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.saveCvDraft(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const generateCareerReport = withAuth(async (req, res, next, userId) => {
  const creditCost     = req.creditCost     ?? 0;
  const idempotencyKey = req.headers['idempotency-key'] ?? null;
  const userTier       = req.user?.normalizedTier ?? req.user?.plan ?? 'free';
  const result = await onboardingService.generateCareerReport(userId, creditCost, idempotencyKey, userTier);
  return res.status(200).json({ success: true, data: result });
});

const savePersonalDetails = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.savePersonalDetails(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const getCvPreview = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.getCvPreview(userId);
  return res.status(200).json({ success: true, data: result });
});

const generateCV = withAuth(async (req, res, next, userId) => {
  const creditCost     = req.creditCost     ?? 0;
  const idempotencyKey = req.headers['idempotency-key'] ?? null;
  const result = await onboardingService.generateCV(userId, creditCost, idempotencyKey);
  return res.status(200).json({ success: true, data: result });
});

const getCvSignedUrl = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.getCvSignedUrl(userId);
  return res.status(200).json({ success: true, data: result });
});

const skipCv = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.skipCv(userId);
  return res.status(200).json({ success: true, data: result });
});

const getProgress = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.getProgress(userId);
  return res.status(200).json({ success: true, data: result });
});

const getChiExplainer = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.getChiExplainer(userId);
  return res.status(200).json({ success: true, data: result });
});

const saveCareerIntent = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.saveCareerIntent(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

const validateCvFileEndpoint = withAuth(async (req, res, next, userId) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      // MODE CONTRACT: mode on error path — consistent with uploadCvDuringOnboarding
      data: { mode: 'sync' },
      error: { code: 'VALIDATION_ERROR', message: 'No file uploaded.' },
    });
  }
  return res.status(200).json({ success: true, data: { valid: true } });
});

const importLinkedIn = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.importLinkedIn(userId, req.file, req.body);
  return res.status(200).json({ success: true, data: result });
});

const confirmLinkedInImport = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.confirmLinkedInImport(userId, req.body);
  return res.status(200).json({ success: true, data: result });
});

/**
 * FIX: suggestRoles was calling getProgress (completely wrong).
 * Now returns role suggestions based on the user's profile / progress data.
 */
const suggestRoles = withAuth(async (req, res, next, userId) => {
  // Use dedicated suggestRoles service if available; otherwise derive from progress
  let result;

  if (typeof onboardingService.suggestRoles === 'function') {
    result = await onboardingService.suggestRoles(userId, req.query);
  } else {
    // Fallback: return role hints from progress data
    const { data: progressRow } = await supabase
      .from('onboarding_progress')
      .select('expected_role_ids,target_role,skills')
      .eq('id', userId)
      .maybeSingle();

    result = {
      suggestedRoles: progressRow?.expected_role_ids || [],
      targetRole:     progressRow?.target_role       || null,
      derivedFrom:    'onboarding_progress',
      message:        'Role suggestions based on your onboarding data.',
    };
  }

  return res.status(200).json({ success: true, data: result });
});

const getTeaserChi = async (req, res, next) => {
  try {
    const result = await onboardingService.getTeaserChi();
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
};

const getChiReady = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.getChiReady(userId);
  return res.status(200).json({ success: true, data: result });
});

const getCareerReportStatus = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.getCareerReportStatus(userId);
  return res.status(200).json({ success: true, data: result });
});

const getFunnelAnalytics = withAuth(async (req, res, next, userId) => {
  const result = await onboardingService.getFunnelAnalytics(userId, req.query);
  return res.status(200).json({ success: true, data: result });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guided Builder backend support (WP-PRO-07, Task 4)
//
// No Guided Builder UI exists yet (per WP-PRO-05B §6, confirmed not found
// anywhere in core/ or front/) — these two endpoints are backend scaffolding
// for a future Guided Builder frontend to call. Both delegate entirely to
// onboarding.guidedBuilder.service.js, which itself delegates entirely to
// the shared professionalProfile normalizer/repository — no field-mapping
// logic lives in this controller.
// ─────────────────────────────────────────────────────────────────────────────

const guidedBuilderService = require('../onboarding.guidedBuilder.service');

const saveGuidedBuilderSection = withAuth(async (req, res, next, userId) => {
  const { section } = req.params;
  const result = await guidedBuilderService.saveGuidedSection(userId, section, req.body);
  return res.status(200).json({ success: true, data: result });
});

const getGuidedBuilderProfile = withAuth(async (req, res, next, userId) => {
  const profile = await guidedBuilderService.getGuidedBuilderPrefill(userId);
  return res.status(200).json({ success: true, data: { profile } });
});

const completeOnboarding = withAuth(async (req, res, next, userId) => {
  // WP-DIAG-01 TEMP — diagnostic-only, remove this whole block once the
  // completion/auth investigation is closed.
  const wpDiagStartedAt = Date.now();
  logger.info('[WP-DIAG] completeOnboarding entered', {
    requestId: req.requestId ?? null,
    userId,
    route:     req.originalUrl ?? req.path,
    timestamp: new Date(wpDiagStartedAt).toISOString(),
  });

  const stepHistory = await mergeStepHistory(userId, 'complete');

  const [{ data: progressRow }, { data: profileRow }] = await Promise.all([
    supabase.from('onboarding_progress').select('*').eq('id', userId).maybeSingle(),
    supabase.from('user_profiles').select('*').eq('id', userId).maybeSingle(),
  ]);

  // WP-DIAG-01 TEMP — counts only, no field values (mask sensitive data).
  logger.info('[WP-DIAG] completeOnboarding rows loaded', {
    requestId:         req.requestId ?? null,
    userId,
    educationCount:    Array.isArray(progressRow?.education) ? progressRow.education.length : 0,
    experienceCount:   Array.isArray(progressRow?.experience) ? progressRow.experience.length
                        : Array.isArray(profileRow?.experience) ? profileRow.experience.length : 0,
    expectedRoleCount: Array.isArray(profileRow?.expected_role_ids) ? profileRow.expected_role_ids.length : 0,
    careerHistoryCount: Array.isArray(profileRow?.career_history) ? profileRow.career_history.length : 0,
  });

  let completionResult;
  try {
    completionResult = await persistCompletionIfReady(userId, progressRow || {}, profileRow || {});
  } catch (err) {
    // WP-DIAG-01 TEMP
    logger.warn('[WP-DIAG] completeOnboarding failed', {
      requestId: req.requestId ?? null,
      userId,
      elapsedMs: Date.now() - wpDiagStartedAt,
      error:     err.message,
    });
    throw err;
  }

  // WP-PRO-12A-2 FIX: completeOnboarding() previously always returned a
  // hardcoded `{ step: 'complete', stepHistory }` payload regardless of
  // whether onboarding was actually complete, and never populated the
  // frontend's declared CompleteOnboardingResponse fields (`isComplete`,
  // `completion`). It now reflects whatever persistCompletionIfReady()
  // (backed by the unmodified evaluateCompletion()) actually determined.
  const isComplete = completionResult?.isComplete === true;

  // WP-DIAG-01 TEMP
  logger.info('[WP-DIAG] completeOnboarding completed successfully', {
    requestId:  req.requestId ?? null,
    userId,
    elapsedMs:  Date.now() - wpDiagStartedAt,
    isComplete,
  });

  return res.status(200).json({
    success: true,
    data: {
      step:        isComplete ? 'complete' : 'incomplete',
      isComplete,
      completion:  completionResult
        ? {
          isComplete:       completionResult.isComplete,
          trackA:           completionResult.trackA,
          trackAUpload:     completionResult.trackAUpload,
          trackB:           completionResult.trackB,
          alreadyCompleted: completionResult.alreadyCompleted,
        }
        : null,
      stepHistory,
    },
  });
});

module.exports = {
  uploadCvDuringOnboarding,
  saveConsent,
  saveQuickStart,
  saveEducationAndExperience,
  saveDraft,
  getDraft,
  saveCvDraft,
  generateCareerReport,
  savePersonalDetails,
  getCvPreview,
  generateCV,
  getCvSignedUrl,
  skipCv,
  getProgress,
  getChiExplainer,
  saveCareerIntent,
  validateCvFileEndpoint,
  importLinkedIn,
  confirmLinkedInImport,
  suggestRoles,
  getTeaserChi,
  getChiReady,
  getCareerReportStatus,
  getFunnelAnalytics,
  completeOnboarding,
  saveGuidedBuilderSection,
  getGuidedBuilderProfile,
};