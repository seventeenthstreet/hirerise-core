'use strict';

/**
 * roles.types.js — Shared constants and type definitions for the Roles module.
 *
 * Keep all magic strings in one place. Both the service layer and the
 * Zod validator import from here — one source of truth, no drift.
 */

// ─── Tier → max expected roles ────────────────────────────────────────────────
// Keyed by req.user.plan values set in auth.middleware.js.
// Any unrecognised plan falls back to FREE_EXPECTED_LIMIT (fail-safe).

const EXPECTED_ROLE_LIMITS = {
  free:       1,
  pro:        3,
  premium:    5,
  enterprise: 5,
};

const FREE_EXPECTED_LIMIT = 1; // hard floor — never grant more than this to unknown tiers

// ─── Constraints ──────────────────────────────────────────────────────────────

const MAX_PREVIOUS_ROLES   = 3;
const MAX_EXPECTED_ROLES   = 5; // absolute ceiling across all tiers
const MAX_SEARCH_RESULTS   = 50;
const DEFAULT_SEARCH_LIMIT = 20;

// ─── Career history constraints ───────────────────────────────────────────────

const MAX_CAREER_HISTORY_ENTRIES = 5;  // max total roles in careerHistory[]
const MAX_DURATION_MONTHS        = 600; // 50 years — sanity ceiling

// ─── Role document field names (for Firestore queries) ───────────────────────

const ROLES_COLLECTION     = 'roles';
const PROFILES_COLLECTION  = 'userProfiles';

// ─── GAP-07: Industry sector controlled vocabulary ────────────────────────────
// Keyed by industryId (used in Firestore + salary band lookups).
// Value is the human-readable display label.
// Frontend sends industryId; unknown values fall back to 'other' with
// the raw string preserved as industryText.

const INDUSTRY_SECTORS = Object.freeze({
  technology:    'Technology & Software',
  fintech:       'Financial Services & Fintech',
  healthcare:    'Healthcare & Pharma',
  ecommerce:     'E-Commerce & Retail',
  manufacturing: 'Manufacturing & Industrial',
  consulting:    'Consulting & Professional Services',
  media:         'Media, Marketing & Advertising',
  education:     'Education & EdTech',
  logistics:     'Logistics & Supply Chain',
  realestate:    'Real Estate & Construction',
  telecom:       'Telecom & Networking',
  energy:        'Energy & Utilities',
  banking:       'Banking & Insurance',
  government:    'Government & Public Sector',
  nonprofit:     'Non-Profit & NGO',
  hospitality:   'Hospitality & Travel',
  agriculture:   'Agriculture & Food',
  automotive:    'Automotive & Mobility',
  aerospace:     'Aerospace & Defence',
  other:         'Other',
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
  ROLES_COLLECTION,
  PROFILES_COLLECTION,
  INDUSTRY_SECTORS,
};