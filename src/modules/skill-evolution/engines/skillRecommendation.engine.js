'use strict';

/**
 * engines/skillRecommendation.engine.js
 *
 * Skill Evolution Engine (SEE)
 *
 * Analyses the student's career predictions, live labor-market skill demand,
 * career-graph path strength, and cognitive profile to produce a ranked list
 * of skills the student should acquire to maximise their career success.
 *
 * Formula:
 *   skill_impact_score = (skill_demand × career_relevance × graph_path_strength)
 *   Normalised to 0–100.
 *
 * Inputs:
 *   careerResult  — output of CareerSuccessEngine  { top_careers, all_careers }
 *   streamResult  — output of StreamIntelligenceEngine { recommended_stream }
 *   cognitiveResult — output of CognitiveProfileEngine { scores, strengths }
 *   marketSkillDemand — array of { skill_name, demand_score, growth_rate }
 *
 * Output:
 * {
 *   top_career:   'Software Engineer',
 *   recommended_stream: 'engineering',
 *   skills: [
 *     { skill: 'Python',           impact: 95, demand: 98, career_relevance: 0.97, learning_order: 1 },
 *     { skill: 'Machine Learning', impact: 92, demand: 96, career_relevance: 0.93, learning_order: 3 },
 *     ...
 *   ],
 *   roadmap: [
 *     { step: 1, skill: 'Python',            rationale: 'Foundation language for all CS careers' },
 *     { step: 2, skill: 'Data Structures',   rationale: 'Core CS fundamental for technical interviews' },
 *     { step: 3, skill: 'Machine Learning',  rationale: 'High-impact differentiator for AI/ML roles' },
 *   ],
 *   engine_version: '1.0.0',
 * }
 */

const ENGINE_VERSION = '1.0.0';

