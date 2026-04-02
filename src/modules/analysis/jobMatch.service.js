const VALID_OPERATIONS = new Set([
  'jobMatchAnalysis',
  'jobSpecificCV',
]);

async function runJobMatch({ userId, resumeId, operationType, tier }) {
  if (!VALID_OPERATIONS.has(operationType)) {
    throw new AppError(
      'Invalid operationType',
      400,
      { operationType },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const { costs, defaultCost } =
    await creditConfigService.getCreditConfig();

  const [resume, user, context] = await Promise.all([
    fetchResume(userId, resumeId),
    getUserCredits(userId),
    fetchCareerContext(userId),
  ]);

  let result;
  let creditsRemaining = user.ai_credits_remaining;

  if (tier === 'free') {
    result = runFreeEngine({
      resumeId,
      resumeText: resume.resume_text,
      fileName: resume.file_name,
    });
  } else {
    const cost = costs[operationType] ?? defaultCost ?? 2;

    if (creditsRemaining < cost) {
      throw new AppError(
        'Insufficient credits',
        402,
        { required: cost, available: creditsRemaining },
        ErrorCodes.PAYMENT_REQUIRED
      );
    }

    const { error: deductError } = await supabase.rpc(
      'deduct_credits',
      {
        user_id: userId,
        amount: cost,
      }
    );

    if (deductError) {
      throw new AppError(
        'Credit deduction failed',
        500,
        {},
        ErrorCodes.INTERNAL_ERROR
      );
    }

    creditsRemaining -= cost;

    try {
      result = await runFullAnalysis({
        userId,
        userTier: tier,
        resumeId,
        resumeText: resume.resume_text,
        fileName: resume.file_name,
        weightedCareerContext: context,
      });
    } catch (engineErr) {
      await supabase.rpc('refund_credits', {
        user_id: userId,
        amount: cost,
      });
      throw engineErr;
    }
  }

  await saveJobMatchResult(userId, resumeId, operationType, result);

  return {
    ...result,
    creditsRemaining,
  };
}