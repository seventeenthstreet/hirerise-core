'use strict';

/**
 * G5 (Phase 1) — Classes 8–10 Science Academic Correctness.
 *
 * Backend-side coverage: the authoritative ACADEMIC_SUBJECTS list (which
 * must mirror academic_subject_enum in SQL — see constants/academics.js
 * header) accepts 'science', and the validator that gates POST
 * /academics accepts a 'science' subject entry without cross-checking
 * against a year-specific list (confirmed there is no such cross-check
 * server-side; SUBJECTS_BY_YEAR is a frontend-only picker constraint).
 */

const { ACADEMIC_SUBJECTS } = require('../constants/academics');
const { validateAcademicsPayload } = require('../validators/academics.validator');

describe('G5 — science academic subject (backend)', () => {
  it('ACADEMIC_SUBJECTS includes "science"', () => {
    expect(ACADEMIC_SUBJECTS).toContain('science');
  });

  it('still includes physics/chemistry/biology for legacy rows and XI–XII streams', () => {
    expect(ACADEMIC_SUBJECTS).toEqual(
      expect.arrayContaining(['physics', 'chemistry', 'biology']),
    );
  });

  it('validateAcademicsPayload accepts a class_8 payload with a single "science" subject', () => {
    expect(() =>
      validateAcademicsPayload({
        years: {
          class_8: {
            board_type: 'cbse',
            is_predicted: false,
            subjects: [
              { subject: 'mathematics', marks_obtained: 88, max_marks: 100, grade: 'A' },
              { subject: 'science', marks_obtained: 91, max_marks: 100, grade: 'A_plus' },
            ],
          },
        },
        is_partial: false,
      }),
    ).not.toThrow();
  });

  it('validateAcademicsPayload still accepts a class_11 payload with separate physics/chemistry/biology (unchanged)', () => {
    expect(() =>
      validateAcademicsPayload({
        years: {
          class_11: {
            board_type: 'cbse',
            is_predicted: false,
            subjects: [
              { subject: 'physics', marks_obtained: 80, max_marks: 100, grade: 'A' },
              { subject: 'chemistry', marks_obtained: 82, max_marks: 100, grade: 'A' },
              { subject: 'biology', marks_obtained: 85, max_marks: 100, grade: 'A' },
            ],
          },
        },
        is_partial: true,
      }),
    ).not.toThrow();
  });
});
