'use strict';

/**
 * @file src/modules/ai-career-advisor/services/advisor.service.js
 * @description
 * Production-grade AI Career Advisor service.
 *
 * Optimized for:
 * - Supabase row-safe retrieval
 * - lower prompt token cost
 * - dynamic response sizing
 * - non-blocking persistence
 * - future abort propagation
 */

const logger = require('../../../utils/logger');
const anthropic = require('../../../config/anthropic.client');
const { supabase } = require('../../../config/supabase');

const { COLLECTIONS } = require('../../education-intelligence/models/student.model');
const marketTrendService = require('../../labor-market-intelligence/services/marketTrend.service');
const {
  buildSystemPrompt,
  buildConversationMessages,
} = require('../prompts/advisorPrompt.builder');
const {
  CONVERSATIONS_COLLECTION,
  buildConversationDoc,
} = require('../models/conversation.model');

const MODEL = 'claude-sonnet-4-20250514';
const HISTORY_LIMIT = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Token sizing
// ─────────────────────────────────────────────────────────────────────────────
function getMaxTokens(message) {
  const text = String(message || '').toLowerCase();

  if (text.includes('salary') || text.includes('roi')) return 320;
  if (text.includes('career path') || text.includes('roadmap')) return 600;
  if (text.includes('stream') || text.includes('subject')) return 400;

  return 450;
}

// ─────────────────────────────────────────────────────────────────────────────
// Student context
// ─────────────────────────────────────────────────────────────────────────────
async function loadStudentContext(studentId) {
  try {
    const [
      studentRes,
      streamRes,
      careerRes,
      roiRes,
      simulationRes,
      cognitiveRes,
    ] = await Promise.all([
      supabase
        .from(COLLECTIONS.STUDENTS)
        .select('id, name, grade, interests')
        .eq('id', studentId)
        .maybeSingle(),

      supabase
        .from(COLLECTIONS.STREAM_SCORES)
        .select('*')
        .eq('student_id', studentId)
        .maybeSingle(),

      supabase
        .from(COLLECTIONS.CAREER_PREDICTIONS)
        .select('*')
        .eq('student_id', studentId)
        .maybeSingle(),

      supabase
        .from(COLLECTIONS.EDUCATION_ROI)
        .select('*')
        .eq('student_id', studentId)
        .maybeSingle(),

      supabase
        .from(COLLECTIONS.CAREER_SIMULATIONS)
        .select('*')
        .eq('user_id', studentId)
        .maybeSingle(),

      supabase
        .from(COLLECTIONS.COGNITIVE)
        .select(`
          analytical_score,
          logical_score,
          memory_score,
          communication_score,
          creativity_score,
          profile_label,
          strengths
        `)
        .eq('student_id', studentId)
        .maybeSingle(),
    ]);

    const cognitiveDoc = cognitiveRes.data || null;

    return {
      student: studentRes.data || null,
      streamResult: streamRes.data || null,
      careerResult: careerRes.data || null,
      roiResult: roiRes.data || null,
      simulationResult: simulationRes.data || null,
      cognitiveResult: cognitiveDoc
        ? {
            scores: {
              analytical_score: cognitiveDoc.analytical_score,
              logical_score: cognitiveDoc.logical_score,
              memory_score: cognitiveDoc.memory_score,
              communication_score: cognitiveDoc.communication_score,
              creativity_score: cognitiveDoc.creativity_score,
            },
            profile_label: cognitiveDoc.profile_label || null,
            strengths: cognitiveDoc.strengths || [],
          }
        : null,
    };
  } catch (err) {
    logger.error('[AdvisorService] loadStudentContext failed', {
      studentId,
      error: err.message,
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────
async function loadConversationHistory(studentId) {
  try {
    const { data, error } = await supabase
      .from(CONVERSATIONS_COLLECTION)
      .select('user_message, ai_response, created_at')
      .eq('student_id', studentId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT);

    if (error) throw error;
    return (data || []).reverse();
  } catch (err) {
    logger.warn('[AdvisorService] Failed to load conversation history', {
      studentId,
      error: err.message,
    });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Save async
// ─────────────────────────────────────────────────────────────────────────────
function saveConversationTurn(studentId, userMessage, aiResponse) {
  const doc = buildConversationDoc(studentId, userMessage, aiResponse);

  supabase
    .from(CONVERSATIONS_COLLECTION)
    .insert([
      {
        ...doc,
        created_at: new Date().toISOString(),
      },
    ])
    .then(() => {})
    .catch((err) => {
      logger.warn('[AdvisorService] Failed to save conversation turn', {
        studentId,
        error: err.message,
      });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Welcome
// ─────────────────────────────────────────────────────────────────────────────
function buildWelcomeMessage(student) {
  const name = student?.name
    ? `, ${student.name.split(' ')[0]}`
    : '';

  return (
    `Hello${name}! 👋 I'm your AI Career Advisor.\n\n` +
    `I've reviewed your stream analysis, cognitive profile, career predictions, ` +
    `education ROI scores, and market demand signals.\n\n` +
    `Ask me anything about your career path.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main chat
// ─────────────────────────────────────────────────────────────────────────────
async function chat(studentId, userMessage, opts = {}) {
  logger.info('[AdvisorService] Chat request', { studentId });

  const [studentContext, history, marketData] = await Promise.all([
    loadStudentContext(studentId),
    loadConversationHistory(studentId),
    marketTrendService.getCareerTrends().catch(() => null),
  ]);

  const { student } = studentContext;

  if (!student) {
    const err = new Error(`Student ${studentId} not found.`);
    err.statusCode = 404;
    throw err;
  }

  const systemPrompt = buildSystemPrompt({
    ...studentContext,
    marketData,
  });

  const messages = buildConversationMessages(history, userMessage);

  let aiResponse =
    'I am temporarily unavailable. Please try again shortly.';

  try {
    const completion = await anthropic.messages.create({
      model: MODEL,
      max_tokens: getMaxTokens(userMessage),
      system: systemPrompt,
      messages,
      signal: opts.signal,
    });

    aiResponse =
      completion?.content
        ?.filter((block) => block.type === 'text')
        ?.map((block) => block.text)
        ?.join('') || aiResponse;
  } catch (err) {
    logger.error('[AdvisorService] Claude API failed', {
      studentId,
      error: err.message,
    });
  }

  saveConversationTurn(studentId, userMessage, aiResponse);

  return {
    response: aiResponse,
    studentName: student.name || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Welcome
// ─────────────────────────────────────────────────────────────────────────────
async function getWelcome(studentId) {
  const { data, error } = await supabase
    .from(COLLECTIONS.STUDENTS)
    .select('name')
    .eq('id', studentId)
    .maybeSingle();

  if (error) throw error;

  return {
    message: buildWelcomeMessage(data),
    studentName: data?.name || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────
async function getHistory(studentId) {
  const history = await loadConversationHistory(studentId);
  return { conversations: history };
}

module.exports = {
  chat,
  getWelcome,
  getHistory,
};