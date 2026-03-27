'use strict';

/**
 * careerCopilot.service.js — Career Copilot RAG Service
 *
 * Grounded AI response pipeline for the Career Copilot.
 * Replaces the ungrounded advisor.service.js chat() function with a
 * full RAG pipeline: Retrieve → Ground → Generate → Validate → Return.
 *
 * Pipeline:
 *   1. RETRIEVE  — ragRetriever.retrieveContext()  → all platform data
 *   2. PRE-FLIGHT — groundingGuard.preFlightCheck() → refuse if insufficient
 *   3. BUILD     — ragContextBuilder.buildContext() → structured context string
 *   4. GENERATE  — anthropic.messages.create()     → grounded LLM response
 *   5. POST-FLIGHT — groundingGuard.postFlightScan() → detect hallucinations
 *   6. PERSIST   — save to copilot_rag_contexts + copilot_conversations
 *   7. RETURN    — { response, data_sources, confidence, ... }
 *
 * This service is the ONLY module allowed to call the LLM for the Copilot.
 * All existing advisor routes that call this service automatically gain
 * RAG grounding — no changes required in controllers or routes.
 *
 * Integration:
 *   Replaces advisor.service.js chat() for job-seeker path.
 *   The student advisor path (education module) is unaffected — it has its
 *   own context loading and is not modified.
 *
 * @module src/modules/career-copilot/careerCopilot.service
 */
const {
  randomUUID
} = require('crypto');
const logger = require('../../utils/logger');
const anthropic = require('../../config/anthropic.client');
const supabase = require('../../core/supabaseClient');
const cacheManager = require('../../core/cache/cache.manager');
const ragRetriever = require('./retrieval/ragRetriever');
const ragContextBuilder = require('./context/ragContextBuilder');
const groundingGuard = require('./grounding/groundingGuard');

// ─── Config ───────────────────────────────────────────────────────────────────

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS = 1024;
const TEMPERATURE = 0.3; // lower temperature for more factual, grounded responses
const HISTORY_LIMIT = 10; // last N turns loaded for conversation context

const cache = cacheManager.getClient();

// ─── Conversation history ─────────────────────────────────────────────────────

async function _loadHistory(userId, conversationId) {
  // Load from Supabase (structured, joinable with context)
  try {
    const { data } = await supabase
      .from('copilot_conversations')
      .select('user_message, ai_response, created_at')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .order('turn_index', { ascending: true })
      .limit(HISTORY_LIMIT);
    if (data?.length > 0) return data;
  } catch (_) {}
  return [];
}

async function _saveConversationTurn(userId, conversationId, turnIndex, {
  userMessage,
  aiResponse,
  dataSources,
  confidence,
  ragContextId
}) {
  const turn = {
    user_id: userId,
    conversation_id: conversationId,
    turn_index: turnIndex,
    user_message: userMessage,
    ai_response: aiResponse,
    data_sources: dataSources,
    confidence,
    rag_context_id: ragContextId || null,
    created_at: new Date().toISOString()
  };

  // Write to Supabase
  supabase
    .from('copilot_conversations')
    .insert(turn)
    .then(() => {})
    .catch(() => {});
}

async function _saveRAGContext(userId, conversationId, turnIndex, {
  userQuery,
  ragContext,
  contextObj,
  aiResponse,
  confidence,
  refused,
  refusalReason
}) {
  const { data } = await supabase
    .from('copilot_rag_contexts')
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      turn_index: turnIndex,
      user_query: userQuery,
      retrieved_context: {
        user_profile: ragContext.user_profile,
        chi_score: ragContext.chi_score,
        skill_gaps: ragContext.skill_gaps,
        job_matches: ragContext.job_matches,
        opportunity_radar: ragContext.opportunity_radar,
        risk_analysis: ragContext.risk_analysis,
        salary_benchmarks: ragContext.salary_benchmarks,
        personalization_profile: ragContext.personalization_profile
      },
      data_sources_used: contextObj.dataSources || [],
      confidence_score: confidence,
      data_completeness: ragContext.data_completeness,
      ai_response: aiResponse,
      refused_generation: refused,
      refusal_reason: refusalReason || null
    })
    .select('id')
    .single();
  return data?.id || null;
}

// ─── System prompt builder ────────────────────────────────────────────────────

