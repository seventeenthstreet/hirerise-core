"use strict";

/**
 * SalaryImpactRepository
 *
 * Responsibility:
 *   - Provide normalized salary impact data per skill for a given role
 *   - Abstract underlying data source (Firestore, API, skillMarketRepo, etc.)
 *   - Enforce soft-delete safety
 *   - Ensure null-safe structured output
 *
 * Design Philosophy:
 *   - Engine must never know where salary data comes from
 *   - Repository returns clean, predictable structure
 *   - Future-ready for advanced salary modeling (percentile, region, etc.)
 */

class SalaryImpactRepository {
  /**
   * @param {Object} dependencies
   * @param {Object} dependencies.skillMarketRepo - existing repository (temporary source)
   * @param {Object} dependencies.salaryDataSource - optional future dedicated salary source
   */
  constructor({ skillMarketRepo, salaryDataSource }) {
    this._skillMarketRepo = skillMarketRepo;
    this._salaryDataSource = salaryDataSource;
  }

  /**
   * Fetch salary impact data by role ID.
   *
   * Expected return shape:
   * {
   *   skillId: {
   *     salaryDelta: number (0–100 normalized),
   *     percentileBoost?: number,
   *     regionMultiplier?: number
   *   }
   * }
   *
   * @param {string} roleId
   * @returns {Promise<Object>}
   */
  async getSalaryImpactByRoleId(roleId) {
    if (!roleId || typeof roleId !== "string") {
      throw this._validationError("roleId must be a non-empty string.");
    }

    try {
      // 🔹 If future dedicated salary source exists, prefer that
      if (this._salaryDataSource?.getByRoleId) {
        const raw = await this._salaryDataSource.getByRoleId(roleId);
        return this._normalizeSalaryImpact(raw);
      }

      // 🔹 Fallback to skillMarketRepo for backward compatibility
      if (this._skillMarketRepo?.getSalaryImpactByRoleId) {
        const raw = await this._skillMarketRepo.getSalaryImpactByRoleId(roleId);
        return this._normalizeSalaryImpact(raw);
      }

      return {};
    } catch (err) {
      // Fail safe — never break engine
      return {};
    }
  }

  /**
   * Normalize raw salary impact structure.
   *
   * Ensures:
   * - salaryDelta is number between 0–100
   * - No soft-deleted entries
   * - Clean object keyed by skillId
   */
  _normalizeSalaryImpact(rawData) {
    if (!rawData || typeof rawData !== "object") {
      return {};
    }

    const normalized = {};

    for (const [skillId, data] of Object.entries(rawData)) {
      if (!data || data.isDeleted === true) {
        continue; // Soft delete safe
      }

      const salaryDelta = this._safeNumber(data.salaryDelta);

      normalized[skillId] = {
        salaryDelta: Math.min(100, Math.max(0, salaryDelta)),
        percentileBoost: this._safeNumber(data.percentileBoost, 0),
        regionMultiplier: this._safeNumber(data.regionMultiplier, 1),
      };
    }

    return normalized;
  }

  _safeNumber(value, fallback = 0) {
    return typeof value === "number" && !isNaN(value) ? value : fallback;
  }

  _validationError(message) {
    const err = new Error(message);
    err.name = "SalaryImpactRepositoryValidationError";
    err.statusCode = 422;
    return err;
  }
}

module.exports = SalaryImpactRepository;









