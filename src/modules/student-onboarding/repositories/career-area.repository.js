'use strict';

/**
 * src/modules/student-onboarding/repositories/career-area.repository.js
 *
 * PHASE 1 — GOVERNED CAREER AREA VOCABULARY (READ-ONLY)
 * ══════════════════════════════════════════════════════
 * Reads the frozen 8-value Career Area vocabulary from its existing
 * governed owner, `public.cms_career_domains.canonical_key`
 * (see 20260904010000_phase3b6e3_career_area_governed_vocabulary.sql).
 *
 * This module does NOT define, seed, expand, or otherwise govern the
 * vocabulary — it only reads the currently-active governed keys so that
 * recommendation-output.validator.js has a single, reused source of truth
 * to validate `careerAreaKey` against, rather than hardcoding a second,
 * competing list (Phase 1 spec §10).
 *
 * Public API:
 *   fetchGovernedCareerAreaKeys([supabase]) → string[]
 */

const { supabase: defaultSupabase } = require('../../../config/supabase');

const CAREER_DOMAINS_TABLE = 'cms_career_domains';

/**
 * Returns the currently-active governed Career Area canonical keys.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} [supabaseClient]
 * @returns {Promise<string[]>}
 */
async function fetchGovernedCareerAreaKeys(supabaseClient = defaultSupabase) {
  const { data, error } = await supabaseClient
    .from(CAREER_DOMAINS_TABLE)
    .select('canonical_key')
    .eq('soft_deleted', false)
    .not('canonical_key', 'is', null);

  if (error) throw error;

  return (data ?? [])
    .map((row) => row.canonical_key)
    .filter((key) => typeof key === 'string' && key.length > 0);
}

module.exports = {
  fetchGovernedCareerAreaKeys,
};
