'use strict';

/**
 * src/modules/resume/resume.service.js
 *
 * FIX: Column names in the INSERT were wrong.
 *   - Inserted as `raw_text`   → correct (matches schema)
 *   - But analysis.service was reading `resume_text` → does not exist in schema
 *
 * The resolution chosen here is to make resume.service the source of truth:
 * we insert using the real schema column `raw_text` and ALSO store `file_name`
 * inside the `content` JSONB (already done) so that analysis.service.js can
 * extract it. analysis.service.js has been updated to read `raw_text` via the
 * `content`/`raw_text` columns directly.
 *
 * Additionally: DB inserts previously used ErrorCodes.DB_ERROR which was not
 * defined in errorHandler.js — now it is, but we keep the reference.
 */

const path   = require('path');
const crypto = require('crypto');

const { supabase }            = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger                  = require('../../utils/logger');

const MODEL          = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'resumes';
const MAX_BYTES      = Number(process.env.RESUME_MAX_BYTES || 10485760);
const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_AI_INPUT_CHARS     = 12000;

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
    logger.error(`[ResumeService] ${context}`, { error: result.error.message });

    throw new AppError(
      `${context} failed`,
      500,
      { context, error: result.error.message },
      ErrorCodes.DB_ERROR  // ← now defined in errorHandler.js
    );
  }

  return result.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text extraction (PDF / DOCX / plain text)
// ─────────────────────────────────────────────────────────────────────────────

