'use strict';

const observabilityRepo = require('../../repositories/ai-observability.repository');
const alertService = require('../observability/alert.service');

/**
 * circuit-breaker.service.js
 *
 * AI Circuit Breaker — automatic model fallback without service restart.
 *
 * STATE MACHINE:
 *   CLOSED  → normal operation, primary model in use
 *   OPEN    → primary model tripped; fallback model active
 *   HALF_OPEN → probe mode; test primary model on 10% of traffic
 *
 * TRIP CONDITIONS (any one triggers OPEN):
 *   - error_rate > configured threshold in rolling window
 *   - p95 latency exceeds CRITICAL threshold
 *   - drift alert at CRITICAL level
 *
 * RECOVERY:
 *   After RECOVERY_WINDOW_MS, transitions to HALF_OPEN.
 *   If 5 consecutive probes succeed in HALF_OPEN, transitions back to CLOSED.
 *   If any probe fails in HALF_OPEN, resets to OPEN.
 *
 * CONCURRENCY SAFETY:
 *   State is stored in an in-process Map with atomic transitions.
 *   For multi-replica: replace _state Map with Redis Hash using HSETNX.
 *
 * FALLBACK ORDER:
 *   Defined per-feature in MODEL_REGISTRY (model-registry.js).
 *   Circuit breaker iterates through fallbacks in order; if all fail, throws.
 */

const CIRCUIT_CONFIG = {
  ERROR_RATE_TRIP: 0.15,          // 15% error rate trips breaker
  LATENCY_TRIP_MS: 6000,           // Single-call latency trip
  RECOVERY_WINDOW_MS: 5 * 60_000, // 5 minutes before HALF_OPEN probe
  HALF_OPEN_PROBE_RATE: 0.1,       // 10% traffic as probes in HALF_OPEN
  CONSECUTIVE_SUCCESSES_TO_CLOSE: 5,
  ROLLING_WINDOW_MS: 60_000,       // 1-minute window for error rate
};

const CircuitState = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

class CircuitBreakerService {
  constructor() {
    // Per-feature circuit state
    // { feature: { state, primaryModel, currentModel, tripTime, halfOpenSuccesses, recentCalls: [] } }
    this._circuits = new Map();
  }

  /**
   * Execute fn with circuit breaker protection.
   * Returns result from primary or fallback model.
   *
   * @param {string} feature
   * @param {string} primaryModel
   * @param {Array<string>} fallbackModels - ordered fallback list
   * @param {Function} fn - async (model) => result
   */
  async execute(feature, primaryModel, fallbackModels, fn) {
    const circuit = this._getCircuit(feature, primaryModel);

    // Determine which model to use
    const modelToUse = this._resolveModel(circuit, primaryModel);
    const isProbe = circuit.state === CircuitState.HALF_OPEN && Math.random() < CIRCUIT_CONFIG.HALF_OPEN_PROBE_RATE;
    const modelForCall = isProbe ? primaryModel : modelToUse;

    const start = Date.now();
    try {
      const result = await fn(modelForCall);
      this._recordSuccess(feature, modelForCall, Date.now() - start);

      if (isProbe) {
        circuit.halfOpenSuccesses = (circuit.halfOpenSuccesses || 0) + 1;
        if (circuit.halfOpenSuccesses >= CIRCUIT_CONFIG.CONSECUTIVE_SUCCESSES_TO_CLOSE) {
          await this._transition(feature, CircuitState.CLOSED, primaryModel);
        }
      }

      return result;
    } catch (err) {
      this._recordFailure(feature, modelForCall, Date.now() - start, err);

      if (isProbe) {
        // Probe failed — reset to OPEN
        circuit.halfOpenSuccesses = 0;
        await this._transition(feature, CircuitState.OPEN, modelToUse);
        throw err;
      }

      // Primary failed — try fallbacks
      if (modelForCall === primaryModel) {
        return this._tryFallbacks(feature, primaryModel, fallbackModels, fn, err);
      }

      throw err;
    }
  }

  async _tryFallbacks(feature, primaryModel, fallbackModels, fn, originalError) {
    for (const fallback of fallbackModels) {
      try {
        const result = await fn(fallback);

        // Trip the breaker for primary model
        await this._transition(feature, CircuitState.OPEN, fallback, primaryModel);

        return { ...result, _modelSwitched: true, _fallbackModel: fallback };
      } catch {
        // Try next fallback
        continue;
      }
    }

    // All fallbacks exhausted
    throw originalError;
  }

