'use strict';

/**
 * bulk-import-validator.js
 *
 * Supabase-first bulk import validator + RPC chunk importer
 *
 * Features:
 * - strict dataset validation
 * - chunked RPC imports
 * - retry with exponential backoff
 * - structured metrics
 * - callback isolation
 * - throughput telemetry
 * - production-safe error reporting
 */

const logger = require('../utils/logger');

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const REQUIRED_FIELDS = Object.freeze({
  roles: ['role_id', 'normalized_name'],
  skills: ['skill_id', 'old_id'],
  role_skills: ['role_id', 'skill_id'],
  role_transitions: ['from_role_id', 'to_role_id'],
  skill_relationships: ['skill_id', 'related_skill_id'],
  role_education: ['role_id', 'education_level'],
  role_salary_market: ['role_id', 'country'],
  role_market_demand: ['role_id', 'country'],
});

const VALID_DATASETS = Object.freeze(Object.keys(REQUIRED_FIELDS));
const DEFAULT_CHUNK_SIZE = 1000;
const MAX_CHUNK_SIZE = 5000;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeChunkSize(size) {
  const numeric = Number(size);

  if (!Number.isInteger(numeric) || numeric <= 0) {
    return DEFAULT_CHUNK_SIZE;
  }

  return Math.min(numeric, MAX_CHUNK_SIZE);
}

// ─────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────

function validateBatch(dataset, rows) {
  if (!VALID_DATASETS.includes(dataset)) {
    throw new Error(
      `Invalid dataset "${dataset}". Valid: ${VALID_DATASETS.join(', ')}`
    );
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      `Rows must be a non-empty array for dataset "${dataset}"`
    );
  }

  const required = REQUIRED_FIELDS[dataset];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (!row || typeof row !== 'object') {
      errors.push(`Row ${i}: must be an object`);
      continue;
    }

    for (const field of required) {
      const value = row[field];

      if (
        value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim() === '')
      ) {
        errors.push(`Row ${i}: missing required field "${field}"`);
      }
    }

    if (errors.length >= 20) {
      break;
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Validation failed for dataset "${dataset}":\n${errors.join('\n')}`
    );
  }
}

// ─────────────────────────────────────────────
// Chunking
// ─────────────────────────────────────────────

function chunkRows(rows, size = DEFAULT_CHUNK_SIZE) {
  const safeSize = normalizeChunkSize(size);
  const chunks = [];

  for (let i = 0; i < rows.length; i += safeSize) {
    chunks.push(rows.slice(i, i + safeSize));
  }

  return chunks;
}

// ─────────────────────────────────────────────
// Bulk Import
// ─────────────────────────────────────────────

async function bulkImport(supabase, dataset, rows, options = {}) {
  if (!supabase?.rpc) {
    throw new Error(
      '[BulkImport] valid Supabase client with rpc() is required'
    );
  }

  const {
    chunkSize = DEFAULT_CHUNK_SIZE,
    onChunk = null,
    retries = 2,
    baseDelay = 300,
  } = options;

  validateBatch(dataset, rows);

  const safeChunkSize = normalizeChunkSize(chunkSize);
  const chunks = chunkRows(rows, safeChunkSize);

  const startedAt = Date.now();

  const totals = {
    inserted: 0,
    updated: 0,
    total: 0,
    failed_chunks: 0,
  };

  logger.info('[BulkImport] Started', {
    dataset,
    total_rows: rows.length,
    chunk_size: safeChunkSize,
    chunks: chunks.length,
  });

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const chunkStartedAt = Date.now();

    let attempt = 0;
    let success = false;

    while (!success && attempt <= retries) {
      try {
        const { data, error } = await supabase.rpc(
          'bulk_import_graph',
          {
            p_dataset: dataset,
            p_rows: chunk,
          }
        );

        if (error) {
          throw error;
        }

        const inserted = Number(data?.inserted ?? 0);
        const updated = Number(data?.updated ?? 0);
        const total = Number(data?.total ?? chunk.length);

        totals.inserted += inserted;
        totals.updated += updated;
        totals.total += total;

        const duration = Date.now() - chunkStartedAt;

        if (typeof onChunk === 'function') {
          try {
            await onChunk({
              chunk: index + 1,
              of: chunks.length,
              inserted,
              updated,
              total,
              duration_ms: duration,
            });
          } catch (callbackError) {
            logger.warn('[BulkImport] onChunk callback failed', {
              chunk: index + 1,
              error: callbackError.message,
            });
          }
        }

        logger.info('[BulkImport] Chunk completed', {
          dataset,
          chunk: index + 1,
          of: chunks.length,
          inserted,
          updated,
          total,
          duration_ms: duration,
        });

        success = true;
      } catch (error) {
        attempt += 1;

        logger.warn('[BulkImport] Chunk failed', {
          dataset,
          chunk: index + 1,
          of: chunks.length,
          attempt,
          retries,
          error: error.message,
        });

        if (attempt > retries) {
          totals.failed_chunks += 1;

          logger.error('[BulkImport] Chunk permanently failed', {
            dataset,
            chunk: index + 1,
            error: error.message,
          });

          throw new Error(
            `bulk_import_graph failed on chunk ${index + 1}/${chunks.length}: ${error.message}`
          );
        }

        const delay = baseDelay * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  const throughput =
    durationMs > 0
      ? Math.round(totals.total / (durationMs / 1000))
      : totals.total;

  const result = {
    ...totals,
    duration_ms: durationMs,
    throughput_rows_per_sec: throughput,
    chunk_size: safeChunkSize,
    total_chunks: chunks.length,
  };

  logger.info('[BulkImport] Completed', {
    dataset,
    ...result,
  });

  return result;
}

module.exports = {
  validateBatch,
  chunkRows,
  bulkImport,
};