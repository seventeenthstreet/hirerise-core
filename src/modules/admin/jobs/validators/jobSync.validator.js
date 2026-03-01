'use strict';

const Joi = require('joi');

const SUPPORTED_SOURCE_TYPES = ['google_sheets', 'csv', 'json'];

// Only allow safe jobCode characters (used as Firestore doc ID)
const SAFE_JOBCODE_REGEX = /^[A-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Request Body Schema
// ---------------------------------------------------------------------------

const jobSyncSchema = Joi.object({

  sourceType: Joi.string()
    .valid(...SUPPORTED_SOURCE_TYPES)
    .required()
    .messages({
      'any.only': `sourceType must be one of: ${SUPPORTED_SOURCE_TYPES.join(', ')}`,
      'any.required': 'sourceType is required',
    }),

  sourceUrl: Joi.string()
    .uri({ scheme: ['https'] })
    .pattern(/^(?!https:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0))/i)
    .required()
    .messages({
      'string.uri': 'sourceUrl must be a valid HTTPS URL',
      'string.pattern.base': 'sourceUrl cannot point to localhost or private hosts',
      'any.required': 'sourceUrl is required',
    }),

  options: Joi.object({
    skipHeader: Joi.boolean().default(true),
    delimiter:  Joi.string().max(1).default(','),
    sheetId:    Joi.string().max(100).optional(),
  }).default({}),

}).options({
  allowUnknown: false,
  abortEarly: false,
  stripUnknown: true,
});

// ---------------------------------------------------------------------------
// Job Record Schema
// ---------------------------------------------------------------------------

const jobRecordSchema = Joi.object({

  jobCode: Joi.string()
    .trim()
    .uppercase()
    .pattern(SAFE_JOBCODE_REGEX)
    .max(100)
    .required()
    .messages({
      'string.pattern.base': 'jobCode may only contain A-Z, 0-9, hyphen (-), and underscore (_)',
    }),

  title: Joi.string().trim().max(200).required(),

  company: Joi.string().trim().max(200).required(),

  location: Joi.string().trim().max(200).required(),

  type: Joi.string()
    .valid('full_time', 'part_time', 'contract', 'internship', 'remote')
    .required(),

  salary: Joi.object({
    min: Joi.number().min(0).required(),
    max: Joi.number().min(Joi.ref('min')).required(),
    currency: Joi.string().length(3).uppercase().default('USD'),
  }).optional(),

  description: Joi.string().trim().max(10_000).optional(),

  tags: Joi.array()
    .items(
      Joi.string()
        .trim()
        .lowercase()
        .max(50)
    )
    .max(20)
    .default([]),

  externalUrl: Joi.string()
    .uri({ scheme: ['https'] })
    .optional(),

  postedAt: Joi.date().iso().optional(),

}).options({
  allowUnknown: false,
  abortEarly: false,
  stripUnknown: true,
});

// ---------------------------------------------------------------------------

function validateSyncRequest(body) {
  return jobSyncSchema.validate(body);
}

function validateJobRecord(record) {
  return jobRecordSchema.validate(record);
}

module.exports = { validateSyncRequest, validateJobRecord };