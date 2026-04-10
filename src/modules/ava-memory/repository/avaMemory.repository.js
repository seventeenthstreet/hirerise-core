async function runSafeIncrementRpc(rpcName, methodName, userId, delta = 1) {
  const normalizedUserId = String(userId || '').trim();

  if (!normalizedUserId) {
    throw new Error(`${methodName}: userId is required`);
  }

  const safeDelta = Number.isInteger(delta)
    ? Math.max(delta, 1)
    : 1;

  const { data, error } = await supabase.rpc(rpcName, {
    p_user_id: normalizedUserId,
    p_delta: safeDelta,
  });

  if (error) {
    handleError(methodName, error, {
      rpc: rpcName,
      delta: safeDelta,
    });

    throw error;
  }

  return data;
}

async function incrementSkillsAdded(userId, delta = 1) {
  return runSafeIncrementRpc(
    'increment_ava_memory_skills',
    'incrementSkillsAdded',
    userId,
    delta
  );
}

async function incrementJobsApplied(userId, delta = 1) {
  return runSafeIncrementRpc(
    'increment_ava_memory_jobs',
    'incrementJobsApplied',
    userId,
    delta
  );
}