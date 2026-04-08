'use strict';

/**
 * helpers.js — Async Wrappers & Response Utilities
 *
 * Production-safe Express helpers:
 * - asyncHandler
 * - sendSuccess
 * - sendPaginated
 */

/**
 * Wrap async Express handlers safely.
 *
 * Prevents unhandled promise rejections and ensures
 * sync + async errors both flow to next().
 *
 * @param {Function} fn
 * @returns {Function}
 */
const asyncHandler = (fn) => {
  if (typeof fn !== 'function') {
    throw new TypeError('[helpers] asyncHandler requires a function');
  }

  return function wrappedAsyncHandler(req, res, next) {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(next);
  };
};

/**
 * Standard success response formatter.
 *
 * @param {import('express').Response} res
 * @param {unknown} data
 * @param {number} [statusCode=200]
 * @param {object} [meta={}]
 */
const sendSuccess = (res, data, statusCode = 200, meta = {}) => {
  const safeMeta =
    meta && typeof meta === 'object' && !Array.isArray(meta)
      ? meta
      : {};

  return res.status(statusCode).json({
    success: true,
    data,
    meta: {
      ...safeMeta,
      responded_at: new Date().toISOString(),
    },
  });
};

/**
 * Standard paginated response formatter.
 *
 * @param {import('express').Response} res
 * @param {Array} items
 * @param {{
 *   page?: number,
 *   limit?: number,
 *   total?: number,
 *   meta?: object
 * }} options
 */
const sendPaginated = (
  res,
  items,
  {
    page = 1,
    limit = 10,
    total = Array.isArray(items) ? items.length : 0,
    meta = {},
  } = {}
) => {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Number(limit) || 10);
  const safeTotal = Math.max(0, Number(total) || 0);
  const totalPages = Math.ceil(safeTotal / safeLimit);

  return res.status(200).json({
    success: true,
    data: Array.isArray(items) ? items : [],
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: safeTotal,
      total_pages: totalPages,
      has_next: safePage < totalPages,
      has_prev: safePage > 1,
    },
    meta: {
      ...(meta || {}),
      responded_at: new Date().toISOString(),
    },
  });
};

module.exports = {
  asyncHandler,
  sendSuccess,
  sendPaginated,
};