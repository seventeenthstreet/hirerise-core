'use strict';

const { getSupabaseClient } = require('../../config/supabase');
const logger = require('../../utils/logger');

const mutationFence = new Map();

function nextSeq(key) {
  const next = (mutationFence.get(key) || 0) + 1;
  mutationFence.set(key, next);
  return next;
}

async function authoritativeUpsert({
  table,
  payload,
  conflictKey = 'id',
  requestKey,
}) {
  const supabase = getSupabaseClient();

  const mutationSeq = nextSeq(`${table}:${requestKey || payload[conflictKey]}`);

  const finalPayload = {
    ...payload,
    mutation_seq: mutationSeq,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from(table)
    .upsert(finalPayload, { onConflict: conflictKey })
    .select()
    .single();

  if (error) {
    logger.error('[Patch44] authoritative upsert failed', {
      table,
      conflictKey,
      error: error.message,
    });
    throw error;
  }

  return data;
}

module.exports = {
  authoritativeUpsert,
};
