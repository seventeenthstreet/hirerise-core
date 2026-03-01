'use strict';

/**
 * careerReadiness.validator.js — UPDATED
 *
 * GAP T6: Changed candidateId from Joi.string().uuid() to Joi.string().min(20).max(40)
 *   Firebase UIDs are 28-character alphanumeric strings, NOT UUID format.
 *   The previous uuid() validator rejected ALL real Firebase users.
 */

const Joi = require('joi');

const candidateProfileSchema = Joi.object({
  // GAP T6: Firebase UIDs are 28-char alphanumeric, not UUID format
  candidateId:          Joi.string().min(20).max(40).required(),
  skills:               Joi.array().items(Joi.string()).min(1).required(),
  totalYearsExperience: Joi.number().min(0).max(60).required(),
  workHistory:          Joi.array().items(
    Joi.object({
      title:  Joi.string().required(),
      years:  Joi.number().min(0).required(),
      skills: Joi.array().items(Joi.string()).default([]),
    })
  ).required(),
  certifications:       Joi.array().items(Joi.string()).default([]),
  highestEducation:     Joi.string()
    .valid('none', 'associates', 'bachelors', 'masters', 'phd', 'diploma', 'certificate', 'undergraduate', 'postgraduate', 'doctorate')
    .required(),
  currentSalary:        Joi.number().min(0).required(),
  targetRoleId:         Joi.string().required(),
});

function validateCandidateProfile(data) {
  const { error, value } = candidateProfileSchema.validate(data, { abortEarly: false });
  if (error) {
    const messages = error.details.map(d => d.message);
    throw new ValidationError('Invalid candidate profile', messages);
  }
  return value;
}

class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name       = 'ValidationError';
    this.details    = details;
    this.statusCode = 422;
  }
}

module.exports = { validateCandidateProfile, ValidationError };
