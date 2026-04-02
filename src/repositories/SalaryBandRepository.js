'use strict';

const BaseRepository = require('./BaseRepository');
const { supabase } = require('../config/supabase');

const { AppError, ErrorCodes } = require('../middleware/errorHandler');

class SalaryBandRepository extends BaseRepository {
  constructor() {
    super('salaryBands');
  }

  // ─────────────────────────────────────────────────────────
  // Find by Role ID
  // ─────────────────────────────────────────────────────────
  async findByRoleId(roleId) {

    if (!roleId) {
      throw new AppError(
        'roleId is required',
        400,
        { roleId },
        ErrorCodes.VALIDATION_ERROR
      );
    }

    return await this.findById(roleId);
  }

  // ─────────────────────────────────────────────────────────
  // Legacy find
  // ─────────────────────────────────────────────────────────
  async findByRoleIdLegacy(roleId) {

    const result = await this.find(
      [{ field: 'roleId', op: '==', value: roleId }],
      { limit: 1 }
    );

    return result?.length > 0 ? result[0] : null;
  }

  // ─────────────────────────────────────────────────────────
  // FIXED: Transaction → Safe Update
  // ─────────────────────────────────────────────────────────
  async updateWithTransaction(id, updates, userId = 'system') {

    // 1. Read existing record
    const { data: existing, error: readError } = await supabase
      .from('salaryBands')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (readError) throw readError;

    if (!existing) {
      throw new AppError(
        'Salary band not found',
        404,
        { id },
        ErrorCodes.NOT_FOUND
      );
    }

    if (existing.softDeleted) { // ⚠️ snake_case: soft_deleted
      throw new AppError(
        'Cannot update soft deleted salary band',
        409,
        { id },
        ErrorCodes.CONFLICT
      );
    }

    // 2. Metadata (same logic preserved)
    const metadata = this._getUpdateMetadata(userId);

    // 3. Update
    const { error: updateError } = await supabase
      .from('salaryBands')
      .update({
        ...updates,
        ...metadata
      })
      .eq('id', id);

    if (updateError) throw updateError;

    // 4. Return merged result (same behavior)
    return {
      ...existing,
      ...updates
    };
  }
}

module.exports = SalaryBandRepository;