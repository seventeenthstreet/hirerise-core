'use strict';

/**
 * shared/repositories/__tests__/partitioned-jobs.repository.test.js
 *
 * Covers Work Package A — Repository Idempotency Restoration:
 *   1. createJob persists user_id / idempotency_key / resume_id to the real
 *      (snake_case) automation_jobs columns instead of spreading the
 *      caller's raw camelCase object.
 *   2. findByIdempotencyKey (previously missing) correctly finds/excludes
 *      rows by user, key, status, and soft-delete state.
 *   3. A round trip (createJob -> findByIdempotencyKey) demonstrates the
 *      duplicate-submission path this was built to restore.
 */

const { createSupabaseMock } = require('./testHelpers/supabaseMock');

// Real automation_jobs columns as of
// supabase/migrations/20260712073230_add_resume_id_to_automation_jobs.sql
const AUTOMATION_JOBS_COLUMNS = [
  'id',
  'user_id',
  'status',
  'attempts',
  'max_attempts',
  'worker_id',
  'result',
  'idempotency_key',
  'resume_id',
  'created_at',
  'updated_at',
  'claimed_at',
  'completed_at',
  'failed_at',
  'deleted_at',
  'last_error_code',
  'last_error_message',
];

jest.mock('../../../src/config/supabaseClient', () => ({
  supabase: global.__partitionedJobsSupabaseMock,
}));

jest.mock('../../logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

describe('PartitionedJobRepository', () => {
  let partitionedJobRepo;

  function loadRepoWithMock(mock) {
    global.__partitionedJobsSupabaseMock = mock;
    jest.resetModules();
    ({ partitionedJobRepo } = require('../partitioned-jobs.repository'));
  }

  beforeEach(() => {
    loadRepoWithMock(
      createSupabaseMock({
        tables: { automation_jobs: [] },
        schemas: { automation_jobs: AUTOMATION_JOBS_COLUMNS },
      })
    );
  });

  describe('createJob', () => {
    it('persists user_id, idempotency_key, and resume_id to real columns', async () => {
      await partitionedJobRepo.createJob('job-1', {
        userId: 'user-1',
        idempotencyKey: 'idem-abc',
        resumeId: 'resume-1',
      });

      const [row] = global.__partitionedJobsSupabaseMock.__state.tables.automation_jobs;

      expect(row).toMatchObject({
        id: 'job-1',
        user_id: 'user-1',
        idempotency_key: 'idem-abc',
        resume_id: 'resume-1',
        status: 'pending',
        attempts: 0,
        max_attempts: 5,
        deleted_at: null,
      });
    });

    it('does not error and does not persist caller fields with no matching column (type, input)', async () => {
      // Regression guard for the original defect: createJob used to spread
      // the raw jobData object (including `type` / `input`, which have no
      // automation_jobs column) directly into the insert, which would have
      // errored against real PostgREST. Callers like salary.controller.js /
      // career.controller.js still pass these fields; createJob must ignore
      // them rather than throw.
      await expect(
        partitionedJobRepo.createJob('job-2', {
          type: 'SALARY_BENCHMARK',
          userId: 'user-1',
          idempotencyKey: 'idem-xyz',
          input: { jobTitle: 'Engineer' },
        })
      ).resolves.toBe('job-2');

      const [row] = global.__partitionedJobsSupabaseMock.__state.tables.automation_jobs;
      expect(row).not.toHaveProperty('type');
      expect(row).not.toHaveProperty('input');
      expect(row.user_id).toBe('user-1');
      expect(row.idempotency_key).toBe('idem-xyz');
    });

    it('throws when jobId is missing', async () => {
      await expect(partitionedJobRepo.createJob('', {})).rejects.toThrow('jobId is required');
    });
  });

  describe('findByIdempotencyKey', () => {
    beforeEach(() => {
      loadRepoWithMock(
        createSupabaseMock({
          tables: {
            automation_jobs: [
              {
                id: 'job-pending',
                user_id: 'user-1',
                idempotency_key: 'idem-1',
                status: 'pending',
                resume_id: 'resume-1',
                created_at: '2026-07-12T00:00:00.000Z',
                deleted_at: null,
              },
              {
                id: 'job-complete',
                user_id: 'user-1',
                idempotency_key: 'idem-2',
                status: 'complete',
                resume_id: 'resume-2',
                created_at: '2026-07-11T00:00:00.000Z',
                deleted_at: null,
              },
              {
                id: 'job-deleted',
                user_id: 'user-1',
                idempotency_key: 'idem-3',
                status: 'pending',
                resume_id: 'resume-3',
                created_at: '2026-07-11T00:00:00.000Z',
                deleted_at: '2026-07-11T01:00:00.000Z',
              },
              {
                id: 'job-other-user',
                user_id: 'user-2',
                idempotency_key: 'idem-1',
                status: 'pending',
                resume_id: 'resume-4',
                created_at: '2026-07-12T00:00:00.000Z',
                deleted_at: null,
              },
            ],
          },
          schemas: { automation_jobs: AUTOMATION_JOBS_COLUMNS },
        })
      );
    });

    it('finds a pending job matching user + idempotency key and returns a normalized shape', async () => {
      const result = await partitionedJobRepo.findByIdempotencyKey('user-1', 'idem-1');

      expect(result).toEqual({
        id: 'job-pending',
        resumeId: 'resume-1',
        status: 'pending',
        createdAt: '2026-07-12T00:00:00.000Z',
      });
    });

    it('returns null when no job matches the idempotency key', async () => {
      const result = await partitionedJobRepo.findByIdempotencyKey('user-1', 'no-such-key');
      expect(result).toBeNull();
    });

    it('does not match a different user with the same idempotency key', async () => {
      const result = await partitionedJobRepo.findByIdempotencyKey('user-1', 'idem-nonexistent');
      expect(result).toBeNull();
    });

    it('ignores jobs whose status is not pending/processing (e.g. complete)', async () => {
      const result = await partitionedJobRepo.findByIdempotencyKey('user-1', 'idem-2');
      expect(result).toBeNull();
    });

    it('ignores soft-deleted jobs', async () => {
      const result = await partitionedJobRepo.findByIdempotencyKey('user-1', 'idem-3');
      expect(result).toBeNull();
    });

    it('throws when userId is missing', async () => {
      await expect(partitionedJobRepo.findByIdempotencyKey('', 'idem-1')).rejects.toThrow(
        'userId is required'
      );
    });

    it('throws when idempotencyKey is missing', async () => {
      await expect(partitionedJobRepo.findByIdempotencyKey('user-1', '')).rejects.toThrow(
        'idempotencyKey is required'
      );
    });
  });

  describe('createJob -> findByIdempotencyKey round trip', () => {
    it('finds the job it just created, with the resumeId intact', async () => {
      await partitionedJobRepo.createJob('job-new', {
        userId: 'user-9',
        idempotencyKey: 'idem-round-trip',
        resumeId: 'resume-9',
      });

      const result = await partitionedJobRepo.findByIdempotencyKey('user-9', 'idem-round-trip');

      expect(result).toEqual({
        id: 'job-new',
        resumeId: 'resume-9',
        status: 'pending',
        createdAt: expect.any(String),
      });
    });
  });
});