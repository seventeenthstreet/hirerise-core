'use strict';

const BaseRepository = require('./BaseRepository');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

class SalaryBandRepository extends BaseRepository {
  constructor() {
    super('salary_bands');
  }

  // ─────────────────────────────────────────────────────────
  // PRIMARY LOOKUP
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

    return this.findById(roleId);
  }

  // ─────────────────────────────────────────────────────────
  // LEGACY COMPATIBILITY
  // ─────────────────────────────────────────────────────────

  async findByRoleIdLegacy(roleId) {
    const result = await this.find(
      [{ field: 'roleId', op: '==', value: roleId }],
      { limit: 1 }
    );

    return result.docs?.[0] ?? null;
  }

  // ─────────────────────────────────────────────────────────
  // BACKWARD-COMPAT SAFE UPDATE
  // ─────────────────────────────────────────────────────────

  async updateWithTransaction(
    id,
    updates,
    userId = 'system'
  ) {
    if (!id) {
      throw new AppError(
        'Salary band id is required',
        400,
        { id },
        ErrorCodes.VALIDATION_ERROR
      );
    }

    return this.update(id, updates, userId);
  }
}

module.exports = SalaryBandRepository;