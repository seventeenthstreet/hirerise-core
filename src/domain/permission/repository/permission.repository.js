'use strict';

/**
 * @file src/domain/permission/repository/permission.repository.js
 *
 * WP-ADMIN-04F-02 — Permission Repository
 *
 * Concrete Supabase implementation of ./permission.repository.contract.js,
 * persisting to the `permissions` table
 * (supabase/migrations/20260804120000_wp_admin_04f_02_permission_repository_schema.sql).
 *
 * Follows the established "manual Supabase query + dedicated mapper"
 * repository convention (modules/admin/cms/skills/adminCmsSkills.repository.js,
 * modules/admin/users/adminUsers.repository.js) rather than extending
 * shared/repositories/base.repository.js — per the WP-ADMIN-04F Repository
 * Audit (documents/WP-ADMIN-04C/Repository Audit Report — WP-ADMIN-04F.docx):
 * BaseRepository's generic `_normalize()` camelCases columns directly and
 * has no concept of consuming a domain factory, which would conflict with
 * this WP's explicit "Repository Mapping — consume the existing domain
 * factories" requirement. The CMS admin repositories are this codebase's
 * established precedent for exactly this shape of capability (single-table
 * CRUD + lookups + search), so this file follows that precedent instead.
 *
 * This module is PERSISTENCE ONLY, per WP-ADMIN-04F-02's Repository
 * Boundaries: no governance, no lifecycle transitions, no evaluation, no
 * assignment, no business filtering. Every read maps through
 * ./permission.repository.mapper.js, which in turn maps through the
 * certified domain factories in ../permission.model.js /
 * ../permission.validation.js — this file never re-validates a Resource,
 * Action, Category, or Status value itself.
 */

const logger = require('../../../utils/logger');
const { PermissionRepository } = require('./permission.repository.contract');
const {
  rowToPermission,
  rowsToPermissions,
  createInputToRow,
  updateInputToRow,
} = require('./permission.repository.mapper');
const {
  PermissionDuplicateError,
  PermissionRepositoryValidationError,
  PermissionRepositoryError,
} = require('./permission.repository.errors');

const TABLE = 'permissions';

// Lazy require, matching the existing convention (adminCmsSkills.repository.js,
// adminUsers.repository.js) — avoids a load-order dependency on
// config/supabase.js at module-require time, and keeps this module easily
// mockable in tests via jest.mock('.../config/supabase').
function getSupabase() {
  return require('../../../config/supabase').supabase;
}

function requireNonEmptyString(value, argName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PermissionRepositoryValidationError(`${argName} must be a non-empty string`, { received: value });
  }
  return value;
}

function normalizePagination({ limit = 50, offset = 0 } = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  return { limit: safeLimit, offset: safeOffset };
}

