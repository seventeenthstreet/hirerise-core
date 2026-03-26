/**
 * helpers.js — Async Wrappers & Response Utilities
 *
 * asyncHandler: Wraps async controller functions so unhandled promise
 * rejections are automatically forwarded to Express's error middleware.
 * Without this, an unhandled async error in a controller silently hangs
 * the request or crashes the process.
 *
 * Note: We apply this via server.js express error propagation, but having
 * it available as a named utility enables explicit wrapping in edge cases
 * and is useful in testing.
 */

'use strict';

/**
 * Wraps an async Express handler to forward any thrown error to next().
 * Usage: router.get('/path', asyncHandler(myAsyncController))
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Standard success response formatter.
 * Ensures every success response has a consistent envelope.
 */
const sendSuccess = (res, data, statusCode = 200, meta = {}) => {
  res.status(statusCode).json({
    success: true,
    data,
    meta: {
      ...meta,
      respondedAt: new Date().toISOString(),
    },
  });
};

/**
 * Paginated response formatter.
 * Use when returning lists that support pagination.
 */
const sendPaginated = (res, items, { page, limit, total }) => {
  res.status(200).json({
    success: true,
    data:    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext:    page * limit < total,
      hasPrev:    page > 1,
    },
  });
};

module.exports = { asyncHandler, sendSuccess, sendPaginated };