// ─── Career → Skill Relevance Matrix ─────────────────────────────────────────
//
// For each career we define:
//   skills:  ordered list of skills most relevant to that career
//   weights: career_relevance score (0–1) for each skill
//   stream:  which educational stream this career maps to
//
const CAREER_SKILL_MATRIX = {
  'Software Engineer': {
    stream: 'engineering',
    skills: [
      { name: 'Python',             relevance: 0.97, order: 1, rationale: 'Primary language for backend, ML, and scripting' },
      { name: 'Data Structures',    relevance: 0.95, order: 2, rationale: 'Core CS fundamental for technical interviews' },
      { name: 'System Design',      relevance: 0.92, order: 4, rationale: 'Required for senior engineering roles' },
      { name: 'SQL',                relevance: 0.88, order: 3, rationale: 'Essential for data handling in every application' },
      { name: 'JavaScript',         relevance: 0.85, order: 5, rationale: 'Full-stack development capability' },
      { name: 'Docker',             relevance: 0.80, order: 6, rationale: 'Modern deployment and containerisation' },
      { name: 'AWS',                relevance: 0.78, order: 7, rationale: 'Cloud infrastructure skills in high demand' },
    ],
  },
  'AI / ML Engineer': {
    stream: 'engineering',
    skills: [
      { name: 'Python',             relevance: 0.99, order: 1, rationale: 'The language of ML and AI development' },
      { name: 'Machine Learning',   relevance: 0.98, order: 3, rationale: 'Core domain expertise for AI engineering' },
      { name: 'Data Structures',    relevance: 0.90, order: 2, rationale: 'Foundation required before advanced ML' },
      { name: 'TensorFlow',         relevance: 0.88, order: 4, rationale: 'Industry-standard ML framework' },
      { name: 'NLP',                relevance: 0.82, order: 5, rationale: 'Fastest growing AI sub-domain' },
      { name: 'SQL',                relevance: 0.78, order: 3, rationale: 'Essential for data pipeline work' },
      { name: 'AWS',                relevance: 0.75, order: 6, rationale: 'Cloud ML deployment infrastructure' },
    ],
  },
  'Data Scientist': {
    stream: 'engineering',
    skills: [
      { name: 'Python',             relevance: 0.97, order: 1, rationale: 'Primary tool for data science workflows' },
      { name: 'SQL',                relevance: 0.95, order: 2, rationale: 'Essential for querying and exploring datasets' },
      { name: 'Machine Learning',   relevance: 0.93, order: 3, rationale: 'Required for predictive modelling' },
      { name: 'Data Analysis',      relevance: 0.90, order: 3, rationale: 'Core skill of the role' },
      { name: 'TensorFlow',         relevance: 0.78, order: 5, rationale: 'Deep learning model development' },
      { name: 'Agile',              relevance: 0.65, order: 6, rationale: 'Collaborative sprint-based delivery' },
    ],
  },
  'Cybersecurity Specialist': {
    stream: 'engineering',
    skills: [
      { name: 'Network Security',   relevance: 0.97, order: 1, rationale: 'Core domain expertise' },
      { name: 'Python',             relevance: 0.88, order: 2, rationale: 'Scripting for automated security tools' },
      { name: 'Data Structures',    relevance: 0.72, order: 3, rationale: 'Useful for understanding exploits' },
      { name: 'Docker',             relevance: 0.70, order: 4, rationale: 'Container security hardening' },
      { name: 'AWS',                relevance: 0.68, order: 5, rationale: 'Cloud security architecture' },
    ],
  },
  'Systems Architect': {
    stream: 'engineering',
    skills: [
      { name: 'System Design',      relevance: 0.99, order: 1, rationale: 'The core of the role' },
      { name: 'AWS',                relevance: 0.95, order: 2, rationale: 'Primary cloud platform skills' },
      { name: 'Kubernetes',         relevance: 0.90, order: 3, rationale: 'Orchestration for large-scale systems' },
      { name: 'Docker',             relevance: 0.88, order: 2, rationale: 'Containerisation fundamentals' },
      { name: 'Python',             relevance: 0.75, order: 4, rationale: 'Infrastructure-as-code scripting' },
    ],
  },
  'Doctor (MBBS / MD)': {
    stream: 'medical',
    skills: [
      { name: 'Clinical Diagnosis', relevance: 0.99, order: 1, rationale: 'Primary medical skill' },
      { name: 'Medical Research',   relevance: 0.90, order: 3, rationale: 'Evidence-based practice' },
      { name: 'Patient Care',       relevance: 0.95, order: 2, rationale: 'Core interpersonal clinical skill' },
      { name: 'Communication',      relevance: 0.88, order: 2, rationale: 'Essential for patient relationships' },
      { name: 'Data Analysis',      relevance: 0.65, order: 4, rationale: 'Medical data interpretation' },
    ],
  },
  'Investment Banker': {
    stream: 'commerce',
    skills: [
      { name: 'Financial Modeling', relevance: 0.99, order: 1, rationale: 'Core technical banking skill' },
      { name: 'Excel',              relevance: 0.95, order: 2, rationale: 'Industry-standard modelling tool' },
      { name: 'Communication',      relevance: 0.88, order: 3, rationale: 'Client presentation and deal-making' },
      { name: 'Data Analysis',      relevance: 0.80, order: 3, rationale: 'Quantitative market analysis' },
      { name: 'Python',             relevance: 0.60, order: 4, rationale: 'Growing use in quant finance' },
    ],
  },
  'Chartered Accountant': {
    stream: 'commerce',
    skills: [
      { name: 'Excel',              relevance: 0.97, order: 1, rationale: 'Essential for audit and reporting' },
      { name: 'Financial Modeling', relevance: 0.90, order: 2, rationale: 'Valuation and forecasting' },
      { name: 'Data Analysis',      relevance: 0.78, order: 3, rationale: 'Financial data insights' },
      { name: 'Communication',      relevance: 0.72, order: 3, rationale: 'Client advisory communication' },
      { name: 'SQL',                relevance: 0.58, order: 4, rationale: 'Database-driven reporting' },
    ],
  },
  'UX Designer': {
    stream: 'humanities',
    skills: [
      { name: 'Figma',              relevance: 0.99, order: 1, rationale: 'Industry-standard UX design tool' },
      { name: 'Communication',      relevance: 0.88, order: 2, rationale: 'User research and stakeholder alignment' },
      { name: 'JavaScript',         relevance: 0.72, order: 3, rationale: 'Interaction prototyping capability' },
      { name: 'Data Analysis',      relevance: 0.65, order: 3, rationale: 'Interpreting user behaviour data' },
    ],
  },
  'Lawyer': {
    stream: 'humanities',
    skills: [
      { name: 'Communication',      relevance: 0.99, order: 1, rationale: 'Argumentation and written advocacy' },
      { name: 'Digital Marketing',  relevance: 0.55, order: 3, rationale: 'Building a personal brand' },
      { name: 'Data Analysis',      relevance: 0.60, order: 2, rationale: 'Case research and analysis' },
    ],
  },
  'Marketing Manager': {
    stream: 'commerce',
    skills: [
      { name: 'Digital Marketing',  relevance: 0.99, order: 1, rationale: 'Core domain expertise' },
      { name: 'Communication',      relevance: 0.90, order: 2, rationale: 'Content strategy and copywriting' },
      { name: 'Data Analysis',      relevance: 0.82, order: 3, rationale: 'Campaign analytics and performance' },
      { name: 'Figma',              relevance: 0.65, order: 3, rationale: 'Creative asset design' },
      { name: 'SQL',                relevance: 0.55, order: 4, rationale: 'Customer data querying' },
    ],
  },
  'Entrepreneur': {
    stream: 'commerce',
    skills: [
      { name: 'Communication',      relevance: 0.96, order: 1, rationale: 'Pitching and stakeholder communication' },
      { name: 'Digital Marketing',  relevance: 0.88, order: 2, rationale: 'Growth and customer acquisition' },
      { name: 'Financial Modeling', relevance: 0.85, order: 2, rationale: 'Business planning and fundraising' },
      { name: 'Agile',              relevance: 0.80, order: 3, rationale: 'Fast iteration and team management' },
      { name: 'Python',             relevance: 0.55, order: 4, rationale: 'Building early MVPs' },
    ],
  },
  'Biomedical Researcher': {
    stream: 'medical',
    skills: [
      { name: 'Data Analysis',      relevance: 0.95, order: 1, rationale: 'Statistical analysis of experimental data' },
      { name: 'Machine Learning',   relevance: 0.80, order: 3, rationale: 'Bioinformatics and drug discovery' },
      { name: 'Python',             relevance: 0.78, order: 2, rationale: 'Research scripting and automation' },
      { name: 'Communication',      relevance: 0.72, order: 3, rationale: 'Publishing and academic collaboration' },
    ],
  },
  'Civil Services (IAS/IPS)': {
    stream: 'humanities',
    skills: [
      { name: 'Communication',      relevance: 0.99, order: 1, rationale: 'Public speaking and report writing' },
      { name: 'Data Analysis',      relevance: 0.78, order: 2, rationale: 'Policy analysis and evaluation' },
      { name: 'Digital Marketing',  relevance: 0.50, order: 3, rationale: 'Public engagement and communication' },
    ],
  },
};

