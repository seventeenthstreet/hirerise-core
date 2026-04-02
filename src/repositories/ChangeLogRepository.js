'use strict';

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

class ChangeLogRepository {

  constructor() {
    this.table = 'change_logs';
  }

  // ─────────────────────────────────────────────────────────────
  // CREATE LOG
  // ─────────────────────────────────────────────────────────────

  async logChange(changeData) {
    try {
      const {
        collectionName,
        documentId,
        operation,
        changedFields = {},
        previousValue = null,
        newValue = null,
        userId = 'system',
        metadata = {},
      } = changeData;

      if (!collectionName || !documentId || !operation) {
        logger.warn('[ChangeLog] Missing required fields');
        return;
      }

      const record = {
        collection_name: collectionName,
        document_id: documentId,
        operation,
        changed_fields: changedFields,
        previous_value: previousValue,
        new_value: newValue,
        user_id: userId,
        metadata,
        timestamp: new Date().toISOString(),
      };

      const { error } = await supabase
        .from(this.table)
        .insert(record);

      if (error) throw error;

    } catch (error) {
      logger.error('[ChangeLog] Failed (non-fatal)', {
        error: error.message,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // BATCH LOG
  // ─────────────────────────────────────────────────────────────

  async logChangesBatch(changes, userId = 'system') {
    try {
      if (!Array.isArray(changes) || changes.length === 0) return;

      const records = changes.map(change => ({
        ...change,
        user_id: userId,
        timestamp: new Date().toISOString(),
      }));

      const { error } = await supabase
        .from(this.table)
        .insert(records);

      if (error) throw error;

    } catch (error) {
      logger.error('[ChangeLog] Batch failed (non-fatal)', {
        error: error.message,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GET DOCUMENT HISTORY
  // ─────────────────────────────────────────────────────────────

  async getDocumentHistory(collectionName, documentId, limit = 50) {
    const { data, error } = await supabase
      .from(this.table)
      .select('*')
      .eq('collection_name', collectionName)
      .eq('document_id', documentId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  // ─────────────────────────────────────────────────────────────
  // USER ACTIVITY
  // ─────────────────────────────────────────────────────────────

  async getUserActivity(userId, limit = 50) {
    const { data, error } = await supabase
      .from(this.table)
      .select('*')
      .eq('user_id', userId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  // ─────────────────────────────────────────────────────────────
  // RECENT CHANGES
  // ─────────────────────────────────────────────────────────────

  async getRecentChanges(limit = 100) {
    const { data, error } = await supabase
      .from(this.table)
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

}

module.exports = ChangeLogRepository;





