'use strict';

const BaseRepository = require('./BaseRepository');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const VALID_TRACKS = Object.freeze([
  'individual_contributor',
  'management',
  'specialist',
]);

class RoleRepository extends BaseRepository {
  constructor() {
    super('roles');
    this.jobFamiliesRepo = null;
    this.salaryBandsRepo = null;
    this.careerPathsRepo = null;
  }

  setDependencies({
    jobFamiliesRepo,
    salaryBandsRepo,
    careerPathsRepo,
  }) {
    this.jobFamiliesRepo = jobFamiliesRepo;
    this.salaryBandsRepo = salaryBandsRepo;
    this.careerPathsRepo = careerPathsRepo;
  }

  async create(roleData, userId = 'system', docId = null) {
    const normalized = this.#normalizeRoleInput(roleData);

    this._validateRoleData(normalized);
    await this._validateJobFamilyExists(normalized.jobFamilyId);

    return super.create(normalized, userId, docId);
  }

  async update(roleId, updates, userId = 'system') {
    const normalized = this.#normalizeRoleInput(updates);

    if (normalized.jobFamilyId) {
      await this._validateJobFamilyExists(
        normalized.jobFamilyId
      );
    }

    if (
      normalized.seniorityLevel ||
      normalized.track ||
      normalized.roleName
    ) {
      this._validateRoleData({
        ...normalized,
        jobFamilyId:
          normalized.jobFamilyId || 'preserved',
      });
    }

    return super.update(roleId, normalized, userId);
  }

  async softDelete(roleId, userId = 'system', force = false) {
    if (!force) {
      await this._checkDependencies(roleId);
    }

    return super.softDelete(roleId, userId);
  }

  // ───────────────────────────────────────────
  // DOMAIN QUERIES (camelCase only)
  // ───────────────────────────────────────────

  async findByJobFamily(jobFamilyId, options = {}) {
    const result = await this.find(
      [{ field: 'roleFamily', op: '==', value: jobFamilyId }],
      {
        ...options,
        orderBy: {
          field: 'seniorityLevel',
          direction: 'asc',
        },
      }
    );

    return result.docs;
  }

  async findByLevel(level, options = {}) {
    const result = await this.find(
      [{ field: 'seniorityLevel', op: '==', value: level }],
      options
    );

    return result.docs;
  }

  async findByTrack(track, options = {}) {
    const result = await this.find(
      [{ field: 'track', op: '==', value: track }],
      options
    );

    return result.docs;
  }

  async searchByTitle(titleFragment, limit = 20) {
    const term = String(titleFragment || '').trim();
    if (!term) return [];

    const { data, error } = await this.db
      .from(this.table)
      .select('*')
      .eq('soft_deleted', false)
      .or(
        `role_name.ilike.%${term}%,alternative_titles.cs.{${term}}`
      )
      .limit(Math.min(Number(limit) || 20, 100));

    if (error) {
      logger.error('[RoleRepository] searchByTitle failed', {
        term,
        message: error.message,
      });
      throw error;
    }

    return (data ?? []).map(row => this._normalize(row));
  }

  async getProgressionPath(jobFamilyId, track) {
    const result = await this.find(
      [
        { field: 'roleFamily', op: '==', value: jobFamilyId },
        { field: 'track', op: '==', value: track },
      ],
      {
        orderBy: {
          field: 'seniorityLevel',
          direction: 'asc',
        },
      }
    );

    return result.docs;
  }

  async findByDemandTrend(trend, limit = 50) {
    const result = await this.find(
      [{ field: 'demandTrend', op: '==', value: trend }],
      { limit }
    );

    return result.docs;
  }

  async _validateJobFamilyExists(jobFamilyId) {
    if (!this.jobFamiliesRepo) {
      logger.warn('[RoleRepository] jobFamiliesRepo not injected');
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

  _validateRoleData(roleData = {}) {
    const required = [
      'roleName',
      'seniorityLevel',
      'track',
      'jobFamilyId',
    ];

    const missing = required.filter(field => !roleData[field]);

    if (missing.length) {
      throw new AppError(
        `Missing required fields: ${missing.join(', ')}`,
        400,
        { missingFields: missing },
        ErrorCodes.VALIDATION_ERROR
      );
    }

    if (!/^L[1-6]$/.test(roleData.seniorityLevel)) {
      throw new AppError(
        'Invalid level format. Must be L1-L6',
        400,
        { level: roleData.seniorityLevel },
        ErrorCodes.VALIDATION_ERROR
      );
    }

    if (!VALID_TRACKS.includes(roleData.track)) {
      throw new AppError(
        `Invalid track. Must be one of: ${VALID_TRACKS.join(', ')}`,
        400,
        { track: roleData.track },
        ErrorCodes.VALIDATION_ERROR
      );
    }
  }

  #normalizeRoleInput(data = {}) {
    return {
      ...data,
      roleName: data.roleName ?? data.role_name ?? data.title,
      seniorityLevel:
        data.seniorityLevel ??
        data.seniority_level ??
        data.level,
      roleFamily:
        data.roleFamily ??
        data.role_family ??
        data.jobFamilyId,
      jobFamilyId:
        data.jobFamilyId ??
        data.roleFamily ??
        data.role_family,
    };
  }

  async _checkDependencies(roleId) {
    const dependencies = [];

    const [pathsFrom, pathsTo, salaryBand] =
      await Promise.all([
        this.careerPathsRepo
          ? this.careerPathsRepo.find([
              { field: 'fromRoleId', op: '==', value: roleId },
            ])
          : { docs: [] },

        this.careerPathsRepo
          ? this.careerPathsRepo.find([
              { field: 'toRoleId', op: '==', value: roleId },
            ])
          : { docs: [] },

        this.salaryBandsRepo
          ? this.salaryBandsRepo.findById(roleId)
          : null,
      ]);

    if (pathsFrom.docs.length) {
      dependencies.push(
        `${pathsFrom.docs.length} outgoing career paths`
      );
    }

    if (pathsTo.docs.length) {
      dependencies.push(
        `${pathsTo.docs.length} incoming career paths`
      );
    }

    if (salaryBand) {
      dependencies.push('Salary band exists');
    }

    if (dependencies.length) {
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