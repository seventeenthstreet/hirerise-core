'use strict';

/**
 * resume.service.js
 *
 * CHANGES:
 *   FIX-13: Added scoreResume() and uploadResume() methods.
 *   FIX-14: scoreResume() now uses Anthropic Claude API for AI-powered
 *            resume scoring. Fetches resume from Firestore by resumeId,
 *            sends resumeText to Claude, returns structured score.
 *   FIX-15: uploadResume() now stores file in Firebase Storage, extracts
 *            text from PDF/DOCX via pdf-parse / mammoth, and persists a
 *            resume document to Firestore with analysisStatus:'pending'.
 *   FIX-16: pdf-parse fix for Node 18+ DOMMatrix error using version option.
 *   FIX-17: CV document validation — Claude checks if uploaded file is actually
 *            a CV/resume before storing. Non-CV documents are rejected with a
 *            clear user-facing message.
 */

const path   = require('path');
const crypto = require('crypto');

const { db, storage } = require('../../config/firebase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

// Lazy-load Anthropic client to avoid errors in test mode
const getAnthropicClient = () => {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../../config/anthropic.client');
};

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';

/** Strip markdown code fences from Claude responses before JSON.parse */
function stripJson(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT — SCORING
// ─────────────────────────────────────────────────────────────
const SCORING_SYSTEM_PROMPT = `You are an expert resume evaluator and career coach with 20 years of experience in technical hiring.

Your job is to analyze a resume and return a structured JSON score. Be objective, specific, and actionable.

You MUST respond with ONLY valid JSON — no preamble, no explanation, no markdown fences.

Return this exact structure:
{
  "score": <integer 0-100>,
  "tier": <"strong" | "good" | "average" | "weak">,
  "summary": <one sentence summary of the resume>,
  "breakdown": {
    "clarity": <integer 0-100>,
    "relevance": <integer 0-100>,
    "experience": <integer 0-100>,
    "skills": <integer 0-100>,
    "achievements": <integer 0-100>
  },
  "strengths": [<string>, <string>, <string>],
  "improvements": [<string>, <string>, <string>],
  "topSkills": [<string>, <string>, <string>],
  "estimatedExperienceYears": <integer>
}

Scoring guide:
- clarity: How well-written, structured, and easy to read the resume is
- relevance: How well the resume matches the target role (if provided)
- experience: Depth and quality of work experience
- skills: Breadth and relevance of technical and soft skills
- achievements: Quantified accomplishments and impact

Tier mapping:
- strong: score >= 75
- good: score >= 55
- average: score >= 35
- weak: score < 35`;

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT — CV VALIDATION (Claude layer)
// ─────────────────────────────────────────────────────────────
const CV_VALIDATION_SYSTEM_PROMPT = `You are a strict resume validation engine.
Your task is to determine whether the provided text is a genuine professional CV/resume.
Return JSON only.
Rules:
- A valid CV must contain structured professional information such as work experience, education, skills, or projects.
- Reject if it is random text, essay, blog post, spam, repeated filler text, or AI-generated nonsense.
- Reject if content lacks professional structure.
- Be conservative. If unsure, mark as invalid.
Return format:
{
  "isValidCV": true/false,
  "confidenceScore": 0-100,
  "reason": "short reason under 20 words",
  "category": "tech | non-tech | student | unclear"
}
Do not include explanations.
Do not include extra text.
Return JSON only.`;

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Extract plain text from an uploaded file buffer.
 * Supports: .pdf, .docx, .doc, .txt
 */
async function extractTextFromBuffer(buffer, mimetype, originalname) {
  const ext = path.extname(originalname).toLowerCase();

  // ── Plain text ────────────────────────────────────────────
  if (mimetype === 'text/plain' || ext === '.txt') {
    return buffer.toString('utf-8');
  }

  // ── PDF ───────────────────────────────────────────────────
  if (mimetype === 'application/pdf' || ext === '.pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const result   = await pdfParse(buffer, { version: 'v1.10.100' });
      if (!result.text || result.text.trim().length < 10) {
        throw new Error('No text extracted');
      }
      return result.text;
    } catch (err) {
      throw new AppError(
        'Could not extract text from PDF. Please ensure it is not scanned/image-only.',
        422,
        { originalname },
        ErrorCodes.VALIDATION_ERROR
      );
    }
  }

  // ── DOCX / DOC ────────────────────────────────────────────
  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimetype === 'application/msword' ||
    ext === '.docx' ||
    ext === '.doc'
  ) {
    const mammoth = require('mammoth');
    const result  = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  throw new AppError(
    `Unsupported file type: ${ext || mimetype}. Please upload a PDF, DOCX, DOC, or TXT file.`,
    415,
    { mimetype, ext },
    ErrorCodes.VALIDATION_ERROR
  );
}

/**
 * primaryCvCheck(resumeText)
 *
 * Layer 1 — fast server-side heuristic check before calling Claude.
 * Returns { pass: true } if the text looks CV-like enough to send to Claude.
 * Returns { pass: false, reason } if it clearly is not a CV.
 */
function primaryCvCheck(resumeText) {
  const text       = resumeText.toLowerCase();
  const wordCount  = resumeText.trim().split(/\s+/).length;

  // Too short to be a real CV
  if (wordCount < 80) {
    return { pass: false, reason: 'Document is too short to be a CV (under 80 words).' };
  }

  // Must contain at least 2 of these CV signal words
  const cvSignals = [
    'experience', 'education', 'skills', 'qualification', 'employment',
    'university', 'college', 'degree', 'diploma', 'certification',
    'work', 'job', 'position', 'role', 'company', 'organisation',
    'projects', 'achievements', 'responsibilities', 'objective', 'summary',
    'b.com', 'm.com', 'bba', 'mba', 'bsc', 'msc', 'b.tech', 'm.tech',
  ];

  const matchCount = cvSignals.filter(s => text.includes(s)).length;
  if (matchCount < 2) {
    return { pass: false, reason: 'Document does not contain enough professional CV keywords.' };
  }

  // Reject obvious non-CV patterns
  const rejectPatterns = [
    /invoice\s*(no|number|#)/i,
    /bill\s*to/i,
    /total\s*amount/i,
    /terms\s*and\s*conditions/i,
    /chapter\s+\d+/i,
    /abstract:/i,
    /dear\s+(sir|madam|mr|ms)/i,
  ];

  for (const pattern of rejectPatterns) {
    if (pattern.test(resumeText)) {
      return { pass: false, reason: 'Document matches a non-CV pattern (invoice, letter, or academic paper).' };
    }
  }

  return { pass: true };
}

/**
 * validateIsResume(resumeText, originalname)
 *
 * Two-layer CV validation:
 *  Layer 1 — server-side heuristic (free, instant)
 *  Layer 2 — Claude strict validation (only if Layer 1 passes)
 */
async function validateIsResume(resumeText, originalname) {
  // Skip validation in test mode
  if (process.env.NODE_ENV === 'test') return;

  // ── Layer 1: Server-side pre-check ───────────────────────
  const preCheck = primaryCvCheck(resumeText);

  if (!preCheck.pass) {
    logger.debug('[ResumeService] CV pre-check failed — skipping Claude', {
      originalname,
      reason: preCheck.reason,
    });
    throw new AppError(
      `The uploaded document doesn't appear to be a CV or resume. ${preCheck.reason}`,
      422,
      { originalname, reason: preCheck.reason },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  logger.debug('[ResumeService] CV pre-check passed — sending to Claude', { originalname });

  // ── Layer 2: Claude strict validation ────────────────────
  let validation;

  try {
    const anthropic = getAnthropicClient();
    const sample    = resumeText.trim().slice(0, 3000);

    const response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 256,
      system:     CV_VALIDATION_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: `Document text:\n${sample}` }],
    });

    const rawText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Strip markdown fences if present
    const clean = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    validation  = JSON.parse(clean);

  } catch (err) {
    // Claude hiccup — allow upload to continue rather than block legitimate users
    logger.warn('[ResumeService] Claude CV validation failed — allowing upload', {
      originalname,
      error: err.message,
    });
    return;
  }

  logger.debug('[ResumeService] Claude CV validation result', {
    originalname,
    isValidCV:       validation.isValidCV,
    confidenceScore: validation.confidenceScore,
    category:        validation.category,
    reason:          validation.reason,
  });

  // Reject if Claude is confident it is not a valid CV (score < 40)
  if (!validation.isValidCV && validation.confidenceScore >= 40) {
    throw new AppError(
      `The uploaded document doesn't appear to be a CV or resume. ` +
      `Please upload your resume to continue. (${validation.reason})`,
      422,
      { originalname, reason: validation.reason, category: validation.category },
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

/**
 * Upload a buffer to Firebase Storage and return the signed URL.
 */
async function uploadToStorage(buffer, storagePath, mimetype) {
  const bucket = storage.bucket(process.env.FIREBASE_STORAGE_BUCKET);
  const file   = bucket.file(storagePath);

  await file.save(buffer, {
    metadata: { contentType: mimetype },
    resumable: false,
  });

  // FIX G-03: Calculate and return the expiry time so callers can store it.
  // Storing signedUrlExpiresAt enables the refreshSignedUrl endpoint to detect
  // stale URLs and regenerate them before they cause 403s for users.
  const URL_TTL_MS   = 7 * 24 * 60 * 60 * 1000;
  const expiresAt    = new Date(Date.now() + URL_TTL_MS);

  const [signedUrl] = await file.getSignedUrl({
    action:  'read',
    expires: expiresAt.getTime(),
  });

  return { signedUrl, expiresAt };
}

// ─────────────────────────────────────────────────────────────
// UPLOAD RESUME
// ─────────────────────────────────────────────────────────────

/**
 * uploadResume(userId, file, options?)
 *
 * Flow:
 *  1. Validate file presence + size
 *  2. Extract plain text from PDF / DOCX / TXT
 *  3. Validate extracted text is actually a CV (Claude)
 *  4. Upload original file buffer to Firebase Storage
 *  5. Write resume document to Firestore (analysisStatus: 'pending')
 *  6. Return { resumeId, fileName, status }
 */
async function uploadResume(userId, file, options = {}) {
  // ── Guard: file must exist ────────────────────────────────
  if (!file || !file.buffer) {
    throw new AppError(
      'No file uploaded. Please attach a resume file.',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (!userId) {
    throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  const { originalname, mimetype, size, buffer } = file;
  const { targetRole = null } = options;

  // ── Guard: file size (default 10 MB) ─────────────────────
  const MAX_BYTES = parseInt(process.env.RESUME_MAX_BYTES || '10485760', 10);
  if (size > MAX_BYTES) {
    throw new AppError(
      `File too large. Maximum allowed size is ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`,
      413,
      { size, maxBytes: MAX_BYTES },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  logger.debug('[ResumeService] uploadResume start', { userId, originalname, size });

  // ── Step 1: Extract text ──────────────────────────────────
  let resumeText;
  try {
    resumeText = await extractTextFromBuffer(buffer, mimetype, originalname);
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error('[ResumeService] Text extraction failed', { error: err.message });
    throw new AppError(
      'Failed to read resume file. The file may be corrupted or password-protected.',
      422,
      { originalname },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (!resumeText || resumeText.trim().length < 50) {
    throw new AppError(
      'Could not extract enough text from the uploaded file. ' +
      'Please ensure the resume is not scanned/image-only.',
      422,
      { originalname },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  // ── Step 2: Validate it's actually a CV ──────────────────
  await validateIsResume(resumeText, originalname);

  // ── Step 3: Upload to Firebase Storage ───────────────────
  const resumeId    = crypto.randomUUID();
  const ext         = path.extname(originalname) || '';
  const storagePath = `resumes/${userId}/${resumeId}${ext}`;

  let fileUrl            = null;
  let signedUrlExpiresAt = null; // FIX G-03: store URL expiry for refresh support

  if (process.env.NODE_ENV !== 'test') {
    try {
      const upload       = await uploadToStorage(buffer, storagePath, mimetype);
      fileUrl            = upload.signedUrl;
      signedUrlExpiresAt = upload.expiresAt;
    } catch (err) {
      logger.error('[ResumeService] Storage upload failed', { error: err.message });
      throw new AppError(
        'File upload to storage failed. Please try again.',
        502,
        { originalname },
        ErrorCodes.EXTERNAL_SERVICE_ERROR
      );
    }
  }

  // ── Step 4: Persist to Firestore ──────────────────────────
  const now = new Date();

  const resumeDoc = {
    userId,
    fileName:                 originalname,
    fileUrl,
    storagePath,
    signedUrlExpiresAt,       // FIX G-03: null in test, Date in production
    mimetype,
    sizeBytes:                size,
    resumeText:               resumeText.trim(),
    targetRole,
    analysisStatus:           'pending',
    score:                    null,
    tier:                     null,
    scoreBreakdown:           null,
    strengths:                [],
    improvements:             [],
    topSkills:                [],
    estimatedExperienceYears: null,
    createdAt:                now,
    updatedAt:                now,
    softDeleted:              false,
  };

  await db.collection('resumes').doc(resumeId).set(resumeDoc);

  logger.debug('[ResumeService] uploadResume complete', { userId, resumeId });

  return {
    resumeId,
    fileName:       originalname,
    status:         'pending',
    charactersRead: resumeText.trim().length,
    createdAt:      now.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// SCORE RESUME
// ─────────────────────────────────────────────────────────────
async function scoreResume(userId, resumeId) {
  if (!userId) {
    throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  if (!resumeId) {
    throw new AppError('resumeId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  logger.debug('[ResumeService] scoreResume start', { userId, resumeId });

  // ── Fetch resume from Firestore ───────────────────────────
  const resumeDoc = await db.collection('resumes').doc(resumeId).get();

  if (!resumeDoc.exists) {
    throw new AppError(
      `Resume '${resumeId}' not found`,
      404,
      { resumeId },
      ErrorCodes.NOT_FOUND
    );
  }

  const resumeData = resumeDoc.data();

  // ── Ownership check ───────────────────────────────────────
  if (resumeData.userId !== userId) {
    throw new AppError(
      'Unauthorized access to resume',
      403,
      { resumeId },
      ErrorCodes.UNAUTHORIZED
    );
  }

  const resumeText = resumeData.resumeText;

  if (!resumeText || resumeText.trim().length < 50) {
    throw new AppError(
      'Resume text is too short or missing. Please upload a valid resume.',
      422,
      { resumeId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  // ── Build prompt ──────────────────────────────────────────
  const userPrompt = [
    resumeData.targetRole
      ? `Target Role: ${resumeData.targetRole}`
      : null,
    resumeData.skillsDetected?.length
      ? `Detected Skills: ${resumeData.skillsDetected.join(', ')}`
      : null,
    `\nResume Text:\n${resumeText}`,
  ]
    .filter(Boolean)
    .join('\n');

  // ── Call Claude API ───────────────────────────────────────
  let parsed;

  try {
    const anthropic = getAnthropicClient();

    const response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      system:     SCORING_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    const rawText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    parsed = JSON.parse(stripJson(rawText));

  } catch (err) {
    logger.error('[ResumeService] Claude scoring failed', {
      resumeId,
      error: err.message,
    });

    throw new AppError(
      'Resume scoring failed. Please try again.',
      502,
      { resumeId },
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  // ── Persist score back to Firestore ──────────────────────
  try {
    await db.collection('resumes').doc(resumeId).update({
      analysisStatus:           'completed',
      score:                    parsed.score,
      tier:                     parsed.tier,
      scoreBreakdown:           parsed.breakdown,
      strengths:                parsed.strengths,
      improvements:             parsed.improvements,
      topSkills:                parsed.topSkills,
      estimatedExperienceYears: parsed.estimatedExperienceYears,
      scoredAt:                 new Date(),
    });
  } catch (err) {
    logger.warn('[ResumeService] Failed to persist score to Firestore', {
      resumeId,
      error: err.message,
    });
  }

  logger.debug('[ResumeService] scoreResume complete', {
    resumeId,
    score: parsed.score,
    tier:  parsed.tier,
  });

  return {
    resumeId,
    fileName:                 resumeData.fileName,
    targetRole:               resumeData.targetRole || null,
    score:                    parsed.score,
    tier:                     parsed.tier,
    summary:                  parsed.summary,
    breakdown:                parsed.breakdown,
    strengths:                parsed.strengths,
    improvements:             parsed.improvements,
    topSkills:                parsed.topSkills,
    estimatedExperienceYears: parsed.estimatedExperienceYears,
    scoredAt:                 new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT — GROWTH ANALYSIS
// ─────────────────────────────────────────────────────────────
const GROWTH_ANALYSIS_SYSTEM_PROMPT = `You are a senior technical career growth analyst.
Your task is to analyze a resume and generate a structured career growth evaluation relative to a specified target role.
Be precise and concise.
Do not provide motivational language.
Do not provide long explanations.
Return structured JSON only.
Do not include markdown.
Do not include commentary outside JSON.
Rules:
1. Estimate current seniority level realistically.
2. Compare resume skills against target role expectations.
3. Identify concrete skill gaps (technical, system design, leadership, impact).
4. Estimate realistic timeline in months to reach target level.
5. Provide logical career path progression titles.
6. Estimate salary range logically based on level progression.
7. Be conservative in estimates.
8. If information is missing, mark fields as "insufficient_data".
Return format:
{
  "currentLevel": "L1 | L2 | L3 | L4 | L5 | unclear",
  "targetLevel": "string",
  "skillGapSummary": {
    "technical": [],
    "systemDesign": [],
    "leadership": [],
    "impactScope": []
  },
  "timelineEstimateMonths": number,
  "careerPath": [],
  "salaryProjection": {
    "currentEstimatedRange": "string",
    "targetEstimatedRange": "string"
  },
  "confidenceScore": 0-100
}
Keep arrays concise.
Maximum 5 items per array.
Do not exceed requested structure.`;

// ─────────────────────────────────────────────────────────────
// ANALYZE RESUME GROWTH
// ─────────────────────────────────────────────────────────────

/**
 * analyzeResumeGrowth(userId, payload)
 *
 * @param {string} userId
 * @param {object} payload
 * @param {string} payload.resumeId    - ID of the resume to analyse
 * @param {string} payload.targetRole  - Role the user wants to grow into
 *
 * Flow:
 *  1. Fetch resume from Firestore + validate ownership
 *  2. Send resumeText + targetRole to Claude
 *  3. Parse structured growth analysis
 *  4. Persist to resume_growth_signals collection
 *  5. Return analysis
 */
async function analyzeResumeGrowth(userId, payload) {
  if (!userId) {
    throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  const { resumeId, targetRole } = payload || {};

  if (!resumeId) {
    throw new AppError('resumeId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  if (!targetRole || !targetRole.trim()) {
    throw new AppError('targetRole is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  logger.debug('[ResumeService] analyzeResumeGrowth start', { userId, resumeId, targetRole });

  // ── Fetch resume from Firestore ───────────────────────────
  const resumeDoc = await db.collection('resumes').doc(resumeId).get();

  if (!resumeDoc.exists) {
    throw new AppError(
      `Resume '${resumeId}' not found`,
      404,
      { resumeId },
      ErrorCodes.NOT_FOUND
    );
  }

  const resumeData = resumeDoc.data();

  // ── Ownership check ───────────────────────────────────────
  if (resumeData.userId !== userId) {
    throw new AppError(
      'Unauthorized access to resume',
      403,
      { resumeId },
      ErrorCodes.UNAUTHORIZED
    );
  }

  const resumeText = resumeData.resumeText;

  if (!resumeText || resumeText.trim().length < 50) {
    throw new AppError(
      'Resume text is too short or missing. Please upload a valid resume.',
      422,
      { resumeId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  // ── Build prompt ──────────────────────────────────────────
  const userPrompt =
    `Target Role: ${targetRole.trim()}\n\nResume Text:\n${resumeText.trim()}`;

  // ── Call Claude API ───────────────────────────────────────
  let analysis;

  try {
    const anthropic = getAnthropicClient();

    const response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      system:     GROWTH_ANALYSIS_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    const rawText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    analysis = JSON.parse(stripJson(rawText));

  } catch (err) {
    logger.error('[ResumeService] Growth analysis failed', {
      resumeId,
      error: err.message,
    });

    throw new AppError(
      'Resume growth analysis failed. Please try again.',
      502,
      { resumeId },
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  // ── Persist to resume_growth_signals ─────────────────────
  const now      = new Date();
  const signalId = crypto.randomUUID();

  const signalDoc = {
    signalId,
    userId,
    resumeId,
    targetRole:             targetRole.trim(),
    currentLevel:           analysis.currentLevel,
    targetLevel:            analysis.targetLevel,
    skillGapSummary:        analysis.skillGapSummary,
    timelineEstimateMonths: analysis.timelineEstimateMonths,
    careerPath:             analysis.careerPath,
    salaryProjection:       analysis.salaryProjection,
    confidenceScore:        analysis.confidenceScore,
    createdAt:              now,
    softDeleted:            false,
  };

  try {
    await db.collection('resume_growth_signals').doc(signalId).set(signalDoc);
  } catch (err) {
    // Non-fatal — analysis still returned even if persist fails
    logger.warn('[ResumeService] Failed to persist growth signal', {
      resumeId,
      error: err.message,
    });
  }

  logger.debug('[ResumeService] analyzeResumeGrowth complete', {
    resumeId,
    signalId,
    currentLevel:           analysis.currentLevel,
    timelineEstimateMonths: analysis.timelineEstimateMonths,
  });

  return {
    signalId,
    resumeId,
    targetRole: targetRole.trim(),
    ...analysis,
    analyzedAt: now.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// FIX G-03: REFRESH SIGNED URL
// ─────────────────────────────────────────────────────────────

/**
 * refreshSignedUrl(userId, resumeId)
 *
 * FIX G-03: Regenerates a fresh 7-day signed URL for a resume's stored PDF.
 *
 * PROBLEM BEING FIXED:
 *   Signed URLs generated during CV creation expire after exactly 7 days.
 *   Before this fix, there was no mechanism to detect expiry or regenerate.
 *   After day 7, the user's CV link silently returned 403 from Firebase Storage.
 *   The dashboard showed a broken link with no error message or recovery path.
 *
 * HOW IT WORKS:
 *   1. Fetch resume doc — verify ownership
 *   2. Check signedUrlExpiresAt (written by generateCV after G-03 patch)
 *      If URL was created before the patch (no expiry field), always refresh.
 *   3. If URL is still valid (> 1 hour remaining), return early — no-op
 *   4. Use storagePath to generate a new signed URL for the same file
 *   5. Update fileUrl + signedUrlExpiresAt in Firestore
 *   6. Return new URL + expiry to client
 *
 * IDEMPOTENCY: Safe to call multiple times. Early-exits if URL not yet expired.
 *
 * @param {string} userId
 * @param {string} resumeId
 * @returns {Promise<{ resumeId, fileUrl, signedUrlExpiresAt, refreshed }>}
 */
async function refreshSignedUrl(userId, resumeId) {
  if (!userId)   throw new AppError('userId is required',   400, {}, ErrorCodes.VALIDATION_ERROR);
  if (!resumeId) throw new AppError('resumeId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const resumeSnap = await db.collection('resumes').doc(resumeId).get();

  if (!resumeSnap.exists) {
    throw new AppError(`Resume '${resumeId}' not found`, 404, { resumeId }, ErrorCodes.NOT_FOUND);
  }

  const resumeData = resumeSnap.data();

  if (resumeData.userId !== userId) {
    throw new AppError('Unauthorized access to resume', 403, { resumeId }, ErrorCodes.UNAUTHORIZED);
  }

  if (!resumeData.storagePath) {
    throw new AppError('Resume has no storage path — cannot refresh URL.', 422, { resumeId }, ErrorCodes.VALIDATION_ERROR);
  }

  // Early-exit guard: only refresh if URL expires within 1 hour or is missing
  // (docs created before G-03 patch will have no signedUrlExpiresAt → always refresh)
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const expiresAt   = resumeData.signedUrlExpiresAt?.toDate?.() ?? null;
  const stillValid  = expiresAt && (expiresAt.getTime() - Date.now() > ONE_HOUR_MS);

  if (stillValid) {
    logger.debug('[ResumeService] refreshSignedUrl — URL still valid, skipping', { resumeId });
    return {
      resumeId,
      fileUrl:            resumeData.fileUrl,
      signedUrlExpiresAt: expiresAt.toISOString(),
      refreshed:          false,
    };
  }

  // Generate a new signed URL for the same file in storage
  const URL_TTL_MS         = 7 * 24 * 60 * 60 * 1000;
  const newExpiresAt       = new Date(Date.now() + URL_TTL_MS);
  let   newFileUrl         = null;

  try {
    const bucket = storage.bucket(process.env.FIREBASE_STORAGE_BUCKET);
    const file   = bucket.file(resumeData.storagePath);

    const [signedUrl] = await file.getSignedUrl({
      action:  'read',
      expires: newExpiresAt.getTime(),
    });
    newFileUrl = signedUrl;
  } catch (err) {
    logger.error('[ResumeService] refreshSignedUrl — storage error', { resumeId, error: err.message });
    throw new AppError('Failed to refresh CV URL. Please try again.', 502, { resumeId }, ErrorCodes.EXTERNAL_SERVICE_ERROR);
  }

  // Persist new URL and expiry to Firestore
  await db.collection('resumes').doc(resumeId).update({
    fileUrl:            newFileUrl,
    signedUrlExpiresAt: newExpiresAt,
    updatedAt:          new Date(),
  });

  logger.info('[ResumeService] refreshSignedUrl — URL refreshed', { resumeId, newExpiresAt });

  return {
    resumeId,
    fileUrl:            newFileUrl,
    signedUrlExpiresAt: newExpiresAt.toISOString(),
    refreshed:          true,
  };
}

module.exports = {
  scoreResume,
  uploadResume,
  analyzeResumeGrowth,
  refreshSignedUrl,
};