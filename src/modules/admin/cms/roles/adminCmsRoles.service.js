'use strict';

/**
 * adminCmsRoles.service.js — Admin CMS Roles Business Logic
 *
 * Duplicate check uses the composite key:
 *   normalizeForComposite(name, jobFamilyId)  → "director::engineering"
 *
 * This allows:
 *   ✓ "Director" in Engineering
 *   ✓ "Director" in Product (different family — different composite key)
 *   ✗ "Director" and "director" both in Engineering (same normalized composite key)
 *
 * @module modules/admin/cms/roles/adminCmsRoles.service
 */

const rolesRepo  = require('./adminCmsRoles.repository');
const { normalizeForComposite } = require('../../../../shared/utils/normalizeText');
const { DuplicateError }        = require('../../../../shared/errors/duplicate.error');
const logger                    = require('../../../../utils/logger');

async function createRole(payload, adminId, agency = null) {
  const { name, jobFamilyId, level, track, description, alternativeTitles } = payload;

  // ── Composite duplicate check ────────────────────────────────────────────
  const compositeKey = normalizeForComposite(name, jobFamilyId);
  const existing     = await rolesRepo.findByCompositeKey(compositeKey);

  if (existing) {
    logger.warn('[AdminCmsRoles] Duplicate attempt blocked', {
      event:        'duplicate_attempt',
      dataset_type: 'roles',
      dataset_value: name,
      job_family_id: jobFamilyId,
      composite_key: compositeKey,
      admin_id:     adminId,
      existing_id:  existing.id,
      timestamp:    new Date().toISOString(),
    });

    throw new DuplicateError('roles', name, existing.id, {
      compositeKey,
      jobFamilyId,
      field: 'name + jobFamilyId',
    });
  }

  const created = await rolesRepo.createRole(
    { name, jobFamilyId, level, track, description, alternativeTitles },
    adminId,
    agency
  );

  logger.info('[AdminCmsRoles] Role created', {
    roleId:    created.id,
    name:      created.name,
    family:    jobFamilyId,
    admin_id:  adminId,
  });

  return created;
}

async function updateRole(roleId, updates, adminId) {
  // If name or family changes, re-check for duplicate composite key
  if (updates.name || updates.jobFamilyId) {
    const current = await rolesRepo.findById(roleId);
    if (!current) {
      const { AppError, ErrorCodes } = require('../../../../middleware/errorHandler');
      throw new AppError('Role not found', 404, { roleId }, ErrorCodes.NOT_FOUND);
    }

    const newName     = updates.name      || current.name;
    const newFamilyId = updates.jobFamilyId || current.jobFamilyId;
    const newKey      = normalizeForComposite(newName, newFamilyId);
    const existing    = await rolesRepo.findByCompositeKey(newKey);

    if (existing && existing.id !== roleId) {
      logger.warn('[AdminCmsRoles] Duplicate name on update blocked', {
        event:        'duplicate_attempt',
        dataset_type: 'roles',
        dataset_value: newName,
        admin_id:     adminId,
        existing_id:  existing.id,
        timestamp:    new Date().toISOString(),
      });

      throw new DuplicateError('roles', newName, existing.id, {
        compositeKey:  newKey,
        jobFamilyId:   newFamilyId,
      });
    }
  }

  return await rolesRepo.updateRole(roleId, updates, adminId);
}

async function listRoles({ limit = 100, jobFamilyId } = {}) {
  const filters = [];
  if (jobFamilyId) {
    filters.push({ field: 'jobFamilyId', op: '==', value: jobFamilyId });
  }
  const result = await rolesRepo.find(filters, { limit });
  return { roles: result.docs, total: result.count };
}

module.exports = { createRole, updateRole, listRoles };








