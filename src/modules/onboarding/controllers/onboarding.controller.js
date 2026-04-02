'use strict';

/**
 * onboarding.controller.js — UPDATED (Phase 1)
 *
 * Phase 1 additions:
 *   saveQuickStart      — P1-01: minimal 4-field save → provisional CHI
 *   suggestRoles        — P1-05: role suggestions from job title
 *   getTeaserChi        — P1-06: industry-average CHI snapshot
 *
 * MIGRATED: All Firestore db.collection() calls replaced with supabase.from()
 * FieldValue.serverTimestamp() → new Date().toISOString()
 * batch()                      → Promise.all([...])
 */

const onboardingService = require('../onboarding.service');
const { suggestRolesForOnboarding } = require('../../roles/roles.service'); // P1-05

function _safeUserId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

// POST /api/v1/onboarding/consent  (PROMPT-2)
async function saveConsent(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.saveConsent(userId, req.body);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/quick-start  (P1-01)
// Body: { jobTitle, company, startDate, expectedRoleIds[], skills[], isCurrent?, targetRoleFreeText? }
// Returns immediately with chiStatus: 'generating' — CHI fires async in background.
async function saveQuickStart(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.saveQuickStart(userId, req.body);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/education-experience
async function saveEducationAndExperience(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.saveEducationAndExperience(userId, req.body);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// PATCH /api/v1/onboarding/draft  (GAP F5)
async function saveDraft(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.saveDraft(userId, req.body);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/career-report
async function generateCareerReport(req, res, next) {
  try {
    const userId         = _safeUserId(req);
    const idempotencyKey = req.headers['idempotency-key'] || null;
    const userTier       = req.user?.normalizedTier ?? req.user?.plan ?? 'free';
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.generateCareerReport(userId, req.creditCost, idempotencyKey, userTier);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/personal-details
async function savePersonalDetails(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const authEmail = req.user?.email || null;
    const result = await onboardingService.savePersonalDetails(userId, req.body, authEmail);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/cv-preview  (GAP F4)
async function getCvPreview(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.getCvPreview(userId);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/generate-cv
async function generateCV(req, res, next) {
  try {
    const userId         = _safeUserId(req);
    const idempotencyKey = req.headers['idempotency-key'] || null;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const userTier = req.user?.normalizedTier ?? req.user?.plan ?? 'free';
    const result = await onboardingService.generateCV(userId, req.creditCost, idempotencyKey, userTier);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/cv-url  (GAP T5)
async function getCvSignedUrl(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.getCvSignedUrl(userId);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/skip-cv
async function skipCv(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.skipCv(userId);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/progress
async function getProgress(req, res, next) {
  try {
    const userId = _safeUserId(req);
    const tier   = req.user?.plan ?? 'free';
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.getProgress(userId, tier);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/chi-explainer  (G-14)
async function getChiExplainer(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.getChiExplainer(userId);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/career-intent
async function saveCareerIntent(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.saveCareerIntent(userId, req.body);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// ─── CV Personal Detail Extraction ────────────────────────────────────────────
// Uses the local Resume Parser Engine (zero API cost) first.
// Falls back to Claude Haiku only when confidenceScore < 50 (needsAIParsing = true)
// and ENABLE_AI_CV_FALLBACK env var is set to "true".
//
// Free users: local parser only (no AI cost).
// Paid users or low-confidence CVs: local parser + optional AI enhancement.

const { parseResumeText, mapParsedToOnboardingShape } = require('../../../services/resumeParser');

const AI_FALLBACK_PROMPT = `You are a precise CV data extractor.
Given raw CV/resume text, extract the MISSING fields only (marked null below).
Return ONLY valid JSON. No preamble, no markdown, no explanation.

Improve only: fullName, email, phone, city, country, linkedInUrl, portfolioUrl,
languages (spoken, not programming), professionalSummary, currentJobTitle, currentCompany, yearsOfExperience.

Return the same structure — null for fields you cannot confidently determine.`;

async function _extractCvPersonalDetails(resumeText, userId) {
  const logger = require('../../../utils/logger');

  // ── Step 1: Local parser (zero cost, < 50ms) ──────────────────────────────
  let parsed;
  let onboardingShape;
  try {
    parsed          = parseResumeText(resumeText);
    onboardingShape = mapParsedToOnboardingShape(parsed);

    logger.info('[OnboardingController] Local CV parser complete', {
      userId,
      confidenceScore: parsed.confidenceScore,
      needsAIParsing:  parsed.needsAIParsing,
      skillsFound:     parsed.skills.length,
      rolesFound:      parsed.detectedRoles.length,
      hasEmail:        !!parsed.email,
      hasName:         !!parsed.name,
    });
  } catch (parseErr) {
    logger.warn('[OnboardingController] Local CV parser threw — returning null', {
      userId, error: parseErr.message,
    });
    return null;
  }

  // ── Step 2: AI fallback only when needed and enabled ─────────────────────
  const aiEnabled = process.env.ENABLE_AI_CV_FALLBACK === 'true';
  if (parsed.needsAIParsing && aiEnabled && process.env.NODE_ENV !== 'test') {
    try {
      const anthropic = require('../../../config/anthropic.client');
      const sample    = resumeText.trim().slice(0, 5000);

      const partialResult = JSON.stringify({
        fullName:    onboardingShape.personalDetails.fullName,
        email:       onboardingShape.personalDetails.email,
        phone:       onboardingShape.personalDetails.phone,
        city:        onboardingShape.personalDetails.city,
        country:     onboardingShape.personalDetails.country,
        linkedInUrl: onboardingShape.personalDetails.linkedInUrl,
        portfolioUrl:onboardingShape.personalDetails.portfolioUrl,
        languages:   [],
        professionalSummary: onboardingShape.personalDetails.professionalSummary,
        currentJobTitle:  parsed.detectedRoles[0] || null,
        currentCompany:   null,
        yearsOfExperience: parsed.yearsExperience,
      }, null, 2);

      const response = await anthropic.messages.create({
        model:      process.env.CV_EXTRACT_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system:     AI_FALLBACK_PROMPT,
        messages:   [{
          role: 'user',
          content: `CV Text:\n${sample}\n\nCurrent extraction (improve nulls only):\n${partialResult}`,
        }],
      });

      const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const clean   = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const aiParsed = JSON.parse(clean);

      // Merge: AI fills only the fields that local parser left null
      const pd = onboardingShape.personalDetails;
      onboardingShape.personalDetails = {
        fullName:            pd.fullName            || aiParsed.fullName            || null,
        email:               pd.email               || aiParsed.email               || null,
        phone:               pd.phone               || aiParsed.phone               || null,
        city:                pd.city                || aiParsed.city                || null,
        country:             pd.country             || aiParsed.country             || null,
        linkedInUrl:         pd.linkedInUrl         || aiParsed.linkedInUrl         || null,
        portfolioUrl:        pd.portfolioUrl        || aiParsed.portfolioUrl        || null,
        languages:           pd.languages?.length   ? pd.languages : (aiParsed.languages || []),
        professionalSummary: pd.professionalSummary || aiParsed.professionalSummary || null,
      };

      if (!parsed.yearsExperience && aiParsed.yearsOfExperience) {
        onboardingShape.parsedResume.yearsExperience = aiParsed.yearsOfExperience;
      }

      logger.info('[OnboardingController] AI CV fallback applied', { userId });

    } catch (aiErr) {
      logger.warn('[OnboardingController] AI CV fallback failed — using local result', {
        userId, error: aiErr.message,
      });
      // Continue with local-only result
    }
  }

  // ── Return in the shape the caller expects ────────────────────────────────
  const pd = onboardingShape.personalDetails;
  return {
    fullName:            pd.fullName,
    email:               pd.email,
    phone:               pd.phone,
    city:                pd.city,
    country:             pd.country,
    linkedInUrl:         pd.linkedInUrl,
    portfolioUrl:        pd.portfolioUrl,
    languages:           pd.languages || [],
    professionalSummary: pd.professionalSummary,
    skills:              onboardingShape.skills.map(s => s.name),
    currentJobTitle:     parsed.detectedRoles[0] || null,
    currentCompany:      null,
    yearsOfExperience:   parsed.yearsExperience || onboardingShape.parsedResume.yearsExperience || null,
    // Career fields for Step 2 pre-fill
    industry:            parsed.industry       || null,
    educationLevel:      parsed.educationLevel || null,
    // Extra fields stored in Supabase for CHI and analytics
    _parsedResume:       onboardingShape.parsedResume,
  };
}

// POST /api/v1/onboarding/validate-cv
// Pure validation — no DB writes, no side effects.
// Accepts multipart resume file, extracts text, runs classifier.
// Returns ClassificationResult JSON.
async function validateCvFileEndpoint(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    const { classifyDocument } = require('../../services/cvClassifier.service');
    const logger = require('../../../utils/logger');

    // Extract text from the buffer (PDF + DOCX both supported)
    let text = '';
    try {
      const ext = (req.file.originalname || '').split('.').pop()?.toLowerCase();
      if (ext === 'pdf' || req.file.mimetype === 'application/pdf') {
        const pdfParse = require('pdf-parse');
        const parsed   = await pdfParse(req.file.buffer);
        text = parsed.text || '';
      } else {
        // DOCX / DOC — mammoth handles both
        const mammoth = require('mammoth');
        const result  = await mammoth.extractRawText({ buffer: req.file.buffer });
        text = result.value || '';
      }
    } catch (extractErr) {
      logger.warn('[validateCvFileEndpoint] Text extraction failed', { error: extractErr.message });
      // Return a safe "unreadable" response — client shows the scanned-PDF message
      return res.json({
        success: true,
        data: {
          is_cv:             false,
          confidence:        80,
          document_type:     'other',
          reason:            'Could not extract text from this file. It may be a scanned image PDF.',
          detected_sections: [],
        },
      });
    }

    if (!text || text.trim().length < 40) {
      return res.json({
        success: true,
        data: {
          is_cv:             false,
          confidence:        85,
          document_type:     'other',
          reason:            'File contains no readable text. Please upload a text-based resume.',
          detected_sections: [],
        },
      });
    }

    const result = await classifyDocument(text);
    logger.info('[validateCvFileEndpoint] Classification complete', {
      document_type: result.document_type,
      confidence: result.confidence,
      is_cv: result.is_cv,
    });

    return res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

// POST /api/v1/onboarding/upload-cv  (GAP-11)
// FIX: After uploading the CV, extract personal details from resumeText using Claude Haiku
// and pre-populate onboardingProgress.personalDetails so the personal_upload step
// shows pre-filled fields instead of blank ones.
async function uploadCvDuringOnboarding(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

    // ── CV classifier gate: reject non-CV documents before storing ─────────
    try {
      const { classifyDocument } = require('../../services/cvClassifier.service');
      const logger = require('../../../utils/logger');
      let cvText = '';
      try {
        const ext = (req.file.originalname || '').split('.').pop()?.toLowerCase();
        if (ext === 'pdf' || req.file.mimetype === 'application/pdf') {
          const pdfParse = require('pdf-parse');
          const parsed   = await pdfParse(req.file.buffer);
          cvText = parsed.text || '';
        } else {
          const mammoth = require('mammoth');
          const result  = await mammoth.extractRawText({ buffer: req.file.buffer });
          cvText = result.value || '';
        }
      } catch { /* extraction failure is non-fatal — proceed to upload */ }

      if (cvText && cvText.trim().length >= 40) {
        const classification = await classifyDocument(cvText, { skipAi: false });
        logger.info('[uploadCvDuringOnboarding] CV classification', {
          userId, is_cv: classification.is_cv, confidence: classification.confidence,
          document_type: classification.document_type,
        });

        // Reject only when we're sure it's not a CV (confidence >= 75)
        if (!classification.is_cv && classification.confidence >= 75) {
          const typeMessages = {
            invoice:         'This file appears to be an invoice, not a CV.',
            cover_letter:    'This file appears to be a cover letter, not a CV. Please upload your resume.',
            random_document: 'This file does not appear to be a CV or resume.',
          };
          const msg = typeMessages[classification.document_type]
            || 'This file does not appear to be a valid CV or resume. Please upload a document that includes your experience, skills, or education.';

          return res.status(400).json({
            success:        false,
            message:        msg,
            classification,
          });
        }
      }
    } catch (classifyErr) {
      // Non-fatal: if classifier fails, proceed with normal upload
      require('../../../utils/logger').warn('[uploadCvDuringOnboarding] Classifier error — proceeding', {
        userId, error: classifyErr.message,
      });
    }

    const { uploadResume } = require('../../resume/resume.service');
    const uploadResult = await uploadResume(userId, req.file);

    const { supabase } = require('../../../config/supabase');
    const { appendStepHistory, mergeStepHistory, persistCompletionIfReady } = require('../onboarding.service');

    // ── FIX: Extract personal details from the uploaded CV text ───────────────
    let extractedDetails = null;
    let extractedSkills  = [];

    try {
      // Primary: use resumeText returned directly by uploadResume() — no DB roundtrip needed
      // Fallback: read from the stored Supabase row if resume_text column exists
      let resumeText = uploadResult.resumeText || null;

      if (!resumeText) {
        const { data: resumeRow, error: resumeErr } = await supabase
          .from('resumes')
          .select('resumeText, content, parsedData')
          .eq('id', uploadResult.resumeId)
          .maybeSingle();
        if (resumeErr && resumeErr.code !== 'PGRST116') {
          require('../../../utils/logger').warn('[OnboardingController] Resume fetch error', { userId, error: resumeErr.message });
        }
        resumeText = resumeRow?.resumeText
          || resumeRow?.content?.resumeText
          || null;

        if (!resumeText || resumeText.trim().length <= 50) {
          // Fallback: use parsedData already stored by uploadResume()
          const pd = resumeRow?.parsedData || resumeRow?.content?.parsedData;
          if (pd) {
            require('../../../utils/logger').info('[OnboardingController] Using stored parsedData as fallback', { userId });
            if (pd.skills?.length) extractedSkills = pd.skills.slice(0, 20).map(s => ({ name: String(s).trim(), proficiency: 'intermediate' }));
            extractedDetails = {
              fullName:    pd.name  || null,
              email:       pd.email || null,
              phone:       pd.phone || null,
              city:        pd.location?.city    || null,
              country:     pd.location?.country || null,
              linkedInUrl: pd.linkedInUrl  || null,
              portfolioUrl:pd.portfolioUrl || null,
              languages:   [],
              professionalSummary: null,
              skills:      pd.skills || [],
              currentJobTitle:    pd.detectedRoles?.[0] || null,
              currentCompany:     null,
              yearsOfExperience:  pd.yearsExperience || null,
              industry:           null,
              educationLevel:     null,
              _parsedResume: pd,
            };
          }
        }
      }

      if (resumeText && resumeText.trim().length > 50) {
        extractedDetails = await _extractCvPersonalDetails(resumeText, userId);
        if (extractedDetails?.skills?.length) {
          extractedSkills = extractedDetails.skills.map(name => ({
            name:        String(name).trim(),
            proficiency: 'intermediate',
          })).filter(s => s.name).slice(0, 20);
        }
      }
    } catch (extractErr) {
      // Non-fatal — upload still succeeds, user fills in details manually
      require('../../../utils/logger').warn('[OnboardingController] CV detail extraction fetch failed', {
        userId, resumeId: uploadResult.resumeId, error: extractErr.message,
      });
    }

    // ── Build the pre-populated personal details object ───────────────────────
    const preFilledPersonalDetails = extractedDetails ? {
      fullName:            extractedDetails.fullName    || null,
      email:               extractedDetails.email       || null,
      phone:               extractedDetails.phone       || null,
      city:                extractedDetails.city        || null,
      country:             extractedDetails.country     || null,
      linkedInUrl:         extractedDetails.linkedInUrl || null,
      portfolioUrl:        extractedDetails.portfolioUrl|| null,
      languages:           Array.isArray(extractedDetails.languages) ? extractedDetails.languages.filter(Boolean) : [],
      professionalSummary: extractedDetails.professionalSummary || null,
    } : {};

    const nowISO = new Date().toISOString();
    const stepHistory = await mergeStepHistory(userId, 'cv_uploaded');

    const progressUpdate = {
      id:         userId,
      step:       'cv_uploaded',
      cvResumeId: uploadResult.resumeId,
      wantsCv:    true,
      stepHistory,
      updatedAt:  nowISO,
    };

    // Only write personalDetails if we successfully extracted something
    if (extractedDetails && Object.values(preFilledPersonalDetails).some(v => v !== null && v !== undefined)) {
      progressUpdate.personalDetails = preFilledPersonalDetails;
    }

    // Write extracted skills if found
    if (extractedSkills.length > 0) {
      progressUpdate.skills = extractedSkills;
    }

    // Write extracted career info to userProfiles for CHI pre-seeding (fire-and-forget)
    if (extractedDetails?.currentJobTitle || extractedDetails?.yearsOfExperience) {
      supabase.from('userProfiles').upsert({
        id:         userId,
        ...(extractedDetails.currentJobTitle    ? { currentJobTitle:    extractedDetails.currentJobTitle }    : {}),
        ...(extractedDetails.currentCompany     ? { currentCompany:     extractedDetails.currentCompany }     : {}),
        ...(extractedDetails.yearsOfExperience  ? { yearsOfExperience:  extractedDetails.yearsOfExperience }  : {}),
        updatedAt:  nowISO,
      }).then(({ error }) => {
        if (error) require('../../../utils/logger').warn('[OnboardingController] userProfiles career pre-seed failed', { userId, error: error.message });
      });
    }

    const { error: progressErr } = await supabase.from('onboardingProgress').upsert(progressUpdate);
    if (progressErr) {
      require('../../../utils/logger').error('[DB] onboardingProgress.upsert (upload-cv) failed', { userId, error: progressErr.message });
    }

    const [{ data: progressRow }, { data: profileRow }] = await Promise.all([
      supabase.from('onboardingProgress').select('*').eq('id', userId).maybeSingle(),
      supabase.from('userProfiles').select('*').eq('id', userId).maybeSingle(),
    ]);
    await persistCompletionIfReady(userId, progressRow || {}, profileRow || {});

    return res.status(201).json({
      success: true,
      data: {
        userId,
        resumeId:         uploadResult.resumeId,
        fileUrl:          uploadResult.fileUrl ?? null,
        step:             'cv_uploaded',
        message:          'Your CV has been uploaded. Career Health Index will generate shortly.',
        // Return extracted data so frontend can pre-fill without a separate fetch
        extractedDetails: extractedDetails ? {
          fullName:    preFilledPersonalDetails.fullName,
          email:       preFilledPersonalDetails.email,
          phone:       preFilledPersonalDetails.phone,
          city:        preFilledPersonalDetails.city,
          country:     preFilledPersonalDetails.country,
          linkedInUrl: preFilledPersonalDetails.linkedInUrl,
          portfolioUrl:preFilledPersonalDetails.portfolioUrl,
          languages:   preFilledPersonalDetails.languages,
          professionalSummary: preFilledPersonalDetails.professionalSummary,
          skills:      extractedSkills,
          // Career fields — used by career-onboarding Step 2 to pre-fill the form
          jobTitle:       extractedDetails.currentJobTitle    || null,
          industry:       extractedDetails.industry           || null,
          educationLevel: extractedDetails.educationLevel     || null,
          yearsExperience:extractedDetails.yearsOfExperience  || null,
        } : null,
      },
    });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/import-linkedin  (SPRINT-3 H8)
async function importLinkedIn(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let payload = req.body;
    if (req.file?.buffer) {
      try {
        payload = JSON.parse(req.file.buffer.toString('utf8'));
      } catch {
        return res.status(400).json({ success: false, message: 'Could not parse LinkedIn export file as JSON. Please upload the JSON export from LinkedIn Settings → Data Privacy → Get a copy of your data.' });
      }
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ success: false, message: 'Request body must be a LinkedIn profile JSON object.' });
    }

    const result = await onboardingService.importLinkedIn(userId, payload);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/suggest-roles  (P1-05)
// Query: ?q=<jobTitle>&limit=<max>
// Returns role suggestions with confidence scores for Quick Start pre-fill.
async function suggestRoles(req, res, next) {
  try {
    const { q, limit } = req.query;
    const parsedLimit  = limit ? Math.min(parseInt(limit, 10) || 5, 10) : 5;

    if (!q || !String(q).trim()) {
      return res.status(200).json({ success: true, data: { suggestions: [], total: 0 } });
    }

    const result = await suggestRolesForOnboarding({
      jobTitle: String(q).trim(),
      limit:    parsedLimit,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/teaser-chi  (P1-06)
// Query: ?jobFamilyId=<id>  (optional — defaults to 'general')
async function getTeaserChi(req, res, next) {
  try {
    const { jobFamilyId } = req.query;
    const result = await onboardingService.getTeaserChi(jobFamilyId || null);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/chi-ready  (P2-05)
async function getChiReady(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.getChiReady(userId);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/career-report/status  (P2-07)
async function getCareerReportStatus(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.getCareerReportStatus(userId);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// POST /api/v1/onboarding/import-linkedin/confirm  (P3-02)
async function confirmLinkedInImport(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.confirmLinkedInImport(userId);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/draft  (P3-04)
async function getDraft(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.getDraft(userId);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// PATCH /api/v1/onboarding/cv-draft  (P3-07)
async function saveCvDraft(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const result = await onboardingService.saveCvDraft(userId, req.body);
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}

// GET /api/v1/onboarding/analytics/funnel  (P4-04)
// Admin-only: onboarding funnel conversion rates + drop-off by step.
// B-06 FIX: mandatory date range params (from + to) prevents full-collection scan at scale.
async function getFunnelAnalytics(req, res, next) {
  try {
    const { from, to, after } = req.query;
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 500, 2000) : 500;

    // B-06: Require date range to prevent unbounded collection scan at >10k users.
    if (!from || !to) {
      return res.status(400).json({
        success: false,
        error: 'Query params "from" and "to" are required (ISO date, e.g. 2025-01-01).',
      });
    }

    const fromDate = new Date(from);
    const toDate   = new Date(to);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date format. Use ISO 8601 (e.g. 2025-01-01).',
      });
    }

    if (fromDate > toDate) {
      return res.status(400).json({
        success: false,
        error: '"from" must be earlier than "to".',
      });
    }

    const result = await onboardingService.getFunnelAnalytics({ limit, after: after || null, fromDate, toDate });
    return res.status(200).json({ success: true, data: result });
  } catch (err) { return next(err); }
}


// POST /api/v1/onboarding/complete
// Explicitly marks onboarding complete for the CV-upload (Track A) path.
// The manual path uses generateCareerReport → persistCompletionIfReady.
// The upload path has no career report step in the 2-step UI, so we need
// this direct endpoint to write onboardingCompleted to the users table
// that GET /users/me reads from.
async function completeOnboarding(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { supabase } = require('../../../config/supabase');
    const logger   = require('../../../utils/logger');
    const { mergeStepHistory } = require('../onboarding.helpers');

    const now = new Date().toISOString();
    const stepHistory = await mergeStepHistory(userId, 'onboarding_completed');

    // Write to BOTH tables — users is read by /users/me, userProfiles by services
    await Promise.all([
      supabase.from('users').upsert({
        id:                    userId,
        onboardingCompleted:   true,
        onboardingCompletedAt: now,
        updatedAt:             now,
      }),
      supabase.from('userProfiles').upsert({
        id:                    userId,
        onboardingCompleted:   true,
        onboardingCompletedAt: now,
        updatedAt:             now,
      }),
      supabase.from('onboardingProgress').upsert({
        id:          userId,
        step:        'completed',
        completedAt: now,
        stepHistory,
        updatedAt:   now,
      }),
    ]);

    logger.info('[OnboardingController] completeOnboarding — marked complete', { userId });

    return res.status(200).json({
      success: true,
      data: { userId, step: 'completed', message: 'Onboarding complete.' },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  saveConsent,
  saveQuickStart,              // P1-01
  saveEducationAndExperience,
  saveDraft,
  getDraft,                    // P3-04
  generateCareerReport,
  savePersonalDetails,
  getCvPreview,
  saveCvDraft,                 // P3-07
  generateCV,
  getCvSignedUrl,
  skipCv,
  getProgress,
  getChiExplainer,
  saveCareerIntent,
  uploadCvDuringOnboarding,
  validateCvFileEndpoint,
  importLinkedIn,              // SPRINT-3 H8
  confirmLinkedInImport,       // P3-02
  suggestRoles,                // P1-05
  getTeaserChi,                // P1-06
  getChiReady,                 // P2-05
  getCareerReportStatus,       // P2-07
  getFunnelAnalytics,          // P4-04
  completeOnboarding,
};
