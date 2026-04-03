'use strict';

const { supabase } = require('../../config/supabase');
const crypto = require('crypto');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const { logAIInteraction } = require('../../infrastructure/aiLogger');
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

const STORAGE_BUCKET = 'resumes';
const TABLE_PROGRESS = 'onboarding_progress';
const TABLE_USERS = 'users';
const TABLE_RESUMES = 'resumes';

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
    throw new AppError(
      'Failed to generate signed URL',
      500,
      {},
      ErrorCodes.STORAGE_ERROR
    );
  }

  return {
    file_url: data.signedUrl,
    expires_at: new Date(Date.now() + URL_TTL_MS).toISOString(),
  };
}

/**
 * Replace this with your real PDF generator service.
 * Must return valid binary PDF bytes.
 */
async function renderCvPdf(cvContent) {
  const pdfHeader = '%PDF-1.4\n';
  const body = JSON.stringify(cvContent, null, 2);
  return Buffer.from(`${pdfHeader}${body}\n%%EOF`);
}

async function generateCV(
  userId,
  creditCost,
  idempotencyKey = null,
  userTier = 'free'
) {
  if (!userId) {
    throw new AppError(
      'userId required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const cached = await checkIdempotencyKey(
    userId,
    'generateCV',
    idempotencyKey
  );
  if (cached) return cached;

  const [progressRes, profileRes] = await Promise.all([
    supabase
      .from(TABLE_PROGRESS)
      .select('*')
      .eq('id', userId)
      .maybeSingle(),

    supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle(),
  ]);

  if (progressRes.error) throw progressRes.error;
  if (profileRes.error) throw profileRes.error;
  if (!progressRes.data) {
    throw new AppError('No onboarding data found', 404);
  }

  const data = progressRes.data;
  const profile = profileRes.data || {};

  if (!data.personal_details?.full_name) {
    throw new AppError('Personal details missing', 422);
  }

  const aiContext = buildAIContext(data, profile);
  const startMs = Date.now();

  let cvContent;
  try {
    const anthropic = require('../../config/anthropic.client');

    const response = await callAnthropicWithRetry(
      () =>
        anthropic.messages.create({
          model: MODEL,
          max_tokens: 2048,
          messages: [
            {
              role: 'user',
              content: JSON.stringify({ data, aiContext }),
            },
          ],
        }),
      { module: 'generateCV', userId }
    );

    const rawText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    cvContent = JSON.parse(stripJson(rawText));

    if (creditCost > 0) {
      await deductCredits(userId, creditCost, idempotencyKey);
    }

    logAIInteraction({
      module: 'generateCV',
      latencyMs: Date.now() - startMs,
      status: 'success',
      userId,
    });

  } catch (err) {
    logAIInteraction({
      module: 'generateCV',
      latencyMs: Date.now() - startMs,
      status: 'error',
      error: err,
      userId,
    });

    logger.error('[CVService] generateCV failed', {
      userId,
      err: err.message,
    });

    throw new AppError('AI generation failed', 502);
  }

  const pdfBuffer = await renderCvPdf(cvContent);

  const resumeId = crypto.randomUUID();
  const storagePath = `${userId}/${resumeId}.pdf`;
  const upload = await uploadToStorage(storagePath, pdfBuffer);

  const now = new Date().toISOString();

  const resumeRow = {
    id: resumeId,
    user_id: userId,
    file_url: upload.file_url,
    storage_path: storagePath,
    signed_url_expires_at: upload.expires_at,
    mimetype: 'application/pdf',
    resume_text: JSON.stringify(cvContent),
    cv_content_structured: cvContent,
    created_at: now,
    updated_at: now,
    soft_deleted: false,
  };

  const writes = await Promise.all([
    supabase.from(TABLE_RESUMES).insert(resumeRow),
    supabase.from(TABLE_PROGRESS).upsert({
      id: userId,
      step: 'cv_generated',
      cv_resume_id: resumeId,
      updated_at: now,
    }),
    supabase.from(TABLE_USERS).upsert({
      id: userId,
      resume_uploaded: true,
      latest_resume_id: resumeId,
      updated_at: now,
    }),
  ]);

  const failed = writes.find(r => r.error);
  if (failed?.error) throw failed.error;

  emitOnboardingEvent(userId, 'onboarding_step_completed', {
    step: 'cv_generated',
  });

  triggerResumeScoring(userId, resumeId);

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

async function getCvSignedUrl(userId) {
  const { data: progress, error } = await supabase
    .from(TABLE_PROGRESS)
    .select('cv_resume_id')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  if (!progress?.cv_resume_id) {
    throw new AppError('No CV found', 404);
  }

  const { data: resume, error: resumeErr } = await supabase
    .from(TABLE_RESUMES)
    .select('id, storage_path')
    .eq('id', progress.cv_resume_id)
    .maybeSingle();

  if (resumeErr) throw resumeErr;
  if (!resume) throw new AppError('Resume not found', 404);

  const expiresIn = Math.floor(URL_TTL_MS / 1000);

  const { data, error: signedErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(resume.storage_path, expiresIn);

  if (signedErr) throw signedErr;

  return {
    userId,
    resumeId: resume.id,
    fileUrl: data?.signedUrl,
  };
}

module.exports = {
  generateCV,
  getCvSignedUrl,
};