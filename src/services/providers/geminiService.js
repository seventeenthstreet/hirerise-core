'use strict';

/**
 * @file src/services/providers/geminiService.js
 * @description
 * Gemini Flash provider (PRIMARY)
 *
 * Optimized for:
 * - singleton SDK reuse
 * - secret memoization
 * - timeout protection
 * - structured logging
 * - robust response validation
 * - Supabase warm runtime safety
 */

const logger = require('../../utils/logger');
const { getSecret } = require('../../modules/secrets');

let GoogleGenerativeAI;

try {
  ({ GoogleGenerativeAI } = require('@google/generative-ai'));
} catch {
  GoogleGenerativeAI = null;
}

const PROVIDER_NAME = 'gemini';
const DEFAULT_MODEL = 'gemini-1.5-flash-8b';
const REQUEST_TIMEOUT_MS = 20000;

let apiKeyPromise = null;
let clientPromise = null;

async function getClient() {
  if (!GoogleGenerativeAI) {
    throw new Error(
      'Package @google/generative-ai is not installed. Run: npm install @google/generative-ai'
    );
  }

  if (clientPromise) {
    return clientPromise;
  }

  clientPromise = (async () => {
    if (!apiKeyPromise) {
      apiKeyPromise = getSecret('GEMINI_API_KEY');
    }

    const apiKey = await apiKeyPromise;

    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('Missing Gemini API key');
    }

    return new GoogleGenerativeAI(apiKey);
  })();

  try {
    return await clientPromise;
  } catch (error) {
    clientPromise = null;
    apiKeyPromise = null;
    throw error;
  }
}

async function withTimeout(promise, timeoutMs) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Gemini request timed out'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function generate(prompt, options = {}) {
  const startedAt = Date.now();

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Gemini prompt must be a non-empty string');
  }

  const genAI = await getClient();

  const modelName = options.model || DEFAULT_MODEL;
  const model = genAI.getGenerativeModel({
    model: modelName,
  });

  try {
    const result = await withTimeout(
      model.generateContent(prompt),
      options.timeoutMs || REQUEST_TIMEOUT_MS
    );

    const response = result?.response;
    const text =
      typeof response?.text === 'function'
        ? response.text().trim()
        : '';

    if (!text) {
      throw new Error('Gemini returned an empty response');
    }

    logger.info('[AI Router] Gemini success', {
      provider: PROVIDER_NAME,
      model: modelName,
      latency_ms: Date.now() - startedAt,
      prompt_chars: prompt.length,
    });

    return {
      provider: PROVIDER_NAME,
      text,
      model: modelName,
    };
  } catch (error) {
    logger.error('[AI Router] Gemini failure', {
      provider: PROVIDER_NAME,
      model: modelName,
      latency_ms: Date.now() - startedAt,
      error: error.message,
    });

    throw error;
  }
}

module.exports = {
  generate,
  PROVIDER_NAME,
};