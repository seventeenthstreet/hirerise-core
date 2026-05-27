'use strict';

/**
 * src/modules/student-onboarding/validators/cognitive.validator.js
 *
 * SERVER-SIDE VALIDATION — Cognitive & Processing Intelligence (Phase 3C)
 *
 * POSITION IN STACK:
 *   Route → [validateCognitive* middleware] → Controller → Service
 *
 * VALIDATION PHILOSOPHY:
 *   • Server is authoritative. Frontend validation is UX-only.
 *   • Partial saves are supported — students can answer one question at a time.
 *   • question_id must correspond to a real, active question (ownership check).
 *   • selected_option_keys must be non-empty; multi-select capped at MAX_MULTI_SELECT_CHOICES.
 *   • Duplicate responses for the same question are prevented at the DB layer
 *     (UNIQUE constraint) but also caught here for a clean error message.
 *
 * ERROR SHAPE:
 *   All errors throw CognitiveValidationError({ message, field, status: 400 })
 */

const {
  ALL_COGNITIVE_SIGNAL_TAGS,
  MAX_MULTI_SELECT_CHOICES,
  SIGNAL_WEIGHT_MIN,
  SIGNAL_WEIGHT_MAX,
} = require('../constants/cognitive');

// ─────────────────────────────────────────────────────────────────────────────
// Validation error
// ─────────────────────────────────────────────────────────────────────────────

class CognitiveValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name   = 'CognitiveValidationError';
    this.field  = field;
    this.status = 400;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive validators
// ─────────────────────────────────────────────────────────────────────────────

function requireBody(body) {
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    throw new CognitiveValidationError('Request body must be a JSON object.');
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CognitiveValidationError(`${field} is required and must be a non-empty string.`, field);
  }
  return value.trim();
}

function requireUUID(value, field) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new CognitiveValidationError(`${field} must be a valid UUID.`, field);
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// validateSaveResponse
// Validates a single question response payload.
//
// Expected body shape:
//   {
//     question_id:          string (UUID)
//     selected_option_keys: string[]  (1–MAX_MULTI_SELECT_CHOICES elements)
//     is_partial?:          boolean   (default: true)
//   }
// ─────────────────────────────────────────────────────────────────────────────

function validateSaveResponse(body) {
  requireBody(body);

  const question_id = requireUUID(body.question_id, 'question_id');

  if (!Array.isArray(body.selected_option_keys)) {
    throw new CognitiveValidationError(
      'selected_option_keys must be an array of option key strings.',
      'selected_option_keys',
    );
  }

  if (body.selected_option_keys.length === 0) {
    throw new CognitiveValidationError(
      'selected_option_keys must contain at least one selection.',
      'selected_option_keys',
    );
  }

  if (body.selected_option_keys.length > MAX_MULTI_SELECT_CHOICES) {
    throw new CognitiveValidationError(
      `selected_option_keys may contain at most ${MAX_MULTI_SELECT_CHOICES} selections.`,
      'selected_option_keys',
    );
  }

  const selected_option_keys = body.selected_option_keys.map((key, idx) => {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new CognitiveValidationError(
        `selected_option_keys[${idx}] must be a non-empty string.`,
        'selected_option_keys',
      );
    }
    return key.trim();
  });

  // Deduplicate silently (UI shouldn't send dupes, but be resilient)
  const deduped = [...new Set(selected_option_keys)];

  const is_partial = body.is_partial !== undefined ? Boolean(body.is_partial) : true;

  return { question_id, selected_option_keys: deduped, is_partial };
}

// ─────────────────────────────────────────────────────────────────────────────
// validateBatchResponses
// Validates multiple question responses in a single request.
// Used by the frontend to batch-save all answers at once on commit.
//
// Expected body shape:
//   {
//     responses: [
//       { question_id: uuid, selected_option_keys: string[] },
//       ...
//     ]
//   }
// ─────────────────────────────────────────────────────────────────────────────

function validateBatchResponses(body) {
  requireBody(body);

  if (!Array.isArray(body.responses) || body.responses.length === 0) {
    throw new CognitiveValidationError(
      'responses must be a non-empty array.',
      'responses',
    );
  }

  const seenQuestionIds = new Set();
  const validated = body.responses.map((item, idx) => {
    let parsed;
    try {
      parsed = validateSaveResponse({ ...item, is_partial: true });
    } catch (err) {
      throw new CognitiveValidationError(
        `responses[${idx}]: ${err.message}`,
        `responses[${idx}]`,
      );
    }

    if (seenQuestionIds.has(parsed.question_id)) {
      throw new CognitiveValidationError(
        `Duplicate question_id "${parsed.question_id}" at responses[${idx}]. Each question may appear only once.`,
        `responses[${idx}].question_id`,
      );
    }
    seenQuestionIds.add(parsed.question_id);
    return parsed;
  });

  return { responses: validated };
}

// ─────────────────────────────────────────────────────────────────────────────
// validateOptionOwnership
// Confirms that every selected_option_key belongs to the given question.
// Called by the service layer after fetching options from the DB.
//
// @param {string[]} selectedKeys
// @param {string[]} validKeys       — option_keys from the DB for this question
// @param {string}   questionKey     — for error messaging
// @throws CognitiveValidationError
// ─────────────────────────────────────────────────────────────────────────────

function validateOptionOwnership(selectedKeys, validKeys, questionKey) {
  const validSet = new Set(validKeys);
  for (const key of selectedKeys) {
    if (!validSet.has(key)) {
      throw new CognitiveValidationError(
        `Option key "${key}" does not belong to question "${questionKey}".`,
        'selected_option_keys',
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// validateMultiSelectAllowed
// Confirms that single-select questions received only one selection.
//
// @param {boolean}  allowsMulti
// @param {string[]} selectedKeys
// @param {string}   questionKey
// ─────────────────────────────────────────────────────────────────────────────

function validateMultiSelectAllowed(allowsMulti, selectedKeys, questionKey) {
  if (!allowsMulti && selectedKeys.length > 1) {
    throw new CognitiveValidationError(
      `Question "${questionKey}" is single-select. Only one option may be chosen.`,
      'selected_option_keys',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware factories
// ─────────────────────────────────────────────────────────────────────────────

function validateSaveResponseMiddleware(req, res, next) {
  try {
    req.validatedCognitiveResponse = validateSaveResponse(req.body);
    next();
  } catch (err) {
    if (err.name === 'CognitiveValidationError') {
      return res.status(400).json({
        ok:    false,
        error: { message: err.message, field: err.field },
      });
    }
    next(err);
  }
}

function validateBatchResponsesMiddleware(req, res, next) {
  try {
    req.validatedBatchResponses = validateBatchResponses(req.body);
    next();
  } catch (err) {
    if (err.name === 'CognitiveValidationError') {
      return res.status(400).json({
        ok:    false,
        error: { message: err.message, field: err.field },
      });
    }
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  CognitiveValidationError,
  validateSaveResponse,
  validateBatchResponses,
  validateOptionOwnership,
  validateMultiSelectAllowed,
  validateSaveResponseMiddleware,
  validateBatchResponsesMiddleware,
};
