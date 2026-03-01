import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from '../logger/index.js';

export class BaseRepository {
  #db;
  #collectionName;

  constructor(collectionName) {
    if (!collectionName) throw new Error('BaseRepository requires a collection name');
    this.#collectionName = collectionName;
    this.#db = getFirestore();
  }

  get collection() {
    return this.#db.collection(this.#collectionName);
  }

  get db() {
    return this.#db;
  }

  get serverTimestamp() {
    return FieldValue.serverTimestamp();
  }

  async findById(id) {
    const snap = await this.collection.doc(id).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.deletedAt) return null;
    return this.#normalize({ id: snap.id, ...data });
  }

  async findOneWhere(conditions = []) {
    let query = this.collection.where('deletedAt', '==', null);
    for (const [field, op, value] of conditions) {
      query = query.where(field, op, value);
    }
    const snap = await query.limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return this.#normalize({ id: doc.id, ...doc.data() });
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
    return snap.docs.map((d) => this.#normalize({ id: d.id, ...d.data() }));
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
      throw new Error(`Document ${id} not found in ${this.#collectionName}`);
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
    return this.#db.runTransaction(fn);
  }

  async batchWrite(operations) {
    const chunks = this.#chunk(operations, 500);
    for (const chunk of chunks) {
      const batch = this.#db.batch();
      for (const op of chunk) {
        const ref = this.collection.doc(op.id);
        if (op.type === 'set') batch.set(ref, op.data, op.options ?? {});
        else if (op.type === 'update') batch.update(ref, op.data);
        else if (op.type === 'delete') batch.delete(ref);
      }
      await batch.commit();
    }
  }

  #normalize(data) {
    const result = { ...data };
    for (const [key, val] of Object.entries(result)) {
      if (val instanceof Timestamp) {
        result[key] = val.toDate().toISOString();
      }
    }
    return result;
  }

  #chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
