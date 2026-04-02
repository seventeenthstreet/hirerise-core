'use strict';

/**
 * adaptiveWeight.controller.js
 *
 * Production-grade HTTP controller
 * - Zero business logic
 * - Strong input sanitization
 * - Consistent API responses
 * - Observability-ready
 */

const crypto = require('crypto');
const logger = require('../../utils/logger');
const { AdaptiveWeightValidationError } = require('./adaptiveWeight.validator');

class AdaptiveWeightController {
  constructor({ adaptiveWeightService }) {
    this._service = adaptiveWeightService;

    // Bind methods
    this.getWeights      = this.getWeights.bind(this);
    this.recordOutcome   = this.recordOutcome.bind(this);
    this.applyOverride   = this.applyOverride.bind(this);
    this.releaseOverride = this.releaseOverride.bind(this);
  }

  // ─────────────────────────────────────────────────────────────
  // 🔹 Helpers
  // ─────────────────────────────────────────────────────────────
  _getRequestId(req) {
    return (
      req.headers['x-request-id'] ||
      req.headers['x-correlation-id'] ||
      crypto.randomUUID()
    );
  }

  _sanitizeQuery(query = {}) {
    return {
      roleFamily: query.roleFamily || null,
      experienceBucket: query.experienceBucket || null,
      industryTag: query.industryTag || null,
    };
  }

  _sendSuccess(res, data, meta = {}) {
    return res.status(200).json({
      success: true,
      data,
      meta,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 📊 GET /weights
  // ─────────────────────────────────────────────────────────────
  async getWeights(req, res, next) {
    const requestId = this._getRequestId(req);

    try {
      const { roleFamily, experienceBucket, industryTag } =
        this._sanitizeQuery(req.query);

      const result = await this._service.getWeightsForScoring({
        roleFamily,
        experienceBucket,
        industryTag,
        requestId,
      });

      return this._sendSuccess(res, result, { requestId });

    } catch (err) {
      logger.error('[AdaptiveWeightController:getWeights]', {
        requestId,
        error: err.message,
      });
      return this._handleError(err, res, next, requestId);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 📥 POST /outcome
  // ─────────────────────────────────────────────────────────────
  async recordOutcome(req, res, next) {
    const requestId = this._getRequestId(req);

    try {
      const payload = {
        ...req.body,
        requestId,
      };

      const result = await this._service.recordOutcome(payload);

      return this._sendSuccess(res, result, { requestId });

    } catch (err) {
      logger.error('[AdaptiveWeightController:recordOutcome]', {
        requestId,
        error: err.message,
      });
      return this._handleError(err, res, next, requestId);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 🛠️ POST /override
  // ─────────────────────────────────────────────────────────────
  async applyOverride(req, res, next) {
    const requestId = this._getRequestId(req);

    try {
      const payload = {
        ...req.body,
        requestId,
      };

      const result = await this._service.applyManualOverride(payload);

      return this._sendSuccess(res, result, { requestId });

    } catch (err) {
      logger.error('[AdaptiveWeightController:applyOverride]', {
        requestId,
        error: err.message,
      });
      return this._handleError(err, res, next, requestId);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 🔓 POST /override/release
  // ─────────────────────────────────────────────────────────────
  async releaseOverride(req, res, next) {
    const requestId = this._getRequestId(req);

    try {
      const payload = {
        ...req.body,
        requestId,
      };

      const result = await this._service.releaseManualOverride(payload);

      return this._sendSuccess(res, result, { requestId });

    } catch (err) {
      logger.error('[AdaptiveWeightController:releaseOverride]', {
        requestId,
        error: err.message,
      });
      return this._handleError(err, res, next, requestId);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ❌ Error Handler
  // ─────────────────────────────────────────────────────────────
  _handleError(err, res, next, requestId) {
    if (err instanceof AdaptiveWeightValidationError || err.name === 'AdaptiveWeightValidationError') {
      return res.status(422).json({
        success: false,
        error: err.message,
        details: err.details || null,
        requestId,
      });
    }

    // Unknown error → pass to global handler
    return next(err);
  }
}

module.exports = AdaptiveWeightController;
