import { BaseRepository } from './base.repository.js';

// ─────────────────────────────────────────────────────────────
// Resume Repository
// ─────────────────────────────────────────────────────────────

export class ResumeRepository extends BaseRepository {
  constructor() {
    super('resumes');
  }

  async findByUserId(userId) {
    return this.findWhere([['userId', '==', userId]], {
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 10,
    });
  }

  async findLatestByUserId(userId) {
    return this.findOneWhere([
      ['userId', '==', userId],
      ['status', '==', 'active'],
    ]);
  }

  async markProcessing(resumeId) {
    await this.update(resumeId, {
      processingStatus: 'processing',
      processingStartedAt: this.serverTimestamp,
    });
  }

  async markComplete(resumeId, engineVersion) {
    await this.update(resumeId, {
      processingStatus: 'complete',
      processedAt: this.serverTimestamp,
      lastEngineVersion: engineVersion,
    });
  }

  async markFailed(resumeId, errorCode) {
    await this.update(resumeId, {
      processingStatus: 'failed',
      failedAt: this.serverTimestamp,
      lastErrorCode: errorCode,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Score Repository
// ─────────────────────────────────────────────────────────────

export class ScoreRepository extends BaseRepository {
  constructor() {
    super('scores');
  }

  /**
   * Deterministic Score ID:
   *   {userId}_{resumeId}_{engineVersion}
   *
   * Ensures idempotency:
   *   Re-scoring same resume with same engine overwrites.
   */
  buildScoreId(userId, resumeId, engineVersion) {
    return `${userId}_${resumeId}_${engineVersion.replace(/\./g, '_')}`;
  }

  async upsertScore(userId, resumeId, engineVersion, scoreData) {
    const id = this.buildScoreId(userId, resumeId, engineVersion);

    await this.upsert(id, {
      userId,
      resumeId,
      engineVersion,
      ...scoreData,
      scoredAt: this.serverTimestamp,
    });

    return id;
  }

  async getLatestScore(userId, resumeId) {
    return this.findOneWhere([
      ['userId', '==', userId],
      ['resumeId', '==', resumeId],
    ]);
  }

  async getScoreHistory(userId) {
    return this.findWhere([['userId', '==', userId]], {
      orderBy: { field: 'scoredAt', direction: 'desc' },
      limit: 50,
    });
  }
}