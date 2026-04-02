'use strict';

/**
 * adminCmsRoles.repository.js — Optimized (Supabase Native)
 */

const { normalizeText, normalizeForComposite } = require('../../../../shared/utils/normalizeText');
const { AppError, ErrorCodes } = require('../../../../middleware/errorHandler');
const supabase = require('../../../../config/supabase'); // ✅ avoid re-require per call

const TABLE = 'cms_roles';

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

    return this._toCamel(data);
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

    return this._toCamel(data);
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