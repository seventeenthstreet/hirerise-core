'use strict';

// FIX: Converted from ESM to CJS to match the rest of the codebase.

const { db, FieldValue, Timestamp } = require('../../src/core/supabaseDbShim');
const logger = require('../logger');

class BaseRepository {
  constructor(collectionName) {
    if (!collectionName) throw new Error('BaseRepository requires a collection name');
    this._collectionName = collectionName;
    this._db = require('../../src/core/supabaseDbShim').db;
  }

  get collection() {
    return this._db.collection(this._collectionName);
  }

  get db() {
    return this._db;
  }

  get serverTimestamp() {
    return FieldValue.serverTimestamp();
  }

  async findById(id) {
    const snap = await this.collection.doc(id).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.deletedAt) return null;
    return this._normalize({ id: snap.id, ...data });
  }

  async findOneWhere(conditions = []) {
    let query = this.collection.where('deletedAt', '==', null);
    for (const [field, op, value] of conditions) {
      query = query.where(field, op, value);
    }
    const snap = await query.limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return this._normalize({ id: doc.id, ...doc.data() });
  }

  async findWhere(conditions = [], { limit = 100, orderBy = null, startAfter = null } = {}) {
    let query = this.collection.where('deletedAt', '==', null);
    for (const [field, op, value] of conditions) {
      query = query.where(field, op, value);
    }
    if (orderBy) query = query.orderBy(orderBy.field, orderBy.direction ?? 'asc');
    if (startAfter) query = query.startAfter(startAfter);
    query = query.limit(limit);

    const snap = await query.get();
    return snap.docs.map((d) => this._normalize({ id: d.id, ...d.data() }));
  }

  async create(id, data) {
    const ref = id ? this.collection.doc(id) : this.collection.doc();
    const payload = {
      ...data,
      createdAt: this.serverTimestamp,
      updatedAt: this.serverTimestamp,
      deletedAt: null,
    };
    await ref.set(payload);
    return ref.id;
  }

  async update(id, data) {
    const ref = this.collection.doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().deletedAt) {
      throw new Error(`Document ${id} not found in ${this._collectionName}`);
    }
    await ref.update({ ...data, updatedAt: this.serverTimestamp });
  }

  async upsert(id, data) {
    const ref = this.collection.doc(id);
    await ref.set(
      { ...data, updatedAt: this.serverTimestamp, deletedAt: null },
      { merge: true }
    );
    return id;
  }

  async softDelete(id, deletedBy = null) {
    const ref = this.collection.doc(id);
    await ref.update({
      deletedAt: this.serverTimestamp,
      deletedBy,
      updatedAt: this.serverTimestamp,
    });
  }

  async exists(id) {
    const snap = await this.collection.doc(id).get();
    return snap.exists && !snap.data().deletedAt;
  }

  async runTransaction(fn) {
    return this._db.runTransaction(fn);
  }

  async batchWrite(operations) {
    const chunks = this._chunk(operations, 500);
    for (const chunk of chunks) {
      const batch = this._db.batch();
      for (const op of chunk) {
        const ref = this.collection.doc(op.id);
        if (op.type === 'set')    batch.set(ref, op.data, op.options ?? {});
        else if (op.type === 'update') batch.update(ref, op.data);
        else if (op.type === 'delete') batch.delete(ref);
      }
      await batch.commit();
    }
  }

  _normalize(data) {
    const result = { ...data };
    for (const [key, val] of Object.entries(result)) {
      if (val instanceof Timestamp) {
        result[key] = val.toDate().toISOString();
      }
    }
    return result;
  }

  _chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

module.exports = { BaseRepository };