'use strict';

const jobRepository      = require('../repositories/job.repository');
const syncLogRepository  = require('../repositories/syncLog.repository');
const syncLockRepository = require('../repositories/syncLock.repository');
const { fetchJobRecords }   = require('../utils/jobSourceFetcher.util');
const { validateJobRecord } = require('../validators/jobSync.validator');
const logger = require('../../../../shared/logger');

const BATCH_SIZE     = 50;
const MAX_RECORDS    = 20000; // safety guard
const MAX_ERRORS_LOG = 500;   // prevent memory explosion
const MAX_BATCH_RETRIES = 2;

class JobSyncService {

  async syncJobs({ sourceType, sourceUrl, options = {}, initiatedBy }) {

    const safeUrl = this._sanitizeUrl(sourceUrl);

    logger.info('[JobSyncService.syncJobs] starting', {
      sourceType,
      sourceUrl: safeUrl,
      initiatedBy
    });

    const { acquired, reason } =
      await syncLockRepository.acquireLock(initiatedBy);

    if (!acquired) {
      const err = new Error(reason);
      err.statusCode = 409;
      throw err;
    }

    let total   = 0;
    let success = 0;
    let errors  = [];

    try {
      let rawRecords = await fetchJobRecords(sourceType, sourceUrl, options);

      if (!Array.isArray(rawRecords)) {
        throw new Error('Source did not return an array');
      }

      if (rawRecords.length > MAX_RECORDS) {
        throw new Error(`Record limit exceeded. Max allowed: ${MAX_RECORDS}`);
      }

      total = rawRecords.length;

      const chunks = this._chunkArray(rawRecords, BATCH_SIZE);

      for (let i = 0; i < chunks.length; i++) {
        const chunkResult = await this._processChunk(chunks[i]);

        success += chunkResult.success;

        if (errors.length < MAX_ERRORS_LOG) {
          errors.push(...chunkResult.errors.slice(0, MAX_ERRORS_LOG - errors.length));
        }
      }

    } finally {
      await syncLockRepository.releaseLock();
    }

    const failed = total - success;

    syncLogRepository
      .create({
        sourceType,
        sourceUrl: safeUrl,
        totalRecords: total,
        successCount: success,
        failCount: failed,
        initiatedBy,
        errors: errors.slice(0, MAX_ERRORS_LOG),
      })
      .catch((err) =>
        logger.error('[JobSyncService] syncLog write failed', { error: err.message })
      );

    logger.info('[JobSyncService.syncJobs] complete', { total, success, failed });

    return { total, success, failed, errors };
  }

  async _processChunk(rawRecords) {

    let success = 0;
    const errors = [];

    const validationResults = await Promise.all(
      rawRecords.map((raw) => this._validate(raw))
    );

    const validItems = [];
    for (const result of validationResults) {
      if (result.ok) validItems.push(result);
      else errors.push({ jobCode: result.jobCode, message: result.message });
    }

    if (!validItems.length) return { success, errors };

    const existenceResults = await Promise.all(
      validItems.map(async ({ jobData }) => {
        try {
          const isNew = !(await jobRepository.exists(jobData.jobCode));
          return { ok: true, jobData, isNew };
        } catch (err) {
          return { ok: false, jobCode: jobData.jobCode, message: err.message };
        }
      })
    );

    const batchItems = [];
    for (const result of existenceResults) {
      if (result.ok) batchItems.push(result);
      else errors.push({ jobCode: result.jobCode, message: result.message });
    }

    if (!batchItems.length) return { success, errors };

    const batch = jobRepository.createBatch();
    for (const { jobData, isNew } of batchItems) {
      jobRepository.addUpsertToBatch(batch, jobData, isNew);
    }

    let attempt = 0;
    while (attempt <= MAX_BATCH_RETRIES) {
      try {
        await jobRepository.commitBatch(batch);
        success += batchItems.length;
        break;
      } catch (err) {
        attempt++;
        if (attempt > MAX_BATCH_RETRIES) {
          for (const { jobData } of batchItems) {
            errors.push({
              jobCode: jobData.jobCode,
              message: `Batch commit failed after retries: ${err.message}`
            });
          }
          break;
        }
        await this._delay(200 * attempt);
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
    return { ok: true, jobData };
  }

  _chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  _delay(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  _sanitizeUrl(url) {
    try {
      const u = new URL(url);
      return u.origin;
    } catch {
      return 'invalid-url';
    }
  }
}

module.exports = new JobSyncService();