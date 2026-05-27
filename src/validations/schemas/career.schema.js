'use strict';

import { body } from 'express-validator';
import { CAREER_FIELDS } from '../constants/fields.js';

/**
 * Validation schema for POST /v1/career/path
 *
 * Fields:
 *   currentTitle  – required string, the user's current job title
 *   targetTitle   – required string, the desired career target
 *   currentSkills – optional array of skill strings (up to 50 items)
 */
export const careerPathSchema = [
  body()
    .custom((_, { req }) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new Error('Invalid request body');
      }
      const extra = Object.keys(req.body).filter(
        (key) => !CAREER_FIELDS.includes(key),
      );
      if (extra.length > 0) {
        throw new Error(`Unknown fields: ${extra.join(', ')}`);
      }
      return true;
    }),

  body('currentTitle')
    .isString()
    .withMessage('currentTitle must be a string')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('currentTitle is required')
    .bail()
    .isLength({ max: 200 })
    .withMessage('currentTitle must not exceed 200 characters'),

  body('targetTitle')
    .isString()
    .withMessage('targetTitle must be a string')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('targetTitle is required')
    .bail()
    .isLength({ max: 200 })
    .withMessage('targetTitle must not exceed 200 characters'),

  body('currentSkills')
    .optional()
    .isArray({ max: 50 })
    .withMessage('currentSkills must be an array with at most 50 items'),

  body('currentSkills.*')
    .optional()
    .isString()
    .withMessage('Each skill must be a string')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('Skill entries must not be empty strings')
    .bail()
    .isLength({ max: 100 })
    .withMessage('Each skill must not exceed 100 characters'),
];