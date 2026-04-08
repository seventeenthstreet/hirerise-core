/**
 * Resume Score Engine — v1.1
 * Production-ready, Firebase-free, deterministic scoring engine
 */

const WEIGHTS = Object.freeze({
  completeness: 0.25,
  skills: 0.30,
  experience: 0.25,
  education: 0.10,
  formatting: 0.10,
});

const REQUIRED_SECTIONS = Object.freeze([
  'experience',
  'skills',
  'contact',
]);

const OPTIONAL_SECTIONS = Object.freeze([
  'education',
  'summary',
  'certifications',
  'projects',
]);

const SENIOR_SIGNALS = new Set([
  'led',
  'managed',
  'architected',
  'founded',
  'director',
  'principal',
  'staff',
  'vp',
  'head of',
  'senior',
  'lead',
]);

const HIGH_VALUE_SKILLS = new Set([
  'python',
  'typescript',
  'kubernetes',
  'terraform',
  'react',
  'node.js',
  'aws',
  'gcp',
  'azure',
  'machine learning',
  'system design',
  'sql',
  'docker',
  'graphql',
  'rust',
  'go',
]);

export class ResumeScoreEngineV1 {
  get version() {
    return 'resume_score_v1.1';
  }

  score(parsed = {}) {
    const safeParsed = this.#normalizeParsed(parsed);

    const breakdown = {
      completeness: this.#scoreCompleteness(safeParsed),
      skills: this.#scoreSkills(safeParsed),
      experience: this.#scoreExperience(safeParsed),
      education: this.#scoreEducation(safeParsed),
      formatting: this.#scoreFormatting(safeParsed),
    };

    const overallScore = Math.round(
      Object.entries(breakdown).reduce(
        (sum, [dimension, score]) =>
          sum + score * (WEIGHTS[dimension] ?? 0),
        0
      )
    );

    return {
      overallScore,
      tier: this.#mapTier(overallScore),
      breakdown,
      extractedSkills: [...safeParsed.skills],
      recommendations: this.#generateRecommendations(
        breakdown,
        safeParsed
      ),
      rawData: {
        weightMap: WEIGHTS,
        version: this.version,
      },
    };
  }

  #normalizeParsed(parsed) {
    return {
      ...parsed,
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      sections:
        parsed.sections && typeof parsed.sections === 'object'
          ? parsed.sections
          : {},
      metadata:
        parsed.metadata && typeof parsed.metadata === 'object'
          ? parsed.metadata
          : {},
    };
  }

  #scoreCompleteness(parsed) {
    const { sections } = parsed;

    const requiredScore =
      REQUIRED_SECTIONS.filter(
        (section) => (sections[section] ?? []).length > 0
      ).length / REQUIRED_SECTIONS.length;

    const optionalScore =
      OPTIONAL_SECTIONS.filter(
        (section) => (sections[section] ?? []).length > 0
      ).length / OPTIONAL_SECTIONS.length;

    return Math.round((requiredScore * 0.8 + optionalScore * 0.2) * 100);
  }

  #scoreSkills(parsed) {
    const { skills } = parsed;
    if (skills.length === 0) return 0;

    const normalized = skills
      .filter(Boolean)
      .map((skill) => String(skill).toLowerCase().trim());

    const uniqueSkills = new Set(normalized);
    const highValueCount = normalized.filter((skill) =>
      HIGH_VALUE_SKILLS.has(skill)
    ).length;

    const countScore = Math.min(uniqueSkills.size / 20, 1);
    const qualityScore = Math.min(highValueCount / 5, 1);

    return Math.round((countScore * 0.4 + qualityScore * 0.6) * 100);
  }

  #scoreExperience(parsed) {
    const experiences = parsed.sections.experience ?? [];
    if (experiences.length === 0) return 10;

    const totalYears =
      Number(parsed.metadata.totalYearsExperience) ||
      experiences.length * 1.5;

    const yearsScore = Math.min(totalYears / 10, 1);

    const seniorityScore = experiences.some((experience) => {
      const title = String(experience?.title ?? '')
        .toLowerCase()
        .trim();

      return [...SENIOR_SIGNALS].some((signal) =>
        title.includes(signal)
      );
    })
      ? 1
      : 0.5;

    const diversityScore = Math.min(experiences.length / 4, 1);

    return Math.round(
      (yearsScore * 0.5 +
        seniorityScore * 0.3 +
        diversityScore * 0.2) *
        100
    );
  }

  #scoreEducation(parsed) {
    const education = parsed.sections.education ?? [];
    if (education.length === 0) return 30;

    const degreePoints = {
      phd: 100,
      masters: 85,
      bachelors: 70,
      associates: 50,
      other: 40,
    };

    let highest = 0;

    for (const item of education) {
      const level = String(item?.degree ?? '')
        .toLowerCase()
        .trim();

      for (const [degree, points] of Object.entries(degreePoints)) {
        if (level.includes(degree)) {
          highest = Math.max(highest, points);
        }
      }
    }

    return highest || degreePoints.other;
  }

  #scoreFormatting(parsed) {
    const wordCount = Number(parsed.metadata.wordCount) || 0;

    const lengthScore =
      wordCount >= 300 && wordCount <= 1200
        ? 100
        : wordCount < 300
        ? 40
        : 70;

    const structureScore =
      Object.keys(parsed.sections).length >= 4 ? 100 : 60;

    return Math.round(lengthScore * 0.6 + structureScore * 0.4);
  }

  #mapTier(score) {
    if (score >= 85) return 'elite';
    if (score >= 70) return 'strong';
    if (score >= 50) return 'developing';
    return 'needs_work';
  }

  #generateRecommendations(breakdown, parsed) {
    const recommendations = [];

    if (breakdown.completeness < 60) {
      recommendations.push({
        priority: 'high',
        dimension: 'completeness',
        message: 'Add summary and contact information',
      });
    }

    if (breakdown.skills < 60) {
      recommendations.push({
        priority: 'high',
        dimension: 'skills',
        message: 'Add in-demand technical skills',
      });
    }

    if (breakdown.experience < 60) {
      recommendations.push({
        priority: 'medium',
        dimension: 'experience',
        message: 'Quantify achievements with numbers',
      });
    }

    if (
      breakdown.education < 50 &&
      (parsed.sections.education ?? []).length === 0
    ) {
      recommendations.push({
        priority: 'low',
        dimension: 'education',
        message: 'Add certifications or courses',
      });
    }

    if (breakdown.formatting < 60) {
      recommendations.push({
        priority: 'medium',
        dimension: 'formatting',
        message: 'Keep resume between 400–800 words',
      });
    }

    return recommendations;
  }
}