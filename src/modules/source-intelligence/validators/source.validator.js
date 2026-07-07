'use strict';

/**
 * src/modules/source-intelligence/validators/source.validator.js
 *
 * express-validator chains for the SIM API surface, plus a small
 * `runValidation` helper that mirrors the canonical error response shape
 * used across the rest of the platform (see errorHandler.js).
 */

const { body, param, query, validationResult } = require('express-validator');
const {
  SOURCE_TYPES,
  SOURCE_STATUS,
  COLLECTION_METHODS,
  AUTHENTICATION_METHODS,
  UPDATE_FREQUENCIES,
  PRIORITY_LEVELS,
  isValidCapabilityProfile,
  isValidDomainList,
  isValidEntityList,
  isValidDataQualityProfile,
  isValidComplianceMetadata,
  isValidConnectorList,
  isValidFreshnessPolicy,
  SOURCE_RELATIONSHIP_TYPES,
} = require('../models/source.model');

function runValidation(req, res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();

  return res.status(400).json({
    success: false,
    error: {
      code: 'SIM_VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: errors.array().map((e) => ({
        field: e.path,
        message: e.msg,
      })),
    },
  });
}

const createSourceValidator = [
  body('displayName').isString().trim().notEmpty().withMessage('displayName is required'),
  body('sourceType')
    .isString()
    .isIn(Object.values(SOURCE_TYPES))
    .withMessage('sourceType must be a recognized SIM source type'),
  body('category').optional().isString().trim(),
  body('subcategory').optional().isString().trim(),
  body('description').optional().isString(),
  body('owner').optional().isString().trim(),
  body('maintainer').optional().isString().trim(),
  body('country').optional().isString().trim(),
  body('region').optional().isString().trim(),
  body('coverage').optional().isString().trim(),
  body('language').optional().isString().trim(),
  body('authenticationMethod')
    .optional()
    .isIn(Object.values(AUTHENTICATION_METHODS)),
  body('apiEndpoint').optional().isURL().withMessage('apiEndpoint must be a valid URL'),
  body('website').optional().isURL().withMessage('website must be a valid URL'),
  body('license').optional().isString(),
  body('usageRestrictions').optional().isString(),
  body('updateFrequency').optional().isIn(Object.values(UPDATE_FREQUENCIES)),
  body('expectedFreshnessHours').optional().isInt({ min: 0 }),
  body('collectionMethod').optional().isIn(Object.values(COLLECTION_METHODS)),
  body('preferredConnector').optional().isString(),
  body('priority').optional().isIn(Object.values(PRIORITY_LEVELS)),
  body('tags').optional().isArray(),
  body('notes').optional().isString(),

  // ── Enterprise Enhancement fields (all optional, all additive) ──────
  body('capabilityProfile')
    .optional()
    .custom(isValidCapabilityProfile)
    .withMessage('capabilityProfile must be an object of {capability: boolean} using recognized SIM capabilities'),
  body('knowledgeDomains')
    .optional()
    .custom(isValidDomainList)
    .withMessage('knowledgeDomains must be an array of recognized SIM knowledge domains'),
  body('canonicalEntityCoverage')
    .optional()
    .custom(isValidEntityList)
    .withMessage('canonicalEntityCoverage must be an array of recognized SIM canonical entities'),
  body('dataQualityProfile')
    .optional()
    .custom(isValidDataQualityProfile)
    .withMessage('dataQualityProfile must score recognized dimensions (0-100)'),
  body('complianceMetadata')
    .optional()
    .custom(isValidComplianceMetadata)
    .withMessage('complianceMetadata contains an unrecognized field or value'),
  body('connectorCompatibility')
    .optional()
    .custom(isValidConnectorList)
    .withMessage('connectorCompatibility must be an array of recognized SIM connector types'),
  body('freshnessPolicy')
    .optional()
    .custom(isValidFreshnessPolicy)
    .withMessage('freshnessPolicy contains an unrecognized field or value'),

  runValidation,
];

