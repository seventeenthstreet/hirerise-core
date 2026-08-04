'use strict';

/**
 * @file src/shared/utils/roleCatalog.js
 * @description
 * Career Role Resolution (WP-PRO-10B).
 *
 * The Guided Builder's Career Goals step (CareerGoalsForm.tsx) only
 * captures a free-text `targetRole` — there is no role-catalog picker
 * component in this repository yet. Career Report / Career Intelligence
 * require the canonical `expected_role_ids` column instead.
 *
 * This module resolves free-text role titles to the closest matching
 * canonical `roles` catalog id, so callers can bridge `target_role` into
 * `expected_role_ids` without duplicating a second career-intent model.
 *
 * Lives under shared/ (not a *.service.js file) so it can be required by
 * both `roles.service.js` and `onboarding.careerReport.service.js` without
 * violating the `local/no-service-importing-service` governance rule
 * (Doc 08 — Dependency Rules), which forbids one *.service.js file from
 * requiring another directly.
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

const ROLES_TABLE = 'roles';

/**
 * Resolve a free-text role title to the closest matching canonical role
 * catalog id.
 *
 * @param {string} title - free-text role title (e.g. Career Goals `targetRole`)
 * @returns {Promise<string[]>} zero or one resolved role ids
 */
async function resolveExpectedRoleIdsFromTitle(title) {
  const term = typeof title === 'string' ? title.trim() : '';
  if (!term) return [];

  try {
    const { data, error } = await supabase
      .from(ROLES_TABLE)
      .select('role_id, role_name')
      .eq('soft_deleted', false)
      .ilike('role_name', `%${term}%`)
      .limit(1);

    if (error) {
      logger.warn('[RoleCatalog] role title resolution query failed', {
        title: term,
        error: error.message,
      });
      return [];
    }

    return data?.length ? [data[0].role_id] : [];
  } catch (error) {
    logger.warn('[RoleCatalog] role title resolution failed', {
      title: term,
      error: error.message,
    });
    return [];
  }
}

module.exports = Object.freeze({
  resolveExpectedRoleIdsFromTitle,
});