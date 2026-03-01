'use strict';

const BaseRepository = require('./BaseRepository');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

class SalaryBandRepository extends BaseRepository {
  constructor() {
    super('salaryBands');
  }

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

  async findByRoleIdLegacy(roleId) {
    const result = await this.find(
      [{ field: 'roleId', op: '==', value: roleId }],
      { limit: 1 }
    );

    return result.docs.length > 0 ? result.docs[0] : null;
  }

  async updateWithTransaction(id, updates, userId = 'system') {
    return await this.runInTransaction(async (transaction) => {
      const docRef = this.collection.doc(id);
      const snapshot = await transaction.get(docRef);

      if (!snapshot.exists) {
        throw new AppError(
          'Salary band not found',
          404,
          { id },
          ErrorCodes.NOT_FOUND
        );
      }

      const currentData = snapshot.data();

      if (currentData.softDeleted) {
        throw new AppError(
          'Cannot update soft deleted salary band',
          409,
          { id },
          ErrorCodes.CONFLICT
        );
      }

      const metadata = this._getUpdateMetadata(userId);

      transaction.update(docRef, {
        ...updates,
        ...metadata,
      });

      return {
        ...currentData,
        ...updates,
      };
    });
  }
}

module.exports = SalaryBandRepository;
