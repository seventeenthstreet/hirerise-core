'use strict';

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const cache = require('../../../infrastructure/cache/analyticsCache.service');

const CACHE_NAMESPACE_VERSION = 'v1';

function buildScopedTenantId(tenantId) {
  return tenantId || 'global';
}

async function getCachedPercentile({
  tenantId,
  scoreType,
  score,
}) {
  const scopedTenantId = buildScopedTenantId(tenantId);

  try {
    return await cache.getOrSet({
      namespace: `${CACHE_NAMESPACE_VERSION}:percentile`,
      tenantId: scopedTenantId,
      payload: { scoreType, score },
      ttl: cache.DEFAULT_TTL.percentile,
      queryFn: async () => {
        const { data, error } = await supabase.rpc(
          'get_chi_percentile',
          {
            p_tenant_id: tenantId,
            p_score_type: scoreType,
            p_score: score,
          }
        );

        if (error) throw error;
        return data;
      },
    });
  } catch (error) {
    logger.warn(
      '[CHI Analytics Cache] percentile fallback to direct RPC',
      {
        tenantId: scopedTenantId,
        scoreType,
        error: error?.message || 'Unknown cache error',
      }
    );

    const { data, error: rpcError } = await supabase.rpc(
      'get_chi_percentile',
      {
        p_tenant_id: tenantId,
        p_score_type: scoreType,
        p_score: score,
      }
    );

    if (rpcError) throw rpcError;
    return data;
  }
}

async function getCachedTrendHistory({
  tenantId,
  cohortId,
  days = 90,
}) {
  const scopedTenantId = buildScopedTenantId(tenantId);

  try {
    return await cache.getOrSet({
      namespace: `${CACHE_NAMESPACE_VERSION}:trend`,
      tenantId: scopedTenantId,
      payload: { cohortId, days },
      ttl: cache.DEFAULT_TTL.trend,
      queryFn: async () => {
        const { data, error } = await supabase.rpc(
          'get_chi_trend_history',
          {
            p_tenant_id: tenantId,
            p_cohort_id: cohortId,
            p_days: days,
          }
        );

        if (error) throw error;
        return data;
      },
    });
  } catch (error) {
    logger.warn(
      '[CHI Analytics Cache] trend fallback to direct RPC',
      {
        tenantId: scopedTenantId,
        cohortId,
        days,
        error: error?.message || 'Unknown cache error',
      }
    );

    const { data, error: rpcError } = await supabase.rpc(
      'get_chi_trend_history',
      {
        p_tenant_id: tenantId,
        p_cohort_id: cohortId,
        p_days: days,
      }
    );

    if (rpcError) throw rpcError;
    return data;
  }
}

module.exports = {
  getCachedPercentile,
  getCachedTrendHistory,
};