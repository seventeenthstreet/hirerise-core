'use strict';

const crypto = require('crypto');
const supabase = require('../config/supabase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const getAnthropicClient = () => {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../config/anthropic.client');
};

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

function stripJson(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

// ─────────────────────────────────────────────────────────────
// TEMPLATE PROMPTS (unchanged — keep your existing ones)
// ─────────────────────────────────────────────────────────────

const { TEMPLATE_PROMPTS, TEMPLATE_LABELS, getTemplatePrompt } = require('./cvTemplates.helper');

// ─────────────────────────────────────────────────────────────

async function generateJobSpecificCv(userId, payload) {

  if (!userId) {
    throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  const { jobDescription, jobTitle, templateId = 'modern' } = payload || {};

  if (!jobDescription || jobDescription.length < 50) {
    throw new AppError('Job description must be at least 50 characters.', 400);
  }

  // ── FETCH USER + RESUME ─────────────────────────────

  const [userRes, resumeRes] = await Promise.all([
    supabase.from('users').select('*').eq('id', userId).maybeSingle(),
    supabase
      .from('resumes')
      .select('*')
      .eq('user_id', userId)
      .eq('soft_deleted', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const userData   = userRes.data || {};
  const resumeData = resumeRes.data;

  if (!resumeData) {
    throw new AppError('No resume found', 404);
  }

  const parsed = resumeData.parsedData || resumeData.parsed_data || {};

  const candidateContext = {
    name: parsed.name || userData.display_name || 'Candidate',
    skills: parsed.skills || userData.skills || [],
    experience: parsed.yearsExperience ?? userData.experience_years ?? null,
    education: parsed.educationLevel || null,
    roles: parsed.detectedRoles || [],
    resumeText: (resumeData.resume_text || '').slice(0, 4000),
  };

  // ── TEMPLATE ─────────────────────────────────────

  const systemPrompt = getTemplatePrompt(templateId);
  const templateLabel = TEMPLATE_LABELS[templateId] || 'Modern';

  // ── BUILD MESSAGE ────────────────────────────────

  const userMessage = `
TARGET ROLE: ${jobTitle || 'Not specified'}

JOB DESCRIPTION:
${jobDescription.slice(0, 3000)}

RESUME TEXT:
${candidateContext.resumeText}

SKILLS:
${JSON.stringify(candidateContext.skills.slice(0, 20))}
`;

  // ── LLM CALL ─────────────────────────────────────

  const anthropic = getAnthropicClient();
  let cvResult;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const rawText = response.content.map(b => b.text || '').join('');
    cvResult = JSON.parse(stripJson(rawText));

  } catch (err) {
    logger.error('[CvBuilder] Failed', { error: err.message });
    throw new AppError('CV generation failed', 502);
  }

  // ── SAVE CV ──────────────────────────────────────

  const cvVersionId = crypto.randomUUID();

  const record = {
    id: cvVersionId,
    user_id: userId,
    template_id: templateId,
    template_label: templateLabel,
    job_title: jobTitle || 'Untitled',
    job_description: jobDescription.slice(0, 2000),
    optimized_summary: cvResult.optimizedSummary || '',
    extracted_keywords: cvResult.extractedJobKeywords || [],
    highlighted_skills: cvResult.highlightedSkills || [],
    reordered_experience: cvResult.reorderedExperience || [],
    keyword_match_score: cvResult.keywordMatchScore || 0,
    optimization_notes: cvResult.optimizationNotes || [],
    created_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('user_cvs').insert(record);

  if (error) throw error;

  return {
    cvVersionId,
    ...record,
  };
}

// ─────────────────────────────────────────────────────────────

async function getCvVersions(userId, limit = 20) {

  const { data, error } = await supabase
    .from('user_cvs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return {
    userId,
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