class SupabasePermissionRepository extends PermissionRepository {
  /**
   * @param {Object} input
   * @param {import('../permission.types').Resource} input.resource
   * @param {import('../permission.types').Action} input.action
   * @param {import('../permission.types').PermissionCategory} [input.category]
   * @param {import('../permission.types').PermissionStatus} [input.status]
   * @param {string} [input.description]
   * @returns {Promise<import('../permission.types').Permission & {id: string, createdAt: string, updatedAt: string}>}
   * @throws {PermissionDomainError} for invalid domain input (via the domain factory)
   * @throws {PermissionDuplicateError} if a Permission with the same name already exists
   */
  async create(input) {
    // createInputToRow() calls the certified domain factory, which throws
    // a PermissionDomainError (Invalid*Error) for any invalid resource,
    // action, category, status, or description before we ever touch the
    // database.
    const { row } = createInputToRow(input);

    // Checked proactively rather than relying on the table's unique
    // constraint erroring — see permission.repository.errors.js's
    // PermissionDuplicateError doc for why.
    if (await this.existsByName(row.name)) {
      throw new PermissionDuplicateError(`a Permission named "${row.name}" already exists`, { name: row.name });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.from(TABLE).insert(row).select('*').single();

    if (error) {
      logger.error('[PermissionRepository] create error', { name: row.name, error: error.message });
      throw new PermissionRepositoryError(`Failed to create Permission "${row.name}": ${error.message}`, 'PERMISSION_REPOSITORY_CREATE_FAILED', { name: row.name });
    }

    return rowToPermission(data);
  }

  /** @param {string} id */
  async findById(id) {
    requireNonEmptyString(id, 'id');
    const supabase = getSupabase();
    const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();

    if (error) {
      logger.error('[PermissionRepository] findById error', { id, error: error.message });
      throw new PermissionRepositoryError(`Failed to read Permission [${id}]: ${error.message}`, 'PERMISSION_REPOSITORY_READ_FAILED', { id });
    }

    return data ? rowToPermission(data) : null;
  }

  /** @param {string} name */
  async findByName(name) {
    requireNonEmptyString(name, 'name');
    const supabase = getSupabase();
    const { data, error } = await supabase.from(TABLE).select('*').eq('name', name).maybeSingle();

    if (error) {
      logger.error('[PermissionRepository] findByName error', { name, error: error.message });
      throw new PermissionRepositoryError(`Failed to read Permission "${name}": ${error.message}`, 'PERMISSION_REPOSITORY_READ_FAILED', { name });
    }

    return data ? rowToPermission(data) : null;
  }

  /**
   * @param {string} id
   * @param {{category?: string, status?: string, description?: string}} updates
   * @returns {Promise<object|null>} the updated Permission, or null if id does not exist
   */
  async update(id, updates) {
    requireNonEmptyString(id, 'id');
    // updateInputToRow() validates every provided field via the domain
    // validators (throws PermissionDomainError / PermissionRepositoryValidationError).
    const row = updateInputToRow(updates);

    const supabase = getSupabase();
    const { data, error } = await supabase.from(TABLE).update(row).eq('id', id).select('*').maybeSingle();

    if (error) {
      logger.error('[PermissionRepository] update error', { id, error: error.message });
      throw new PermissionRepositoryError(`Failed to update Permission [${id}]: ${error.message}`, 'PERMISSION_REPOSITORY_UPDATE_FAILED', { id });
    }

    return data ? rowToPermission(data) : null;
  }

  /** @param {string} id @returns {Promise<boolean>} whether a row was deleted */
  async delete(id) {
    requireNonEmptyString(id, 'id');
    const supabase = getSupabase();
    const { data, error } = await supabase.from(TABLE).delete().eq('id', id).select('id');

    if (error) {
      logger.error('[PermissionRepository] delete error', { id, error: error.message });
      throw new PermissionRepositoryError(`Failed to delete Permission [${id}]: ${error.message}`, 'PERMISSION_REPOSITORY_DELETE_FAILED', { id });
    }

    return Array.isArray(data) && data.length > 0;
  }

  /** @param {string} id */
  async existsById(id) {
    return Boolean(await this.findById(id));
  }

  /** @param {string} name */
  async existsByName(name) {
    return Boolean(await this.findByName(name));
  }

  async findByResource(resource, options) {
    requireNonEmptyString(resource, 'resource');
    return this._listWhere({ resource }, options);
  }

  async findByAction(action, options) {
    requireNonEmptyString(action, 'action');
    return this._listWhere({ action }, options);
  }

  async findByCategory(category, options) {
    requireNonEmptyString(category, 'category');
    return this._listWhere({ category }, options);
  }

  async findByStatus(status, options) {
    requireNonEmptyString(status, 'status');
    return this._listWhere({ status }, options);
  }

  /** @param {{limit?: number, offset?: number}} [options] */
  async list(options) {
    return this._listWhere({}, options);
  }

  /**
   * Case-insensitive substring search across `name` and `description`.
   * Mirrors adminCmsSkills.repository.js's `.or(...)` ILIKE search shape.
   *
   * @param {string} term
   * @param {{limit?: number, offset?: number}} [options]
   */
  async search(term, options) {
    requireNonEmptyString(term, 'term');
    const { limit, offset } = normalizePagination(options);
    const supabase = getSupabase();

    const trimmed = term.trim();
    if (!trimmed) {
      return { items: [], total: 0 };
    }

    const like = `%${trimmed}%`;
    const { data, error, count } = await supabase
      .from(TABLE)
      .select('*', { count: 'exact' })
      .or(`name.ilike.${like},description.ilike.${like}`)
      .order('name')
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error('[PermissionRepository] search error', { term, error: error.message });
      throw new PermissionRepositoryError(`Failed to search Permissions: ${error.message}`, 'PERMISSION_REPOSITORY_SEARCH_FAILED', { term });
    }

    return { items: rowsToPermissions(data), total: count ?? 0 };
  }

  /**
   * Shared exact-match filter + pagination helper for findByResource /
   * findByAction / findByCategory / findByStatus / list. Exact-match
   * only — this is the "Query Support", not "business filtering"
   * (WP-ADMIN-04F-02's explicit boundary).
   *
   * @param {object} eqFilters - field -> exact value, applied via .eq()
   * @param {{limit?: number, offset?: number}} [options]
   * @private
   */
  async _listWhere(eqFilters, options) {
    const { limit, offset } = normalizePagination(options);
    const supabase = getSupabase();

    let query = supabase.from(TABLE).select('*', { count: 'exact' }).order('name').range(offset, offset + limit - 1);

    for (const [field, value] of Object.entries(eqFilters)) {
      query = query.eq(field, value);
    }

    const { data, error, count } = await query;

    if (error) {
      logger.error('[PermissionRepository] list error', { filters: eqFilters, error: error.message });
      throw new PermissionRepositoryError(`Failed to list Permissions: ${error.message}`, 'PERMISSION_REPOSITORY_LIST_FAILED', { filters: eqFilters });
    }

    // rowsToPermissions() throws a typed PermissionMappingError for any
    // corrupt row (see the mapper) — allowed to propagate here rather than
    // being swallowed, so a bad row stays visible to the caller instead of
    // silently vanishing from a list result.
    return { items: rowsToPermissions(data), total: count ?? 0 };
  }
}

module.exports = {
  SupabasePermissionRepository,
  // Convenience singleton, matching the existing
  // `module.exports = new AdminCmsSkillsRepository()` convention — a
  // future consumer can `require(...)` this directly, or construct its
  // own instance (e.g. for tests) via the named export above.
  permissionRepository: new SupabasePermissionRepository(),
};
