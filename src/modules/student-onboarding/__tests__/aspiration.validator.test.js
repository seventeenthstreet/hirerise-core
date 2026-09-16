'use strict';

/**
 * modules/student-onboarding/__tests__/aspiration.validator.test.js
 *
 * Pure function tests — no mocking required.
 */

const {
  AspirationValidationError,
  validateSaveAspiration,
  validateSaveAspirationMiddleware,
} = require('../validators/aspiration.validator');

describe('aspiration.validator', () => {
  describe('validateSaveAspiration', () => {
    it('accepts a valid full payload', () => {
      const result = validateSaveAspiration({
        careerInterests: ['engineering', 'science'],
        motivationDriver: 'impact',
        timeHorizon: 'medium',
      });

      expect(result).toEqual({
        careerInterests: ['engineering', 'science'],
        motivationDriver: 'impact',
        timeHorizon: 'medium',
      });
    });

    it('accepts a valid payload with motivationDriver and timeHorizon null (optional fields)', () => {
      const result = validateSaveAspiration({
        careerInterests: ['medicine'],
        motivationDriver: null,
        timeHorizon: null,
      });

      expect(result).toEqual({
        careerInterests: ['medicine'],
        motivationDriver: null,
        timeHorizon: null,
      });
    });

    it('rejects a missing/empty careerInterests array', () => {
      expect(() =>
        validateSaveAspiration({ careerInterests: [], motivationDriver: null, timeHorizon: null }),
      ).toThrow(AspirationValidationError);
    });

    it('rejects careerInterests that is not an array', () => {
      expect(() =>
        validateSaveAspiration({ careerInterests: 'medicine', motivationDriver: null, timeHorizon: null }),
      ).toThrow(AspirationValidationError);
    });

    it('rejects an invalid career interest value', () => {
      expect(() =>
        validateSaveAspiration({
          careerInterests: ['medicine', 'astronaut'],
          motivationDriver: null,
          timeHorizon: null,
        }),
      ).toThrow(/invalid value/);
    });

    it('rejects duplicate career interest values', () => {
      expect(() =>
        validateSaveAspiration({
          careerInterests: ['medicine', 'medicine'],
          motivationDriver: null,
          timeHorizon: null,
        }),
      ).toThrow(/duplicate value/);
    });

    it("rejects 'undecided' combined with other domains", () => {
      expect(() =>
        validateSaveAspiration({
          careerInterests: ['undecided', 'medicine'],
          motivationDriver: null,
          timeHorizon: null,
        }),
      ).toThrow(/cannot combine 'undecided'/);
    });

    it("accepts 'undecided' alone", () => {
      const result = validateSaveAspiration({
        careerInterests: ['undecided'],
        motivationDriver: null,
        timeHorizon: null,
      });
      expect(result.careerInterests).toEqual(['undecided']);
    });

    it('rejects an invalid motivationDriver value', () => {
      expect(() =>
        validateSaveAspiration({
          careerInterests: ['medicine'],
          motivationDriver: 'because I said so',
          timeHorizon: null,
        }),
      ).toThrow(/motivationDriver must be one of/);
    });

    it('rejects an invalid timeHorizon value', () => {
      expect(() =>
        validateSaveAspiration({
          careerInterests: ['medicine'],
          motivationDriver: null,
          timeHorizon: 'yesterday',
        }),
      ).toThrow(/timeHorizon must be one of/);
    });

    it('rejects a malformed (non-object) payload', () => {
      expect(() => validateSaveAspiration(null)).toThrow(AspirationValidationError);
      expect(() => validateSaveAspiration('nope')).toThrow(AspirationValidationError);
      expect(() => validateSaveAspiration([])).toThrow(AspirationValidationError);
    });

    it('deduplicates and normalizes careerInterests order deterministically', () => {
      const result = validateSaveAspiration({
        careerInterests: ['science', 'medicine'],
        motivationDriver: null,
        timeHorizon: null,
      });
      // Order is preserved as first-seen (Set insertion order) — assert the
      // exact contract rather than an unordered comparison, since the
      // repository upserts this array verbatim.
      expect(result.careerInterests).toEqual(['science', 'medicine']);
    });
  });

  describe('validateSaveAspirationMiddleware', () => {
    function mockRes() {
      const res = {};
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);
      return res;
    }

    it('sets req.validatedAspiration and calls next() on valid input', () => {
      const req = { body: { careerInterests: ['medicine'], motivationDriver: null, timeHorizon: null } };
      const res = mockRes();
      const next = jest.fn();

      validateSaveAspirationMiddleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedAspiration).toEqual({
        careerInterests: ['medicine'],
        motivationDriver: null,
        timeHorizon: null,
      });
      expect(res.status).not.toHaveBeenCalled();
    });

    it('responds 400 with a field-scoped error on invalid input, without calling next()', () => {
      const req = { body: { careerInterests: [] } };
      const res = mockRes();
      const next = jest.fn();

      validateSaveAspirationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        ok: false,
        error: expect.objectContaining({ field: 'careerInterests' }),
      });
      expect(next).not.toHaveBeenCalled();
    });
  });
});
