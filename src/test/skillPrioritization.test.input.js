// test/skillPrioritization.test.input.js

const testInput = {
  user_id:          "usr_01HXYZ9KBM3T7Q2WNPF6R",
  targetRoleId:    "role_senior_backend_engineer",
  currentRoleId:   "role_mid_backend_engineer",
  experienceYears: 3,
  resumeScore:     58,   // Below 60 → foundational boost applies
  skills: [
    { skillId: "nodejs",      proficiencyLevel: 72 },
    { skillId: "postgresql",  proficiencyLevel: 65 },
    { skillId: "redis",       proficiencyLevel: 30 },
    { skillId: "kubernetes",  proficiencyLevel: 10 },
    { skillId: "system-design", proficiencyLevel: 40 },
    { skillId: "typescript",  proficiencyLevel: 55 },
    { skillId: "graphql",     proficiencyLevel: 20 },
    { skillId: "terraform",   proficiencyLevel: 0  },
  ],
};

module.exports = testInput;








