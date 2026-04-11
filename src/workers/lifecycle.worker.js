const supabase = require("../../supabaseClient");
const logger = require("../utils/logger");

const {
  prewarmTenantBenchmarks,
} = require("./benchmarkPrewarm.worker");

/**
 * Runs tenant retention lifecycle safely:
 * 1) retention cleanup
 * 2) MV refresh
 * 3) benchmark cache prewarm
 */
async function runTenantLifecycle({
  tenantId,
  refreshBenchmarks = true,
  prewarmBenchmarks = true,
}) {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }

  const result = {
    tenantId,
    retention: null,
    mvRefresh: null,
    prewarm: null,
  };

  try {
    logger.info("[LifecycleWorker] starting tenant lifecycle", {
      tenantId,
    });

    /**
     * STEP 1 → retention cleanup / partition lifecycle
     */
    const { data: retentionData, error: retentionError } =
      await supabase.rpc("run_analytics_retention_lifecycle", {
        p_tenant_id: tenantId,
      });

    if (retentionError) {
      throw retentionError;
    }

    result.retention = retentionData || {
      success: true,
    };

    /**
     * STEP 2 → refresh benchmark MV
     * MUST finish before cache prewarm
     */
    if (refreshBenchmarks) {
      const { data: mvData, error: mvError } = await supabase.rpc(
        "refresh_peer_benchmark_mv",
        {
          p_tenant_id: tenantId,
        }
      );

      if (mvError) {
        throw mvError;
      }

      result.mvRefresh = mvData || {
        refreshed: true,
      };
    }

    /**
     * STEP 3 → cache prewarm
     * Safe only AFTER MV refresh
     */
    if (prewarmBenchmarks) {
      result.prewarm = await prewarmTenantBenchmarks({
        tenantId,
        includeHotCohorts: true,
        limit: 20,
      });
    }

    logger.info("[LifecycleWorker] tenant lifecycle complete", {
      tenantId,
      prewarm: result.prewarm,
    });

    return result;
  } catch (error) {
    logger.error("[LifecycleWorker] tenant lifecycle failed", {
      tenantId,
      error: error.message,
    });

    throw error;
  }
}

/**
 * Batch lifecycle for enterprise + scheduled jobs
 */
async function runBatchLifecycle({
  tenantIds = [],
  concurrency = 5,
}) {
  const queue = [...tenantIds];
  const results = [];

  async function worker() {
    while (queue.length) {
      const tenantId = queue.shift();

      try {
        const res = await runTenantLifecycle({
          tenantId,
          refreshBenchmarks: true,
          prewarmBenchmarks: true,
        });

        results.push({
          tenantId,
          success: true,
          result: res,
        });
      } catch (error) {
        results.push({
          tenantId,
          success: false,
          error: error.message,
        });
      }
    }
  }

  await Promise.allSettled(
    Array.from({ length: concurrency }).map(() => worker())
  );

  return results;
}

/**
 * Boot warmup for hot enterprise tenants
 */
async function warmHotTenantsOnDeploy() {
  try {
    const { data: tenants, error } = await supabase.rpc(
      "get_hot_enterprise_tenants"
    );

    if (error) {
      throw error;
    }

    if (!Array.isArray(tenants) || !tenants.length) {
      return [];
    }

    return runBatchLifecycle({
      tenantIds: tenants.map((t) => t.tenant_id),
      concurrency: 3,
    });
  } catch (error) {
    logger.warn("[LifecycleWorker] deploy warmup failed", {
      error: error.message,
    });

    return [];
  }
}

module.exports = {
  runTenantLifecycle,
  runBatchLifecycle,
  warmHotTenantsOnDeploy,
};