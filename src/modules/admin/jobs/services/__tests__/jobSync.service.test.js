'use strict';

/**
 * @file jobSync.service.test.js
 * @description WP-ADMIN-COMP-06 regression tests.
 *
 * Covers:
 *   1. sourceType is threaded from the sync request into
 *      jobRepository.bulkUpsert(items, { source: sourceType }) — the real
 *      "jobs" table's `source` column is NOT NULL and part of the
 *      jobs_external_source_uq dedup key, so a sync that doesn't pass it
 *      through would fail at the database layer.
 *   2. A successful sync fires the standard Admin audit trail
 *      (adminAuditLogger.logAdminAction) with action JOB_SYNC_TRIGGERED,
 *      in addition to (not instead of) the existing sync_logs write.
 */

jest.mock('../../repositories/job.repository', () => ({
  bulkUpsert: jest.fn(),
}));

jest.mock('../../repositories/syncLog.repository', () => ({
  create: jest.fn().mockResolvedValue({ id: 'log-1' }),
}));

jest.mock('../../repositories/syncLock.repository', () => ({
  acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
  releaseLock: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/jobSourceFetcher.util', () => ({
  fetchJobRecords: jest.fn(),
  parseJobRecordsFromCsvText: jest.fn(),
}));

jest.mock('../../../../../utils/adminAuditLogger', () => ({
  logAdminAction: jest.fn(),
}));

jest.mock('../../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const jobRepository = require('../../repositories/job.repository');
const syncLogRepository = require('../../repositories/syncLog.repository');
const { fetchJobRecords, parseJobRecordsFromCsvText } = require('../../utils/jobSourceFetcher.util');
const { logAdminAction } = require('../../../../../utils/adminAuditLogger');
const jobSyncService = require('../jobSync.service');

describe('jobSync.service', () => {
  beforeEach(() => {
    jobRepository.bulkUpsert.mockResolvedValue(1);
  });

  it('threads sourceType through to jobRepository.bulkUpsert as { source }', async () => {
    fetchJobRecords.mockResolvedValue([
      { jobCode: 'ENG-1', title: 'Engineer', company: 'Acme', location: 'Remote', type: 'full_time' },
    ]);

    await jobSyncService.syncJobs({
      sourceType: 'json',
      sourceUrl: 'https://example.com/jobs.json',
      initiatedBy: 'admin-1',
    });

    expect(jobRepository.bulkUpsert).toHaveBeenCalledWith(
      expect.any(Array),
      { source: 'json' }
    );
  });

  it('fires the standard admin audit trail with JOB_SYNC_TRIGGERED on completion', async () => {
    fetchJobRecords.mockResolvedValue([
      { jobCode: 'ENG-1', title: 'Engineer', company: 'Acme', location: 'Remote', type: 'full_time' },
    ]);

    await jobSyncService.syncJobs({
      sourceType: 'csv',
      sourceUrl: 'https://example.com/jobs.csv',
      initiatedBy: 'admin-1',
    });

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'admin-1',
        action: 'JOB_SYNC_TRIGGERED',
        entityType: 'job_sync',
      })
    );
  });

  it('still writes the domain-specific sync_logs entry alongside the audit log (no parallel mechanism replaces it)', async () => {
    fetchJobRecords.mockResolvedValue([
      { jobCode: 'ENG-1', title: 'Engineer', company: 'Acme', location: 'Remote', type: 'full_time' },
    ]);

    await jobSyncService.syncJobs({
      sourceType: 'csv',
      sourceUrl: 'https://example.com/jobs.csv',
      initiatedBy: 'admin-1',
    });

    expect(syncLogRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'csv', initiatedBy: 'admin-1' })
    );
  });
});

