/**
 * RoleRepository — Role Entity Data Access
 *
 * ENTERPRISE PATTERN: Domain-Specific Repository
 *
 * Purpose:
 *   - Encapsulate role-specific business rules
 *   - Enforce referential integrity (jobFamilyId must exist)
 *   - Provide domain-specific query methods
 *   - Handle role lifecycle operations
 *
 * CRITICAL BUSINESS RULES:
 *   - Role must belong to existing job family
 *   - Role ID format: {family}-{level}-{track} slug
 *   - Salary bands must exist before role can be active
 *   - Deleting a role requires checking career path dependencies
 *
 * @module repositories/RoleRepository
 */

'use strict';

const BaseRepository = require('./BaseRepository');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class RoleRepository extends BaseRepository {
  constructor() {
    super('roles');
    this.jobFamiliesRepo = null; // Will be injected to avoid circular dependency
    this.salaryBandsRepo = null;
    this.careerPathsRepo = null;
  }

  /**
   * Set dependencies (called after all repositories are instantiated)
   */
  setDependencies({ jobFamiliesRepo, salaryBandsRepo, careerPathsRepo }) {
    this.jobFamiliesRepo = jobFamiliesRepo;
    this.salaryBandsRepo = salaryBandsRepo;
    this.careerPathsRepo = careerPathsRepo;
  }

  /**
   * Create role with referential integrity validation
   *
   * @param {object} roleData
   * @param {string} userId
   * @returns {Promise<object>}
   * @throws {AppError} If jobFamilyId doesn't exist
   */
  async create(roleData, userId = 'system', docId = null) {
    // GOVERNANCE: Validate foreign key
    await this._validateJobFamilyExists(roleData.jobFamilyId);

    // GOVERNANCE: Validate required fields
    this._validateRoleData(roleData);

    return await super.create(roleData, userId, docId);
  }

  /**
   * Update role with referential integrity validation
   *
   * @param {string} roleId
   * @param {object} updates
   * @param {string} userId
   * @returns {Promise<object>}
   */
  async update(roleId, updates, userId = 'system') {
    // If changing jobFamilyId, validate new family exists
    if (updates.jobFamilyId) {
      await this._validateJobFamilyExists(updates.jobFamilyId);
    }

    return await super.update(roleId, updates, userId);
  }

  /**
   * Soft delete role with dependency checking
   *
   * CRITICAL: Before deleting, check if role is referenced by:
   *   - Active career paths
   *   - Salary bands
   *   - User profiles (external check)
   *
   * @param {string} roleId
   * @param {string} userId
   * @param {boolean} force - Skip dependency checks (dangerous!)
   * @returns {Promise<void>}
   * @throws {AppError} If role has dependencies
   */
  async softDelete(roleId, userId = 'system', force = false) {
    if (!force) {
      await this._checkDependencies(roleId);
    }

    return await super.softDelete(roleId, userId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DOMAIN-SPECIFIC QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find all roles in a job family
   *
   * @param {string} jobFamilyId
   * @param {object} options
   * @returns {Promise<Array>}
   */
  async findByJobFamily(jobFamilyId, options = {}) {
    const filters = [
      { field: 'jobFamilyId', op: '==', value: jobFamilyId },
    ];

    const queryOptions = {
      ...options,
      orderBy: { field: 'level', direction: 'asc' },
    };

    const result = await this.find(filters, queryOptions);
    return result.docs;
  }

  /**
   * Find roles by level (e.g., all L3 roles across families)
   *
   * @param {string} level - 'L1', 'L2', etc.
   * @param {object} options
   * @returns {Promise<Array>}
   */
  async findByLevel(level, options = {}) {
    const filters = [
      { field: 'level', op: '==', value: level },
    ];

    const result = await this.find(filters, options);
    return result.docs;
  }

  /**
   * Find roles by track (IC, management, specialist)
   *
   * @param {string} track
   * @param {object} options
   * @returns {Promise<Array>}
   */
  async findByTrack(track, options = {}) {
    const filters = [
      { field: 'track', op: '==', value: track },
    ];

    const result = await this.find(filters, options);
    return result.docs;
  }

  /**
   * Search roles by title (case-insensitive substring match)
   *
   * NOTE: Firestore doesn't support full-text search natively
   * For production, integrate Algolia or Elasticsearch
   *
   * @param {string} titleFragment
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async searchByTitle(titleFragment, limit = 20) {
    // WORKAROUND: Fetch all roles and filter in memory
    // For production scale, use external search service
    const result = await this.find([], { limit: 1000 });
    
    const searchTerm = titleFragment.toLowerCase();
    const matches = result.docs.filter(role => 
      role.title.toLowerCase().includes(searchTerm) ||
      (role.alternativeTitles || []).some(alt => 
        alt.toLowerCase().includes(searchTerm)
      )
    );

    return matches.slice(0, limit);
  }

  /**
   * Get role progression path within a job family
   *
   * Returns roles ordered by level for career visualization
   *
   * @param {string} jobFamilyId
   * @param {string} track
   * @returns {Promise<Array>}
   */
  async getProgressionPath(jobFamilyId, track) {
    const filters = [
      { field: 'jobFamilyId', op: '==', value: jobFamilyId },
      { field: 'track', op: '==', value: track },
    ];

    const result = await this.find(filters, {
      orderBy: { field: 'level', direction: 'asc' },
    });

    return result.docs;
  }

  /**
   * Get roles with demand trend filter
   *
   * Useful for recommending high-growth roles
   *
   * @param {string} trend - 'growing' | 'stable' | 'declining'
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async findByDemandTrend(trend, limit = 50) {
    const filters = [
      { field: 'demandTrend', op: '==', value: trend },
    ];

    const result = await this.find(filters, { limit });
    return result.docs;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRIVATE VALIDATION METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Validate job family exists
   * @private
   */
  async _validateJobFamilyExists(jobFamilyId) {
    if (!this.jobFamiliesRepo) {
      logger.warn('[RoleRepo] jobFamiliesRepo not injected, skipping validation');
      return;
    }

    const family = await this.jobFamiliesRepo.findById(jobFamilyId);
    
    if (!family) {
      throw new AppError(
        `Job family not found: ${jobFamilyId}`,
        400,
        { jobFamilyId },
        ErrorCodes.VALIDATION_ERROR
      );
    }
  }

  /**
   * Validate role data structure
   * @private
   */
  _validateRoleData(roleData) {
    const required = ['title', 'level', 'track', 'jobFamilyId'];
    const missing = required.filter(field => !roleData[field]);

    if (missing.length > 0) {
      throw new AppError(
        `Missing required fields: ${missing.join(', ')}`,
        400,
        { missingFields: missing },
        ErrorCodes.VALIDATION_ERROR
      );
    }

    // Validate level format
    if (!/^L[1-6]$/.test(roleData.level)) {
      throw new AppError(
        'Invalid level format. Must be L1, L2, L3, L4, L5, or L6',
        400,
        { level: roleData.level },
        ErrorCodes.VALIDATION_ERROR
      );
    }

    // Validate track
    const validTracks = ['individual_contributor', 'management', 'specialist'];
    if (!validTracks.includes(roleData.track)) {
      throw new AppError(
        `Invalid track. Must be one of: ${validTracks.join(', ')}`,
        400,
        { track: roleData.track },
        ErrorCodes.VALIDATION_ERROR
      );
    }
  }

  /**
   * Check for dependencies before deletion
   * @private
   */
  async _checkDependencies(roleId) {
    const dependencies = [];

    // Check career paths
    if (this.careerPathsRepo) {
      const pathsFrom = await this.careerPathsRepo.find([
        { field: 'fromRoleId', op: '==', value: roleId },
      ]);

      const pathsTo = await this.careerPathsRepo.find([
        { field: 'toRoleId', op: '==', value: roleId },
      ]);

      if (pathsFrom.docs.length > 0) {
        dependencies.push(`${pathsFrom.docs.length} career paths originating from this role`);
      }

      if (pathsTo.docs.length > 0) {
        dependencies.push(`${pathsTo.docs.length} career paths leading to this role`);
      }
    }

    // Check salary bands
    if (this.salaryBandsRepo) {
      const salaryBand = await this.salaryBandsRepo.findById(roleId);
      if (salaryBand) {
        dependencies.push('Salary band exists for this role');
      }
    }

    if (dependencies.length > 0) {
      throw new AppError(
        'Cannot delete role with active dependencies',
        409,
        { dependencies },
        ErrorCodes.CONFLICT
      );
    }
  }
}

module.exports = RoleRepository;
