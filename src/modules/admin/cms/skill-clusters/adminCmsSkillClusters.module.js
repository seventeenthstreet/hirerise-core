'use strict';

/**
 * adminCmsSkillClusters.module.js
 *
 * CMS module for the `skill_clusters` Supabase table.
 * Extends the generic CMS dataset factory with a mandatory
 * `domainId` relationship field.
 *
 * Supabase table: cms_skill_clusters
 *
 * Schema:
 *   id               — primary key
 *   name             — e.g. "Frontend Development"
 *   domainId         — FK reference to cms_career_domains.id
 *   description      — optional
 *   normalizedName   — normalized lookup key
 *   status           — 'active' | 'inactive'
 *   createdByAdminId — audit field
 *   updatedByAdminId — audit field
 *   softDeleted      — soft delete flag
 *
 * @module modules/admin/cms/skill-clusters/adminCmsSkillClusters.module
 */

const { createCmsDatasetModule } = require('../adminCmsGeneric.factory');
const { body } = require('express-validator');

const skillClustersModule = createCmsDatasetModule({
  collection: 'cms_skill_clusters',
  datasetType: 'skillClusters',
  allowedFields: ['name', 'domainId', 'description'],
  extraValidators: [
    body('domainId')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('domainId is required'),

    body('description')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 500 })
      .withMessage('description must be at most 500 characters'),
  ],
});

module.exports = skillClustersModule;