'use strict';

/**
 * adminCmsCareerDomains.module.js
 *
 * CMS module for the `career_domains` Firestore collection.
 * Reuses the generic factory for standard CRUD + dedup pipeline.
 *
 * Firestore collection: cms_career_domains
 *
 * Schema:
 *   domain_id        — auto-generated Firestore doc ID
 *   name             — human-readable domain name  (e.g. "Software Engineering")
 *   description      — optional summary
 *   normalizedName   — lowercase/trimmed for dedup
 *   status           — 'active' | 'inactive'
 *   createdByAdminId
 *   updatedByAdminId
 *   softDeleted
 *
 * @module modules/admin/cms/career-domains/adminCmsCareerDomains.module
 */

const { createCmsDatasetModule } = require('../adminCmsGeneric.factory');
const { body }                   = require('express-validator');

const careerDomainsModule = createCmsDatasetModule({
  collection:    'cms_career_domains',
  datasetType:   'careerDomains',
  allowedFields: ['name', 'description'],
  extraValidators: [
    body('description').optional().isString().trim().isLength({ max: 500 }),
  ],
});

module.exports = careerDomainsModule;









