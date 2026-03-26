'use strict';

/**
 * geminiService.js — Gemini Flash Provider (PRIMARY)
 *
 * DEPENDENCY: @google/generative-ai
 *   Install with: npm install @google/generative-ai
 *   If absent, throws a clean error so the AI Router falls through.
 */

const { getSecret } = require('../../modules/secrets');
const logger        = require('../../utils/logger');

const PROVIDER_NAME = 'gemini';
// gemini-2.0-flash-lite is available to all API users including new accounts
const GEMINI_MODEL  = 'gemini-1.5-flash-8b'; // gemini-1.5-flash-8b: available to all API users

async function generate(prompt, options = {}) {
  let GoogleGenerativeAI;
  try {
    ({ GoogleGenerativeAI } = require('@google/generative-ai'));
  } catch {
    throw new Error('Package @google/generative-ai is not installed. Run: npm install @google/generative-ai');
  }

  const apiKey = await getSecret('GEMINI_API_KEY');
  const genAI  = new GoogleGenerativeAI(apiKey);

  const model = genAI.getGenerativeModel({
    model: options.model || GEMINI_MODEL,
  });

  const result = await model.generateContent(prompt);
  const text   = result.response.text();

  if (!text || !text.trim()) throw new Error('Gemini returned an empty response');

  logger.info(`[AI Router] ${PROVIDER_NAME} responded successfully`);
  return { provider: PROVIDER_NAME, text };
}

module.exports = { generate, PROVIDER_NAME };








