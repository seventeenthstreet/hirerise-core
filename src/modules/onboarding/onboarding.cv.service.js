'use strict';

/**
 * @file src/modules/onboarding/onboarding.cv.service.js
 * Production-ready CV generation service (Phase 1 hardened)
 */

const { supabase } = require('../../config/supabase');
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const {
  authoritativeUpsert,
} = require('../../lib/db/authoritativeMutation');
const {
  logAIInteraction,
} = require('../../infrastructure/aiLogger');
const {
  MODEL,
  URL_TTL_MS,
  callAnthropicWithRetry,
  stripJson,
  checkIdempotencyKey,
  saveIdempotencyKey,
  deductCredits,
  emitOnboardingEvent,
  buildAIContext,
  triggerResumeScoring,
} = require('./onboarding.helpers');

// ── Phase 2: scoring services ────────────────────────────────────────────────
const { computeConfidence } = require('../../services/confidence.utils');
const { computeQuality }    = require('../../services/quality.utils');
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_BUCKET = 'resumes';
const TABLE_PROGRESS = 'onboarding_progress';
const TABLE_USERS = 'users';
const TABLE_RESUMES = 'resumes';

/* =========================
   🔒 NEW: Content Sanitizer
========================= */
function sanitizeCvContent(cv) {
  return {
    ...cv,
    summary: String(cv.summary || '').slice(0, 2000),

    skills: Array.isArray(cv.skills)
      ? cv.skills.slice(0, 50)
      : [],

    experience: Array.isArray(cv.experience)
      ? cv.experience.slice(0, 10)
      : [],

    education: Array.isArray(cv.education)
      ? cv.education.slice(0, 5)
      : [],

    certifications: Array.isArray(cv.certifications)
      ? cv.certifications.slice(0, 10)
      : [],
  };
}

async function uploadToStorage(storagePath, pdfBuffer) {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (error) throw error;

  const expiresIn = Math.floor(URL_TTL_MS / 1000);

  const { data, error: urlErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, expiresIn);

  if (urlErr || !data?.signedUrl) {
    throw new AppError('Failed to generate signed URL', 500);
  }

  return {
    file_url: data.signedUrl,
    expires_at: new Date(Date.now() + URL_TTL_MS).toISOString(),
  };
}

async function renderCvPdf(cvContent) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([595, 842]);
  let y = 790;

  function draw(text, size = 11, isBold = false) {
    page.drawText(String(text || '').slice(0, 120), {
      x: 50,
      y,
      size,
      font: isBold ? bold : font,
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= size + 4;
  }

  if (cvContent.name) draw(cvContent.name, 18, true);
  if (cvContent.email) draw(cvContent.email, 10);
  if (cvContent.phone) draw(cvContent.phone, 10);

  if (cvContent.summary) {
    draw('SUMMARY', 12, true);
    draw(cvContent.summary, 10);
  }

  if (cvContent.skills?.length) {
    draw('SKILLS', 12, true);
    draw(cvContent.skills.join(', '), 10);
  }

  if (cvContent.experience?.length) {
    draw('EXPERIENCE', 12, true);
    cvContent.experience.forEach(e => {
      draw(`${e.title || ''} - ${e.company || ''}`, 10, true);
      draw(e.description || '', 9);
    });
  }

  if (cvContent.education?.length) {
    draw('EDUCATION', 12, true);
    cvContent.education.forEach(e => {
      draw(`${e.degree || ''} - ${e.institution || ''}`, 10);
    });
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

async function generateCV(userId, creditCost, idempotencyKey = null) {
  if (!userId) {
    throw new AppError('userId required', 400);
  }

  const cached = await checkIdempotencyKey(
    userId,
    'generateCV',
    idempotencyKey
  );
  if (cached) return cached;

  const { data: progress } = await supabase
    .from(TABLE_PROGRESS)
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (!progress) {
    throw new AppError('No onboarding data found', 404);
  }

  const aiContext = buildAIContext(progress);

  let cvContent;

  try {
    const anthropic = require('../../config/anthropic.client');

    const response = await callAnthropicWithRetry(() =>
      anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({ data: progress, aiContext }),
          },
        ],
      })
    );

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    /* =========================
       🔒 FIX 1: Safe JSON Parse
    ========================= */
    let parsed;
    try {
      parsed = JSON.parse(stripJson(rawText));
    } catch (err) {
      logger.error('[CVService] Invalid AI JSON', {
        userId,
        error: err.message,
      });
      throw new AppError('Failed to generate CV content', 502);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new AppError('AI returned invalid CV content', 502);
    }

    cvContent = parsed;

    if (creditCost > 0) {
      await deductCredits(userId, creditCost, idempotencyKey);
    }

    logAIInteraction({
      module: 'generateCV',
      status: 'success',
      userId,
    });
  } catch (err) {
    logger.error('[CVService] generateCV failed', {
      userId,
      error: err.message,
    });
    throw new AppError('AI generation failed', 502);
  }

  /* =========================
     🔒 FIX 2: Sanitize Content
  ========================= */
  const safeContent = sanitizeCvContent(cvContent);

  const pdfBuffer = await renderCvPdf(safeContent);

  const resumeId = crypto.randomUUID();
  const storagePath = `${userId}/${resumeId}.pdf`;

  const upload = await uploadToStorage(storagePath, pdfBuffer);

  // ── Phase 2: Confidence + Quality scoring ──────────────────────────────────
  // safeContent is the generated CV shape — scored on a best-effort basis.
  // Wrapped in try/catch so a scoring failure never breaks CV generation.
  let confidence = null;
  let quality    = null;

  try {
    confidence = computeConfidence(safeContent);
    quality    = computeQuality(safeContent);
  } catch (err) {
    logger.error('[Phase2] CV scoring failed:', err);
  }
  // ───────────────────────────────────────────────────────────────────────────

  await supabase.from(TABLE_RESUMES).insert({
    id: resumeId,
    user_id: userId,
    file_url: upload.file_url,
    storage_path: storagePath,
    cv_content_structured: safeContent,
    // Phase 2 additions — non-breaking new columns
    confidence,
    quality,
    parser_version: confidence?.version || null,
  });

  const result = {
    userId,
    resumeId,
    fileUrl: upload.file_url,
    step: 'cv_generated',
  };

  await saveIdempotencyKey(
    userId,
    'generateCV',
    idempotencyKey,
    result
  );

  return result;
}

module.exports = {
  generateCV,
};