async function extractTextFromBuffer(buffer, mimetype, originalname) {
  try {
    if (
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      const mammoth = require('mammoth');
      const result  = await mammoth.extractRawText({ buffer });
      return result.value || '';
    }

    if (mimetype === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const result   = await pdfParse(buffer);
      return result.text || '';
    }

    if (mimetype === 'text/plain' || mimetype === 'application/json') {
      return buffer.toString('utf-8');
    }

    // Attempt plain-text decode for unknown types
    return buffer.toString('utf-8');
  } catch (err) {
    logger.warn('[ResumeService] Text extraction failed', {
      mimetype,
      filename: originalname,
      error:    err.message,
    });
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage upload
// ─────────────────────────────────────────────────────────────────────────────

async function uploadToStorage(buffer, storagePath, mimetype) {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimetype,
      upsert:      false,
    });

  if (error) {
    logger.error('[ResumeService] Storage upload failed', { storagePath, error: error.message });
    throw new AppError('File upload failed', 500, { storagePath }, ErrorCodes.DB_ERROR);
  }

  // Generate a signed URL valid for 7 days
  const { data: signedData, error: signedError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  const signedUrlExpiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString();

  if (signedError) {
    logger.warn('[ResumeService] Signed URL generation failed', {
      storagePath,
      error: signedError.message,
    });
  }

  return {
    fileUrl:           signedData?.signedUrl || null,
    signedUrlExpiresAt: signedUrlExpiresAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main upload function
// FIX: column mapping verified against actual schema:
//   raw_text       ← resume plain text (NOT resume_text — that column doesn't exist)
//   content (JSONB) ← file metadata including fileName, mimetype, sizeBytes
//   file_name       ← NOT a schema column; stored inside content JSONB
// ─────────────────────────────────────────────────────────────────────────────

async function uploadResume(userId, file, options = {}) {
  if (!userId) {
    throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  if (!file?.buffer) {
    throw new AppError('No file uploaded', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  if (file.size > MAX_BYTES) {
    throw new AppError('File too large', 413, { maxBytes: MAX_BYTES }, ErrorCodes.VALIDATION_ERROR);
  }

  const now      = new Date().toISOString();
  const resumeId = crypto.randomUUID();

  const resumeText    = await extractTextFromBuffer(file.buffer, file.mimetype, file.originalname);
  const isPdf         = file.mimetype === 'application/pdf';
  const extractedLength = resumeText?.trim().length ?? 0;

  let isScannedPdf = false;

  if (extractedLength < 50) {
    if (isPdf) {
      isScannedPdf = true;
      logger.warn('[ResumeService] Scanned PDF detected', {
        userId,
        fileName: file.originalname,
        extractedLength,
      });
    } else {
      throw new AppError(
        'Could not extract enough text from resume',
        422,
        {},
        ErrorCodes.VALIDATION_ERROR
      );
    }
  }

  logger.info('[ResumeService] Extraction result', {
    userId,
    fileName:    file.originalname,
    charCount:   extractedLength,
    isPdf,
    isScannedPdf,
  });

  const ext         = path.extname(file.originalname) || '';
  const storagePath = `resumes/${userId}/${resumeId}${ext}`;

  // content JSONB holds all file-level metadata
  const contentMeta = {
    fileName:  file.originalname,   // ← analysis.service reads this via content->>'fileName'
    mimetype:  file.mimetype,
    sizeBytes: file.size,
    storagePath,
    fileUrl:             null,
    signedUrlExpiresAt:  null,
  };

  if (process.env.NODE_ENV !== 'test') {
    const storageMeta = await uploadToStorage(file.buffer, storagePath, file.mimetype);

    contentMeta.fileUrl            = storageMeta.fileUrl;
    contentMeta.signedUrlExpiresAt = storageMeta.signedUrlExpiresAt;
  }

  const row = {
    id:           resumeId,
    user_id:      userId,
    content:      contentMeta,       // JSONB, includes fileName
    raw_text:     isScannedPdf ? '' : resumeText.trim(),  // correct column name
    parsed_data:  null,
    ats_score:    null,
    ats_breakdown: null,
    target_role:  options.targetRole ?? null,
    source:       'uploaded',
    version:      1,
    is_primary:   false,
    soft_deleted: false,
    created_at:   now,
    updated_at:   now,
  };

  ensureSuccess(
    await supabase.from('resumes').insert(row),
    'resume insert'
  );

  logger.info('[ResumeService] Resume inserted', { userId, resumeId });

  return {
    jobId:        resumeId,
    resumeId,
    fileName:     file.originalname,
    fileUrl:      contentMeta.fileUrl,
    resumeText:   isScannedPdf ? '' : resumeText.trim(),
    isScannedPdf,
    isTruncated:  resumeText.trim().length > MAX_AI_INPUT_CHARS,
    status:       'pending',
    createdAt:    now,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// List resumes for a user
// ─────────────────────────────────────────────────────────────────────────────

async function listResumes(userId) {
  logger.info('[ResumeService] listResumes', { userId });

  // HARDENED: explicit safe-only column list.
  // Excluded fields and why:
  //   raw_text     — INTERNAL: full resume plain-text blob (can be 100 KB+); AI pipeline only
  //   soft_deleted — INTERNAL: always false here (filtered in WHERE); DB flag, not UI concept
  //   source       — INTERNAL: ingestion origin ('uploaded', 'imported'); not relevant to UI
  //   version      — INTERNAL: DB row version counter; not a public API concept
  const SAFE_LIST_FIELDS =
    'id, content, ats_score, ats_breakdown, target_role, is_primary, created_at, updated_at';

  const { data, error } = await supabase
    .from('resumes')
    .select(SAFE_LIST_FIELDS)
    .eq('user_id', userId)
    .eq('soft_deleted', false)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('[ResumeService] listResumes failed', { userId, error: error.message });
    throw new AppError('Failed to fetch resumes', 500, {}, ErrorCodes.DB_ERROR);
  }

  return { resumes: data || [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Get a single resume (ownership enforced)
// ─────────────────────────────────────────────────────────────────────────────

async function getResume(userId, resumeId) {
  logger.info('[ResumeService] getResume', { userId, resumeId });

  // HARDENED: explicit column list instead of select('*').
  // Excluded fields and why:
  //   raw_text     — INTERNAL: full resume plain-text, used by AI pipeline only
  //   user_id      — INTERNAL: ownership enforced by the WHERE clause; redundant in payload
  //   soft_deleted — INTERNAL: always false here (filtered in WHERE); a DB flag, not UI state
  //   source       — INTERNAL: ingestion origin ('uploaded', 'imported') — not frontend-relevant
  //   version      — INTERNAL: DB row version counter, not a public API concept
  const SAFE_RESUME_FIELDS =
    'id, content, ats_score, ats_breakdown, target_role, is_primary, created_at, updated_at';

  const { data, error } = await supabase
    .from('resumes')
    .select(SAFE_RESUME_FIELDS)
    .eq('id', resumeId)
    .eq('user_id', userId)
    .eq('soft_deleted', false)
    .maybeSingle();

  if (error) {
    throw new AppError('Failed to fetch resume', 500, {}, ErrorCodes.DB_ERROR);
  }
  if (!data) {
    throw new AppError('Resume not found', 404, {}, ErrorCodes.NOT_FOUND);
  }

  return { resume: data };
}

// ─────────────────────────────────────────────────────────────────────────────
// Soft-delete a resume (ownership enforced)
// ─────────────────────────────────────────────────────────────────────────────

async function deleteResume(userId, resumeId) {
  logger.info('[ResumeService] deleteResume', { userId, resumeId });

  const { error } = await supabase
    .from('resumes')
    .update({ soft_deleted: true, updated_at: new Date().toISOString() })
    .eq('id', resumeId)
    .eq('user_id', userId);

  if (error) {
    throw new AppError('Failed to delete resume', 500, {}, ErrorCodes.DB_ERROR);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Score a resume — returns cached score or pending status for the worker
// ─────────────────────────────────────────────────────────────────────────────

async function scoreResume(userId, resumeId) {
  logger.info('[ResumeService] scoreResume', { userId, resumeId });

  const { data: row, error } = await supabase
    .from('resumes')
    .select('id, raw_text, content, ats_score, ats_breakdown, target_role')
    .eq('id', resumeId)
    .eq('user_id', userId)
    .eq('soft_deleted', false)
    .maybeSingle();

  if (error) throw new AppError('Failed to fetch resume for scoring', 500, {}, ErrorCodes.DB_ERROR);
  if (!row)  throw new AppError('Resume not found', 404, {}, ErrorCodes.NOT_FOUND);

  // Return cached score if already computed
  if (row.ats_score !== null) {
    return {
      resumeId,
      score:      row.ats_score,
      breakdown:  row.ats_breakdown,
      targetRole: row.target_role,
      cached:     true,
    };
  }

  // Scoring runs async via resume-worker; return pending status
  return {
    resumeId,
    score:   null,
    status:  'pending',
    message: 'Scoring in progress. Poll GET /api/v1/resumes/:id for results.',
    cached:  false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Analyse resume growth opportunities (AI-powered)
// ─────────────────────────────────────────────────────────────────────────────

async function analyzeResumeGrowth(userId, { resumeId, targetRole }) {
  logger.info('[ResumeService] analyzeResumeGrowth', { userId, resumeId, targetRole });

  const { data: row, error } = await supabase
    .from('resumes')
    .select('id, raw_text, content')
    .eq('id', resumeId)
    .eq('user_id', userId)
    .eq('soft_deleted', false)
    .maybeSingle();

  if (error) throw new AppError('Failed to fetch resume', 500, {}, ErrorCodes.DB_ERROR);
  if (!row)  throw new AppError('Resume not found', 404, {}, ErrorCodes.NOT_FOUND);

  const rawText = row.raw_text || '';
  if (rawText.length < 30) {
    throw new AppError('Insufficient resume text for growth analysis', 422, {}, ErrorCodes.VALIDATION_ERROR);
  }

  const inputText = rawText.slice(0, MAX_AI_INPUT_CHARS);
  let growthData  = null;

  try {
    const anthropic = getAnthropicClient();
    if (!anthropic) {
      return { resumeId, targetRole: targetRole || null, growthOpportunities: [], status: 'test_mode' };
    }

    const response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 1000,
      messages: [{
        role:    'user',
        content: `Analyse this resume for growth opportunities${targetRole ? ` towards: ${targetRole}` : ''}.\n\nReturn ONLY valid JSON: { "gaps": [], "strengths": [], "recommendations": [], "growthScore": 0 }\n\nResume:\n${inputText}`,
      }],
    });

    const raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    growthData = JSON.parse(stripJson(raw));
  } catch (err) {
    logger.warn('[ResumeService] analyzeResumeGrowth AI call failed', { userId, error: err.message });
    growthData = { gaps: [], strengths: [], recommendations: [], growthScore: null };
  }

  return { resumeId, targetRole: targetRole || null, ...growthData };
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh the signed URL for an uploaded resume file
// ─────────────────────────────────────────────────────────────────────────────

async function refreshSignedUrl(userId, resumeId) {
  logger.info('[ResumeService] refreshSignedUrl', { userId, resumeId });

  const { data: row, error } = await supabase
    .from('resumes')
    .select('content')
    .eq('id', resumeId)
    .eq('user_id', userId)
    .eq('soft_deleted', false)
    .maybeSingle();

  if (error) throw new AppError('Failed to fetch resume', 500, {}, ErrorCodes.DB_ERROR);
  if (!row)  throw new AppError('Resume not found', 404, {}, ErrorCodes.NOT_FOUND);

  const storagePath = row.content?.storagePath; // INTERNAL — storage path is not exposed to frontend
  if (!storagePath) {
    throw new AppError('No storage path on record for this resume', 422, {}, ErrorCodes.VALIDATION_ERROR);
  }

  const { data: signedData, error: signedError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (signedError || !signedData?.signedUrl) {
    throw new AppError('Failed to generate signed URL', 500, {}, ErrorCodes.DB_ERROR);
  }

  const signedUrlExpiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString();
  // INTERNAL: signedUrlExpiresAt persisted to DB for server-side cache busting only.
  // Frontend receives fileUrl; it should not read or store signedUrlExpiresAt.

  // Persist refreshed URL back into content JSONB blob
  await supabase
    .from('resumes')
    .update({
      content:    { ...row.content, fileUrl: signedData.signedUrl, signedUrlExpiresAt },
      updated_at: new Date().toISOString(),
    })
    .eq('id', resumeId)
    .eq('user_id', userId);

  // Only fileUrl is returned — signedUrlExpiresAt is an internal cache detail
  return { resumeId, fileUrl: signedData.signedUrl };
}

module.exports = {
  uploadResume,
  listResumes,
  getResume,
  deleteResume,
  scoreResume,
  analyzeResumeGrowth,
  refreshSignedUrl,
};