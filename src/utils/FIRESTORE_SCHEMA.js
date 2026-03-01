/**
 * FIRESTORE_SCHEMA.js — HireRise Firestore Data Model Reference
 *
 * This file is DOCUMENTATION ONLY — not executed at runtime.
 * It defines the canonical schema for every Firestore collection.
 *
 * Design principles:
 *   - One document per entity (no sub-collections for frequently-joined data)
 *   - Role ID is the shared foreign key across collections (denormalized for
 *     read performance — Firestore has no joins)
 *   - Salary bands and skill requirements stored as maps within a single doc
 *     per role, not as separate docs per level (avoids N reads for one view)
 *   - All Timestamps stored as Firestore Timestamp, not ISO strings
 *   - Arrays are used only for small, bounded lists (not for pagination)
 *
 * Collection index requirements (Firestore composite indexes needed):
 *   - roles: [jobFamilyId ASC, level ASC]
 *   - roles: [track ASC, level ASC]
 *   - skills: [category ASC, searchTokens ARRAY_CONTAINS]
 */

// ═══════════════════════════════════════════════════════════════════════════
//  COLLECTION: jobFamilies/{familyId}
// ═══════════════════════════════════════════════════════════════════════════
const JOB_FAMILY_SCHEMA = {
  // Document ID: "software-engineering" (slug, human-readable)
  id:          "software-engineering",
  name:        "Software Engineering",
  description: "Roles focused on designing, building, and maintaining software systems.",
  icon:        "code-bracket",         // Heroicons name — used by frontend
  tracks: [
    "individual_contributor",
    "management",
    "specialist"
  ],
  createdAt: "Firestore.Timestamp",
  updatedAt: "Firestore.Timestamp",
};

// ═══════════════════════════════════════════════════════════════════════════
//  COLLECTION: roles/{roleId}
// ═══════════════════════════════════════════════════════════════════════════
const ROLE_SCHEMA = {
  // Document ID: "swe-l3-ic" (family-level-track slug)
  id:    "swe-l3-ic",
  title: "Software Engineer III",
  level: "L3",   // L1–L6
  track: "individual_contributor",   // individual_contributor | management | specialist
  jobFamilyId: "software-engineering",
  description: "Mid-level software engineer responsible for owning features end-to-end...",
  alternativeTitles: ["Mid-level SWE", "Software Developer", "Full Stack Engineer"],

  // Optional: override default experience band thresholds for this role's family
  // Null = use DEFAULT_EXPERIENCE_BANDS from salary.service.js
  customExperienceBands: null,

  // Frontend display metadata
  avgTimeInRole: 2.5,              // Average years professionals spend at this level
  demandTrend:   "growing",        // growing | stable | declining
  remotePercent: 72,               // % of job postings listing remote

  createdAt: "Firestore.Timestamp",
  updatedAt: "Firestore.Timestamp",
};

// ═══════════════════════════════════════════════════════════════════════════
//  COLLECTION: salaryBands/{roleId}
//  Document ID matches roles/{roleId} — enables O(1) lookup without index
// ═══════════════════════════════════════════════════════════════════════════
const SALARY_BAND_SCHEMA = {
  roleId: "swe-l3-ic",

  // Map of level → salary data (all in INR annual, metro baseline)
  // Including all levels allows the full progression chart to be loaded
  // with a SINGLE document read.
  levels: {
    "L1": {
      min:    600000,
      max:    1000000,
      median: 800000,
      percentiles: {
        p25: 680000,
        p50: 800000,
        p75: 950000,
        p90: 1000000,
      },
    },
    "L2": {
      min:    900000,
      max:    1500000,
      median: 1200000,
      percentiles: {
        p25: 950000,
        p50: 1200000,
        p75: 1400000,
        p90: 1500000,
      },
    },
    "L3": {
      min:    1400000,
      max:    2500000,
      median: 1900000,
      percentiles: {
        p25: 1500000,
        p50: 1900000,
        p75: 2300000,
        p90: 2500000,
      },
    },
    "L4": {
      min:    2200000,
      max:    4000000,
      median: 3000000,
      percentiles: {
        p25: 2400000,
        p50: 3000000,
        p75: 3600000,
        p90: 4000000,
      },
    },
    "L5": {
      min:    3500000,
      max:    7000000,
      median: 5000000,
      percentiles: {
        p25: 3800000,
        p50: 5000000,
        p75: 6200000,
        p90: 7000000,
      },
    },
    "L6": {
      min:    6000000,
      max:    15000000,
      median: 9000000,
      percentiles: {
        p25: 6500000,
        p50: 9000000,
        p75: 12000000,
        p90: 15000000,
      },
    },
  },

  dataSource:  "Mercer India Compensation Survey 2024 + LinkedIn Salary Insights",
  sampleSize:  1240,      // Number of salary data points in survey
  updatedAt:   "Firestore.Timestamp",
};