// ─── Stream-level fallback skill sets ─────────────────────────────────────────
// Used when the student's top career isn't in the matrix above.

const STREAM_SKILLS_FALLBACK = {
  engineering: [
    { name: 'Python',          relevance: 0.95, order: 1, rationale: 'Core programming language for engineering' },
    { name: 'Data Structures', relevance: 0.90, order: 2, rationale: 'CS fundamentals' },
    { name: 'SQL',             relevance: 0.85, order: 3, rationale: 'Data management' },
    { name: 'System Design',   relevance: 0.80, order: 4, rationale: 'Architecture thinking' },
    { name: 'AWS',             relevance: 0.75, order: 5, rationale: 'Cloud deployment' },
  ],
  medical: [
    { name: 'Clinical Diagnosis', relevance: 0.95, order: 1, rationale: 'Core clinical skill' },
    { name: 'Patient Care',       relevance: 0.90, order: 2, rationale: 'Interpersonal care' },
    { name: 'Data Analysis',      relevance: 0.70, order: 3, rationale: 'Evidence-based decisions' },
    { name: 'Communication',      relevance: 0.88, order: 2, rationale: 'Patient communication' },
  ],
  commerce: [
    { name: 'Financial Modeling', relevance: 0.90, order: 1, rationale: 'Core finance skill' },
    { name: 'Excel',              relevance: 0.85, order: 2, rationale: 'Finance tool proficiency' },
    { name: 'Communication',      relevance: 0.80, order: 2, rationale: 'Business communication' },
    { name: 'Data Analysis',      relevance: 0.75, order: 3, rationale: 'Market analysis' },
    { name: 'Digital Marketing',  relevance: 0.68, order: 4, rationale: 'Digital business skills' },
  ],
  humanities: [
    { name: 'Communication',     relevance: 0.95, order: 1, rationale: 'Core humanities skill' },
    { name: 'Digital Marketing', relevance: 0.78, order: 2, rationale: 'Digital presence' },
    { name: 'Data Analysis',     relevance: 0.65, order: 3, rationale: 'Research and insight' },
    { name: 'Figma',             relevance: 0.60, order: 4, rationale: 'Visual communication' },
  ],
};

// ─── Cognitive → Skill Affinity Map ───────────────────────────────────────────
// Boosts skills that align with a student's cognitive strengths.
// boost = 0–0.10 multiplied into the final impact score.

const COGNITIVE_SKILL_AFFINITY = {
  analytical:    ['Python', 'Data Analysis', 'Machine Learning', 'SQL', 'Financial Modeling'],
  logical:       ['Data Structures', 'System Design', 'Python', 'Network Security', 'SQL'],
  memory:        ['Clinical Diagnosis', 'Medical Research', 'Patient Care', 'Excel'],
  communication: ['Communication', 'Digital Marketing', 'Figma', 'Agile'],
  creativity:    ['Figma', 'Digital Marketing', 'NLP', 'Machine Learning', 'JavaScript'],
};

