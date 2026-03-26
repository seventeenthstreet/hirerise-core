'use strict';

const { supabase } = require('../../config/supabase');
const { COLLECTION } = require('./adaptiveWeight.constants');

class AdaptiveWeightRepository {
  constructor() {
    this._table = COLLECTION; // Supabase table name
  }

  _buildDocId(roleFamily, experienceBucket, industryTag) {
    return [roleFamily, experienceBucket, industryTag]
      .map((s) => s.trim().toLowerCase().replace(/\s+/g, "_"))
      .join("__");
  }

  // ─────────────────────────────────────────────

  async findByKey(roleFamily, experienceBucket, industryTag) {
    const docId = this._buildDocId(roleFamily, experienceBucket, industryTag);

    const { data, error } = await supabase
      .from(this._table)
      .select('*')
      .eq('id', docId)
      .maybeSingle();

    if (error) throw error;
    if (!data || data.softDeleted === true) return null;

    return data;
  }

  // ─────────────────────────────────────────────

  async create(roleFamily, experienceBucket, industryTag, payload) {
    const docId = this._buildDocId(roleFamily, experienceBucket, industryTag);
    const now = new Date().toISOString();

    const { error } = await supabase
      .from(this._table)
      .insert([
        {
          id: docId,
          roleFamily,
          experienceBucket,
          industryTag,
          ...payload,
          softDeleted: false,
          createdAt: now,
          updatedAt: now,
        },
      ]);

    if (error) throw error;

    return docId;
  }

  // ─────────────────────────────────────────────

  async update(roleFamily, experienceBucket, industryTag, patch) {
    const docId = this._buildDocId(roleFamily, experienceBucket, industryTag);

    const { error } = await supabase
      .from(this._table)
      .update({
        ...patch,
        updatedAt: new Date().toISOString(),
      })
      .eq('id', docId);

    if (error) throw error;
  }

  // ─────────────────────────────────────────────

  async softDelete(roleFamily, experienceBucket, industryTag) {
    await this.update(roleFamily, experienceBucket, industryTag, {
      softDeleted: true,
      deletedAt: new Date().toISOString(),
    });
  }
}

module.exports = AdaptiveWeightRepository;


