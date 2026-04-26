'use strict';

/**
 * src/lib/db/authoritativeMutation.js
 *
 * Single-function helper for upserts that MUST succeed.
 * Any DB error is thrown as a hard error (not silently swallowed).
 *
 * Named "authoritative" because the caller treats this write as the
 * single source of truth — it is never a fire-and-forget.
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

/**
 * Upsert a single row and throw on any DB error.
 *
 * @param {object} opts
 * @param {string} opts.table       - Supabase table name
 * @param {object} opts.payload     - Row data to upsert
 * @param {string} opts.conflictKey - Column(s) used for ON CONFLICT (e.g. 'id' or 'user_id')
 * @returns {object} The payload that was written (Supabase upsert returns data only with select())
 * @throws  On any DB error
 */
async function authoritativeUpsert({ table, payload, conflictKey }) {
  if (!table || typeof table !== 'string') {
    throw new Error('[authoritativeUpsert] table name is required');
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error(`[authoritativeUpsert] invalid payload for table "${table}"`);
  }

  if (!conflictKey) {
    throw new Error(`[authoritativeUpsert] conflictKey is required for table "${table}"`);
  }

  const { error } = await supabase
    .from(table)
    .upsert(payload, { onConflict: conflictKey });

  if (error) {
    logger.error('[authoritativeUpsert] DB write failed', {
      table,
      conflictKey,
      errorCode:    error.code,
      errorMessage: error.message,
      payloadKeys:  Object.keys(payload),
    });

    // Surface as a plain Error so callers can catch and convert to AppError
    // if needed, without coupling this utility to the error handler module.
    const err = new Error(`DB upsert failed on "${table}": ${error.message}`);
    err.dbError    = error;
    err.table      = table;
    err.conflictKey = conflictKey;
    throw err;
  }

  return payload;
}

module.exports = { authoritativeUpsert };
