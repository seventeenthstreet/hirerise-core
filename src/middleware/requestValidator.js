'use strict';

/**
 * requestValidator.js (Production Optimized)
 */

const { validationResult } = require('express-validator');
const { AppError, ErrorCodes } = require('./errorHandler');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATOR FACTORY
// ─────────────────────────────────────────────────────────────────────────────

const validate = (chains = []) => {
  return [
    ...chains,

    (req, res, next) => {
      const result = validationResult(req);

      if (result.isEmpty()) {
        return next();
      }

      const errors = result.array();

      // Format safely (no sensitive data leakage)
      const formattedErrors = errors.map(err => ({
        field: err.path,
        message: err.msg,
        location: err.location,
        // ⚠️ Avoid returning raw value unless needed
        ...(process.env.NODE_ENV === 'development' && { value: err.value }),
      }));

      // Observability logging (non-sensitive)
      logger.warn('[Validation] Request validation failed', {
        correlationId: req.correlationId,
        path: req.path,
        method: req.method,
        errorCount: errors.length,
        fields: formattedErrors.map(e => e.field),
      });

      return next(
        new AppError(
          'Request validation failed',
          400,
          { fields: formattedErrors },
          ErrorCodes.VALIDATION_ERROR
        )
      );
    },
  ];
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { validate };