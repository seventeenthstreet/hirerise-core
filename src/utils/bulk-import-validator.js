'use strict';

/**
 * bulk-import-validator.js
 *
 * Adds:
 * - Centralized logging
 * - Performance metrics
 * - Retry with backoff
 */

const logger = require('../utils/logger'); // adjust path if needed

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = {
  roles: ['role_id', 'normalized_name'],
  skills: ['skill_id', 'old_id'],
  role_skills: ['role_id', 'skill_id'],
  role_transitions: ['from_role_id', 'to_role_id'],
  skill_relationships: ['skill_id', 'related_skill_id'],
  role_education: ['role_id', 'education_level'],
  role_salary_market: ['role_id', 'country'],
  role_market_demand: ['role_id', 'country'],
};

const VALID_DATASETS = Object.keys(REQUIRED_FIELDS);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

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
  }

  if (errors.length > 0) {
    throw new Error(
      `Validation failed for dataset "${dataset}":\n` +
        errors.slice(0, 10).join('\n') +
        (errors.length > 10
          ? `\n...and ${errors.length - 10} more`
          : '')
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Chunking
// ─────────────────────────────────────────────────────────────

function chunkRows(rows, size = 1000) {
  const chunks = [];

  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }

  return chunks;
}

// ─────────────────────────────────────────────────────────────
// Bulk Import with Metrics
// ─────────────────────────────────────────────────────────────

async function bulkImport(supabase, dataset, rows, options = {}) {
  const {
    chunkSize = 1000,
    onChunk = null,
    retries = 2,
    baseDelay = 300, // ms
  } = options;

  const startTime = Date.now();

  logger.info('[BulkImport] Started', {
    dataset,
    total_rows: rows.length,
    chunkSize,
  });

  validateBatch(dataset, rows);

  const chunks = chunkRows(rows, chunkSize);

  const totals = {
    inserted: 0,
    updated: 0,
    total: 0,
    failed_chunks: 0,
  };

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkStart = Date.now();

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

        if (error) throw error;

        const inserted = data?.inserted ?? 0;
        const updated = data?.updated ?? 0;
        const total = data?.total ?? 0;

        totals.inserted += inserted;
        totals.updated += updated;
        totals.total += total;

        const duration = Date.now() - chunkStart;

        // Callback or logging
        if (onChunk) {
          onChunk({
            chunk: i + 1,
            of: chunks.length,
            inserted,
            updated,
            total,
            duration,
          });
        }

        logger.info('[BulkImport] Chunk completed', {
          dataset,
          chunk: i + 1,
          of: chunks.length,
          inserted,
          updated,
          duration_ms: duration,
        });

        success = true;

      } catch (err) {
        attempt++;

        logger.warn('[BulkImport] Chunk failed', {
          dataset,
          chunk: i + 1,
          attempt,
          error: err.message,
        });

        if (attempt > retries) {
          totals.failed_chunks++;

          logger.error('[BulkImport] Chunk permanently failed', {
            dataset,
            chunk: i + 1,
            error: err.message,
          });

          throw new Error(
            `bulk_import_graph failed on chunk ${i + 1}/${chunks.length}: ${err.message}`
          );
        }

        // exponential backoff
        const delay = baseDelay * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const throughput =
    Math.round(totals.total / (durationMs / 1000)) || 0;

  const result = {
    ...totals,
    duration_ms: durationMs,
    throughput_rows_per_sec: throughput,
  };

  logger.info('[BulkImport] Completed', {
    dataset,
    ...result,
  });

  return result;
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  validateBatch,
  chunkRows,
  bulkImport,
};