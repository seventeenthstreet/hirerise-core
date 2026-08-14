'use strict';

const jobRepository = require('../repositories/job.repository');
const syncLogRepository = require('../repositories/syncLog.repository');
const syncLockRepository = require('../repositories/syncLock.repository');
const { fetchJobRecords, parseJobRecordsFromCsvText } = require('../utils/jobSourceFetcher.util');
const { validateJobRecord } = require('../validators/jobSync.validator');
const logger = require('../../../../utils/logger');
const { logAdminAction } = require('../../../../utils/adminAuditLogger');

const BATCH_SIZE = 500; // Supabase handles larger bulk inserts efficiently
const MAX_RECORDS = 20000;
const MAX_ERRORS_LOG = 500;
const MAX_BATCH_RETRIES = 2;

class JobSyncService {
  async syncJobs({ sourceType, sourceUrl, options = {}, initiatedBy }) {
    const safeUrl = this._sanitizeUrl(sourceUrl);

    logger.info('[JobSyncService.syncJobs] starting', {
      sourceType,
      sourceUrl: safeUrl,
      initiatedBy,
    });

    return this._executeSync({
      sourceType,
      sourceOrigin: safeUrl,
      initiatedBy,
      auditAction: 'JOB_SYNC_TRIGGERED',
      auditMetadataExtra: { sourceUrl: safeUrl },
      fetchRawRecords: () => fetchJobRecords(sourceType, sourceUrl, options),
    });
  }

  /**
   * syncJobsFromCsvUpload — WP-ADMIN-COMP-06-R2.
   *
   * Same ingestion pipeline as syncJobs() (lock → parse/fetch → validate
   * → chunk → bulkUpsert → sync log → audit log), just fed from an
   * uploaded CSV buffer already in memory instead of a URL fetch. No
   * duplicated chunking, validation, repository, or logging logic — both
   * paths converge on the same _executeSync()/_processChunk() helpers.
   */
  async syncJobsFromCsvUpload({ csvBuffer, options = {}, initiatedBy, fileName }) {
    const safeFileName = this._sanitizeFileName(fileName);
    const sourceOrigin = `uploaded:${safeFileName}`;

    logger.info('[JobSyncService.syncJobsFromCsvUpload] starting', {
      fileName: safeFileName,
      fileSizeBytes: csvBuffer?.length ?? 0,
      initiatedBy,
    });

    return this._executeSync({
      sourceType: 'csv_upload',
      sourceOrigin,
      initiatedBy,
      auditAction: 'JOB_CSV_UPLOAD_TRIGGERED',
      auditMetadataExtra: {
        fileName: safeFileName,
        fileSizeBytes: csvBuffer?.length ?? 0,
      },
      fetchRawRecords: () =>
        parseJobRecordsFromCsvText(csvBuffer.toString('utf8'), options),
    });
  }

