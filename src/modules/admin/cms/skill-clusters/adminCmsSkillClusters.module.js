'use strict';

/**
 * adminCmsSkillClusters.module.js
 *
 * CMS module for the `skill_clusters` Firestore collection.
 * Extends the generic factory with a mandatory `domain_id` relationship field.
 *
 * Firestore collection: cms_skill_clusters
 *
 * Schema:
 *   cluster_id       — auto-generated Firestore doc ID
 *   name             — e.g. "Frontend Development"
 *   domainId         — FK reference to cms_career_domains doc ID
 *   description      — optional
 *   normalizedName
 *   status           — 'active' | 'inactive'
 *   createdByAdminId
 *   updatedByAdminId
 *   softDeleted
 *
 * @module modules/admin/cms/skill-clusters/adminCmsSkillClusters.module
 */

const { createCmsDatasetModule } = require('../adminCmsGeneric.factory');
const { body }                   = require('express-validator');

const skillClustersModule = createCmsDatasetModule({
  collection:    'cms_skill_clusters',
  datasetType:   'skillClusters',
  allowedFields: ['name', 'domainId', 'description'],
  extraValidators: [
    body('domainId').isString().trim().notEmpty().withMessage('domainId is required'),
    body('description').optional().isString().trim().isLength({ max: 500 }),
  ],
});

module.exports = skillClustersModule;









