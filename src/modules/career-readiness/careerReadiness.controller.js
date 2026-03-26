// careerReadiness.controller.js
const { ValidationError } = require("./careerReadiness.validator");

class CareerReadinessController {
  constructor({ careerReadinessService }) {
    this.service = careerReadinessService;
    this.computeReadiness = this.computeReadiness.bind(this);
  }

  async computeReadiness(req, res, next) {
    try {
      const { profile, resumeData } = req.body;
      const result = await this.service.computeReadiness(profile, resumeData);
      return res.status(200).json({ success: true, data: result });
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(422).json({ success: false, error: err.message, details: err.details });
      }
      next(err);
    }
  }
}

module.exports = CareerReadinessController;








