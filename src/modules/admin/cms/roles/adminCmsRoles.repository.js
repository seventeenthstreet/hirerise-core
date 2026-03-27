'use strict';

/**
 * adminCmsRoles.repository.js — Admin CMS Roles (Supabase)
 * MIGRATED: Firestore cms_roles → Supabase cms_roles table
 */

const { normalizeText, normalizeForComposite } = require('../../../../shared/utils/normalizeText');
const { AppError, ErrorCodes } = require('../../../../middleware/errorHandler');

function getSupabase() { return require('../../../../core/supabaseClient'); }
const TABLE = 'cms_roles';

class AdminCmsRolesRepository {

  async findByCompositeKey(compositeKey) {
    if (!compositeKey) return null;
    const supabase = getSupabase();
    // HARDENING T2: .single() → .maybeSingle() — key may not exist
    // HARDENING T7: destructure and throw on error
    const { data, error } = await supabase
      .from(TABLE).select('*')
      .eq('normalized_composite_key', compositeKey)
      .eq('soft_deleted', false)
      .maybeSingle();
    if (error) throw error;
    return data ? this._toCamel(data) : null;
  }

  async findManyByCompositeKey(compositeKeys) {
    const map = new Map();
    if (!compositeKeys?.length) return map;
    const supabase = getSupabase();
    // HARDENING T7: destructure and throw on error
    const { data, error } = await supabase
      .from(TABLE).select('*')
      .in('normalized_composite_key', compositeKeys)
      .eq('soft_deleted', false);
    if (error) throw error;
    for (const row of (data || [])) map.set(row.normalized_composite_key, this._toCamel(row));
    return map;
  }

  async createRole(roleData, adminId, agency = null) {
    if (!roleData.name || !roleData.jobFamilyId) {
      throw new AppError('name and jobFamilyId are required', 400,
        { fields: ['name', 'jobFamilyId'] }, ErrorCodes.VALIDATION_ERROR);
    }
    const supabase = getSupabase();
    const normalizedName         = normalizeText(roleData.name);
    const normalizedCompositeKey = normalizeForComposite(roleData.name, roleData.jobFamilyId);

    const { data, error } = await supabase.from(TABLE).insert({
      name:                     roleData.name.trim(),
      normalized_name:          normalizedName,
      normalized_composite_key: normalizedCompositeKey,
      job_family_id:            roleData.jobFamilyId,
      level:                    roleData.level       || null,
      track:                    roleData.track       || 'individual_contributor',
      description:              roleData.description || '',
      alternative_titles:       roleData.alternativeTitles || [],
      created_by_admin_id:      adminId,
      updated_by_admin_id:      adminId,
      source_agency:            agency,
      status:                   'active',
      soft_deleted:             false,
    }).select().single();

    if (error) throw new AppError(`Failed to create role: ${error.message}`, 500);
    return this._toCamel(data);
  }

  async updateRole(id, updates, adminId) {
    const supabase = getSupabase();
    const current = await this.findById(id);
    if (!current) throw new AppError('Role not found', 404, { id }, ErrorCodes.NOT_FOUND);

    const safe = { updated_by_admin_id: adminId };
    const newName     = updates.name     || current.name;
    const newFamilyId = updates.jobFamilyId || current.jobFamilyId;

    if (updates.name || updates.jobFamilyId) {
      safe.name                     = newName.trim();
      safe.normalized_name          = normalizeText(newName);
      safe.normalized_composite_key = normalizeForComposite(newName, newFamilyId);
    }
    if (updates.jobFamilyId)         safe.job_family_id       = updates.jobFamilyId;
    if (updates.level != null)       safe.level               = updates.level;
    if (updates.track)               safe.track               = updates.track;
    if (updates.description != null) safe.description         = updates.description;
    if (updates.alternativeTitles)   safe.alternative_titles  = updates.alternativeTitles;
    if (updates.status)              safe.status              = updates.status;

    const { data, error } = await supabase.from(TABLE).update(safe).eq('id', id).select().single();
    if (error) throw new AppError(`Failed to update role: ${error.message}`, 500);
    return this._toCamel(data);
  }

  async softDelete(id, adminId, force = false) {
    const supabase = getSupabase();
    // HARDENING T7: destructure and throw on error
    const { error } = await supabase.from(TABLE)
      .update({ soft_deleted: true, updated_by_admin_id: adminId })
      .eq('id', id);
    if (error) throw error;
  }

  async list({ jobFamilyId, status, limit = 50, offset = 0 } = {}) {
    const supabase = getSupabase();
    let q = supabase.from(TABLE).select('*').eq('soft_deleted', false)
      .order('name').range(offset, offset + limit - 1);
    if (jobFamilyId) q = q.eq('job_family_id', jobFamilyId);
    if (status)      q = q.eq('status', status);
    // HARDENING T7: destructure and throw on error
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(r => this._toCamel(r));
  }

  async findById(id) {
    const supabase = getSupabase();
    // HARDENING T2: .single() → .maybeSingle() — role may not exist
    // HARDENING T7: destructure and throw on error
    const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? this._toCamel(data) : null;
  }

  async searchByTitle(titleFragment, limit = 20) {
    const supabase = getSupabase();
    // HARDENING T7: destructure and throw on error
    const { data, error } = await supabase.from(TABLE).select('*')
      .ilike('name', `%${titleFragment}%`)
      .eq('soft_deleted', false).limit(limit);
    if (error) throw error;
    return (data || []).map(r => this._toCamel(r));
  }

  _toCamel(row) {
    if (!row) return null;
    return {
      id:                    row.id,
      name:                  row.name,
      normalizedName:        row.normalized_name,
      normalizedCompositeKey: row.normalized_composite_key,
      jobFamilyId:           row.job_family_id,
      level:                 row.level,
      track:                 row.track,
      description:           row.description,
      alternativeTitles:     row.alternative_titles || [],
      status:                row.status,
      createdByAdminId:      row.created_by_admin_id,
      updatedByAdminId:      row.updated_by_admin_id,
      sourceAgency:          row.source_agency,
      softDeleted:           row.soft_deleted,
      createdAt:             row.created_at,
      updatedAt:             row.updated_at,
    };
  }
}

module.exports = new AdminCmsRolesRepository();
module.exports.AdminCmsRolesRepository = AdminCmsRolesRepository;