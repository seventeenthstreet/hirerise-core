'use strict';

/**
 * adminCmsRoles.service.js — Supabase Optimized Version
 */

const rolesRepo  = require('./adminCmsRoles.repository');
const { normalizeForComposite } = require('../../../../shared/utils/normalizeText');
const { DuplicateError }        = require('../../../../shared/errors/duplicate.error');
const logger                    = require('../../../../utils/logger');

// ─────────────────────────────────────────────
// CREATE ROLE
// ─────────────────────────────────────────────
async function createRole(payload, adminId, agency = null) {
  const { name, jobFamilyId, level, track, description, alternativeTitles } = payload;

  const compositeKey = normalizeForComposite(name, jobFamilyId);

  try {
    const created = await rolesRepo.createRole(
      {
        name: name.trim(),
        jobFamilyId,
        level,
        track,
        description,
        alternativeTitles,
        compositeKey, // 🔥 store in DB for fast lookup
      },
      adminId,
      agency
    );

    logger.info('[AdminCmsRoles] Role created', {
      roleId: created.id,
      name: created.name,
      family: jobFamilyId,
      admin_id: adminId,
    });

    return created;

  } catch (err) {
    // 🔥 Handle DB-level unique constraint (Supabase/Postgres)
    if (err.code === '23505') {
      logger.warn('[AdminCmsRoles] Duplicate blocked (DB constraint)', {
        compositeKey,
        admin_id: adminId,
      });

      throw new DuplicateError('roles', name, null, {
        compositeKey,
        jobFamilyId,
        source: 'database_constraint',
      });
    }

    throw err;
  }
}

// ─────────────────────────────────────────────
// UPDATE ROLE
// ─────────────────────────────────────────────
async function updateRole(roleId, updates, adminId) {
  const current = await rolesRepo.findById(roleId);

  if (!current) {
    const { AppError, ErrorCodes } = require('../../../../middleware/errorHandler');
    throw new AppError('Role not found', 404, { roleId }, ErrorCodes.NOT_FOUND);
  }

  let compositeKey = null;

  if (updates.name || updates.jobFamilyId) {
    const newName     = updates.name || current.name;
    const newFamilyId = updates.jobFamilyId || current.jobFamilyId;

    compositeKey = normalizeForComposite(newName, newFamilyId);
    updates.compositeKey = compositeKey;
  }

  try {
    return await rolesRepo.updateRole(roleId, updates, adminId);

  } catch (err) {
    if (err.code === '23505') {
      logger.warn('[AdminCmsRoles] Duplicate on update blocked', {
        roleId,
        compositeKey,
        admin_id: adminId,
      });

      throw new DuplicateError('roles', updates.name || current.name, null, {
        compositeKey,
        source: 'database_constraint',
      });
    }

    throw err;
  }
}

// ─────────────────────────────────────────────
// LIST ROLES (SUPABASE STYLE)
// ─────────────────────────────────────────────
async function listRoles({ limit = 100, jobFamilyId } = {}) {
  const result = await rolesRepo.listRoles({
    limit,
    jobFamilyId,
  });

  return {
    roles: result.data,
    total: result.count,
  };
}

module.exports = {
  createRole,
  updateRole,
  listRoles,
};