// ─── Learning Order Weights ───────────────────────────────────────────────────
// Earlier skills are foundational; this factor raises their rank slightly.
// order 1 = 1.06, order 2 = 1.03, order 3+ = 1.0

function _orderFactor(order) {
  if (order === 1) return 1.06;
  if (order === 2) return 1.03;
  return 1.0;
}

// ─── Main Engine ──────────────────────────────────────────────────────────────

/**
 * Compute a ranked list of skill recommendations for a student.
 *
 * @param {object} careerResult    — CareerSuccessEngine output
 * @param {object} streamResult    — StreamIntelligenceEngine output
 * @param {object} cognitiveResult — CognitiveProfileEngine output
 * @param {Array}  marketDemand    — LMI skill demand array [{ skill_name, demand_score, growth_rate }]
 * @returns {SkillEvolutionResult}
 */
function recommend({ careerResult, streamResult, cognitiveResult, marketDemand = [] }) {
  const topCareer         = careerResult?.top_careers?.[0]?.career ?? 'Software Engineer';
  const recommendedStream = streamResult?.recommended_stream ?? 'engineering';
  const cogScores         = cognitiveResult?.scores ?? {};
  const strengths         = cognitiveResult?.strengths ?? [];

  // ── Build demand map from LMI ───────────────────────────────────────────
  const demandMap = {};
  for (const s of marketDemand) {
    demandMap[s.skill_name] = {
      demand_score: s.demand_score ?? 70,
      growth_rate:  s.growth_rate  ?? 0.10,
    };
  }

  // ── Select skill set for the student's top career ───────────────────────
  const careerEntry    = CAREER_SKILL_MATRIX[topCareer];
  const rawSkills      = careerEntry
    ? careerEntry.skills
    : (STREAM_SKILLS_FALLBACK[recommendedStream] ?? STREAM_SKILLS_FALLBACK.engineering);

  // ── Score each skill ─────────────────────────────────────────────────────
  const scored = rawSkills.map(skill => {
    const lmi = demandMap[skill.name] ?? { demand_score: 70, growth_rate: 0.10 };

    // Graph path strength: 0.8 base + boost for skills directly tied to #1 career
    const graphPathStrength = careerEntry ? 0.90 : 0.75;

    // Cognitive boost: +0–8 points for alignment with student strengths
    let cogBoost = 0;
    for (const [dim, skillList] of Object.entries(COGNITIVE_SKILL_AFFINITY)) {
      if (skillList.includes(skill.name)) {
        const dimScore = cogScores[`${dim}_score`] ?? 50;
        cogBoost += (dimScore / 100) * 4; // up to 4 points per dimension
      }
    }
    // Strengths bonus: +3 if the skill appears in the student's cognitive strengths
    const strengthBonus = strengths.some(s =>
      COGNITIVE_SKILL_AFFINITY[s.toLowerCase()]?.includes(skill.name)
    ) ? 3 : 0;

    // Raw impact = demand × relevance × graphPath, scaled 0–100
    const rawImpact = (lmi.demand_score / 100) * skill.relevance * graphPathStrength * 100;

    // Apply ordering factor (foundational skills get a small rank boost)
    const orderedImpact = rawImpact * _orderFactor(skill.order);

    // Add cognitive alignment boost
    const finalImpact = Math.min(100, Math.round(orderedImpact + cogBoost + strengthBonus));

    return {
      skill:            skill.name,
      impact:           finalImpact,
      demand_score:     lmi.demand_score,
      career_relevance: skill.relevance,
      growth_rate:      lmi.growth_rate,
      learning_order:   skill.order,
      rationale:        skill.rationale,
    };
  });

  // ── Deduplicate (keep highest impact per skill name) ────────────────────
  const seen    = new Set();
  const unique  = [];
  for (const s of scored.sort((a, b) => b.impact - a.impact)) {
    if (!seen.has(s.skill)) {
      seen.add(s.skill);
      unique.push(s);
    }
  }

  // ── Build learning roadmap (sorted by learning_order then impact) ────────
  const roadmapSorted = [...unique].sort((a, b) => {
    const orderDiff = a.learning_order - b.learning_order;
    return orderDiff !== 0 ? orderDiff : b.impact - a.impact;
  });

  const roadmap = roadmapSorted.slice(0, 5).map((s, i) => ({
    step:      i + 1,
    skill:     s.skill,
    impact:    s.impact,
    rationale: s.rationale,
  }));

  return {
    top_career:         topCareer,
    recommended_stream: recommendedStream,
    skills:             unique.slice(0, 8), // top 8 by impact
    roadmap,
    engine_version:     ENGINE_VERSION,
  };
}

module.exports = { recommend };









