'use strict';

/**
 * resumeGrowth.repository.js
 *
 * Thin persistence layer — stores growth signal snapshots only.
 * No direct Firestore access outside this file.
 */

const { db } = require('../../config/firebase');

const COLLECTION = 'resume_growth_signals';

class ResumeGrowthRepository {
  constructor() {
    this._col = db.collection(COLLECTION);
  }

  /**
   * Persist a growth signal result for a user + role.
   * Always appends (never overwrites).
   */
  async save(userId, roleId, signal) {
    const ref = this._col.doc();

    await ref.set({
      user_id:    userId,
      role_id:    roleId,
      signal,
      created_at: new Date(), // better for Firestore indexing
    });

    return ref.id;
  }

  /**
   * Fetch most recent signal.
   */
  async getLatest(userId, roleId) {
    const snap = await this._col
      .where('user_id', '==', userId)
      .where('role_id', '==', roleId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();

    if (snap.empty) return null;

    const doc = snap.docs[0];

    return {
      id: doc.id,
      ...doc.data(),
    };
  }

  /**
   * Fetch full history (future delta use).
   */
  async getHistory(userId, roleId) {
    const snap = await this._col
      .where('user_id', '==', userId)
      .where('role_id', '==', roleId)
      .orderBy('created_at', 'asc')
      .get();

    return snap.docs.map(d => ({
      id: d.id,
      ...d.data(),
    }));
  }
}

module.exports = ResumeGrowthRepository;
