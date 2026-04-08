'use strict';

/**
 * @file test/skillPrioritization.test.input.js
 * @description
 * Immutable test fixture aligned with Supabase-era service payloads.
 */

const testInput = Object.freeze({
  userId: 'usr_01HXYZ9KBM3T7Q2WNPF6R',
  targetRoleId: 'role_senior_backend_engineer',
  currentRoleId: 'role_mid_backend_engineer',
  experienceYears: 3,
  resumeScore: 58, // < 60 => foundational boost applies
  skills: Object.freeze([
    Object.freeze({
      skillId: 'nodejs',
      proficiencyLevel: 72,
    }),
    Object.freeze({
      skillId: 'postgresql',
      proficiencyLevel: 65,
    }),
    Object.freeze({
      skillId: 'redis',
      proficiencyLevel: 30,
    }),
    Object.freeze({
      skillId: 'kubernetes',
      proficiencyLevel: 10,
    }),
    Object.freeze({
      skillId: 'system-design',
      proficiencyLevel: 40,
    }),
    Object.freeze({
      skillId: 'typescript',
      proficiencyLevel: 55,
    }),
    Object.freeze({
      skillId: 'graphql',
      proficiencyLevel: 20,
    }),
    Object.freeze({
      skillId: 'terraform',
      proficiencyLevel: 0,
    }),
  ]),
});

module.exports = testInput;