'use strict';

/**
 * @file src/modules/career-copilot/careerCopilot.service.js
 * @description
 * Production-grade grounded Career Copilot service.
 *
 * Optimized for:
 * - single-RPC RAG retrieval
 * - low token prompt assembly
 * - abort propagation
 * - non-blocking persistence
 * - safer async flow
 */

const { randomUUID } = require('crypto');
const logger = require('../../utils/logger');
const anthropic = require('../../config/anthropic.client');
const { supabase } = require('../../config/supabase');

const ragRetriever = require('./retrieval/ragRetriever');
const ragContextBuilder = require('./context/ragContextBuilder');
const groundingGuard = require('./grounding/groundingGuard');

const MODEL =
  process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

const TEMPERATURE = 0.2;
const HISTORY_LIMIT = 6;

const MAX_TOKENS_BY_INTENT = Object.freeze({
  salary: 280,
  skill_gap: 350,
  career_path: 600,
  opportunity: 450,
  risk: 350,
  health: 300,
  general: 400,
});

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────
async function loadHistory(userId, conversationId) {
  try {
    const { data, error } = await supabase
      .from('copilot_conversations')
      .select('user_message, ai_response')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .order('turn_index', { ascending: false })
      .limit(HISTORY_LIMIT);

    if (error) throw error;
    return Array.isArray(data) ? data.reverse() : [];
  } catch (err) {
    logger.warn('[CopilotService] Failed to load history', {
      userId,
      conversationId,
      error: err.message,
    });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────
function saveConversationTurn(turn) {
  supabase
    .from('copilot_conversations')
    .insert([turn])
    .then(() => {})
    .catch((err) => {
      logger.warn('[CopilotService] Failed to save conversation', {
        userId: turn.user_id,
        conversationId: turn.conversation_id,
        error: err.message,
      });
    });
}

async function saveRAGContext(payload) {
  try {
    const { data, error } = await supabase
      .from('copilot_rag_contexts')
      .insert([payload])
      .select('id')
      .single();

    if (error) throw error;
    return data?.id || null;
  } catch (err) {
    logger.warn('[CopilotService] Failed to save RAG context', {
      userId: payload.user_id,
      conversationId: payload.conversation_id,
      error: err.message,
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt assembly
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(contextString, dataSources) {
  return [
    groundingGuard.buildGroundingInstructions(dataSources),
    'Use only the provided platform data.',
    'Be concise, warm, and actionable.',
    'End with one next step.',
    contextString || '[No context]',
  ].join('\n\n');
}

function buildMessages(history, userMessage) {
  const messages = [];

  for (const turn of history) {
    if (turn.user_message) {
      messages.push({
        role: 'user',
        content: turn.user_message,
      });
    }

    if (turn.ai_response) {
      messages.push({
        role: 'assistant',
        content: turn.ai_response,
      });
    }
  }

  messages.push({
    role: 'user',
    content: userMessage,
  });

  return messages;
}

function getMaxTokens(intent, confidence) {
  const base =
    MAX_TOKENS_BY_INTENT[intent] ||
    MAX_TOKENS_BY_INTENT.general;

  if (confidence >= 0.8) return base + 120;
  if (confidence <= 0.4) return Math.max(220, base - 80);

  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM
// ─────────────────────────────────────────────────────────────────────────────
async function generateLLMResponse({
  systemPrompt,
  messages,
  maxTokens,
  userId,
  signal,
}) {
  try {
    const completion = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: TEMPERATURE,
      system: systemPrompt,
      messages,
      signal,
    });

    return completion.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  } catch (err) {
    logger.error('[CopilotService] LLM failed', {
      userId,
      error: err.message,
    });

    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main chat
// ─────────────────────────────────────────────────────────────────────────────
async function chat(userId, userMessage, opts = {}) {
  const {
    conversationId = randomUUID(),
    forceRefresh = false,
    signal,
  } = opts;

  const startedAt = Date.now();

  const ragContext = await ragRetriever
    .retrieveContext(userId, { forceRefresh })
    .catch((err) => {
      logger.warn('[CopilotService] RAG retrieval fallback', {
        userId,
        error: err.message,
      });

      return {
        data_sources_used: [],
        data_completeness: 0,
        confidence_score: 0,
        is_sufficient: false,
      };
    });

  const preCheck = groundingGuard.preFlightCheck(
    ragContext,
    userMessage
  );

  if (!preCheck.allowed) {
    return {
      response: preCheck.refusalMessage,
      data_sources: [],
      confidence: 0,
      was_grounded: false,
      refused: true,
      refusal_reason: preCheck.intent,
      conversation_id: conversationId,
      duration_ms: Date.now() - startedAt,
    };
  }

  const contextObj = ragContextBuilder.buildContext(ragContext);
  const history = await loadHistory(userId, conversationId);
  const turnIndex = history.length;

  const confidence =
    groundingGuard.calculateResponseConfidence(
      ragContext,
      preCheck.intent,
      contextObj.dataSources
    );

  const rawResponse =
    (await generateLLMResponse({
      systemPrompt: buildSystemPrompt(
        contextObj.contextString,
        contextObj.dataSources
      ),
      messages: buildMessages(history, userMessage),
      maxTokens: getMaxTokens(preCheck.intent, confidence),
      userId,
      signal,
    })) || buildFallbackResponse(ragContext);

  const { cleanedResponse, violations } =
    groundingGuard.postFlightScan(
      rawResponse,
      ragContext
    );

  const durationMs = Date.now() - startedAt;

  const ragPayload = {
    user_id: userId,
    conversation_id: conversationId,
    turn_index: turnIndex,
    user_query: userMessage,
    retrieved_context: ragContext,
    data_sources_used: contextObj.dataSources,
    confidence_score: confidence,
    data_completeness: ragContext.data_completeness,
    ai_response: cleanedResponse,
    refused_generation: false,
    created_at: new Date().toISOString(),
  };

  saveRAGContext(ragPayload)
    .then((ragContextId) => {
      saveConversationTurn({
        user_id: userId,
        conversation_id: conversationId,
        turn_index: turnIndex,
        user_message: userMessage,
        ai_response: cleanedResponse,
        data_sources: contextObj.dataSources,
        confidence,
        rag_context_id: ragContextId,
        created_at: new Date().toISOString(),
      });
    })
    .catch(() => {});

  return {
    response: cleanedResponse,
    data_sources: contextObj.dataSources,
    confidence,
    data_completeness: ragContext.data_completeness,
    signal_strength: getSignalLabel(
      ragContext.data_completeness
    ),
    was_grounded: true,
    refused: false,
    violations_found: violations.length > 0,
    conversation_id: conversationId,
    duration_ms: durationMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function buildFallbackResponse(ragContext) {
  const sources = Array.isArray(ragContext?.data_sources_used)
    ? ragContext.data_sources_used
    : [];

  if (!sources.length) {
    return (
      'I’m temporarily unable to generate a detailed grounded response. ' +
      'Please try again shortly.'
    );
  }

  return (
    `Based on your ${sources.join(', ')} data, ` +
    'I recommend reviewing your latest dashboard insights while I reconnect.'
  );
}

function getSignalLabel(completeness) {
  if (completeness >= 0.75) return 'high';
  if (completeness >= 0.5) return 'medium';
  if (completeness >= 0.25) return 'low';
  return 'insufficient';
}

module.exports = {
  chat,
};