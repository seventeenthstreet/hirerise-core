'use strict';

import { body } from 'express-validator';
import { RESUME_FIELDS } from '../constants/fields.js';

// MIME types accepted by the resume pipeline
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

/**
 * Validation schema for POST /v1/resume/submit
 *
 * Fields:
 *   resumeStoragePath – required string, path in cloud storage
 *   fileName          – required string, original file name
 *   mimeType          – required string, must be an accepted MIME type
 */
export const resumeSubmitSchema = [
  body()
    .custom((_, { req }) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new Error('Invalid request body');
      }
      const extra = Object.keys(req.body).filter(
        (key) => !RESUME_FIELDS.includes(key),
      );
      if (extra.length > 0) {
        throw new Error(`Unknown fields: ${extra.join(', ')}`);
      }
      return true;
    }),

  body('resumeStoragePath')
    .isString()
    .withMessage('resumeStoragePath must be a string')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('resumeStoragePath is required')
    .bail()
    .isLength({ max: 1024 })
    .withMessage('resumeStoragePath must not exceed 1024 characters'),

  body('fileName')
    .isString()
    .withMessage('fileName must be a string')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('fileName is required')
    .bail()
    .isLength({ max: 255 })
    .withMessage('fileName must not exceed 255 characters'),

  body('mimeType')
    .isString()
    .withMessage('mimeType must be a string')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('mimeType is required')
    .bail()
    .isIn(ALLOWED_MIME_TYPES)
    .withMessage(
      `mimeType must be one of: ${ALLOWED_MIME_TYPES.join(', ')}`,
    ),
];