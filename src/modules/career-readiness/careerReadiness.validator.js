"use strict";

/**
 * src/modules/career-readiness/careerReadiness.validator.js
 *
 * Production-grade pure JS validation
 * - Supabase UUID aligned
 * - deterministic cache-safe normalization
 * - analytics-safe field normalization
 * - no Joi dependency
 */

const VALID_EDUCATION = new Set([
  "none",
  "associates",
  "bachelors",
  "masters",
  "phd",
  "diploma",
  "certificate",
  "undergraduate",
  "postgraduate",
  "doctorate",
]);

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeStringArray(arr = []) {
  return [...new Set(
    arr
      .filter((v) => typeof v === "string")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  )];
}

function validateCandidateProfile(data) {
  if (!data || typeof data !== "object") {
    throw new ValidationError("Invalid candidate profile", [
      "profile must be an object",
    ]);
  }

  const errors = [];

  // candidateId → live Supabase UUID alignment
  const candidateId = data.candidateId;
  if (
    !candidateId ||
    typeof candidateId !== "string" ||
    !UUID_REGEX.test(candidateId)
  ) {
    errors.push("candidateId must be a valid UUID");
  }

  // skills
  if (!Array.isArray(data.skills) || data.skills.length < 1) {
    errors.push("skills must be a non-empty array");
  }

  // totalYearsExperience
  const totalYearsExperience = data.totalYearsExperience;
  if (
    typeof totalYearsExperience !== "number" ||
    Number.isNaN(totalYearsExperience) ||
    totalYearsExperience < 0 ||
    totalYearsExperience > 60
  ) {
    errors.push(
      "totalYearsExperience must be a number between 0 and 60"
    );
  }

  // workHistory
  let normalizedWorkHistory = [];

  if (!Array.isArray(data.workHistory)) {
    errors.push("workHistory must be an array");
  } else {
    normalizedWorkHistory = data.workHistory.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        errors.push(`workHistory[${index}] must be an object`);
        return {
          title: null,
          years: 0,
          skills: [],
        };
      }

      const title =
        typeof entry.title === "string"
          ? entry.title.trim()
          : null;

      if (!title) {
        errors.push(`workHistory[${index}].title is required`);
      }

      const years = Number(entry.years);
      if (Number.isNaN(years) || years < 0) {
        errors.push(
          `workHistory[${index}].years must be a non-negative number`
        );
      }

      return {
        title,
        years: Number.isNaN(years) ? 0 : years,
        skills: normalizeStringArray(entry.skills),
      };
    });
  }

  // highestEducation
  const highestEducation =
    typeof data.highestEducation === "string"
      ? data.highestEducation.trim().toLowerCase()
      : null;

  if (!highestEducation || !VALID_EDUCATION.has(highestEducation)) {
    errors.push(
      `highestEducation must be one of: ${[
        ...VALID_EDUCATION,
      ].join(", ")}`
    );
  }

  // currentSalary
  const currentSalary = Number(data.currentSalary);
  if (Number.isNaN(currentSalary) || currentSalary < 0) {
    errors.push("currentSalary must be a non-negative number");
  }

  // targetRoleId → live Supabase UUID alignment
  const targetRoleId = data.targetRoleId;
  if (
    !targetRoleId ||
    typeof targetRoleId !== "string" ||
    !UUID_REGEX.test(targetRoleId)
  ) {
    errors.push("targetRoleId must be a valid UUID");
  }

  if (errors.length) {
    throw new ValidationError("Invalid candidate profile", errors);
  }

  return {
    candidateId,
    skills: normalizeStringArray(data.skills),
    totalYearsExperience,
    workHistory: normalizedWorkHistory,
    certifications: normalizeStringArray(data.certifications),
    highestEducation,
    currentSalary,
    targetRoleId,
  };
}

class ValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
    this.statusCode = 422;
    Error.captureStackTrace?.(this, ValidationError);
  }
}

module.exports = {
  validateCandidateProfile,
  ValidationError,
};