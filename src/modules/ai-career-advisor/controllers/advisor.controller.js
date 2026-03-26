'use strict';

/**
 * controllers/advisor.controller.js
 *
 * HTTP controller for the AI Career Advisor module.
 *
 * Endpoints handled:
 *   POST /api/v1/advisor/chat/:studentId      → generate AI response
 *   GET  /api/v1/advisor/welcome/:studentId   → fetch welcome message (no AI call)
 *   GET  /api/v1/advisor/history/:studentId   → fetch conversation history
 *
 * Auth: all routes require `authenticate` middleware (Firebase ID token).
 * The controller validates that the caller IS the student (or is an admin).
 */

const logger          = require('../../../utils/logger');
const advisorService  = require('../services/advisor.service');

// ─── Helpers ───────────────────────────────────────────────────────────────────

function ok(res, data) {
  return res.status(200).json({ success: true, data });
}

function fail(res, statusCode, message, code = 'ADVISOR_ERROR') {
  return res.status(statusCode).json({ success: false, error: { message, code } });
}

// ─── POST /api/v1/advisor/chat/:studentId ──────────────────────────────────────

/**
 * chat
 *
 * Validates the incoming message, hands off to advisor.service.chat(),
 * returns the AI response.
 *
 * Request body:
 *   { message: string }   — the student's question (1–2000 chars)
 *
 * Response 200:
 *   { success: true, data: { response: string, studentName: string|null } }
 */
async function chat(req, res) {
  const { studentId } = req.params;
  const { message }   = req.body;

  // ── Input validation ────────────────────────────────────────────────────
  if (!message || typeof message !== 'string') {
    return fail(res, 400, 'message is required and must be a string.', 'MISSING_MESSAGE');
  }

  const trimmed = message.trim();

  if (trimmed.length === 0) {
    return fail(res, 400, 'message cannot be empty.', 'EMPTY_MESSAGE');
  }

  if (trimmed.length > 2000) {
    return fail(res, 400, 'message must not exceed 2000 characters.', 'MESSAGE_TOO_LONG');
  }

  // ── Auth guard — caller must be the student or an admin ─────────────────
  const callerUid = req.user && req.user.uid;
  const isAdmin   = req.user && (req.user.role === 'admin' || req.user.is_admin);

  if (!isAdmin && callerUid !== studentId) {
    return fail(res, 403, 'You do not have permission to access this student\'s advisor.', 'FORBIDDEN');
  }

  try {
    const result = await advisorService.chat(studentId, trimmed);
    return ok(res, result);
  } catch (err) {
    const status = err.statusCode || 500;
    logger.error({ studentId, err: err.message }, '[AdvisorController] chat error');
    return fail(res, status, err.message);
  }
}

// ─── GET /api/v1/advisor/welcome/:studentId ────────────────────────────────────

/**
 * welcome
 *
 * Returns the welcome message shown when the student opens the advisor page.
 * Does NOT call Claude — returns immediately.
 *
 * Response 200:
 *   { success: true, data: { message: string, studentName: string|null } }
 */
async function welcome(req, res) {
  const { studentId } = req.params;

  const callerUid = req.user && req.user.uid;
  const isAdmin   = req.user && (req.user.role === 'admin' || req.user.is_admin);

  if (!isAdmin && callerUid !== studentId) {
    return fail(res, 403, 'Forbidden.', 'FORBIDDEN');
  }

  try {
    const result = await advisorService.getWelcome(studentId);
    return ok(res, result);
  } catch (err) {
    logger.error({ studentId, err: err.message }, '[AdvisorController] welcome error');
    return fail(res, 500, 'Failed to load welcome message.');
  }
}

// ─── GET /api/v1/advisor/history/:studentId ────────────────────────────────────

/**
 * history
 *
 * Returns the student's conversation history.
 *
 * Response 200:
 *   { success: true, data: { conversations: Array<ConversationDoc> } }
 */
async function history(req, res) {
  const { studentId } = req.params;

  const callerUid = req.user && req.user.uid;
  const isAdmin   = req.user && (req.user.role === 'admin' || req.user.is_admin);

  if (!isAdmin && callerUid !== studentId) {
    return fail(res, 403, 'Forbidden.', 'FORBIDDEN');
  }

  try {
    const result = await advisorService.getHistory(studentId);
    return ok(res, result);
  } catch (err) {
    logger.error({ studentId, err: err.message }, '[AdvisorController] history error');
    return fail(res, 500, 'Failed to load conversation history.');
  }
}

module.exports = { chat, welcome, history };









