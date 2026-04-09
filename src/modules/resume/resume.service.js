'use strict';

/**
 * src/modules/resume/resume.service.js
 *
 * Final production-grade Supabase-first Resume Service
 * Fully aligned to live snake_case schema + optimized index strategy.
 */

const path = require('path');
const crypto = require('crypto');

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'resumes';
const MAX_BYTES = Number(process.env.RESUME_MAX_BYTES || 10485760);
const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_AI_INPUT_CHARS = 12000;

const getAnthropicClient = () => {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../../config/anthropic.client');
};

function stripJson(text = '') {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ensureSuccess(result, context) {
  if (result?.error) {
    logger.error(`[ResumeService] ${context}`, {
      error: result.error.message
    });

    throw new AppError(
      `${context} failed`,
      500,
      { context, error: result.error.message },
      ErrorCodes.DB_ERROR
    );
  }

  return result.data;
}

async function fetchOwnedResume(userId, resumeId) {
  const result = await supabase
    .from('resumes')
    .select(`
      id,
      user_id,
      content,
      raw_text,
      parsed_data,
      ats_score,
      ats_breakdown,
      target_role,
      is_primary,
      soft_deleted,
      created_at,
      updated_at,
      scored_at
    `)
    .eq('id', resumeId)
    .eq('user_id', userId)
    .eq('soft_deleted', false)
    .maybeSingle();

  if (result.error) {
    throw new AppError(
      'Failed to fetch resume',
      500,
      { resumeId },
      ErrorCodes.DB_ERROR
    );
  }

  if (!result.data) {
    throw new AppError(
      `Resume '${resumeId}' not found`,
      404,
      { resumeId },
      ErrorCodes.NOT_FOUND
    );
  }

  return result.data;
}

async function extractTextFromBuffer(buffer, mimetype, originalname) {
  const ext = path.extname(originalname).toLowerCase();

  if (mimetype === 'text/plain' || ext === '.txt') {
    return buffer.toString('utf-8');
  }

  if (mimetype === 'application/pdf' || ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const result = await pdfParse(buffer, { version: 'v1.10.100' });
    return result.text || '';
  }

  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimetype === 'application/msword' ||
    ext === '.docx' ||
    ext === '.doc'
  ) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }

  throw new AppError(
    `Unsupported file type: ${ext || mimetype}`,
    415,
    {},
    ErrorCodes.VALIDATION_ERROR
  );
}

