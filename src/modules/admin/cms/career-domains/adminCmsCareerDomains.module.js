'use strict';

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

// ─────────────────────────────────────────────
// 🔹 MODULE LOGIC
// ─────────────────────────────────────────────

const careerDomainsModule = {
  // ───────────────────────────────────────────
  // CREATE
  // ───────────────────────────────────────────
  async create(req, res, next) {
    try {
      const { name, description } = req.body;
      const adminId = req.admin?.id;

      const normalized_name = normalizeName(name);

      // 🔍 Dedup check
      const { data: existing } = await supabase
        .from('cms_career_domains')
        .select('id')
        .eq('normalized_name', normalized_name)
        .eq('soft_deleted', false)
        .maybeSingle();

      if (existing) {
        return res.status(409).json({
          success: false,
          errorCode: 'DUPLICATE_DOMAIN',
          message: 'Career domain already exists',
        });
      }

      // ✅ Insert
      const { data, error } = await supabase
        .from('cms_career_domains')
        .insert([
          {
            name,
            description,
            normalized_name,
            status: 'active',
            created_by_admin_id: adminId,
            updated_by_admin_id: adminId,
            soft_deleted: false,
          },
        ])
        .select()
        .single();

      if (error) throw error;

      return res.status(201).json({
        success: true,
        data,
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

      return res.json({
        success: true,
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