  /**
   * _executeSync — shared body for syncJobs() and syncJobsFromCsvUpload().
   * Holds the lock/validate/chunk/log/audit sequence exactly once so the
   * URL-based and upload-based entry points can never drift apart.
   *
   * @param {object} params
   * @param {string} params.sourceType
   * @param {string} params.sourceOrigin — safe-to-log origin (URL origin,
   *   or `uploaded:<filename>` for uploads); NOT written straight into
   *   sync_logs.source_origin — passed through syncLogRepository, which
   *   already knows how to handle a plain non-URL identifier.
   * @param {string} params.initiatedBy
   * @param {string} params.auditAction
   * @param {object} params.auditMetadataExtra — merged into the shared
   *   { sourceType, total, success, failed } audit metadata
   * @param {() => Promise<object[]>} params.fetchRawRecords — resolves
   *   the raw (unvalidated) record array, whether via HTTP fetch or via
   *   in-memory CSV parsing
   */
  async _executeSync({
    sourceType,
    sourceOrigin,
    initiatedBy,
    auditAction,
    auditMetadataExtra,
    fetchRawRecords,
  }) {
    const { acquired, reason } =
      await syncLockRepository.acquireLock(initiatedBy);

    if (!acquired) {
      const err = new Error(reason);
      err.statusCode = 409;
      throw err;
    }

    let total = 0;
    let success = 0;
    const errors = [];

    try {
      const rawRecords = await fetchRawRecords();

      if (!Array.isArray(rawRecords)) {
        throw new Error('Source did not return an array');
      }

      if (rawRecords.length > MAX_RECORDS) {
        throw new Error(`Record limit exceeded. Max allowed: ${MAX_RECORDS}`);
      }

      total = rawRecords.length;

      const chunks = this._chunkArray(rawRecords, BATCH_SIZE);

      for (const chunk of chunks) {
        const chunkResult = await this._processChunk(chunk, sourceType);

        success += chunkResult.success;

        if (errors.length < MAX_ERRORS_LOG) {
          errors.push(
            ...chunkResult.errors.slice(
              0,
              MAX_ERRORS_LOG - errors.length
            )
          );
        }
      }
    } finally {
      await syncLockRepository.releaseLock();
    }

    const failed = total - success;

    // async fire-and-forget logging
    syncLogRepository
      .create({
        sourceType,
        sourceOrigin,
        totalRecords: total,
        successCount: success,
        failCount: failed,
        initiatedBy,
        errors: errors.slice(0, MAX_ERRORS_LOG),
      })
      .catch((err) => {
        logger.error('[JobSyncService] syncLog write failed', {
          error: err.message,
        });
      });

    logger.info('[JobSyncService._executeSync] complete', {
      sourceType,
      total,
      success,
      failed,
    });

    // Fire-and-forget — logAdminAction() never throws, so a logging
    // failure can never fail a sync that already completed. This is the
    // standard Admin audit trail (admin_logs table, same mechanism every
    // other Admin mutation uses) — separate from and in addition to the
    // sync-specific history already written to sync_logs above, which
    // records ingestion-pipeline detail (per-row errors, success rate)
    // the admin_logs table isn't shaped for.
    void logAdminAction({
      adminId: initiatedBy,
      action: auditAction,
      entityType: 'job_sync',
      entityId: null,
      metadata: { sourceType, total, success, failed, ...auditMetadataExtra },
    });

    return { total, success, failed, errors };
  }

  async _processChunk(rawRecords, sourceType) {
    let success = 0;
    const errors = [];

    // 1) Validate all rows
    const validationResults = rawRecords.map((raw) => this._validate(raw));

    const validItems = [];
    for (const result of validationResults) {
      if (result.ok) validItems.push(result.jobData);
      else {
        errors.push({
          jobCode: result.jobCode,
          message: result.message,
        });
      }
    }

    if (!validItems.length) {
      return { success, errors };
    }

    // 2) Bulk UPSERT directly to Supabase
    let attempt = 0;

    while (attempt <= MAX_BATCH_RETRIES) {
      try {
        const insertedCount = await jobRepository.bulkUpsert(validItems, { source: sourceType });

        success += insertedCount;
        break;
      } catch (err) {
        attempt++;

        if (attempt > MAX_BATCH_RETRIES) {
          for (const item of validItems) {
            errors.push({
              jobCode: item.jobCode,
              message: `Bulk upsert failed after retries: ${err.message}`,
            });
          }
          break;
        }

        await this._delay(300 * attempt);
      }
    }

    return { success, errors };
  }

  _validate(raw) {
    const jobCode = raw?.jobCode ?? 'UNKNOWN';
    const { value: jobData, error } = validateJobRecord(raw);

    if (error) {
      return {
        ok: false,
        jobCode,
        message: error.details.map((d) => d.message).join('; '),
      };
    }

    return {
      ok: true,
      jobData,
    };
  }

  _chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _sanitizeUrl(url) {
    try {
      const u = new URL(url);
      return u.origin;
    } catch {
      return 'invalid-url';
    }
  }

  /**
   * Strip path separators/control characters from an uploaded file's
   * original name before it's logged (sync_logs.source_origin,
   * admin_logs metadata) — it's admin-supplied, untrusted display text,
   * never used as an actual filesystem path (upload is memory-only).
   */
  _sanitizeFileName(fileName) {
    const raw = typeof fileName === 'string' ? fileName : 'upload.csv';
    return raw.replace(/[/\\\x00-\x1f]/g, '').slice(0, 150) || 'upload.csv';
  }
}

module.exports = new JobSyncService();