function _buildSystemPrompt(contextString, dataSources, userName) {
  const groundingRules = groundingGuard.buildGroundingInstructions(dataSources);
  const name = userName ? `, ${userName.split(' ')[0]}` : '';
  return `You are Career Copilot${name ? ` speaking with ${name}` : ''}, an AI career advisor for the HireRise platform.\n\n${groundingRules}\n\n## Platform Data Context\n\nThe following data has been retrieved from the user's career profile on HireRise. ALL your advice must be grounded in this data. Do not introduce information not present below.\n\n${contextString || '[No platform data available for this user]'}\n\n## Response Guidelines\n\n- Be warm, specific, and actionable\n- Reference data explicitly: "Based on your 72% match with Operations Analyst..."\n- Keep responses concise (3-5 sentences for simple questions, up to 8 for complex ones)\n- When recommending a skill, cite which job match or skill gap it comes from\n- For salary questions, only quote figures from the Salary Benchmarks or Job Matches sections\n- End with one clear, actionable next step the user can take today`;
}

// ─── Main chat function ───────────────────────────────────────────────────────

/**
 * chat(userId, userMessage, opts)
 *
 * Full RAG pipeline: retrieve → guard → build → generate → validate → persist.
 *
 * @param {string} userId
 * @param {string} userMessage
 * @param {{ conversationId?: string, userName?: string, forceRefresh?: boolean }} opts
 *
 * @returns {Promise<CopilotResponse>}
 */
async function chat(userId, userMessage, opts = {}) {
  const {
    conversationId = randomUUID(),
    userName = null,
    forceRefresh = false
  } = opts;
  const startMs = Date.now();
  logger.info('[CopilotService] Chat request', {
    userId,
    messageLen: userMessage.length,
    conversationId
  });

  // ── Step 1: RETRIEVE ──────────────────────────────────────────────────────
  let ragContext;
  try {
    ragContext = await ragRetriever.retrieveContext(userId, { forceRefresh });
  } catch (err) {
    logger.error('[CopilotService] Context retrieval failed', {
      userId,
      err: err.message
    });
    ragContext = {
      data_sources_used: [],
      data_completeness: 0,
      confidence_score: 0,
      is_sufficient: false
    };
  }

  // ── Step 2: PRE-FLIGHT GROUNDING CHECK ───────────────────────────────────
  const preCheck = groundingGuard.preFlightCheck(ragContext, userMessage);
  if (!preCheck.allowed) {
    logger.info('[CopilotService] Pre-flight refused', {
      userId,
      intent: preCheck.intent
    });

    // Log grounding failure
    supabase
      .from('copilot_grounding_failures')
      .insert({
        user_id: userId,
        user_query: userMessage,
        missing_sources: Object.keys(ragContext).filter(
          k =>
            !['data_sources_used', 'data_completeness', 'confidence_score', 'is_sufficient', 'retrieval_ms', 'retrieved_at', '_cached'].includes(k) &&
            ragContext[k] === null
        ),
        data_completeness: ragContext.data_completeness,
        refusal_message: preCheck.refusalMessage
      })
      .then(() => {})
      .catch(() => {});
    return {
      response: preCheck.refusalMessage,
      data_sources: [],
      confidence: 0,
      was_grounded: false,
      refused: true,
      refusal_reason: preCheck.intent,
      duration_ms: Date.now() - startMs
    };
  }

  // ── Step 3: BUILD CONTEXT ────────────────────────────────────────────────
  const contextObj = ragContextBuilder.buildContext(ragContext);

  // ── Step 4: LOAD HISTORY ─────────────────────────────────────────────────
  let history = [];
  try {
    history = await _loadHistory(userId, conversationId);
  } catch (_) {}

  // Build conversation messages for multi-turn context
  const messages = [
    ...history.flatMap(turn => [
      { role: 'user', content: turn.user_message },
      { role: 'assistant', content: turn.ai_response }
    ]),
    { role: 'user', content: userMessage }
  ];
  const turnIndex = history.length;

  // ── Step 5: GENERATE ─────────────────────────────────────────────────────
  const systemPrompt = _buildSystemPrompt(contextObj.contextString, contextObj.dataSources, userName);
  let rawResponse = null;
  let llmError = null;
  try {
    const completion = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: systemPrompt,
      messages
    });
    rawResponse = completion.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
  } catch (err) {
    llmError = err;
    logger.error('[CopilotService] LLM call failed', { userId, err: err.message });
  }

  // LLM failure fallback — grounded fallback based on available data
  if (!rawResponse) {
    rawResponse = _buildFallbackResponse(ragContext, preCheck.intent);
  }

  // ── Step 6: POST-FLIGHT HALLUCINATION SCAN ───────────────────────────────
  const { cleanedResponse, violations, wasModified } = groundingGuard.postFlightScan(rawResponse, ragContext);
  if (violations.length > 0) {
    logger.warn('[CopilotService] Hallucination patterns detected', {
      userId,
      violations,
      wasModified
    });
  }

  // ── Step 7: CALCULATE CONFIDENCE ─────────────────────────────────────────
  const confidence = groundingGuard.calculateResponseConfidence(ragContext, preCheck.intent, contextObj.dataSources);

  // ── Step 8: PERSIST ──────────────────────────────────────────────────────
  let ragContextId = null;
  try {
    ragContextId = await _saveRAGContext(userId, conversationId, turnIndex, {
      userQuery: userMessage,
      ragContext,
      contextObj,
      aiResponse: cleanedResponse,
      confidence,
      refused: false,
      refusalReason: null
    });
    await _saveConversationTurn(userId, conversationId, turnIndex, {
      userMessage,
      aiResponse: cleanedResponse,
      dataSources: contextObj.dataSources,
      confidence,
      ragContextId
    });
  } catch (err) {
    logger.warn('[CopilotService] Failed to persist conversation', {
      userId,
      err: err.message
    });
  }

  const durationMs = Date.now() - startMs;
  logger.info('[CopilotService] Response generated', {
    userId,
    confidence,
    sources: contextObj.dataSources.length,
    violations: violations.length,
    durationMs
  });

  return {
    response: cleanedResponse,
    data_sources: contextObj.dataSources,
    confidence,
    data_completeness: ragContext.data_completeness,
    signal_strength: _getSignalLabel(ragContext.data_completeness),
    was_grounded: true,
    refused: false,
    violations_found: violations.length > 0,
    conversation_id: conversationId,
    rag_context_id: ragContextId,
    duration_ms: durationMs
  };
}

