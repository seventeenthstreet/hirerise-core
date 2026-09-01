'use strict';

/**
 * adminCmsRoles.repository.js — Optimized (Supabase Native)
 */

const { normalizeText, normalizeForComposite } = require('../../../../shared/utils/normalizeText');
const { AppError, ErrorCodes } = require('../../../../middleware/errorHandler');
const { supabase } = require('../../../../config/supabase'); // ✅ avoid re-require per call
const { deleteCache } = require('../../../../utils/cache.util');
const logger = require('../../../../utils/logger');

const TABLE = 'cms_roles';

// The Career Graph reads from the separate `roles` table (a distinct
// analytics dataset with its own FK-constrained job_family_id), not from
// `cms_roles`. Without this, a role created here never appears in the
// Career Graph until a manual graph-dataset import is run.
//
// NOTE: cms_roles.job_family_id is free text (e.g. "account-fin") and is
// NOT validated against the graph's job_families table, so we deliberately
// write it into roles.role_family (unconstrained) rather than
// roles.job_family_id (FK-constrained) to avoid insert failures.
const GRAPH_ROLES_TABLE = 'roles';
const CAREER_GRAPH_CACHE_KEY = 'graph:career';

class AdminCmsRolesRepository {

  // ─────────────────────────────────────────────────────────────
  // FINDERS
  // ─────────────────────────────────────────────────────────────

  async findByCompositeKey(compositeKey) {
    if (!compositeKey) return null;

    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('normalized_composite_key', compositeKey)
      .eq('soft_deleted', false)
      .maybeSingle();

    if (error) throw this._handleError(error);

    return data ? this._toCamel(data) : null;
  }

  async findManyByCompositeKey(compositeKeys) {
    if (!Array.isArray(compositeKeys) || compositeKeys.length === 0) {
      return new Map();
    }

    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .in('normalized_composite_key', compositeKeys)
      .eq('soft_deleted', false);

    if (error) throw this._handleError(error);

    return new Map(
      (data || []).map(row => [
        row.normalized_composite_key,
        this._toCamel(row)
      ])
    );
  }

  async findById(id) {
    if (!id) return null;

    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw this._handleError(error);

    return data ? this._toCamel(data) : null;
  }

  async list({ jobFamilyId, status, limit = 50, offset = 0 } = {}) {
    let query = supabase
      .from(TABLE)
      .select('*')
      .eq('soft_deleted', false)
      .order('name', { ascending: true })
      .range(offset, offset + limit - 1);

    if (jobFamilyId) query = query.eq('job_family_id', jobFamilyId);
    if (status) query = query.eq('status', status);

    const { data, error } = await query;

    if (error) throw this._handleError(error);

    return (data || []).map(this._toCamel);
  }

  async searchByTitle(titleFragment, limit = 20) {
    if (!titleFragment || titleFragment.length < 2) return [];

    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .ilike('name', `%${titleFragment}%`)
      .eq('soft_deleted', false)
      .limit(limit);

    if (error) throw this._handleError(error);

    return (data || []).map(this._toCamel);
  }

  // ─────────────────────────────────────────────────────────────
  // MUTATIONS
  // ─────────────────────────────────────────────────────────────

