'use strict';

import { validationResult } from 'express-validator';

/**
 * Generic validation middleware.
 *
 * Reads the accumulated express-validator errors from the request object.
 * If any errors exist, responds immediately with a standardised 400 payload
 * so no controller ever receives untrusted input.
 *
 * Attach AFTER a schema array and BEFORE the controller:
 *   router.post('/path', careerPathSchema, validate, controller)
 *
 * Response format (intentionally matches the existing API error shape):
 * {
 *   success: false,
 *   error:   'ValidationError',
 *   details: [ { msg, param, location, value } ]
 * }
 */
export function validate(req, res, next) {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'ValidationError',
      details: errors.array(),
      requestId: req.requestId ?? null,
      timestamp: new Date().toISOString(),
    });
  }

  return next();
}