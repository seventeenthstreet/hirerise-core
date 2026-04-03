'use strict';

/**
 * src/modules/onboarding/onboarding.linkedin.service.js
 * Production-safe LinkedIn import sub-service
 */

const { supabase } = require('../../config/supabase');
const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const {
  mergeStepHistory,
  persistCompletionIfReady,
  triggerProvisionalChi,
} = require('./onboarding.helpers');

const TABLE_PROGRESS = 'onboarding_progress';
const TABLE_PROFILES = 'user_profiles';

function nowISO() {
  return new Date().toISOString();
}

async function safeUpsert(table, payload) {
  const { error } = await supabase
    .from(table)
    .upsert(payload, { onConflict: 'id' });

  if (error) {
    logger.error('[LinkedInService] upsert failed', {
      table,
      error: error.message,
    });
    throw error;
  }
}

async function safeRead(table, userId, columns = '*') {
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data || {};
}

function toYYYYMM(raw) {
  if (!raw) return null;

  if (typeof raw === 'object' && raw.year) {
    const m = String(raw.month || 1).padStart(2, '0');
    return `${raw.year}-${m}`;
  }

  const match = String(raw).match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function estimateExperienceYears(experience = []) {
  let months = 0;

  for (const item of experience) {
    const start = item?.startDate;
    const end = item?.isCurrent
      ? new Date().toISOString().slice(0, 7)
      : item?.endDate;

    if (!start) continue;

    const [sy, sm] = start.split('-').map(Number);
    const [ey, em] = (end || start).split('-').map(Number);

    months += Math.max(
      0,
      (ey - sy) * 12 + (em - sm)
    );
  }

  return Math.round((months / 12) * 10) / 10;
}

async function importLinkedIn(userId, linkedInPayload) {
  if (!userId) {
    throw new AppError(
      'userId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (!linkedInPayload || typeof linkedInPayload !== 'object') {
    throw new AppError(
      'LinkedIn profile payload must be a JSON object.',
      400
    );
  }

  const rawEducation =
    linkedInPayload.Education ||
    linkedInPayload.education ||
    [];

  const rawPositions =
    linkedInPayload.Positions ||
    linkedInPayload.positions ||
    linkedInPayload.Experience ||
    linkedInPayload.experience ||
    [];

  const rawSkills =
    linkedInPayload.Skills ||
    linkedInPayload.skills ||
    [];

  if (
    !rawEducation.length &&
    !rawPositions.length &&
    !rawSkills.length
  ) {
    throw new AppError(
      'LinkedIn payload missing Education, Positions, or Skills.',
      422
    );
  }

  const mappedEducation = rawEducation
    .map((e, i) => {
      const school =
        e.school_name ||
        e.schoolName ||
        e.school ||
        '';

      if (!school) return null;

      const rawEnd =
        e.end_date ||
        e.endDate ||
        e.timePeriod?.endDate;

      let yearOfGraduation = null;
      if (rawEnd) {
        const parsed = parseInt(
          String(rawEnd?.year || rawEnd).split('-')[0],
          10
        );
        if (!Number.isNaN(parsed)) {
          yearOfGraduation = parsed;
        }
      }

      return {
        qualificationName:
          e.degree_name ||
          e.degreeName ||
          'Degree',
        institution: school,
        yearOfGraduation,
        specialization:
          e.field_of_study ||
          e.fieldOfStudy ||
          null,
        certifications: [],
        _importIndex: i,
      };
    })
    .filter(Boolean);

  const mappedExperience = rawPositions
    .map((p, i) => {
      const company =
        p.company_name ||
        p.companyName ||
        p.company ||
        '';

      const title = p.title || p.jobTitle || '';

      if (!company && !title) return null;

      const isCurrent =
        p.isCurrent ||
        (!p.finished_on &&
          !p.endDate &&
          !p.timePeriod?.endDate);

      const startDate = toYYYYMM(
        p.started_on ||
          p.startDate ||
          p.timePeriod?.startDate
      );

      const endDate = isCurrent
        ? null
        : toYYYYMM(
            p.finished_on ||
              p.endDate ||
              p.timePeriod?.endDate
          );

      const responsibilities = (p.description || '')
        .split(/\n|•|·/)
        .map(x => x.trim())
        .filter(x => x.length >= 10)
        .slice(0, 10);

      return {
        jobTitle: title || 'Role',
        company: company || 'Company',
        experienceType: 'full_time',
        startDate,
        endDate,
        isCurrent,
        responsibilities,
        achievements: [],
        _importIndex: i,
      };
    })
    .filter(Boolean);

  const mappedSkills = rawSkills
    .map(s => {
      const name = (
        typeof s === 'string'
          ? s
          : s.name || s.skill_name || ''
      ).trim();

      return name
        ? {
            name,
            proficiency: 'intermediate',
          }
        : null;
    })
    .filter(Boolean)
    .slice(0, 50);

  const importSummary = {
    educationCount: mappedEducation.length,
    experienceCount: mappedExperience.length,
    skillsCount: mappedSkills.length,
    importedAt: nowISO(),
  };

  await safeUpsert(TABLE_PROGRESS, {
    id: userId,
    imported_profile: {
      education: mappedEducation,
      experience: mappedExperience,
      skills: mappedSkills,
      ...importSummary,
    },
    import_source: 'linkedin',
    last_active_step: 'linkedin_imported',
    last_active_at: nowISO(),
    updated_at: nowISO(),
  });

  logger.info('[LinkedInService] profile imported', {
    userId,
    ...importSummary,
  });

  return {
    userId,
    step: 'linkedin_imported',
    imported: importSummary,
    profile: {
      education: mappedEducation,
      experience: mappedExperience,
      skills: mappedSkills,
    },
  };
}

async function confirmLinkedInImport(userId) {
  if (!userId) {
    throw new AppError('userId is required', 400);
  }

  const [progress, profile] = await Promise.all([
    safeRead(TABLE_PROGRESS, userId),
    safeRead(TABLE_PROFILES, userId),
  ]);

  if (!progress?.imported_profile) {
    throw new AppError(
      'No LinkedIn import found to confirm.',
      422
    );
  }

  const imported = progress.imported_profile;

  const mergedEducation =
    imported.education?.length
      ? imported.education.map(({ _importIndex, ...x }) => x)
      : progress.education || [];

  const mergedExperience =
    imported.experience?.length
      ? imported.experience.map(({ _importIndex, ...x }) => x)
      : progress.experience || [];

  const mergedSkills =
    imported.skills?.length
      ? imported.skills
      : profile.skills || [];

  const now = nowISO();
  const stepHistory = await mergeStepHistory(
    userId,
    'linkedin_confirmed'
  );

  await Promise.all([
    safeUpsert(TABLE_PROGRESS, {
      id: userId,
      education: mergedEducation,
      experience: mergedExperience,
      import_source: 'linkedin',
      import_confirmed_at: now,
      step: 'linkedin_confirmed',
      quick_start_completed: true,
      last_active_step: 'linkedin_confirmed',
      last_active_at: now,
      step_history: stepHistory,
      updated_at: now,
    }),

    safeUpsert(TABLE_PROFILES, {
      id: userId,
      skills: mergedSkills,
      total_experience_years:
        estimateExperienceYears(mergedExperience),
      updated_at: now,
    }),
  ]);

  const [updatedProgress, updatedProfile] =
    await Promise.all([
      safeRead(TABLE_PROGRESS, userId),
      safeRead(TABLE_PROFILES, userId),
    ]);

  await persistCompletionIfReady(
    userId,
    updatedProgress,
    updatedProfile
  );

  triggerProvisionalChi(
    userId,
    updatedProgress,
    updatedProfile,
    null,
    'free'
  );

  return {
    userId,
    step: 'linkedin_confirmed',
    educationCount: mergedEducation.length,
    experienceCount: mergedExperience.length,
    skillsCount: mergedSkills.length,
    quickStartCompleted: true,
  };
}

module.exports = {
  importLinkedIn,
  confirmLinkedInImport,
};