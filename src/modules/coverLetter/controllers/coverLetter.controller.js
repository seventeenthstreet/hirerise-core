'use strict';

/**
 * coverLetter.controller.js
 *
 * Production-grade thin HTTP controller for cover letter generation.
 *
 * Responsibilities:
 * - Extract authenticated user identity from Supabase auth middleware
 * - Read validated request payload
 * - Delegate all business logic to service layer
 * - Return stable API response shape
 * - Forward errors to centralized Express error middleware
 *
 * Business logic intentionally remains inside:
 *   ../coverLetter.service
 */

const { generateCoverLetterForUser } = require('../coverLetter.service');

/**
 * Resolve authenticated user ID from request.
 *
 * Supabase-first:
 * - req.user.id  -> preferred
 * - req.user.sub -> JWT standard fallback
 *
 * Legacy compatibility:
 * - req.user.uid -> old Firebase middleware compatibility
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function getAuthenticatedUserId(req) {
  const user = req?.user;
  if (!user) return null;

  return user.id ?? user.sub ?? user.uid ?? null;
}

/**
 * Normalize user plan metadata safely.
 *
 * @param {object|null|undefined} user
 * @returns {{ tier: string, planAmount: number|null }}
 */
function getUserPlanMeta(user) {
  return {
    tier: user?.plan ?? 'free',
    planAmount: user?.planAmount ?? null,
  };
}

/**
 * POST /api/v1/cover-letter/generate
 *
 * Request body is assumed validated by upstream Zod middleware.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function generate(req, res, next) {
  try {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    const {
      companyName,
      jobTitle,
      jobDescription,
      tone,
    } = req.body;

    const { tier, planAmount } = getUserPlanMeta(req.user);

    const result = await generateCoverLetterForUser({
      userId,
      tier,
      planAmount,
      companyName,
      jobTitle,
      jobDescription,
      tone,
    });

    return res.status(200).json({
      success: true,
      data: {
        coverLetter: result.content,
        coverLetterId: result.coverLetterId,
        creditsRemaining: result.creditsRemaining,
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  generate,
};