'use strict';

const { db } = require('../config/firebase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

class BaseRepository {
  constructor(collectionName) {
    if (!db) {
      // Firebase unavailable (test mode) — defer collection access
      this._collectionName = collectionName;
      this.collection = null;
      return;
    }
    this.collection = db.collection(collectionName);
  }

  _getCollection() {
    if (!this.collection) {
      if (!db) throw new Error(`Firebase not initialized. Cannot access collection: ${this._collectionName}`);
      this.collection = db.collection(this._collectionName);
    }
    return this.collection;
  }

  async findById(id) {
    if (!id) return null;
    const col = this._getCollection();
    console.log("🔎 COLLECTION PATH:", col.path);
    console.log("🔎 DOC ID:", id);
    const snapshot = await col.doc(id).get();
    console.log("🔎 EXISTS:", snapshot.exists);
    if (!snapshot.exists) return null;
    const data = snapshot.data();
    console.log("🔎 DATA:", data);
    if (data.softDeleted === true) return null;
    return { id: snapshot.id, ...data };
  }

  async find(filters = [], options = {}) {
    let query = this._getCollection();
    const includeDeleted = options.includeDeleted === true;
    if (!includeDeleted) query = query.where('softDeleted', '==', false);
    for (const filter of filters) {
      query = query.where(filter.field, filter.op, filter.value);
    }
    if (options.orderBy) {
      query = query.orderBy(options.orderBy.field, options.orderBy.direction || 'asc');
    }
    if (options.limit) query = query.limit(options.limit);
    const snapshot = await query.get();
    const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return { docs, count: docs.length };
  }

  async create(data, userId = 'system', docId = null) {
    const col = this._getCollection();
    const now = new Date();
    const payload = {
      ...data,
      createdAt: now, updatedAt: now,
      createdBy: userId, updatedBy: userId,
      version: 1, status: 'active', softDeleted: false,
    };
    const docRef = docId ? col.doc(docId) : col.doc();
    await docRef.set(payload);
    return { id: docRef.id, ...payload };
  }

  async update(id, updates, userId = 'system') {
    const col = this._getCollection();
    const snapshot = await col.doc(id).get();
    if (!snapshot.exists) {
      throw new AppError('Document not found', 404, { id }, ErrorCodes.NOT_FOUND);
    }
    const current = snapshot.data();
    if (current.softDeleted) {
      throw new AppError('Cannot update soft deleted document', 409, { id }, ErrorCodes.CONFLICT);
    }
    const updatedData = {
      ...updates, updatedAt: new Date(), updatedBy: userId,
      version: (current.version || 1) + 1,
    };
    await col.doc(id).update(updatedData);
    return { id, ...current, ...updatedData };
  }

  async softDelete(id, userId = 'system') {
    return await this.update(id, { softDeleted: true, status: 'inactive' }, userId);
  }

  async runTransaction(callback) {
    if (!db) throw new Error('Firebase not initialized');
    return await db.runTransaction(async (transaction) => await callback(transaction));
  }
}

module.exports = BaseRepository;