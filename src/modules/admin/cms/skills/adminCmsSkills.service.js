'use strict';

/**
 * adminCmsSkills.service.js — Admin CMS Skills Business Logic
 *
 * This service is the single source of truth for all skill creation,
 * update, and deduplication logic in the Admin CMS ingestion layer.
 *
 * Duplicate prevention flow:
 *   1. Normalize incoming name → normalizedName
 *   2. Query repository for existing normalizedName (application-layer check)
 *   3. If found → throw DuplicateError (HTTP 409)
 *   4. If not found → delegate to repository.createSkill()
 *   5. Repository calls BaseRepository.create() → Firestore write
 *   (Firestore composite index on normalizedName is the final DB-level guard)
 *
 * Contributor identity:
 *   - adminId is ALWAYS taken from req.user.uid
 *   - agency is ALWAYS taken from req.user.agency
 *   - Neither may come from request body — enforced here and in the controller
 *
 * Logging:
 *   All duplicate attempts are logged with structured fields for observability.
 *
 * @module modules/admin/cms/skills/adminCmsSkills.service
 */

const skillsRepo = require('./adminCmsSkills.repository');
const { normalizeText } = require('../../../../shared/utils/normalizeText');
const { DuplicateError } = require('../../../../shared/errors/duplicate.error');
const { AppError, ErrorCodes } = require('../../../../middleware/errorHandler');
const logger = require('../../../../utils/logger');

// ── Create Skill ─────────────────────────────────────────────────────────────

/**
 * Create a new skill with full duplicate detection.
 *
 * @param {object} payload   — Validated request body (from controller)
 * @param {string} adminId   — req.user.uid — NEVER from request body
 * @param {string} [agency]  — req.user.agency — NEVER from request body
 * @returns {Promise<object>} — Created skill document
 * @throws {DuplicateError}  — HTTP 409 if skill already exists
 * @throws {AppError}        — HTTP 400 for validation failures
 */
async function createSkill(payload, adminId, agency = null) {
  const { name, category, aliases, description, demandScore } = payload;

  // ── Step 1: Normalize ────────────────────────────────────────────────────
  const normalizedName = normalizeText(name);

  // ── Step 2: Duplicate check ──────────────────────────────────────────────
  const existing = await skillsRepo.findByNormalizedName(normalizedName);

  if (existing) {
    // ── Step 3: Log + reject duplicate ──────────────────────────────────
    logger.warn('[AdminCmsSkills] Duplicate attempt blocked', {
      event:       'duplicate_attempt',
      dataset_type: 'skills',
      dataset_value: name,
      normalized:   normalizedName,
      admin_id:     adminId,
      existing_id:  existing.id,
      timestamp:    new Date().toISOString(),
    });

    throw new DuplicateError('skills', name, existing.id, {
      normalizedValue: normalizedName,
      field:           'name',
    });
  }

  // ── Step 4: Create ───────────────────────────────────────────────────────
  const created = await skillsRepo.createSkill(
    { name, category, aliases, description, demandScore },
    adminId,
    agency
  );

  logger.info('[AdminCmsSkills] Skill created', {
    skillId:  created.id,
    name:     created.name,
    admin_id: adminId,
    agency,
  });

  return created;
}

// ── Update Skill ─────────────────────────────────────────────────────────────

/**
 * Update an existing skill.
 * If the name is changing, re-checks for duplicates before saving.
 *
 * @param {string} skillId
 * @param {object} updates   — Validated partial update object
 * @param {string} adminId   — req.user.uid
 * @returns {Promise<object>}
 */
async function updateSkill(skillId, updates, adminId) {
  // If name is changing, check for duplicate with the NEW name
  if (updates.name) {
    const newNormalized = normalizeText(updates.name);
    const existing      = await skillsRepo.findByNormalizedName(newNormalized);

    // Allow update if the only match is the document being updated itself
    if (existing && existing.id !== skillId) {
      logger.warn('[AdminCmsSkills] Duplicate name on update blocked', {
        event:        'duplicate_attempt',
        dataset_type: 'skills',
        dataset_value: updates.name,
        admin_id:     adminId,
        existing_id:  existing.id,
        timestamp:    new Date().toISOString(),
      });

      throw new DuplicateError('skills', updates.name, existing.id, {
        normalizedValue: newNormalized,
        field:           'name',
      });
    }
  }

  return await skillsRepo.updateSkill(skillId, updates, adminId);
}

// ── List Skills ──────────────────────────────────────────────────────────────

/**
 * List all active skills in the CMS catalog.
 *
 * @param {object} options — { limit, category }
 * @returns {Promise<{ skills: object[], total: number }>}
 */
async function listSkills({ limit = 100, category } = {}) {
  const filters = [];
  if (category) {
    filters.push({ field: 'category', op: '==', value: category });
  }

  const result = await skillsRepo.find(filters, { limit });
  return { skills: result.docs, total: result.count };
}

module.exports = { createSkill, updateSkill, listSkills };








