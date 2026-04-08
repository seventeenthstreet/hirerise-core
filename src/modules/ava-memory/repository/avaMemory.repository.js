async function incrementSkillsAdded(userId, delta = 1) {
  const { data, error } = await supabase.rpc('increment_ava_memory_skills', {
    p_user_id: userId,
    p_delta: delta,
  });

  if (error) {
    handleError('incrementSkillsAdded', error, {
      userId,
      delta,
      rpc: 'increment_ava_memory_skills',
    });
  }

  return data;
}

async function incrementJobsApplied(userId, delta = 1) {
  const { data, error } = await supabase.rpc('increment_ava_memory_jobs', {
    p_user_id: userId,
    p_delta: delta,
  });

  if (error) {
    handleError('incrementJobsApplied', error, {
      userId,
      delta,
      rpc: 'increment_ava_memory_jobs',
    });
  }

  return data;
}