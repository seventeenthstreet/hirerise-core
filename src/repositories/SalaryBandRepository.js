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
  // PATCH 32 CANONICAL UPDATE PATH
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