  async _transition(feature, newState, currentModel, trippedModel = null) {
    const circuit = this._getCircuit(feature, currentModel);
    const prevState = circuit.state;

    circuit.state = newState;
    circuit.currentModel = currentModel;
    circuit.halfOpenSuccesses = 0;

    if (newState === CircuitState.OPEN) {
      circuit.tripTime = Date.now();

      // Schedule recovery to HALF_OPEN
      setTimeout(() => {
        if (circuit.state === CircuitState.OPEN) {
          circuit.state = CircuitState.HALF_OPEN;
        }
      }, CIRCUIT_CONFIG.RECOVERY_WINDOW_MS);
    }

    if (newState === CircuitState.OPEN && prevState === CircuitState.CLOSED) {
      // Log model switch event
      await observabilityRepo.writeModelSwitchEvent({
        feature,
        fromModel: trippedModel || currentModel,
        toModel: currentModel,
        reason: 'CIRCUIT_BREAKER_TRIP',
        circuitState: newState,
      }).catch(() => {});

      await alertService.fire({
        type: 'CIRCUIT_BREAKER',
        feature,
        severity: 'CRITICAL',
        title: `Circuit breaker OPEN: ${feature} switched from ${trippedModel} to ${currentModel}`,
        detail: { fromModel: trippedModel, toModel: currentModel, tripTime: new Date().toISOString() },
      }).catch(() => {});
    }

    if (newState === CircuitState.CLOSED && prevState !== CircuitState.CLOSED) {
      await observabilityRepo.writeModelSwitchEvent({
        feature,
        fromModel: currentModel,
        toModel: circuit.primaryModel,
        reason: 'CIRCUIT_BREAKER_RECOVERY',
        circuitState: newState,
      }).catch(() => {});
    }
  }

  _resolveModel(circuit, primaryModel) {
    if (circuit.state === CircuitState.CLOSED) return primaryModel;
    return circuit.currentModel || primaryModel;
  }

  _getCircuit(feature, primaryModel) {
    if (!this._circuits.has(feature)) {
      this._circuits.set(feature, {
        state: CircuitState.CLOSED,
        primaryModel,
        currentModel: primaryModel,
        tripTime: null,
        halfOpenSuccesses: 0,
        recentCalls: [], // { timestamp, success, latencyMs }
      });
    }
    return this._circuits.get(feature);
  }

  _recordSuccess(feature, model, latencyMs) {
    this._pushCall(feature, { success: true, latencyMs, timestamp: Date.now() });

    // Auto-trip on latency spike even on "success"
    if (latencyMs > CIRCUIT_CONFIG.LATENCY_TRIP_MS) {
      const circuit = this._circuits.get(feature);
      if (circuit && circuit.state === CircuitState.CLOSED) {
        // Latency trip (async, non-blocking)
        this._transition(feature, CircuitState.OPEN, model, model).catch(() => {});
      }
    }
  }

  _recordFailure(feature, model, latencyMs, err) {
    this._pushCall(feature, { success: false, latencyMs, timestamp: Date.now(), error: err.code });
    this._checkErrorRate(feature, model);
  }

  _checkErrorRate(feature, model) {
    const circuit = this._circuits.get(feature);
    if (!circuit || circuit.state !== CircuitState.CLOSED) return;

    const now = Date.now();
    const window = circuit.recentCalls.filter(c => now - c.timestamp < CIRCUIT_CONFIG.ROLLING_WINDOW_MS);
    if (window.length < 10) return; // need minimum sample

    const errorRate = window.filter(c => !c.success).length / window.length;
    if (errorRate > CIRCUIT_CONFIG.ERROR_RATE_TRIP) {
      this._transition(feature, CircuitState.OPEN, model, model).catch(() => {});
    }
  }

  _pushCall(feature, callData) {
    const circuit = this._circuits.get(feature);
    if (!circuit) return;
    circuit.recentCalls.push(callData);
    // Prune calls older than window
    const cutoff = Date.now() - CIRCUIT_CONFIG.ROLLING_WINDOW_MS * 2;
    circuit.recentCalls = circuit.recentCalls.filter(c => c.timestamp > cutoff);
  }

  /**
   * Trip breaker externally (called by drift service on CRITICAL drift).
   */
  async tripFromDrift(feature, currentModel, fallbackModel) {
    await this._transition(feature, CircuitState.OPEN, fallbackModel, currentModel);
  }

  getCircuitStatus(feature) {
    const circuit = this._circuits.get(feature);
    if (!circuit) return { state: CircuitState.CLOSED, currentModel: null };
    return {
      state: circuit.state,
      currentModel: circuit.currentModel,
      primaryModel: circuit.primaryModel,
      tripTime: circuit.tripTime,
      halfOpenSuccesses: circuit.halfOpenSuccesses,
    };
  }

  getAllStatuses() {
    const result = {};
    for (const [feature, circuit] of this._circuits.entries()) {
      result[feature] = this.getCircuitStatus(feature);
    }
    return result;
  }
}

module.exports = new CircuitBreakerService();
module.exports.CircuitState = CircuitState;