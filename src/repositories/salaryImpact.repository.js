'use strict';

const logger = require('../utils/logger');

class SalaryImpactRepository {
  constructor({
    skillMarketRepo,
    salaryDataSource,
  } = {}) {
    this._skillMarketRepo = skillMarketRepo ?? null;
    this._salaryDataSource = salaryDataSource ?? null;
  }

  async getSalaryImpactByRoleId(roleId) {
    if (!roleId || typeof roleId !== 'string') {
      throw this._validationError(
        'roleId must be a non-empty string.'
      );
    }

    try {
      const raw = await this.#resolveSource(roleId);
      return this._normalizeSalaryImpact(raw);
    } catch (error) {
      logger.error(
        '[SalaryImpactRepository] Failed resolving salary impact',
        {
          roleId,
          message: error.message,
        }
      );

      // fail-safe contract preserved
      return {};
    }
  }

  _normalizeSalaryImpact(rawData) {
    if (!rawData || typeof rawData !== 'object') {
      return {};
    }

    const normalized = {};

    for (const [skillId, data] of Object.entries(rawData)) {
      if (!data || this.#isSoftDeleted(data)) {
        continue;
      }

      normalized[skillId] = Object.freeze({
        salaryDelta: this.#clampPercent(
          this._safeNumber(data.salaryDelta)
        ),
        percentileBoost: this._safeNumber(
          data.percentileBoost,
          0
        ),
        regionMultiplier: this._safeNumber(
          data.regionMultiplier,
          1
        ),
      });
    }

    return Object.freeze(normalized);
  }

  _safeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  _validationError(message) {
    const error = new Error(message);
    error.name = 'SalaryImpactRepositoryValidationError';
    error.statusCode = 422;
    return error;
  }

  async #resolveSource(roleId) {
    if (this._salaryDataSource?.getByRoleId) {
      return this._salaryDataSource.getByRoleId(roleId);
    }

    if (this._skillMarketRepo?.getSalaryImpactByRoleId) {
      return this._skillMarketRepo.getSalaryImpactByRoleId(
        roleId
      );
    }

    return {};
  }

  #isSoftDeleted(data) {
    return (
      data.isDeleted === true ||
      data.is_deleted === true ||
      data.softDeleted === true ||
      data.soft_deleted === true
    );
  }

  #clampPercent(value) {
    return Math.min(100, Math.max(0, value));
  }
}

module.exports = SalaryImpactRepository;