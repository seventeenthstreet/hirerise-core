'use strict';

const { supabase } = require('../../config/supabase'); // ✅ FIXED
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

// ─────────────────────────────────────────────
// STORAGE UPLOAD (SAFE)
// ─────────────────────────────────────────────
async function uploadToStorage(storagePath, pdfBuffer) {

  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true
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
    expires_at: new Date(Date.now() + URL_TTL_MS).toISOString()
  };
}

// ─────────────────────────────────────────────
// GENERATE CV
// ─────────────────────────────────────────────
async function generateCV(userId, creditCost, idempotencyKey = null, userTier = 'free') {

  if (!userId) throw new AppError('userId required', 400);

  const cached = await checkIdempotencyKey(userId, 'generateCV', idempotencyKey);
  if (cached) return cached;

  // ✅ FIXED TABLES
  const [progressRes, profileRes] = await Promise.all([
    supabase.from('onboarding_progress').select('*').eq('id', userId).maybeSingle(),
    supabase.from('user_profiles').select('*').eq('id', userId).maybeSingle(),
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

  let cvContent;
  const startMs = Date.now();

  try {
    const anthropic = require('../../config/anthropic.client');

    const response = await callAnthropicWithRetry(() =>
      anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: JSON.stringify({ data, aiContext })
        }]
      }),
      { module: 'generateCV', userId }
    );

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    cvContent = JSON.parse(stripJson(rawText));

    if (creditCost) {
      await deductCredits(userId, creditCost, idempotencyKey);
    }

  } catch (err) {
    logAIInteraction({
      module: 'generateCV',
      latencyMs: Date.now() - startMs,
      status: 'error',
      error: err,
      userId,
    });

    throw new AppError('AI generation failed', 502);
  }

  // ── PDF GENERATION ─────────────────────────
  const html = `<html><body>${JSON.stringify(cvContent)}</body></html>`;
  const pdfBuffer = Buffer.from(html);

  const resumeId = crypto.randomUUID();
  const storagePath = `${userId}/${resumeId}.pdf`;

  const upload = await uploadToStorage(storagePath, pdfBuffer);

  const now = new Date().toISOString();

  // ✅ FIXED SCHEMA
  const resumeDoc = {
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

  // ✅ SAFE WRITES
  await Promise.all([

    supabase
      .from('resumes')
      .insert(resumeDoc)
      .select(),

    supabase
      .from('onboarding_progress')
      .upsert({
        id: userId,
        step: 'cv_generated',
        cv_resume_id: resumeId,
        updated_at: now,
      }, { onConflict: 'id' }),

    supabase
      .from('users')
      .upsert({
        id: userId,
        resume_uploaded: true,
        latest_resume_id: resumeId,
        updated_at: now,
      }, { onConflict: 'id' }),
  ]);

  emitOnboardingEvent(userId, 'onboarding_step_completed', {
    step: 'cv_generated'
  });

  triggerResumeScoring(userId, resumeId);

  const result = {
    userId,
    resumeId,
    fileUrl: upload.file_url,
    step: 'cv_generated',
  };

  await saveIdempotencyKey(userId, 'generateCV', idempotencyKey, result);

  return result;
}

// ─────────────────────────────────────────────
// GET SIGNED URL
// ─────────────────────────────────────────────
async function getCvSignedUrl(userId) {

  const { data: progress, error } = await supabase
    .from('onboarding_progress')
    .select('cv_resume_id')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;

  if (!progress?.cv_resume_id) {
    throw new AppError('No CV found', 404);
  }

  const { data: resume } = await supabase
    .from('resumes')
    .select('*')
    .eq('id', progress.cv_resume_id)
    .maybeSingle();

  if (!resume) throw new AppError('Resume not found', 404);

  const expiresIn = Math.floor(URL_TTL_MS / 1000);

  const { data } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(resume.storage_path, expiresIn);

  return {
    userId,
    resumeId: resume.id,
    fileUrl: data?.signedUrl
  };
}

module.exports = {
  generateCV,
  getCvSignedUrl
};