// ─── getHistory ───────────────────────────────────────────────────────────────

async function getHistory(userId, conversationId) {
  const { data } = await supabase
    .from('copilot_conversations')
    .select('user_message, ai_response, data_sources, confidence, created_at, turn_index')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .order('turn_index', { ascending: true })
    .limit(50);
  return {
    conversations: data || [],
    conversation_id: conversationId
  };
}

// ─── getWelcome ───────────────────────────────────────────────────────────────

async function getWelcome(userId) {
  const ragContext = await ragRetriever.retrieveContext(userId).catch(() => null);
  const profile = ragContext?.user_profile;
  const name = profile ? await _loadUserName(userId) : null;
  const firstName = name ? name.split(' ')[0] : null;
  const greeting = firstName ? `Hello, ${firstName}! 👋` : 'Hello! 👋';
  const dataParts = [];
  if (ragContext?.chi_score) dataParts.push('your Career Health Score');
  if (ragContext?.skill_gaps) dataParts.push('skill gap analysis');
  if (ragContext?.job_matches) dataParts.push('job matches');
  if (ragContext?.opportunity_radar) dataParts.push('opportunity radar');
  const dataNote =
    dataParts.length > 0
      ? `I have access to ${dataParts.join(', ')}.`
      : 'Complete your profile to unlock personalised advice.';
  return {
    message: `${greeting} I'm your Career Copilot.\n\n${dataNote}\n\nAsk me anything about your career path, skills to learn, or job opportunities. My answers are based only on your real platform data.`,
    user_name: name,
    data_sources_available: ragContext?.data_sources_used || [],
    data_completeness: ragContext?.data_completeness || 0
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function _loadUserName(userId) {
  try {
    const { data, error } = await supabase
      .from('userProfiles')
      .select('name, fullName')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) return null;
    return data.name || data.fullName || null;
  } catch (_) {
    return null;
  }
}

function _buildFallbackResponse(ragContext, intent) {
  const sources = ragContext?.data_sources_used || [];
  if (sources.length === 0) {
    return `I'm having trouble connecting to my AI engine right now. Please try again in a moment. Meanwhile, check your career dashboards for your latest scores and recommendations.`;
  }
  return `I'm currently unable to generate a detailed response, but based on your ${sources.join(' and ')} data, I can see your profile is being tracked. Please try your question again in a moment.`;
}

function _getSignalLabel(completeness) {
  if (completeness >= 0.75) return 'high';
  if (completeness >= 0.50) return 'medium';
  if (completeness >= 0.25) return 'low';
  return 'insufficient';
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  chat,
  getHistory,
  getWelcome
};