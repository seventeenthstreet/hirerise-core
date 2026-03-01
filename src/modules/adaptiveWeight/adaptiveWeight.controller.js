// adaptiveWeight.controller.js

const { AdaptiveWeightValidationError } = require("./adaptiveWeight.validator");

/**
 * AdaptiveWeightController
 * Zero business logic — pure HTTP boundary.
 * All decisions delegated to service layer.
 */
class AdaptiveWeightController {
  constructor({ adaptiveWeightService }) {
    this._service = adaptiveWeightService;
    this.getWeights       = this.getWeights.bind(this);
    this.recordOutcome    = this.recordOutcome.bind(this);
    this.applyOverride    = this.applyOverride.bind(this);
    this.releaseOverride  = this.releaseOverride.bind(this);
  }

  async getWeights(req, res, next) {
    try {
      const { roleFamily, experienceBucket, industryTag } = req.query;
      const result = await this._service.getWeightsForScoring(roleFamily, experienceBucket, industryTag);
      return res.status(200).json({ success: true, data: result });
    } catch (err) {
      return this._handleError(err, res, next);
    }
  }

  async recordOutcome(req, res, next) {
    try {
      const result = await this._service.recordOutcome(req.body);
      return res.status(200).json({ success: true, data: result });
    } catch (err) {
      return this._handleError(err, res, next);
    }
  }

  async applyOverride(req, res, next) {
    try {
      const result = await this._service.applyManualOverride(req.body);
      return res.status(200).json({ success: true, data: result });
    } catch (err) {
      return this._handleError(err, res, next);
    }
  }

  async releaseOverride(req, res, next) {
    try {
      const result = await this._service.releaseManualOverride(req.body);
      return res.status(200).json({ success: true, data: result });
    } catch (err) {
      return this._handleError(err, res, next);
    }
  }

  _handleError(err, res, next) {
    if (err.name === "AdaptiveWeightValidationError") {
      return res.status(422).json({ success: false, error: err.message, details: err.details });
    }
    next(err);
  }
}

module.exports = AdaptiveWeightController;