  async createRole(roleData, adminId, agency = null) {
    if (!roleData?.name || !roleData?.jobFamilyId) {
      throw new AppError(
        'name and jobFamilyId are required',
        400,
        { fields: ['name', 'jobFamilyId'] },
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const normalizedName = normalizeText(roleData.name);
    const normalizedCompositeKey = normalizeForComposite(
      roleData.name,
      roleData.jobFamilyId
    );

    const payload = {
      name: roleData.name.trim(),
      normalized_name: normalizedName,
      normalized_composite_key: normalizedCompositeKey,
      job_family_id: roleData.jobFamilyId,
      level: roleData.level ?? null,
      track: roleData.track ?? 'individual_contributor',
      description: roleData.description ?? '',
      alternative_titles: roleData.alternativeTitles ?? [],
      created_by_admin_id: adminId,
      updated_by_admin_id: adminId,
      source_agency: agency,
      status: 'active',
      soft_deleted: false,
    };

    const { data, error } = await supabase
      .from(TABLE)
      .insert(payload)
      .select()
      .single();

    if (error) throw this._handleError(error);

    const created = this._toCamel(data);
    await this._syncToGraphRoles(created);

    return created;
  }

  async updateRole(id, updates, adminId) {
    if (!id) {
      throw new AppError('Role ID is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
    }

    const current = await this.findById(id);
    if (!current) {
      throw new AppError('Role not found', 404, { id }, ErrorCodes.NOT_FOUND);
    }

    const nextName = updates.name ?? current.name;
    const nextFamilyId = updates.jobFamilyId ?? current.jobFamilyId;

    const payload = {
      updated_by_admin_id: adminId,
    };

    if (updates.name || updates.jobFamilyId) {
      payload.name = nextName.trim();
      payload.normalized_name = normalizeText(nextName);
      payload.normalized_composite_key = normalizeForComposite(nextName, nextFamilyId);
    }

    if (updates.jobFamilyId) payload.job_family_id = updates.jobFamilyId;
    if (updates.level !== undefined) payload.level = updates.level;
    if (updates.track) payload.track = updates.track;
    if (updates.description !== undefined) payload.description = updates.description;
    if (updates.alternativeTitles) payload.alternative_titles = updates.alternativeTitles;
    if (updates.status) payload.status = updates.status;

    const { data, error } = await supabase
      .from(TABLE)
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw this._handleError(error);

    const updated = this._toCamel(data);
    await this._syncToGraphRoles(updated);

    return updated;
  }

  async softDelete(id, adminId) {
    if (!id) return;

    const { error } = await supabase
      .from(TABLE)
      .update({
        soft_deleted: true,
        updated_by_admin_id: adminId,
      })
      .eq('id', id);

    if (error) throw this._handleError(error);
  }

  // ─────────────────────────────────────────────────────────────
  // INTERNAL HELPERS
  // ─────────────────────────────────────────────────────────────

  // Syncs a cms_roles record into the Career Graph's `roles` table so it
  // shows up in graph search / career-graph views without waiting for a
  // manual dataset import. Never throws — a graph-sync problem should not
  // block CMS role creation/update; it's logged and swallowed.
  //
  // NOTE ON MATCHING: roles.normalized_name is only *partially* unique
  // (unique WHERE soft_deleted = false), so it can't be used as a
  // Postgres ON CONFLICT target via a plain upsert() call — Supabase would
  // throw 42P10 (no matching constraint). Only roles.role_id has a full
  // unique index, so we do a manual find-by-normalized_name then
  // update-by-role_id-or-insert instead of relying on upsert inference.
  async _syncToGraphRoles(cmsRole) {
    try {
      const graphFields = {
        role_name: cmsRole.name,
        normalized_name: cmsRole.normalizedName,
        role_family: cmsRole.jobFamilyId,
        seniority_level: cmsRole.level,
        level: cmsRole.level,
        track: cmsRole.track,
        description: cmsRole.description,
        alternative_titles: cmsRole.alternativeTitles || [],
        agency: cmsRole.sourceAgency || '',
        soft_deleted: !!cmsRole.softDeleted,
        updated_by: cmsRole.updatedByAdminId,
      };

      const { data: existing, error: findError } = await supabase
        .from(GRAPH_ROLES_TABLE)
        .select('role_id')
        .eq('normalized_name', cmsRole.normalizedName)
        .eq('soft_deleted', false)
        .maybeSingle();

      if (findError) throw findError;

      if (existing) {
        const { error: updateError } = await supabase
          .from(GRAPH_ROLES_TABLE)
          .update(graphFields)
          .eq('role_id', existing.role_id);

        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await supabase
          .from(GRAPH_ROLES_TABLE)
          .insert({
            ...graphFields,
            created_by: cmsRole.createdByAdminId,
          });

        if (insertError) throw insertError;
      }

      await deleteCache(CAREER_GRAPH_CACHE_KEY);
    } catch (err) {
      logger.warn('[AdminCmsRoles] Career Graph sync failed (non-fatal)', {
        cmsRoleId: cmsRole.id,
        error: err.message,
      });
    }
  }

  _handleError(error) {
    return new AppError(
      error.message || 'Database error',
      500,
      { details: error.details },
      ErrorCodes.DATABASE_ERROR
    );
  }

  _toCamel = (row) => {
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      normalizedName: row.normalized_name,
      normalizedCompositeKey: row.normalized_composite_key,
      jobFamilyId: row.job_family_id,
      level: row.level,
      track: row.track,
      description: row.description,
      alternativeTitles: row.alternative_titles || [],
      status: row.status,
      createdByAdminId: row.created_by_admin_id,
      updatedByAdminId: row.updated_by_admin_id,
      sourceAgency: row.source_agency,
      softDeleted: row.soft_deleted,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };
}

module.exports = new AdminCmsRolesRepository();
module.exports.AdminCmsRolesRepository = AdminCmsRolesRepository;