describe('jobSync.service — syncJobsFromCsvUpload (WP-ADMIN-COMP-06-R2)', () => {
  beforeEach(() => {
    jobRepository.bulkUpsert.mockResolvedValue(1);
  });

  it('parses the uploaded buffer via the existing CSV parser (parseJobRecordsFromCsvText), not a new one', async () => {
    parseJobRecordsFromCsvText.mockReturnValue([
      { jobCode: 'ENG-9', title: 'Backend Engineer', company: 'Acme', location: 'Remote', type: 'full_time' },
    ]);

    await jobSyncService.syncJobsFromCsvUpload({
      csvBuffer: Buffer.from('jobCode,title,company,location,type\nENG-9,Backend Engineer,Acme,Remote,full_time'),
      initiatedBy: 'admin-1',
      fileName: 'jobs.csv',
    });

    expect(parseJobRecordsFromCsvText).toHaveBeenCalledWith(
      expect.stringContaining('ENG-9'),
      {}
    );
    expect(fetchJobRecords).not.toHaveBeenCalled();
  });

  it('threads sourceType "csv_upload" through to jobRepository.bulkUpsert as { source }, reusing _processChunk unchanged', async () => {
    parseJobRecordsFromCsvText.mockReturnValue([
      { jobCode: 'ENG-9', title: 'Backend Engineer', company: 'Acme', location: 'Remote', type: 'full_time' },
    ]);

    await jobSyncService.syncJobsFromCsvUpload({
      csvBuffer: Buffer.from('irrelevant, real parsing is mocked'),
      initiatedBy: 'admin-1',
      fileName: 'jobs.csv',
    });

    expect(jobRepository.bulkUpsert).toHaveBeenCalledWith(
      expect.any(Array),
      { source: 'csv_upload' }
    );
  });

  it('fires the admin audit trail with JOB_CSV_UPLOAD_TRIGGERED, including filename metadata', async () => {
    parseJobRecordsFromCsvText.mockReturnValue([
      { jobCode: 'ENG-9', title: 'Backend Engineer', company: 'Acme', location: 'Remote', type: 'full_time' },
    ]);

    await jobSyncService.syncJobsFromCsvUpload({
      csvBuffer: Buffer.from('irrelevant'),
      initiatedBy: 'admin-1',
      fileName: 'jobs-export.csv',
    });

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'admin-1',
        action: 'JOB_CSV_UPLOAD_TRIGGERED',
        entityType: 'job_sync',
        metadata: expect.objectContaining({
          sourceType: 'csv_upload',
          fileName: 'jobs-export.csv',
        }),
      })
    );
  });

  it('writes a sync_logs entry with source_type csv_upload and an "uploaded:<filename>" origin, not a URL', async () => {
    parseJobRecordsFromCsvText.mockReturnValue([
      { jobCode: 'ENG-9', title: 'Backend Engineer', company: 'Acme', location: 'Remote', type: 'full_time' },
    ]);

    await jobSyncService.syncJobsFromCsvUpload({
      csvBuffer: Buffer.from('irrelevant'),
      initiatedBy: 'admin-1',
      fileName: 'jobs-export.csv',
    });

    expect(syncLogRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'csv_upload',
        sourceOrigin: 'uploaded:jobs-export.csv',
        initiatedBy: 'admin-1',
      })
    );
  });

  it('sanitizes a path-separator-bearing filename before logging it', async () => {
    parseJobRecordsFromCsvText.mockReturnValue([]);

    await jobSyncService.syncJobsFromCsvUpload({
      csvBuffer: Buffer.from('irrelevant'),
      initiatedBy: 'admin-1',
      fileName: '../../etc/passwd.csv',
    });

    expect(syncLogRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ sourceOrigin: expect.not.stringContaining('/') })
    );
  });

  it('returns the same { total, success, failed, errors } shape as syncJobs()', async () => {
    parseJobRecordsFromCsvText.mockReturnValue([
      { jobCode: 'ENG-9', title: 'Backend Engineer', company: 'Acme', location: 'Remote', type: 'full_time' },
    ]);

    const result = await jobSyncService.syncJobsFromCsvUpload({
      csvBuffer: Buffer.from('irrelevant'),
      initiatedBy: 'admin-1',
      fileName: 'jobs.csv',
    });

    expect(result).toEqual(
      expect.objectContaining({
        total: expect.any(Number),
        success: expect.any(Number),
        failed: expect.any(Number),
        errors: expect.any(Array),
      })
    );
  });
});
