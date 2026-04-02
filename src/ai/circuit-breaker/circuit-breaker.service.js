'use strict';

/**
 * circuit-breaker.service.js (OPTIMIZED)
 *
 * ✅ Firebase-free
 * ✅ ESM compatible
 * ✅ Redis namespaced + TTL safe
 * ✅ Observability decoupled
 * ✅ Production hardened
 */

import redis from '../../config/redis.js';
import observability from '../observability/observability-adapter.js';
import alertService from '../observability/alert.service.js';

// Namespace (VERY IMPORTANT for multi-service systems)
const SERVICE = process.env.SERVICE_NAME || 'core';

const CIRCUIT_CONFIG = {
  ERROR_RATE_TRIP: 0.15,
  LATENCY_TRIP_MS: 6000,
  RECOVERY_WINDOW_MS: 5 * 60_000,
  HALF_OPEN_PROBE_RATE: 0.1,
  CONSECUTIVE_SUCCESSES_TO_CLOSE: 5,
  ROLLING_WINDOW_MS: 60_000,
  TTL_SECONDS: 300, // ✅ auto cleanup
};

const CircuitState = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

class CircuitBreakerService {

  _key(feature) {
    return `${SERVICE}:circuit:${feature}`;
  }

  _lockKey(feature) {
    return `${SERVICE}:lock:circuit:${feature}`;
  }

  // ─────────────────────────────────────────────
  // MAIN EXECUTION
  // ─────────────────────────────────────────────

  async execute(feature, primaryModel, fallbackModels, fn) {
    const circuit = await this._getCircuit(feature, primaryModel);

    // Recovery check
    if (circuit.state === CircuitState.OPEN) {
      const elapsed = Date.now() - circuit.tripTime;

      if (elapsed > CIRCUIT_CONFIG.RECOVERY_WINDOW_MS) {
        await this._safeTransition(feature, CircuitState.HALF_OPEN, primaryModel);
      }
    }

    const currentCircuit = await this._getCircuit(feature, primaryModel);

    const isProbe =
      currentCircuit.state === CircuitState.HALF_OPEN &&
      Math.random() < CIRCUIT_CONFIG.HALF_OPEN_PROBE_RATE;

    const modelToUse = isProbe
      ? primaryModel
      : this._resolveModel(currentCircuit, primaryModel);

    const start = Date.now();

    try {
      const result = await fn(modelToUse);

      await this._recordSuccess(feature, modelToUse, Date.now() - start);

      if (isProbe) {
        await this._incrementHalfOpenSuccess(feature, primaryModel);
      }

      return result;

    } catch (err) {
      await this._recordFailure(feature, modelToUse, Date.now() - start, err);

      if (isProbe) {
        await this._safeTransition(feature, CircuitState.OPEN, modelToUse);
        throw err;
      }

      if (modelToUse === primaryModel) {
        return this._tryFallbacks(feature, primaryModel, fallbackModels, fn, err);
      }

      throw err;
    }
  }

  // ─────────────────────────────────────────────

  async _tryFallbacks(feature, primaryModel, fallbackModels, fn, originalError) {
    for (const fallback of fallbackModels) {
      try {
        const result = await fn(fallback);

        await this._safeTransition(feature, CircuitState.OPEN, fallback, primaryModel);

        return { ...result, _fallbackModel: fallback };

      } catch {
        continue;
      }
    }

    throw originalError;
  }

  // ─────────────────────────────────────────────
  // REDIS STATE
  // ─────────────────────────────────────────────

  async _getCircuit(feature, primaryModel) {
    const key = this._key(feature);

    const data = await redis.hgetall(key);

    if (!data || Object.keys(data).length === 0) {
      const initial = {
        state: CircuitState.CLOSED,
        primaryModel,
        currentModel: primaryModel,
        tripTime: 0,
        halfOpenSuccesses: 0,
      };

      await redis.hset(key, initial);
      await redis.expire(key, CIRCUIT_CONFIG.TTL_SECONDS);

      return initial;
    }

    return {
      ...data,
      tripTime: Number(data.tripTime),
      halfOpenSuccesses: Number(data.halfOpenSuccesses),
    };
  }

  // ─────────────────────────────────────────────
  // SAFE TRANSITION (DISTRIBUTED LOCK)
  // ─────────────────────────────────────────────

  async _safeTransition(feature, newState, currentModel, trippedModel = null) {
    const lockKey = this._lockKey(feature);

    const lock = await redis.set(lockKey, '1', 'NX', 'EX', 5);
    if (!lock) return;

    try {
      await this._transition(feature, newState, currentModel, trippedModel);
    } finally {
      await redis.del(lockKey);
    }
  }

  async _transition(feature, newState, currentModel, trippedModel = null) {
    const key = this._key(feature);
    const circuit = await this._getCircuit(feature, currentModel);

    const prevState = circuit.state;
    const now = Date.now();

    const updated = {
      state: newState,
      currentModel,
      halfOpenSuccesses: 0,
      tripTime: newState === CircuitState.OPEN ? now : circuit.tripTime,
    };

    await redis.hset(key, updated);
    await redis.expire(key, CIRCUIT_CONFIG.TTL_SECONDS);

    // 🔥 Observability (decoupled)
    observability.emitMetric('circuit.transition', 1, {
      feature,
      state: newState,
    }, 'counter');

    // 🚨 Alerts
    if (newState === CircuitState.OPEN && prevState === CircuitState.CLOSED) {
      await alertService.fire({
        type: 'CIRCUIT_BREAKER',
        feature,
        severity: 'CRITICAL',
        title: `Circuit OPEN: ${feature}`,
      }).catch(() => {});
    }
  }

  // ─────────────────────────────────────────────

  async _recordSuccess(feature, model, latencyMs) {
    if (latencyMs > CIRCUIT_CONFIG.LATENCY_TRIP_MS) {
      await this._safeTransition(feature, CircuitState.OPEN, model, model);
    }
  }

  async _recordFailure(feature, model) {
    await this._safeTransition(feature, CircuitState.OPEN, model, model);
  }

  async _incrementHalfOpenSuccess(feature, primaryModel) {
    const key = this._key(feature);

    const count = await redis.hincrby(key, 'halfOpenSuccesses', 1);

    if (count >= CIRCUIT_CONFIG.CONSECUTIVE_SUCCESSES_TO_CLOSE) {
      await this._safeTransition(feature, CircuitState.CLOSED, primaryModel);
    }
  }

  _resolveModel(circuit, primaryModel) {
    if (circuit.state === CircuitState.CLOSED) return primaryModel;
    return circuit.currentModel || primaryModel;
  }

  // ─────────────────────────────────────────────

  async tripFromDrift(feature, currentModel, fallbackModel) {
    await this._safeTransition(feature, CircuitState.OPEN, fallbackModel, currentModel);
  }

  async getCircuitStatus(feature) {
    return this._getCircuit(feature);
  }
}

const service = new CircuitBreakerService();

export default service;
export { CircuitState };