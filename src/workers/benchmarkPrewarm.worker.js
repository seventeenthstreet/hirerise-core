const supabase = require("../../supabaseClient");
const cache = require("../infrastructure/cache/analyticsCache.service");

const DEFAULT_LIMIT = 10;
const HOT_COHORT_LIMIT = 25;
const PREWARM_TTL = cache.DEFAULT_TTL?.percentile || 300;

function buildKeys(tenantId, cohorts = []) {
  return cohorts.map((cohort) => ({
    tenantId,
    scoreType: cohort.scoreType || "overall",
    cohortKey: cohort.cohortKey || "global",
    cohortValue: cohort.cohortValue || "all",
  }));
}

async function fetchHotCohorts(tenantId, limit = HOT_COHORT_LIMIT) {
  const { data, error } = await supabase.rpc("get_hot_benchmark_cohorts", {
    p_tenant_id: tenantId,
    p_limit: limit,
  });

  if (error) {
    throw error;
  }

  return Array.isArray(data) ? data : [];
}

async function hydrateBenchmarkEntry(entry) {
  const cacheKeyPayload = {
    scoreType: entry.scoreType,
    cohortKey: entry.cohortKey,
    cohortValue: entry.cohortValue,
  };

  return cache.getOrSet({
    namespace: "benchmark_mv",
    tenantId: entry.tenantId,
    payload: cacheKeyPayload,
    ttl: PREWARM_TTL,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_peer_benchmark_mv", {
        p_tenant_id: entry.tenantId,
        p_score_type: entry.scoreType,
        p_cohort_key: entry.cohortKey,
        p_cohort_value: entry.cohortValue,
      });

      if (error) {
        throw error;
      }

      return {
        snapshotTs: Date.now(),
        rows: data || [],
      };
    },
  });
}

async function prewarmTenantBenchmarks({
  tenantId,
  cohorts = [],
  includeHotCohorts = true,
  limit = DEFAULT_LIMIT,
}) {
  if (!tenantId) return { warmed: 0 };

  let targets = buildKeys(tenantId, cohorts).slice(0, limit);

  if (includeHotCohorts) {
    const hot = await fetchHotCohorts(tenantId, limit);
    const hotTargets = buildKeys(tenantId, hot);

    const dedupe = new Map();

    [...targets, ...hotTargets].forEach((item) => {
      const key = [
        item.scoreType,
        item.cohortKey,
        item.cohortValue,
      ].join(":");

      dedupe.set(key, item);
    });

    targets = [...dedupe.values()].slice(0, HOT_COHORT_LIMIT);
  }

  const results = await Promise.allSettled(
    targets.map((entry) => hydrateBenchmarkEntry(entry))
  );

  return {
    warmed: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
  };
}

module.exports = {
  prewarmTenantBenchmarks,
};