const logger = require("../../utils/logger");

const MAX_POINTS = Number(process.env.CONSENSUS_DRIFT_MAX_POINTS || 20);
const DISAGREEMENT_SPIKE_THRESHOLD = Number(
  process.env.CONSENSUS_DISAGREEMENT_THRESHOLD || 0.35
);
const REVISION_DRIFT_THRESHOLD = Number(
  process.env.CONSENSUS_REVISION_DRIFT_THRESHOLD || 3
);
const FLAP_THRESHOLD = Number(
  process.env.CONSENSUS_FLAP_THRESHOLD || 4
);
const SEVERITY_HEAL_THRESHOLD = Number(
  process.env.CONSENSUS_HEAL_THRESHOLD || 70
);
const SEVERITY_ISOLATE_THRESHOLD = Number(
  process.env.CONSENSUS_ISOLATE_THRESHOLD || 85
);
const HEAL_COOLDOWN_MS = Number(
  process.env.CONSENSUS_HEAL_COOLDOWN_MS || 15000
);

const STATE = {
  disagreementHistory: new Map(),
  revisionDrift: new Map(),
  flapHistory: new Map(),
  isolatedRegions: new Set(),
  healCooldown: new Map(),
  intervals: new Set(),
};

function boundedPush(bucket, value) {
  bucket.push({
    ts: Date.now(),
    value,
  });

  while (bucket.length > MAX_POINTS) {
    bucket.shift();
  }
}

function getOrCreateBucket(map, key) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = [];
    map.set(key, bucket);
  }
  return bucket;
}

function recordDisagreement(region, votes = {}) {
  const total = Math.max(Number(votes.total || 0), 1);
  const disagree = Math.max(Number(votes.disagree || 0), 0);
  const ratio = disagree / total;

  const bucket = getOrCreateBucket(STATE.disagreementHistory, region);
  boundedPush(bucket, ratio);

  return ratio;
}

function recordRevisionDrift(region, revisions = {}) {
  const min = Number(revisions.min || 0);
  const max = Number(revisions.max || 0);
  const spread = Math.abs(max - min);

  const bucket = getOrCreateBucket(STATE.revisionDrift, region);
  boundedPush(bucket, spread);

  return spread;
}

function recordFlap(region, peerState = {}) {
  const degraded = Boolean(peerState.degraded);
  const bucket = getOrCreateBucket(STATE.flapHistory, region);

  boundedPush(bucket, degraded ? 1 : 0);

  const recent = bucket.slice(-10);
  let flaps = 0;

  for (let i = 1; i < recent.length; i += 1) {
    if (recent[i].value !== recent[i - 1].value) {
      flaps += 1;
    }
  }

  return flaps;
}

function calculateSeverity({ disagreement, drift, flaps }) {
  let score = 0;

  if (disagreement > DISAGREEMENT_SPIKE_THRESHOLD) score += 35;
  if (drift > REVISION_DRIFT_THRESHOLD) score += 35;
  if (flaps > FLAP_THRESHOLD) score += 30;

  return Math.min(score, 100);
}

function shouldHeal(region) {
  const now = Date.now();
  const last = STATE.healCooldown.get(region) || 0;

  if (now - last < HEAL_COOLDOWN_MS) {
    return false;
  }

  STATE.healCooldown.set(region, now);
  return true;
}

function isolateRegion(region) {
  if (STATE.isolatedRegions.has(region)) return;

  STATE.isolatedRegions.add(region);

  logger.warn(
    `[Patch23] Region isolated from promotion voting: ${region}`
  );
}

function clearIsolation(region) {
  if (!STATE.isolatedRegions.has(region)) return;

  STATE.isolatedRegions.delete(region);

  logger.info(
    `[Patch23] Region restored into promotion voting: ${region}`
  );
}

function analyzeSnapshot(snapshot = {}, hooks = {}) {
  const region = snapshot.region;
  if (!region) {
    return {
      severity: 0,
      isolated: false,
      disagreement: 0,
      drift: 0,
      flaps: 0,
    };
  }

  const disagreement = recordDisagreement(
    region,
    snapshot.votes || {}
  );

  const drift = recordRevisionDrift(
    region,
    snapshot.revisions || {}
  );

  const flaps = recordFlap(
    region,
    snapshot.peerState || {}
  );

  const severity = calculateSeverity({
    disagreement,
    drift,
    flaps,
  });

  if (
    severity >= SEVERITY_HEAL_THRESHOLD &&
    typeof hooks.healPeerMesh === "function" &&
    shouldHeal(region)
  ) {
    try {
      hooks.healPeerMesh(region, severity);
    } catch (error) {
      logger.error(
        `[Patch23] healPeerMesh failed for ${region}`,
        error
      );
    }
  }

  if (severity >= SEVERITY_ISOLATE_THRESHOLD) {
    isolateRegion(region);
  } else {
    clearIsolation(region);
  }

  return {
    severity,
    isolated: STATE.isolatedRegions.has(region),
    disagreement,
    drift,
    flaps,
  };
}

function isRegionIsolated(region) {
  return STATE.isolatedRegions.has(region);
}

function shutdown() {
  for (const id of STATE.intervals) {
    clearInterval(id);
  }

  STATE.intervals.clear();
  STATE.disagreementHistory.clear();
  STATE.revisionDrift.clear();
  STATE.flapHistory.clear();
  STATE.isolatedRegions.clear();
  STATE.healCooldown.clear();

  logger.info(
    "[Patch23] consensus drift anomaly detector shutdown complete"
  );
}

module.exports = {
  analyzeSnapshot,
  isRegionIsolated,
  shutdown,
};