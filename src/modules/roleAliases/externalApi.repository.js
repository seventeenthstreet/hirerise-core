'use strict';

/**
 * src/modules/roleAliases/externalApi.repository.js
 *
 * Supabase-native repository for external_salary_apis
 *
 * Table: external_salary_apis
 *
 * Preserved business behavior:
 * - list all providers
 * - list enabled providers
 * - update last sync timestamp
 * - enable / disable provider
 *
 * Firebase / Firestore legacy patterns fully removed.
 */

const { supabase } = require('../../config/supabase');
const {
  AppError,
  ErrorCodes
} = require('../../middleware/errorHandler');

const TABLE = 'external_salary_apis';

class ExternalApiRepository {
  static get SELECT_COLUMNS() {
    return `
      id,
      providerName,
      baseUrl,
      apiKey,
      enabled,
      rateLimit,
      lastSync,
      createdAt,
      updatedAt,
      softDeleted
    `;
  }

  normalize(row) {
    if (!row) return null;

    return {
      id: row.id,
      providerName: row.providerName ?? null,
      baseUrl: row.baseUrl ?? null,
      apiKey: row.apiKey ?? null,
      enabled: Boolean(row.enabled),
      rateLimit: Number(row.rateLimit ?? 0),
      lastSync: row.lastSync ?? null,
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null,
      softDeleted: Boolean(row.softDeleted)
    };
  }

  async listAll() {
    const { data, error } = await supabase
      .from(TABLE)
      .select(ExternalApiRepository.SELECT_COLUMNS)
      .eq('softDeleted', false)
      .order('createdAt', { ascending: false });

    if (error) {
      throw new AppError(
        'Failed to fetch external API providers',
        500,
        ErrorCodes.DB_ERROR,
        error
      );
    }

    return (data || []).map((row) => this.normalize(row));
  }

  async listEnabled() {
    const { data, error } = await supabase
      .from(TABLE)
      .select(ExternalApiRepository.SELECT_COLUMNS)
      .eq('enabled', true)
      .eq('softDeleted', false)
      .order('createdAt', { ascending: true });

    if (error) {
      throw new AppError(
        'Failed to fetch enabled external API providers',
        500,
        ErrorCodes.DB_ERROR,
        error
      );
    }

    return (data || []).map((row) => this.normalize(row));
  }

  async updateLastSync(id) {
    if (!id) {
      throw new AppError(
        'Provider ID is required',
        400,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const timestamp = new Date().toISOString();

    const { error } = await supabase
      .from(TABLE)
      .update({
        lastSync: timestamp,
        updatedAt: timestamp
      })
      .eq('id', id)
      .eq('softDeleted', false);

    if (error) {
      throw new AppError(
        `Failed to update last sync for provider: ${id}`,
        500,
        ErrorCodes.DB_ERROR,
        error
      );
    }
  }

  async setEnabled(id, enabled, adminId) {
    if (!id) {
      throw new AppError(
        'Provider ID is required',
        400,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const timestamp = new Date().toISOString();

    const { data, error } = await supabase
      .from(TABLE)
      .update({
        enabled: Boolean(enabled),
        updatedAt: timestamp,
        updatedBy: adminId || null
      })
      .eq('id', id)
      .eq('softDeleted', false)
      .select(ExternalApiRepository.SELECT_COLUMNS)
      .single();

    if (error) {
      throw new AppError(
        `Failed to update provider enabled status: ${id}`,
        500,
        ErrorCodes.DB_ERROR,
        error
      );
    }

    return this.normalize(data);
  }
}

module.exports = new ExternalApiRepository();