async function uploadToStorage(buffer, storagePath, mimetype) {
  const uploadResult = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimetype,
      upsert: false
    });

  if (uploadResult.error) {
    throw new AppError(
      'Storage upload failed',
      502,
      {},
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  const signedResult = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (signedResult.error) {
    throw new AppError(
      'Signed URL generation failed',
      502,
      {},
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  return {
    fileUrl: signedResult.data.signedUrl,
    signedUrlExpiresAt: new Date(
      Date.now() + SIGNED_URL_TTL_SECONDS * 1000
    ).toISOString()
  };
}

async function uploadResume(userId, file, options = {}) {
  if (!userId) {
    throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  if (!file?.buffer) {
    throw new AppError('No file uploaded', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  if (file.size > MAX_BYTES) {
    throw new AppError('File too large', 413, {}, ErrorCodes.VALIDATION_ERROR);
  }

  const now = new Date().toISOString();
  const resumeId = crypto.randomUUID();

  const resumeText = await extractTextFromBuffer(
    file.buffer,
    file.mimetype,
    file.originalname
  );

  if (!resumeText || resumeText.trim().length < 50) {
    throw new AppError(
      'Could not extract enough text from resume',
      422,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const ext = path.extname(file.originalname) || '';
  const storagePath = `resumes/${userId}/${resumeId}${ext}`;

  const contentMeta = {
    fileName: file.originalname,
    mimetype: file.mimetype,
    sizeBytes: file.size,
    storagePath,
    fileUrl: null,
    signedUrlExpiresAt: null
  };

  if (process.env.NODE_ENV !== 'test') {
    const storageMeta = await uploadToStorage(
      file.buffer,
      storagePath,
      file.mimetype
    );

    contentMeta.fileUrl = storageMeta.fileUrl;
    contentMeta.signedUrlExpiresAt = storageMeta.signedUrlExpiresAt;
  }

  const row = {
    id: resumeId,
    user_id: userId,
    content: contentMeta,
    raw_text: resumeText.trim(),
    parsed_data: null,
    ats_score: null,
    ats_breakdown: null,
    target_role: options.targetRole ?? null,
    source: 'uploaded',
    version: 1,
    is_primary: false,
    soft_deleted: false,
    created_at: now,
    updated_at: now
  };

  ensureSuccess(
    await supabase.from('resumes').insert(row),
    'resume insert'
  );

  return {
  jobId: resumeId,
  resumeId,
  fileName: file.originalname,
  fileUrl: contentMeta.fileUrl,
  resumeText: resumeText.trim(),
  status: 'pending',
  createdAt: now
};
}

async function scoreResume(userId, resumeId) {
  const resume = await fetchOwnedResume(userId, resumeId);

  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: resume.raw_text.slice(0, MAX_AI_INPUT_CHARS)
      }
    ]
  });

  const raw = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const parsed = JSON.parse(stripJson(raw));
  const scoredAt = new Date().toISOString();

  const mergedParsedData = {
    ...(resume.parsed_data || {}),
    tier: parsed.tier,
    strengths: parsed.strengths,
    improvements: parsed.improvements,
    topSkills: parsed.topSkills,
    estimatedExperienceYears: parsed.estimatedExperienceYears
  };

  ensureSuccess(
    await supabase
      .from('resumes')
      .update({
        ats_score: parsed.score,
        ats_breakdown: parsed.breakdown,
        parsed_data: mergedParsedData,
        scored_at: scoredAt,
        updated_at: scoredAt
      })
      .eq('id', resumeId),
    'resume score update'
  );

  return {
    resumeId,
    ...parsed,
    scoredAt
  };
}

async function analyzeResumeGrowth(userId, payload) {
  const { resumeId, targetRole } = payload || {};
  const resume = await fetchOwnedResume(userId, resumeId);

  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Target Role: ${targetRole}\n\n${resume.raw_text.slice(0, MAX_AI_INPUT_CHARS)}`
      }
    ]
  });

  const raw = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const parsed = JSON.parse(stripJson(raw));
  const signalId = crypto.randomUUID();
  const now = new Date().toISOString();

  ensureSuccess(
    await supabase.from('resume_growth_signals').insert({
      id: signalId,
      user_id: userId,
      resume_id: resumeId,
      target_role: targetRole,
      ...parsed,
      created_at: now
    }),
    'resume growth insert'
  );

  return {
    signalId,
    resumeId,
    ...parsed,
    analyzedAt: now
  };
}

async function refreshSignedUrl(userId, resumeId) {
  const resume = await fetchOwnedResume(userId, resumeId);

  const storagePath = resume.content?.storagePath;
  if (!storagePath) {
    throw new AppError(
      'Resume storage path missing',
      422,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const signedResult = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (signedResult.error) {
    throw new AppError(
      'Failed to refresh signed URL',
      502,
      {},
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  const newExpiry = new Date(
    Date.now() + SIGNED_URL_TTL_SECONDS * 1000
  ).toISOString();

  const updatedContent = {
    ...(resume.content || {}),
    fileUrl: signedResult.data.signedUrl,
    signedUrlExpiresAt: newExpiry
  };

  ensureSuccess(
    await supabase
      .from('resumes')
      .update({
        content: updatedContent,
        updated_at: newExpiry
      })
      .eq('id', resumeId),
    'signed URL refresh'
  );

  return {
    resumeId,
    fileUrl: signedResult.data.signedUrl,
    signedUrlExpiresAt: newExpiry,
    refreshed: true
  };
}

async function listResumes(userId) {
  const rows = ensureSuccess(
    await supabase
      .from('resumes')
      .select(`
        id,
        content,
        parsed_data,
        ats_score,
        ats_breakdown,
        target_role,
        is_primary,
        created_at,
        scored_at
      `)
      .eq('user_id', userId)
      .eq('soft_deleted', false)
      .order('created_at', { ascending: false })
      .limit(50),
    'resume list'
  );

  return {
    items: rows.map((row) => ({
      id: row.id,
      fileName: row.content?.fileName ?? '',
      fileSize: row.content?.sizeBytes ?? 0,
      mimeType: row.content?.mimetype ?? '',
      fileUrl: row.content?.fileUrl ?? null,
      status: row.ats_score != null ? 'completed' : 'pending',
      extractedSkills: row.parsed_data?.topSkills ?? [],
      uploadedAt: toIso(row.created_at),
      analysedAt: toIso(row.scored_at),
      resumeScore: row.ats_score ?? null,
      scoreBreakdown: row.ats_breakdown ?? null,
      improvements: row.parsed_data?.improvements ?? [],
      topSkills: row.parsed_data?.topSkills ?? [],
      isPrimary: row.is_primary ?? false,
      targetRole: row.target_role ?? null
    })),
    total: rows.length
  };
}

async function getResume(userId, resumeId) {
  const row = await fetchOwnedResume(userId, resumeId);

  return {
    id: row.id,
    fileName: row.content?.fileName ?? '',
    fileSize: row.content?.sizeBytes ?? 0,
    mimeType: row.content?.mimetype ?? '',
    fileUrl: row.content?.fileUrl ?? null,
    status: row.ats_score != null ? 'completed' : 'pending',
    extractedSkills: row.parsed_data?.topSkills ?? [],
    uploadedAt: toIso(row.created_at),
    analysedAt: toIso(row.scored_at),
    resumeScore: row.ats_score ?? null,
    scoreBreakdown: row.ats_breakdown ?? null,
    improvements: row.parsed_data?.improvements ?? [],
    topSkills: row.parsed_data?.topSkills ?? [],
    isPrimary: row.is_primary ?? false,
    targetRole: row.target_role ?? null
  };
}

async function deleteResume(userId, resumeId) {
  await fetchOwnedResume(userId, resumeId);

  const now = new Date().toISOString();

  ensureSuccess(
    await supabase
      .from('resumes')
      .update({
        soft_deleted: true,
        updated_at: now
      })
      .eq('id', resumeId),
    'resume soft delete'
  );
}

module.exports = {
  uploadResume,
  scoreResume,
  analyzeResumeGrowth,
  refreshSignedUrl,
  listResumes,
  getResume,
  deleteResume
};