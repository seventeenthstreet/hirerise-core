'use strict';

/**
 * anthropic.client.js — Anthropic Claude API Client
 *
 * Single shared instance used across all services.
 * API key loaded from ANTHROPIC_API_KEY environment variable.
 */

const Anthropic = require('@anthropic-ai/sdk');

if (!process.env.ANTHROPIC_API_KEY && process.env.NODE_ENV !== 'test') {
  throw new Error(
    'ANTHROPIC_API_KEY is not set. Add it to your .env file.'
  );
}

const anthropic = process.env.NODE_ENV === 'test'
  ? null  // Not used in test mode — resume.service stubs handle test responses
  : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = anthropic;