// ═══════════════════════════════════════════════════════════════════════════
//  COLLECTION: roleSkills/{roleId}
//  Document ID matches roles/{roleId}
// ═══════════════════════════════════════════════════════════════════════════
const ROLE_SKILLS_SCHEMA = {
  roleId: "swe-l3-ic",

  skills: [
    {
      name:               "JavaScript",
      category:           "technical",     // technical | soft | domain | tool
      criticality:        5,               // 1 (nice-to-have) → 5 (must-have)
      minimumProficiency: "advanced",      // beginner | intermediate | advanced | expert
      roleWeight:         0.9,             // 0–1, how central is this skill to the role
      learningWeeks:      12,
      resources: [
        "MDN Web Docs JavaScript Guide",
        "JavaScript: The Good Parts (book)",
      ],
    },
    {
      name:               "React",
      category:           "technical",
      criticality:        4,
      minimumProficiency: "intermediate",
      roleWeight:         0.7,
      learningWeeks:      8,
      resources: ["React Docs — beta.reactjs.org"],
    },
    {
      name:               "System Design",
      category:           "technical",
      criticality:        4,
      minimumProficiency: "intermediate",
      roleWeight:         0.75,
      learningWeeks:      16,
      resources: ["Designing Data-Intensive Applications (book)"],
    },
    {
      name:               "Communication",
      category:           "soft",
      criticality:        4,
      minimumProficiency: "intermediate",
      roleWeight:         0.6,
      learningWeeks:      null,
      resources: [],
    },
    {
      name:               "Agile / Scrum",
      category:           "domain",
      criticality:        3,
      minimumProficiency: "beginner",
      roleWeight:         0.5,
      learningWeeks:      2,
      resources: ["Scrum Guide — scrumguides.org"],
    },
  ],

  updatedAt: "Firestore.Timestamp",
};

// ═══════════════════════════════════════════════════════════════════════════
//  COLLECTION: certifications/{certId}
// ═══════════════════════════════════════════════════════════════════════════
const CERTIFICATION_SCHEMA = {
  id:             "aws-developer-associate",
  title:          "AWS Certified Developer – Associate",
  provider:       "Amazon Web Services",
  url:            "https://aws.amazon.com/certification/certified-developer-associate/",
  estimatedHours: 80,
  difficulty:     "intermediate",
  free:           false,
  // Lowercase, normalized skill names for array-contains queries
  relatedSkills: ["aws", "cloud", "lambda", "s3", "dynamodb", "serverless"],
  createdAt: "Firestore.Timestamp",
};

// ═══════════════════════════════════════════════════════════════════════════
//  COLLECTION: careerPaths/{fromRoleId}
//  Directed adjacency list — fromRoleId → possible next roles
// ═══════════════════════════════════════════════════════════════════════════
const CAREER_PATH_SCHEMA = {
  fromRoleId: "swe-l3-ic",

  nextRoles: [
    {
      roleId:         "swe-l4-ic",          // Vertical: L3 → L4 in same family
      transitionType: "vertical",
      estimatedYears: 2.5,
      prerequisites:  [],
    },
    {
      roleId:         "em-l4-mgmt",         // Diagonal: IC → Engineering Manager
      transitionType: "diagonal",
      estimatedYears: 3.0,
      prerequisites:  ["swe-l3-ic"],        // Must be at current role first
    },
    {
      roleId:         "pm-l3",              // Lateral: SWE → Product Manager
      transitionType: "lateral",
      estimatedYears: 1.5,
      prerequisites:  [],
    },
    {
      roleId:         "sre-l3",             // Lateral: SWE → Site Reliability Engineer
      transitionType: "lateral",
      estimatedYears: 1.0,
      prerequisites:  [],
    },
  ],

  updatedAt: "Firestore.Timestamp",
};

// ═══════════════════════════════════════════════════════════════════════════
//  COLLECTION: skills/{skillId}
//  Global skill catalog for autocomplete search
// ═══════════════════════════════════════════════════════════════════════════
const SKILL_CATALOG_SCHEMA = {
  id:       "javascript",
  name:     "JavaScript",
  category: "technical",
  aliases:  ["JS", "ECMAScript", "ES6", "ES2015"],
  // Pre-computed search tokens (lowercased, normalized) for Firestore
  // array-contains queries. Generated on write, not at query time.
  searchTokens: ["javascript", "js", "ecmascript", "es6", "es2015"],
  demandScore:  92,   // 0–100: how in-demand globally (updated quarterly)
  createdAt: "Firestore.Timestamp",
};

module.exports = {
  JOB_FAMILY_SCHEMA,
  ROLE_SCHEMA,
  SALARY_BAND_SCHEMA,
  ROLE_SKILLS_SCHEMA,
  CERTIFICATION_SCHEMA,
  CAREER_PATH_SCHEMA,
  SKILL_CATALOG_SCHEMA,
};
