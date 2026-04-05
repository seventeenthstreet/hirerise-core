'use strict';

/**
 * @file src/services/cvBuilder.service.js
 * @description
 * Job-specific CV optimization + versioning service.
 *
 * Optimized for:
 * - Supabase-native snake_case schema
 * - safer Anthropic client loading
 * - resilient JSON parsing
 * - lower query overfetch
 * - deterministic payload normalization
 * - safer list limits
 */

const crypto = require('crypto');
const { supabase } = require('../config/supabase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const {
  TEMPLATE_PROMPTS,
  TEMPLATE_LABELS,
  getTemplatePrompt,
} = require('./cvTemplates.helper');

const MODEL =
  process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function getAnthropicClient() {
  if (process.env.NODE_ENV === 'test') {
    return null;
  }

  try {
    return require('../config/anthropic.client');
  } catch (err) {
    logger.error('[CvBuilder] Anthropic client unavailable', {
      error: err?.message || 'Unknown client load error',
    });
    return null;
  }
}

function stripJson(text = '') {
  return String(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeCvResult(result = {}) {
  return {
    optimized_summary: result.optimizedSummary || '',
    extracted_keywords: safeArray(result.extractedJobKeywords),
    highlighted_skills: safeArray(result.highlightedSkills),
    reordered_experience: safeArray(result.reorderedExperience),
    keyword_match_score: Number(result.keywordMatchScore) || 0,
    optimization_notes: safeArray(result.optimizationNotes),
  };
}

// ─────────────────────────────────────────────────────────────
// Main generator
// ─────────────────────────────────────────────────────────────
async function generateJobSpecificCv(userId, payload = {}) {
  const safeUserId = String(userId || '').trim();

  if (!safeUserId) {
    throw new AppError(
      'userId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const {
    jobDescription,
    jobTitle,
    templateId = 'modern',
  } = payload;

  const safeJobDescription = String(jobDescription || '').trim();

  if (safeJobDescription.length < 50) {
    throw new AppError(
      'Job description must be at least 50 characters.',
      400
    );
  }

  const systemPrompt = getTemplatePrompt(templateId);

  if (!systemPrompt) {
    throw new AppError(
      `Invalid templateId: ${templateId}`,
      400
    );
  }

  // ─────────────────────────────────────────────────────────
  // Fetch user + latest resume
  // ─────────────────────────────────────────────────────────
  const [userRes, resumeRes] = await Promise.all([
    supabase
      .from('users')
      .select('id,display_name,skills,experience_years')
      .eq('id', safeUserId)
      .maybeSingle(),

    supabase
      .from('resumes')
      .select(`
        id,
        parsed_data,
        resume_text,
        created_at
      `)
      .eq('user_id', safeUserId)
      .eq('soft_deleted', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const userData = userRes?.data || {};
  const resumeData = resumeRes?.data;

  if (!resumeData) {
    throw new AppError('No resume found', 404);
  }

  const parsed = resumeData.parsed_data || {};

  const candidateContext = {
    name:
      parsed.name ||
      userData.display_name ||
      'Candidate',

    skills:
      safeArray(parsed.skills).length > 0
        ? parsed.skills
        : safeArray(userData.skills),

    experience:
      parsed.years_experience ??
      userData.experience_years ??
      null,

    education: parsed.education_level || null,
    roles: safeArray(parsed.detected_roles),
    resumeText: String(resumeData.resume_text || '').slice(
      0,
      4000
    ),
  };

  const templateLabel =
    TEMPLATE_LABELS[templateId] || 'Modern';

  const userMessage = `
TARGET ROLE: ${jobTitle || 'Not specified'}

JOB DESCRIPTION:
${safeJobDescription.slice(0, 3000)}

RESUME TEXT:
${candidateContext.resumeText}

SKILLS:
${JSON.stringify(candidateContext.skills.slice(0, 20))}
`;

  const anthropic = getAnthropicClient();

  if (!anthropic) {
    throw new AppError(
      'Anthropic client unavailable',
      503
    );
  }

  let cvResult;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2500,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userMessage,
        },
      ],
    });

    const rawText = safeArray(response.content)
      .map((block) => block?.text || '')
      .join('');

    cvResult = JSON.parse(stripJson(rawText));
  } catch (err) {
    logger.error('[CvBuilder] Generation failed', {
      user_id: safeUserId,
      error: err?.message || 'Unknown LLM error',
    });

    throw new AppError('CV generation failed', 502);
  }

  const cvVersionId = crypto.randomUUID();

  const normalizedResult = normalizeCvResult(cvResult);

  const record = {
    id: cvVersionId,
    user_id: safeUserId,
    template_id: templateId,
    template_label: templateLabel,
    job_title: String(jobTitle || 'Untitled'),
    job_description: safeJobDescription.slice(0, 2000),
    ...normalizedResult,
    created_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('user_cvs')
    .insert(record);

  if (error) {
    logger.error('[CvBuilder] Save failed', {
      user_id: safeUserId,
      error: error.message,
    });

    throw new AppError('Failed to save CV version', 500);
  }

  return {
    cvVersionId,
    ...record,
  };
}

// ─────────────────────────────────────────────────────────────
// Version history
// ─────────────────────────────────────────────────────────────
async function getCvVersions(userId, limit = 20) {
  const safeUserId = String(userId || '').trim();
  const safeLimit = clamp(Number(limit) || 20, 1, 100);

  const { data, error } = await supabase
    .from('user_cvs')
    .select(`
      id,
      template_id,
      template_label,
      job_title,
      keyword_match_score,
      created_at
    `)
    .eq('user_id', safeUserId)
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) {
    logger.error('[CvBuilder] Version fetch failed', {
      user_id: safeUserId,
      error: error.message,
    });

    throw error;
  }

  return {
    userId: safeUserId,
    versions: data || [],
    total: data?.length || 0,
  };
}

module.exports = {
  generateJobSpecificCv,
  getCvVersions,
  getTemplatePrompt,
  TEMPLATE_PROMPTS,
  TEMPLATE_LABELS,
};