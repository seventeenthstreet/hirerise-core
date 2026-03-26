'use strict';

/**
 * coverLetter.controller.js
 *
 * Thin controller — no business logic.
 * Receives validated req.body, calls service, formats response.
 *
 * PATTERN: mirrors careerHealthIndex.controller.js
 *   - _safeUserId() helper
 *   - try/catch → next(err)
 *   - No direct Firestore access
 *   - No credit logic
 */

const { generateCoverLetterForUser } = require('../coverLetter.service');

function _safeUserId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

/**
 * POST /api/v1/cover-letter/generate
 */
async function generate(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // req.body already validated + typed by Zod middleware
    const { companyName, jobTitle, jobDescription, tone } = req.body;

    const result = await generateCoverLetterForUser({
      userId,
      tier:       req.user.plan     ?? 'free',
      planAmount: req.user.planAmount ?? null,
      companyName,
      jobTitle,
      jobDescription,
      tone,
    });

    return res.status(200).json({
      success: true,
      data: {
        coverLetter:      result.content,
        coverLetterId:    result.coverLetterId,
        creditsRemaining: result.creditsRemaining,
      },
    });

  } catch (err) {
    return next(err);
  }
}

module.exports = { generate };








