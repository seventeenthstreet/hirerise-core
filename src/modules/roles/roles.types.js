'use strict';

/**
 * src/modules/roles/roles.types.js
 *
 * Shared constants and module-level type definitions for Roles.
 *
 * Supabase-safe source of truth for:
 *   - tier limits
 *   - onboarding constraints
 *   - search defaults
 *   - shared table names
 *   - controlled vocabularies
 *
 * No Firebase / Firestore terminology remains.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tier → maximum expected roles
// ─────────────────────────────────────────────────────────────────────────────
const EXPECTED_ROLE_LIMITS = Object.freeze({
  free: 1,
  pro: 3,
  premium: 5,
  enterprise: 5,
});

const FREE_EXPECTED_LIMIT = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Hard validation constraints
// ─────────────────────────────────────────────────────────────────────────────
const MAX_PREVIOUS_ROLES = 3;
const MAX_EXPECTED_ROLES = 5;
const MAX_SEARCH_RESULTS = 50;
const DEFAULT_SEARCH_LIMIT = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Career history constraints
// ─────────────────────────────────────────────────────────────────────────────
const MAX_CAREER_HISTORY_ENTRIES = 5;
const MAX_DURATION_MONTHS = 600;

// ─────────────────────────────────────────────────────────────────────────────
// Shared database table names
// ─────────────────────────────────────────────────────────────────────────────
const ROLES_TABLE = 'roles';
const USER_PROFILES_TABLE = 'user_profiles';

// ─────────────────────────────────────────────────────────────────────────────
// GAP-07: Industry sector controlled vocabulary
// ─────────────────────────────────────────────────────────────────────────────
const INDUSTRY_SECTORS = Object.freeze({
  technology: 'Technology & Software',
  fintech: 'Financial Services & Fintech',
  healthcare: 'Healthcare & Pharma',
  ecommerce: 'E-Commerce & Retail',
  manufacturing: 'Manufacturing & Industrial',
  consulting: 'Consulting & Professional Services',
  media: 'Media, Marketing & Advertising',
  education: 'Education & EdTech',
  logistics: 'Logistics & Supply Chain',
  realestate: 'Real Estate & Construction',
  telecom: 'Telecom & Networking',
  energy: 'Energy & Utilities',
  banking: 'Banking & Insurance',
  government: 'Government & Public Sector',
  nonprofit: 'Non-Profit & NGO',
  hospitality: 'Hospitality & Travel',
  agriculture: 'Agriculture & Food',
  automotive: 'Automotive & Mobility',
  aerospace: 'Aerospace & Defence',
  other: 'Other',
});

module.exports = {
  EXPECTED_ROLE_LIMITS,
  FREE_EXPECTED_LIMIT,
  MAX_PREVIOUS_ROLES,
  MAX_EXPECTED_ROLES,
  MAX_SEARCH_RESULTS,
  DEFAULT_SEARCH_LIMIT,
  MAX_CAREER_HISTORY_ENTRIES,
  MAX_DURATION_MONTHS,
  ROLES_TABLE,
  USER_PROFILES_TABLE,
  INDUSTRY_SECTORS,
};