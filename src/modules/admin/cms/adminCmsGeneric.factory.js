'use strict';

/**
 * adminCmsGeneric.factory.js — Generic CMS Dataset Module Factory (Supabase)
 *
 * MIGRATED: Firestore cms_* collections → Supabase cms_* tables
 * Covers: jobFamilies, educationLevels, salaryBenchmarks, careerDomains, skillClusters
 * Same exported interface — adminCmsImport.service.js needs no changes.
 */

const { normalizeText } = require('../../../shared/utils/normalizeText');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const { asyncHandler } = require('../../../utils/helpers');
const { validate } = require('../../../middleware/requestValidator');
const { body, param, query } = require('express-validator');
const express = require('express');
const logger  = require('../../../utils/logger');

function getSupabase() { return require('../../../config/supabase'); }

// Map datasetType → Supabase table name
const TABLE_MAP = {
  jobFamilies:      'cms_job_families',
  educationLevels:  'cms_education_levels',
  salaryBenchmarks: 'cms_salary_benchmarks',
  careerDomains:    'cms_career_domains',
  skillClusters:    'cms_skill_clusters',
};

function createCmsDatasetModule(config) {
  const { collection, datasetType, allowedFields = [] } = config;
  const table = TABLE_MAP[datasetType] || collection;

  // ── Repository ────────────────────────────────────────────────────────────
  class GenericCmsRepository {

    async findByNormalizedName(normalizedName) {
      if (!normalizedName) return null;
      const supabase = getSupabase();
      const { data } = await supabase
        .from(table)
        .select('*')
        .eq('normalized_name', normalizedName.trim())
        .eq('soft_deleted', false)
        .single();
      return data ? this._toCamel(data) : null;
    }

    async findManyByNormalizedName(normalizedNames) {
      const map = new Map();
      if (!normalizedNames?.length) return map;
      const supabase = getSupabase();
      const { data } = await supabase
        .from(table)
        .select('*')
        .in('normalized_name', normalizedNames)
        .eq('soft_deleted', false);
      for (const row of (data || [])) {
        const doc = this._toCamel(row);
        map.set(row.normalized_name, doc);
      }
      return map;
    }

    async createEntry(data, adminId, agency = null) {
      if (!data.name) throw new AppError('name is required', 400, { field: 'name' }, ErrorCodes.VALIDATION_ERROR);
      const supabase = getSupabase();
      const normalizedName = normalizeText(data.name);

      const payload = {
        name:                 data.name.trim(),
        normalized_name:      normalizedName,
        created_by_admin_id:  adminId,
        updated_by_admin_id:  adminId,
        source_agency:        agency,
        status:               'active',
        soft_deleted:         false,
      };

      // Extra allowed fields (snake_case mapping)
      const fieldMap = {
        description: 'description',
        sortOrder: 'sort_order', sort_order: 'sort_order',
        minSalary: 'min_salary', min_salary: 'min_salary',
        maxSalary: 'max_salary', max_salary: 'max_salary',
        medianSalary: 'median_salary', median_salary: 'median_salary',
        year: 'year',
        domainId: 'domain_id', domain_id: 'domain_id',
      };
      for (const field of allowedFields) {
        if (field !== 'name' && data[field] !== undefined) {
          const col = fieldMap[field] || field;
          payload[col] = data[field];
        }
      }

      const { data: created, error } = await supabase
        .from(table).insert(payload).select().single();
      if (error) throw new AppError(`Failed to create ${datasetType}: ${error.message}`, 500);
      return this._toCamel(created);
    }

    async updateEntry(id, updates, adminId) {
      const supabase = getSupabase();
      const safe = { updated_by_admin_id: adminId };
      if (updates.name) {
        safe.name = updates.name.trim();
        safe.normalized_name = normalizeText(updates.name);
      }
      for (const field of allowedFields) {
        if (field !== 'name' && updates[field] !== undefined) safe[field] = updates[field];
      }
      const { data: updated, error } = await supabase
        .from(table).update(safe).eq('id', id).select().single();
      if (error) throw new AppError(`Failed to update ${datasetType}: ${error.message}`, 500);
      return this._toCamel(updated);
    }

    async softDelete(id, adminId) {
      const supabase = getSupabase();
      await supabase.from(table)
        .update({ soft_deleted: true, updated_by_admin_id: adminId })
        .eq('id', id);
    }

    async list({ status, limit = 50, offset = 0 } = {}) {
      const supabase = getSupabase();
      let q = supabase.from(table).select('*').eq('soft_deleted', false)
        .order('created_at', { ascending: false }).range(offset, offset + limit - 1);
      if (status) q = q.eq('status', status);
      const { data } = await q;
      return (data || []).map(r => this._toCamel(r));
    }

    async findById(id) {
      const supabase = getSupabase();
      const { data } = await supabase.from(table).select('*').eq('id', id).single();
      return data ? this._toCamel(data) : null;
    }

    _toCamel(row) {
      if (!row) return null;
      return {
        id:               row.id,
        name:             row.name,
        normalizedName:   row.normalized_name,
        description:      row.description,
        status:           row.status,
        sortOrder:        row.sort_order,
        minSalary:        row.min_salary,
        maxSalary:        row.max_salary,
        medianSalary:     row.median_salary,
        year:             row.year,
        domainId:         row.domain_id,
        createdByAdminId: row.created_by_admin_id,
        updatedByAdminId: row.updated_by_admin_id,
        sourceAgency:     row.source_agency,
        softDeleted:      row.soft_deleted,
        createdAt:        row.created_at,
        updatedAt:        row.updated_at,
      };
    }
  }

  const repository = new GenericCmsRepository();

  // ── Service ───────────────────────────────────────────────────────────────
  const service = {
    async create(data, adminId, agency) {
      const normalizedName = normalizeText(data.name || '');
      const existing = await repository.findByNormalizedName(normalizedName);
      if (existing) throw new AppError(`"${data.name}" already exists.`, 409, { existing }, 'DUPLICATE');
      return repository.createEntry(data, adminId, agency);
    },
    async update(id, updates, adminId) { return repository.updateEntry(id, updates, adminId); },
    async softDelete(id, adminId) { return repository.softDelete(id, adminId); },
    async list(opts) { return repository.list(opts); },
    async findById(id) { return repository.findById(id); },
  };

  // ── Controller ────────────────────────────────────────────────────────────
  const controller = {
    create: asyncHandler(async (req, res) => {
      const result = await service.create(req.body, req.user.uid, req.user?.agency);
      res.status(201).json({ success: true, data: result });
    }),
    list: asyncHandler(async (req, res) => {
      const items = await service.list({ status: req.query.status,
        limit: parseInt(req.query.limit || '50'), offset: parseInt(req.query.offset || '0') });
      res.json({ success: true, data: { items, total: items.length } });
    }),
    getById: asyncHandler(async (req, res) => {
      const item = await service.findById(req.params.id);
      if (!item) throw new AppError('Not found', 404, {}, ErrorCodes.NOT_FOUND);
      res.json({ success: true, data: item });
    }),
    update: asyncHandler(async (req, res) => {
      const result = await service.update(req.params.id, req.body, req.user.uid);
      res.json({ success: true, data: result });
    }),
    delete: asyncHandler(async (req, res) => {
      await service.softDelete(req.params.id, req.user.uid);
      res.json({ success: true, message: `${datasetType} deleted` });
    }),
  };

  // ── Router ────────────────────────────────────────────────────────────────
  const router = express.Router();
  const nameValidator = body('name').isString().trim().notEmpty().isLength({ max: 200 });

  router.get('/',     validate([query('status').optional().isString(), query('limit').optional().isInt(), query('offset').optional().isInt()]), controller.list);
  router.post('/',    validate([nameValidator]), controller.create);
  router.get('/:id',  validate([param('id').isString().notEmpty()]), controller.getById);
  router.patch('/:id',validate([param('id').isString().notEmpty()]), controller.update);
  router.delete('/:id',validate([param('id').isString().notEmpty()]), controller.delete);

  return { repository, service, controller, router };
}

// Pre-built named module instances — consumed directly by server.js
const jobFamiliesModule      = createCmsDatasetModule({ collection: 'cms_job_families',      datasetType: 'jobFamilies',      allowedFields: ['description'] });
const educationLevelsModule  = createCmsDatasetModule({ collection: 'cms_education_levels',  datasetType: 'educationLevels',  allowedFields: ['description', 'sortOrder'] });
const salaryBenchmarksModule = createCmsDatasetModule({ collection: 'cms_salary_benchmarks', datasetType: 'salaryBenchmarks', allowedFields: ['description', 'minSalary', 'maxSalary', 'medianSalary', 'year'] });

const getGenericRepos = () => ({ jobFamiliesModule, educationLevelsModule, salaryBenchmarksModule });

module.exports = {
  createCmsDatasetModule,
  getGenericRepos,
  jobFamiliesModule,
  educationLevelsModule,
  salaryBenchmarksModule,
};








