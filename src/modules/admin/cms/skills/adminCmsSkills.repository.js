'use strict';

/**
 * adminCmsSkills.repository.js — Admin CMS Skills (Supabase)
 * MIGRATED: Firestore cms_skills → Supabase cms_skills table
 */

const { normalizeText } = require('../../../../shared/utils/normalizeText');
const { AppError, ErrorCodes } = require('../../../../middleware/errorHandler');
const logger = require('../../../../utils/logger');

function getSupabase() { return require('../../../../config/supabase'); }

const TABLE = 'cms_skills';

class AdminCmsSkillsRepository {

  async findByNormalizedName(normalizedName) {
    if (!normalizedName) return null;
    const supabase = getSupabase();
    // HARDENING T2: .single() → .maybeSingle() — name may not exist
    // HARDENING T7: destructure error
    const { data, error } = await supabase
      .from(TABLE).select('*')
      .eq('normalized_name', normalizedName.trim())
      .eq('soft_deleted', false)
      .maybeSingle();
    if (error) throw error;
    return data ? this._toCamel(data) : null;
  }

  async findManyByNormalizedName(normalizedNames) {
    const map = new Map();
    if (!normalizedNames?.length) return map;
    const supabase = getSupabase();
    // HARDENING T7: destructure and throw on error
    const { data, error } = await supabase
      .from(TABLE).select('*')
      .in('normalized_name', normalizedNames)
      .eq('soft_deleted', false);
    if (error) throw error;
    for (const row of (data || [])) map.set(row.normalized_name, this._toCamel(row));
    return map;
  }

  async createSkill(skillData, adminId, agency = null) {
    if (!skillData.name) throw new AppError('Skill name is required', 400, { field: 'name' }, ErrorCodes.VALIDATION_ERROR);
    const supabase = getSupabase();
    const normalizedName = normalizeText(skillData.name);
    const aliases = skillData.aliases || [];

    const { data, error } = await supabase.from(TABLE).insert({
      name:                 skillData.name.trim(),
      normalized_name:      normalizedName,
      category:             skillData.category    || 'technical',
      aliases:              aliases,
      description:          skillData.description || '',
      demand_score:         skillData.demandScore ?? null,
      search_tokens:        this._buildSearchTokens(skillData.name, aliases),
      created_by_admin_id:  adminId,
      updated_by_admin_id:  adminId,
      source_agency:        agency,
      status:               'active',
      soft_deleted:         false,
    }).select().single();

    if (error) throw new AppError(`Failed to create skill: ${error.message}`, 500);
    return this._toCamel(data);
  }

  async updateSkill(id, updates, adminId) {
    const supabase = getSupabase();
    const safe = { updated_by_admin_id: adminId };
    if (updates.name)        { safe.name = updates.name.trim(); safe.normalized_name = normalizeText(updates.name); }
    if (updates.category)      safe.category    = updates.category;
    if (updates.aliases)       safe.aliases      = updates.aliases;
    if (updates.description)   safe.description  = updates.description;
    if (updates.demandScore != null) safe.demand_score = updates.demandScore;
    if (updates.status)        safe.status       = updates.status;
    if (safe.name)             safe.search_tokens = this._buildSearchTokens(safe.name, safe.aliases || []);

    const { data, error } = await supabase.from(TABLE).update(safe).eq('id', id).select().single();
    if (error) throw new AppError(`Failed to update skill: ${error.message}`, 500);
    return this._toCamel(data);
  }

  async softDelete(id, adminId) {
    const supabase = getSupabase();
    await supabase.from(TABLE).update({ soft_deleted: true, updated_by_admin_id: adminId }).eq('id', id);
  }

  async list({ category, status, limit = 50, offset = 0 } = {}) {
    const supabase = getSupabase();
    let q = supabase.from(TABLE).select('*').eq('soft_deleted', false)
      .order('name').range(offset, offset + limit - 1);
    if (category) q = q.eq('category', category);
    if (status)   q = q.eq('status', status);
    // HARDENING T7: destructure and throw on error
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(r => this._toCamel(r));
  }

  async findById(id) {
    const supabase = getSupabase();
    // HARDENING T2: .single() → .maybeSingle() — skill may not exist
    // HARDENING T7: destructure and throw on error
    const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? this._toCamel(data) : null;
  }

  _buildSearchTokens(name, aliases = []) {
    const tokens = new Set();
    const add = (str) => {
      if (!str) return;
      tokens.add(str.toLowerCase().trim());
      str.toLowerCase().split(/[\s\-_]+/).filter(t => t.length > 1).forEach(t => tokens.add(t));
    };
    add(name);
    (aliases || []).forEach(add);
    return [...tokens];
  }

  _toCamel(row) {
    if (!row) return null;
    return {
      id:               row.id,
      name:             row.name,
      normalizedName:   row.normalized_name,
      category:         row.category,
      aliases:          row.aliases || [],
      description:      row.description,
      demandScore:      row.demand_score,
      searchTokens:     row.search_tokens || [],
      status:           row.status,
      createdByAdminId: row.created_by_admin_id,
      updatedByAdminId: row.updated_by_admin_id,
      sourceAgency:     row.source_agency,
      softDeleted:      row.soft_deleted,
      createdAt:        row.created_at,
      updatedAt:        row.updated_at,
    };
  }
}

module.exports = new AdminCmsSkillsRepository();
module.exports.AdminCmsSkillsRepository = AdminCmsSkillsRepository;
