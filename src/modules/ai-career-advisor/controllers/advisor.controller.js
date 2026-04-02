'use strict';

/**
 * @file src/modules/advisor/controllers/advisor.controller.js
 * @description
 * Production-grade HTTP controller for AI Career Advisor.
 *
 * Optimized for:
 * - Supabase auth-safe access control
 * - request timeout protection
 * - client disconnect detection
 * - low-latency JSON responses
 * - future SSE-ready architecture
 */

const logger = require('../../../utils/logger');
const advisorService = require('../services/advisor.service');

const REQUEST_TIMEOUT_MS = 30000;
const MAX_MESSAGE_LENGTH = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Response helpers
// ─────────────────────────────────────────────────────────────────────────────
function ok(res, data) {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({
    success: true,
    data,
  });
}

function fail(res, statusCode, message, code = 'ADVISOR_ERROR') {
  res.set('Cache-Control', 'no-store');
  return res.status(statusCode).json({
    success: false,
    error: { message, code },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorization
// ─────────────────────────────────────────────────────────────────────────────
function hasAdvisorAccess(req, studentId) {
  const callerId = req.user?.id || req.user?.uid;
  const role = req.user?.role;
  const isAdmin = role === 'admin' || req.user?.is_admin === true;

  return isAdmin || callerId === studentId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeout wrapper
// ─────────────────────────────────────────────────────────────────────────────
function withTimeout(promise, ms = REQUEST_TIMEOUT_MS) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Advisor request timed out'));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /advisor/chat/:studentId
// ─────────────────────────────────────────────────────────────────────────────
async function chat(req, res) {
  const { studentId } = req.params;
  const rawMessage = req.body?.message;

  if (typeof rawMessage !== 'string') {
    return fail(
      res,
      400,
      'message is required and must be a string.',
      'MISSING_MESSAGE'
    );
  }

  const message = rawMessage.trim();

  if (!message) {
    return fail(res, 400, 'message cannot be empty.', 'EMPTY_MESSAGE');
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return fail(
      res,
      400,
      `message must not exceed ${MAX_MESSAGE_LENGTH} characters.`,
      'MESSAGE_TOO_LONG'
    );
  }

  if (!hasAdvisorAccess(req, studentId)) {
    return fail(
      res,
      403,
      'You do not have permission to access this student advisor.',
      'FORBIDDEN'
    );
  }

  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
  });

  try {
    const result = await withTimeout(
      advisorService.chat(studentId, message)
    );

    if (clientDisconnected) {
      logger.warn('[AdvisorController] Client disconnected before response', {
        studentId,
      });
      return;
    }

    return ok(res, result);
  } catch (err) {
    logger.error('[AdvisorController] chat error', {
      studentId,
      error: err.message,
    });

    return fail(
      res,
      err.statusCode || 500,
      err.message || 'Advisor chat failed.'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /advisor/welcome/:studentId
// ─────────────────────────────────────────────────────────────────────────────
async function welcome(req, res) {
  const { studentId } = req.params;

  if (!hasAdvisorAccess(req, studentId)) {
    return fail(res, 403, 'Forbidden.', 'FORBIDDEN');
  }

  try {
    const result = await withTimeout(
      advisorService.getWelcome(studentId)
    );

    return ok(res, result);
  } catch (err) {
    logger.error('[AdvisorController] welcome error', {
      studentId,
      error: err.message,
    });

    return fail(res, 500, 'Failed to load welcome message.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /advisor/history/:studentId
// ─────────────────────────────────────────────────────────────────────────────
async function history(req, res) {
  const { studentId } = req.params;

  if (!hasAdvisorAccess(req, studentId)) {
    return fail(res, 403, 'Forbidden.', 'FORBIDDEN');
  }

  try {
    const result = await withTimeout(
      advisorService.getHistory(studentId)
    );

    return ok(res, result);
  } catch (err) {
    logger.error('[AdvisorController] history error', {
      studentId,
      error: err.message,
    });

    return fail(res, 500, 'Failed to load conversation history.');
  }
}

module.exports = {
  chat,
  welcome,
  history,
};