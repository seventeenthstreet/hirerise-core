// adaptiveWeight.repository.js

const { COLLECTION } = require("./adaptiveWeight.constants");

/**
 * AdaptiveWeightRepository
 *
 * All Firestore access is encapsulated here.
 * The service layer never touches db directly.
 *
 * Composite key strategy:
 *   documentId = `${roleFamily}__${experienceBucket}__${industryTag}`
 *   (normalized to lowercase, spaces replaced with underscores)
 *
 * This gives O(1) lookups without requiring a compound query,
 * while still being human-readable in the Firestore console.
 */
class AdaptiveWeightRepository {
  /**
   * @param {FirebaseFirestore.Firestore} db - Injected Firestore instance
   */
  constructor(db) {
    this._db = db;
    this._col = db.collection(COLLECTION);
  }

  /**
   * Builds a deterministic, URL-safe document ID from the composite key.
   */
  _buildDocId(roleFamily, experienceBucket, industryTag) {
    return [roleFamily, experienceBucket, industryTag]
      .map((s) => s.trim().toLowerCase().replace(/\s+/g, "_"))
      .join("__");
  }

  /**
   * Fetches a weight record by composite key.
   * Returns null if not found or soft-deleted.
   *
   * @returns {Object|null}
   */
  async findByKey(roleFamily, experienceBucket, industryTag) {
    const docId = this._buildDocId(roleFamily, experienceBucket, industryTag);
    const snap = await this._col.doc(docId).get();

    if (!snap.exists) return null;

    const data = snap.data();
    if (data.softDeleted === true) return null;

    return { id: snap.id, ...data };
  }

  /**
   * Creates a new adaptive weight document.
   * Sets createdAt and updatedAt on first write.
   *
   * @returns {string} Document ID
   */
  async create(roleFamily, experienceBucket, industryTag, payload) {
    const docId = this._buildDocId(roleFamily, experienceBucket, industryTag);
    const now = new Date().toISOString();

    await this._col.doc(docId).set({
      roleFamily,
      experienceBucket,
      industryTag,
      ...payload,
      softDeleted: false,
      createdAt:   now,
      updatedAt:   now,
    });

    return docId;
  }

  /**
   * Partially updates an existing document.
   * Always refreshes updatedAt.
   * Uses Firestore merge to avoid overwriting unrelated fields.
   */
  async update(roleFamily, experienceBucket, industryTag, patch) {
    const docId = this._buildDocId(roleFamily, experienceBucket, industryTag);

    await this._col.doc(docId).set(
      { ...patch, updatedAt: new Date().toISOString() },
      { merge: true }
    );
  }

  /**
   * Soft-deletes a record by setting softDeleted = true.
   * Record is retained for audit trail.
   */
  async softDelete(roleFamily, experienceBucket, industryTag) {
    await this.update(roleFamily, experienceBucket, industryTag, {
      softDeleted: true,
      deletedAt:   new Date().toISOString(),
    });
  }
}

module.exports = AdaptiveWeightRepository;