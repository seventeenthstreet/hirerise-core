'use strict';

// CONTRACT NOTE (Phase 2): All error responses use V2 canonical shape.


/**
 * adminCmsCareerDomains.module.js (Supabase Optimized)
 *
 * Table: cms_career_domains
 *
 * Columns:
 *   id                  UUID (PK)
 *   name                TEXT
 *   description         TEXT
 *   normalized_name     TEXT (indexed, unique)
 *   status              TEXT ('active' | 'inactive')
 *   created_by_admin_id UUID
 *   updated_by_admin_id UUID
 *   soft_deleted        BOOLEAN
 *   created_at          TIMESTAMP
 *   updated_at          TIMESTAMP
 */

const { body } = require('express-validator');
const { supabase } = require('../../../../config/supabase');
const logger   = require('../../../../utils/logger');

// ─────────────────────────────────────────────
// 🔹 HELPERS
// ─────────────────────────────────────────────

function normalizeName(name) {
  return name.trim().toLowerCase();
}

// Phase 3B.6E.3: canonical_key is migration-owned (see
// supabase/migrations/20260904010000_phase3b6e3_career_area_governed_vocabulary.sql).
// Ordinary Admin CRUD on this module must never be able to set or change it —
// the DB CHECK/UNIQUE constraints are a backstop, not the enforcement point.
// This helper makes that governance boundary explicit at the application
// layer. Returns true (and has already written the response) if the request
// was rejected; false if canonical_key was absent and the caller should
// continue.
function rejectCanonicalKeyMutation(req, res) {
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'canonical_key')) {
    res.status(403).json({
      success: false,
      error: {
        code: 'CANONICAL_KEY_GOVERNANCE_RESTRICTED',
        message: 'canonical_key is governed and cannot be supplied through ordinary Admin CRUD',
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    });
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────
// 🔹 MODULE LOGIC
// ─────────────────────────────────────────────

const careerDomainsModule = {
  // ───────────────────────────────────────────
  // CREATE
  // ───────────────────────────────────────────
  async create(req, res, next) {
    try {
      if (rejectCanonicalKeyMutation(req, res)) return;

      // Phase 3B.6E.3: the Career Area vocabulary is closed. The eight
      // governed Career Areas are seeded and owned by the Phase 3B.6E.3
      // migration; ordinary Admin CREATE can no longer add arbitrary
      // Career Areas through this endpoint.
      return res.status(403).json({
        success: false,
        error: {
          code: 'CAREER_AREA_VOCABULARY_CLOSED',
          message: 'Career Area vocabulary is closed; new Career Areas are migration-owned.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    } catch (err) {
      logger.error('CareerDomain CREATE error', err);
      next(err);
    }
  },

  // ───────────────────────────────────────────
  // LIST
  // ───────────────────────────────────────────
  async list(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('cms_career_domains')
        .select('*')
        .eq('soft_deleted', false)
        .order('created_at', { ascending: false });

      if (error) throw error;

      return res.json({
        success: true,
        data,
      });

    } catch (err) {
      logger.error('CareerDomain LIST error', err);
      next(err);
    }
  },

  // ───────────────────────────────────────────
  // UPDATE
  // ───────────────────────────────────────────
  async update(req, res, next) {
    try {
      if (rejectCanonicalKeyMutation(req, res)) return;

      const { id } = req.params;
      const { name, description, status } = req.body;
      const adminId = req.admin?.id;

      let updatePayload = {
        updated_by_admin_id: adminId,
      };

      if (name) {
        updatePayload.name = name;
        updatePayload.normalized_name = normalizeName(name);
      }

      if (description !== undefined) {
        updatePayload.description = description;
      }

      if (status) {
        updatePayload.status = status;
      }

      const { data, error } = await supabase
        .from('cms_career_domains')
        .update(updatePayload)
        .eq('id', id)
        .eq('soft_deleted', false)
        .select()
        .single();

      if (error) throw error;

      return res.json({
        success: true,
        data,
      });

    } catch (err) {
      logger.error('CareerDomain UPDATE error', err);
      next(err);
    }
  },

  // ───────────────────────────────────────────
  // DELETE (SOFT)
  // ───────────────────────────────────────────
  async remove(req, res, next) {
    try {
      const { id } = req.params;
      const adminId = req.admin?.id;

      const { error } = await supabase
        .from('cms_career_domains')
        .update({
          soft_deleted: true,
          updated_by_admin_id: adminId,
        })
        .eq('id', id);

      if (error) throw error;

      // V2 contract: every success:true response must include a `data` key
      // (see src/shared/response/index.js). This handler predates that
      // contract and omitted it, which the frontend API client treats as a
      // hard parse failure (R1 violation) — fixed as the smallest correction
      // needed to make the Archive action work, per WP-ADMIN-COMP-03 §22.
      return res.json({
        success: true,
        data: null,
        message: 'Career domain deleted successfully',
      });

    } catch (err) {
      logger.error('CareerDomain DELETE error', err);
      next(err);
    }
  },
};

// ─────────────────────────────────────────────
// 🔹 VALIDATION
// ─────────────────────────────────────────────

careerDomainsModule.validators = [
  body('name')
    .isString()
    .trim()
    .isLength({ min: 2, max: 100 }),

  body('description')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 500 }),

  body('status')
    .optional()
    .isIn(['active', 'inactive']),
];

// Test-compatible export structure (Phase 3B.6E.3 regression contract):
// these mirror the internal helpers above exactly and do not change
// production routing behavior.
careerDomainsModule._normalizeName = normalizeName;
careerDomainsModule._rejectCanonicalKeyMutation = rejectCanonicalKeyMutation;

module.exports = careerDomainsModule;

// ─────────────────────────────────────────────
// 🔹 ROUTER
// ─────────────────────────────────────────────

const { Router } = require('express');
const { validate } = require('../../../../middleware/requestValidator');

const router = Router();

router.get('/',      careerDomainsModule.list);
router.post('/',     validate(careerDomainsModule.validators), careerDomainsModule.create);
router.put('/:id',   validate(careerDomainsModule.validators), careerDomainsModule.update);
router.delete('/:id', careerDomainsModule.remove);

careerDomainsModule.router = router;