const updateSourceValidator = [
  param('sourceId').isUUID().withMessage('sourceId must be a UUID'),
  body('sourceType').optional().isIn(Object.values(SOURCE_TYPES)),
  body('apiEndpoint').optional().isURL(),
  body('website').optional().isURL(),
  body('updateFrequency').optional().isIn(Object.values(UPDATE_FREQUENCIES)),
  body('collectionMethod').optional().isIn(Object.values(COLLECTION_METHODS)),
  body('priority').optional().isIn(Object.values(PRIORITY_LEVELS)),
  body('tags').optional().isArray(),

  // ── Enterprise Enhancement fields (all optional, all additive) ──────
  body('capabilityProfile').optional().custom(isValidCapabilityProfile),
  body('knowledgeDomains').optional().custom(isValidDomainList),
  body('canonicalEntityCoverage').optional().custom(isValidEntityList),
  body('dataQualityProfile').optional().custom(isValidDataQualityProfile),
  body('complianceMetadata').optional().custom(isValidComplianceMetadata),
  body('connectorCompatibility').optional().custom(isValidConnectorList),
  body('freshnessPolicy').optional().custom(isValidFreshnessPolicy),

  runValidation,
];

const sourceIdParamValidator = [
  param('sourceId').isUUID().withMessage('sourceId must be a UUID'),
  runValidation,
];

const changeStatusValidator = [
  param('sourceId').isUUID().withMessage('sourceId must be a UUID'),
  body('status')
    .isString()
    .isIn(Object.values(SOURCE_STATUS))
    .withMessage('status must be a recognized SIM lifecycle status'),
  body('reason').optional().isString(),
  runValidation,
];

const searchSourceValidator = [
  query('category').optional().isString(),
  query('subcategory').optional().isString(),
  query('sourceType').optional().isIn(Object.values(SOURCE_TYPES)),
  query('status').optional().isIn(Object.values(SOURCE_STATUS)),
  query('minTrustScore').optional().isFloat({ min: 0, max: 100 }),
  // Enterprise Enhancement 2/3/6 — single-value query filters. These are
  // additive query params; omitting them preserves existing search behavior.
  query('knowledgeDomain').optional().isString(),
  query('canonicalEntity').optional().isString(),
  query('connectorType').optional().isString(),
  query('page').optional().isInt({ min: 1 }),
  query('pageSize').optional().isInt({ min: 1, max: 100 }),
  runValidation,
];

const recordHealthValidator = [
  param('sourceId').isUUID().withMessage('sourceId must be a UUID'),
  body('succeeded').isBoolean().withMessage('succeeded is required (boolean)'),
  body('latencyMs').optional().isInt({ min: 0 }),
  body('failureReason').optional().isString(),
  runValidation,
];

// ─────────────────────────────────────────────────────────────
// Enterprise Enhancement 8 — Source Relationship Model validators
// ─────────────────────────────────────────────────────────────

const createRelationshipValidator = [
  param('sourceId').isUUID().withMessage('sourceId must be a UUID'),
  body('relatedSourceId').isUUID().withMessage('relatedSourceId must be a UUID'),
  body('relationshipType')
    .isString()
    .isIn(Object.values(SOURCE_RELATIONSHIP_TYPES))
    .withMessage('relationshipType must be a recognized SIM relationship type'),
  body('notes').optional().isString(),
  runValidation,
];

const deleteRelationshipValidator = [
  param('sourceId').isUUID().withMessage('sourceId must be a UUID'),
  param('relationshipId').isUUID().withMessage('relationshipId must be a UUID'),
  runValidation,
];

module.exports = {
  runValidation,
  createSourceValidator,
  updateSourceValidator,
  sourceIdParamValidator,
  changeStatusValidator,
  searchSourceValidator,
  recordHealthValidator,
  createRelationshipValidator,
  deleteRelationshipValidator,
};
