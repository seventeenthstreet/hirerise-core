const cache = require("./analyticsCache.service");

const WINDOW_15M_MS = 15 * 60 * 1000;
const WINDOW_1H_MS = 60 * 60 * 1000;
const FORECAST_CAP = 40;
const DAY_MINUTES = 24 * 60;

function getTimeSlot(date = new Date(), bucketMinutes = 15) {
  const mins = date.getHours() * 60 + date.getMinutes();
  return Math.floor(mins / bucketMinutes);
}

function getWeekday(date = new Date()) {
  return date.getDay();
}

function buildKey(type, tenantId, suffix) {
  return `${type}:${tenantId}:${suffix}`;
}

async function recordHeat({ tenantId, signalType, weight = 1 }) {
  const now = Date.now();
  const slot15 = getTimeSlot(new Date(now), 15);
  const slot60 = getTimeSlot(new Date(now), 60);
  const weekday = getWeekday(new Date(now));

  const updates = [
    cache.increment(buildKey("heat15m", tenantId, slot15), weight, WINDOW_15M_MS),
    cache.increment(buildKey("heat1h", tenantId, slot60), weight, WINDOW_1H_MS),
    cache.increment(
      buildKey("forecast", tenantId, `${weekday}:${slot15}:${signalType}`),
      weight,
      14 * 24 * 60 * 60 * 1000
    ),
  ];

  await Promise.allSettled(updates);
}

async function getPredictiveBoost({ tenantId, signalType }) {
  const now = new Date();
  const slot15 = getTimeSlot(now, 15);
  const slot60 = getTimeSlot(now, 60);
  const weekday = getWeekday(now);

  const [heat15m, heat1h, replayMemory] = await Promise.all([
    cache.get(buildKey("heat15m", tenantId, slot15)),
    cache.get(buildKey("heat1h", tenantId, slot60)),
    cache.get(buildKey("forecast", tenantId, `${weekday}:${slot15}:${signalType}`)),
  ]);

  const score =
    Number(heat15m || 0) * 1.4 +
    Number(heat1h || 0) * 0.8 +
    Number(replayMemory || 0) * 1.2;

  return Math.min(Math.round(score), FORECAST_CAP);
}

module.exports = {
  recordHeat,
  getPredictiveBoost,
};