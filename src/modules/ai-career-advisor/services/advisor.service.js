'use strict';

/**
 * services/advisor.service.js (Supabase version)
 */

const logger    = require('../../../utils/logger');
const anthropic = require('../../../config/anthropic.client');
const supabase  = require('../../../config/supabase');

const { COLLECTIONS } = require('../../education-intelligence/models/student.model');
const marketTrendService = require('../../labor-market-intelligence/services/marketTrend.service');
const { buildSystemPrompt, buildConversationMessages } = require('../prompts/advisorPrompt.builder');
const { CONVERSATIONS_COLLECTION, buildConversationDoc } = require('../models/conversation.model');

// ─── Config ─────────────────────────────────────────────

const MODEL         = 'claude-sonnet-4-20250514';
const MAX_TOKENS    = 1024;
const HISTORY_LIMIT = 20;

// ─── Data loaders ───────────────────────────────────────

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
      supabase.from(COLLECTIONS.STUDENTS).select('*').eq('id', studentId).single(),
      supabase.from(COLLECTIONS.STREAM_SCORES).select('*').eq('id', studentId).single(),
      supabase.from(COLLECTIONS.CAREER_PREDICTIONS).select('*').eq('id', studentId).single(),
      supabase.from(COLLECTIONS.EDUCATION_ROI).select('*').eq('id', studentId).single(),
      supabase.from(COLLECTIONS.CAREER_SIMULATIONS).select('*').eq('id', studentId).single(),
      supabase.from(COLLECTIONS.COGNITIVE).select('*').eq('id', studentId).single(),
    ]);

    const student          = studentRes.data || null;
    const streamResult     = streamRes.data || null;
    const careerResult     = careerRes.data || null;
    const roiResult        = roiRes.data || null;
    const simulationResult = simulationRes.data || null;
    const cognitiveDoc     = cognitiveRes.data || null;

    const cognitiveResult = cognitiveDoc ? {
      scores: {
        analytical_score:    cognitiveDoc.analytical_score,
        logical_score:       cognitiveDoc.logical_score,
        memory_score:        cognitiveDoc.memory_score,
        communication_score: cognitiveDoc.communication_score,
        creativity_score:    cognitiveDoc.creativity_score,
      },
      profile_label: cognitiveDoc.profile_label || null,
      strengths:     cognitiveDoc.strengths || [],
    } : null;

    return { student, streamResult, cognitiveResult, careerResult, roiResult, simulationResult };

  } catch (err) {
    logger.error({ studentId, err: err.message }, '[AdvisorService] loadStudentContext failed');
    throw err;
  }
}

// ─── Conversation history ───────────────────────────────

async function loadConversationHistory(studentId) {
  try {
    const { data, error } = await supabase
      .from(CONVERSATIONS_COLLECTION)
      .select('*')
      .eq('student_id', studentId)
      .order('created_at', { ascending: true })
      .limit(HISTORY_LIMIT);

    if (error) throw error;

    return data || [];
  } catch (err) {
    logger.warn({ studentId, err: err.message }, '[AdvisorService] Failed to load conversation history');
    return [];
  }
}

// ─── Save conversation ──────────────────────────────────

async function saveConversationTurn(studentId, userMessage, aiResponse) {
  try {
    const doc = buildConversationDoc(studentId, userMessage, aiResponse);

    const { error } = await supabase
      .from(CONVERSATIONS_COLLECTION)
      .insert([
        {
          ...doc,
          created_at: new Date(),
        },
      ]);

    if (error) throw error;

  } catch (err) {
    logger.warn({ studentId, err: err.message }, '[AdvisorService] Failed to save conversation turn');
  }
}

// ─── Welcome message ────────────────────────────────────

function buildWelcomeMessage(student) {
  const name = student && student.name ? `, ${student.name.split(' ')[0]}` : '';
  return (
    `Hello${name}! 👋 I'm your AI Career Advisor.\n\n` +
    `I've reviewed your stream analysis, cognitive profile, career success predictions, ` +
    `education ROI scores, and market demand signals.\n\n` +
    `Ask me anything about your career path. For example:\n` +
    `• "Which stream is best for me?"\n` +
    `• "Which career gives the highest salary for my profile?"\n` +
    `• "Is Computer Science better than Commerce for me?"\n` +
    `• "What skills should I start learning now?"`
  );
}

// ─── Main chat ──────────────────────────────────────────

async function chat(studentId, userMessage) {
  logger.info({ studentId }, '[AdvisorService] Chat request received');

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

  const systemPrompt = buildSystemPrompt({ ...studentContext, marketData });
  const messages     = buildConversationMessages(history, userMessage);

  let aiResponse;

  try {
    const completion = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
    });

    aiResponse = completion.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

  } catch (err) {
    logger.error({ studentId, err: err.message }, '[AdvisorService] Claude API failed');

    aiResponse =
      'I am temporarily unavailable. Please try again shortly.';
  }

  await saveConversationTurn(studentId, userMessage, aiResponse);

  return {
    response: aiResponse,
    studentName: student.name || null,
  };
}

// ─── Welcome endpoint ───────────────────────────────────

async function getWelcome(studentId) {
  const { data } = await supabase
    .from(COLLECTIONS.STUDENTS)
    .select('*')
    .eq('id', studentId)
    .single();

  return {
    message: buildWelcomeMessage(data),
    studentName: data ? data.name : null,
  };
}

// ─── History endpoint ───────────────────────────────────

async function getHistory(studentId) {
  const history = await loadConversationHistory(studentId);
  return { conversations: history };
}

module.exports = { chat, getWelcome, getHistory };