'use strict';

/**
 * aiSanitizer.middleware.js (Production Optimized)
 */

const { supabase } = require('../config/supabase'); // ✅ REQUIRED (kept for consistency)
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const STRICT_MODE = process.env.AI_SANITIZER_STRICT === 'true';

// Precompile patterns once (performance boost)
const INJECTION_PATTERNS = Object.freeze([
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi, replacement: '[removed]' },
  { pattern: /you\s+are\s+now\s+(a\s+)?(different|new|an?\s+)?(\w+\s+)?AI/gi, replacement: '[removed]' },
  { pattern: /pretend\s+(that\s+)?you\s+(are|were)\s+/gi, replacement: '[removed]' },
  { pattern: /act\s+as\s+(a\s+)?(new|different|unrestricted|DAN|jailbreak)/gi, replacement: '[removed]' },
  { pattern: /\bDAN\b|\bjailbreak\b|\bunfiltered\b|\bunrestricted\s+mode\b/gi, replacement: '[removed]' },

  { pattern: /<\s*system\s*>/gi, replacement: '[system]' },
  { pattern: /<\/\s*system\s*>/gi, replacement: '[/system]' },
  { pattern: /<\s*user\s*>/gi, replacement: '[user]' },
  { pattern: /<\/\s*user\s*>/gi, replacement: '[/user]' },
  { pattern: /<\s*assistant\s*>/gi, replacement: '[assistant]' },

  { pattern: /\bnew\s+instructions?\s*:/gi, replacement: '[instructions:]' },
  { pattern: /\boverride\s+(all\s+)?(previous\s+)?instructions?\b/gi, replacement: '[removed]' },
  { pattern: /\bdisregard\s+(all\s+)?(previous\s+)?(instructions?|context|constraints?)\b/gi, replacement: '[removed]' },
  { pattern: /\bforget\s+(all\s+)?(previous\s+)?(instructions?|context|conversation)\b/gi, replacement: '[removed]' },

  { pattern: /```[\s\S]{0,20}```/g, replacement: '[code block removed]' },
  { pattern: /```/g, replacement: "'''" },

  { pattern: /print\s+(your\s+)?(system\s+)?prompt/gi, replacement: '[removed]' },
  { pattern: /reveal\s+(your\s+)?(system\s+)?instructions?/gi, replacement: '[removed]' },
  { pattern: /show\s+(me\s+)?(your\s+)?(system\s+)?prompt/gi, replacement: '[removed]' },
  { pattern: /what\s+(are\s+)?(your|the)\s+(system\s+)?instructions?/gi, replacement: '[removed]' },
]);

const FIELD_MAX_LENGTHS = Object.freeze({
  jobDescription:  8000,
  resumeText:      6000,
  personalDetails: 2000,
  summary:         500,
  default:         3000,
});

// ─────────────────────────────────────────────────────────────────────────────
// CORE SANITIZER
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeText(text, fieldName = 'unknown') {
  if (typeof text !== 'string') {
    return { sanitized: text, patternsFound: [] };
  }

  let result = text;
  const patternsFound = [];

  for (const { pattern, replacement } of INJECTION_PATTERNS) {
    const updated = result.replace(pattern, replacement);
    if (updated !== result) {
      patternsFound.push(pattern.source.slice(0, 40));
      result = updated;
    }
  }

  // Length enforcement
  const maxLen = FIELD_MAX_LENGTHS[fieldName] ?? FIELD_MAX_LENGTHS.default;

  if (result.length > maxLen) {
    result = result.slice(0, maxLen);
    patternsFound.push(`truncated:${fieldName}:${maxLen}`);
  }

  return { sanitized: result, patternsFound };
}

function sanitizeObject(obj, fields) {
  if (!obj || typeof obj !== 'object') {
    return { sanitized: obj, allPatternsFound: [] };
  }

  const sanitized = { ...obj };
  const allPatternsFound = [];

  for (const field of fields) {
    if (sanitized[field] == null) continue;

    if (typeof sanitized[field] === 'string') {
      const { sanitized: clean, patternsFound } = sanitizeText(sanitized[field], field);
      sanitized[field] = clean;
      allPatternsFound.push(...patternsFound);

    } else if (typeof sanitized[field] === 'object' && !Array.isArray(sanitized[field])) {
      const nested = { ...sanitized[field] };

      for (const [k, v] of Object.entries(nested)) {
        if (typeof v === 'string') {
          const { sanitized: cleanV, patternsFound } = sanitizeText(v, k);
          nested[k] = cleanV;
          allPatternsFound.push(...patternsFound);
        }
      }

      sanitized[field] = nested;
    }
  }

  return { sanitized, allPatternsFound };
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeAiInputs(fields = []) {
  return function (req, res, next) {
    if (!req.body || fields.length === 0) return next();

    const { sanitized, allPatternsFound } = sanitizeObject(req.body, fields);

    if (allPatternsFound.length > 0) {
      const userId = req.user?.uid ?? 'unknown';

      logger.warn('[AISanitizer] Injection detected', {
        userId,
        path: req.path,
        patternsFound,
        count: allPatternsFound.length,
      });

      // 🔥 Optional: store security event in Supabase (future-ready)
      try {
        supabase.from('security_events').insert({
          user_id: userId,
          type: 'ai_prompt_injection',
          metadata: {
            patterns: allPatternsFound.slice(0, 5),
            path: req.path,
          },
        }).catch(() => {});
      } catch {}

      if (STRICT_MODE) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Request contains disallowed content patterns.',
          },
        });
      }
    }

    req.body = sanitized;
    return next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE-LEVEL SANITIZER
// ─────────────────────────────────────────────────────────────────────────────

function sanitizePromptInput(text, fieldName = 'default') {
  if (typeof text !== 'string') return text;

  const { sanitized, patternsFound } = sanitizeText(text, fieldName);

  if (patternsFound.length > 0) {
    logger.warn('[AISanitizer] Service-level sanitization', {
      fieldName,
      patternsFound,
    });
  }

  return sanitized;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  sanitizeAiInputs,
  sanitizePromptInput,
  sanitizeText,
  INJECTION_PATTERNS,
};