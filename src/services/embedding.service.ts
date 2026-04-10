import 'dotenv/config';

/**
 * @file src/services/embedding.service.ts
 * @description
 * Deterministic mock embedding service.
 *
 * Production-hardened:
 * - strict TypeScript safe
 * - centralized schema constants
 * - concurrency-safe upserts
 * - normalized skill caching
 * - batch-safe processing
 * - cleaner observability
 */

import { getSupabaseClient } from '../config/supabaseClient';

const supabase = getSupabaseClient();

const TABLES = Object.freeze({
  SKILL_EMBEDDINGS: 'skill_embeddings',
  CAREER_OPPORTUNITY_SIGNALS: 'career_opportunity_signals',
});

const VECTOR_DIMENSION = 384;
const DEFAULT_BATCH_SIZE = 10;
const BATCH_DELAY_MS = 100;

type SkillEmbeddingRow = {
  skill_name: string;
  embedding: number[] | null;
};

type OpportunitySignalRow = {
  required_skills: string[] | null;
};

const localCache = new Map<string, number[]>();

function normalizeSkill(skill: string): string {
  return String(skill || '').trim().toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMockEmbedding(text: string): number[] | null {
  const normalized = normalizeSkill(text);

  if (!normalized) {
    return null;
  }

  const hash = [...normalized].reduce(
    (acc, char) => acc + char.charCodeAt(0),
    0
  );

  return Array.from(
    { length: VECTOR_DIMENSION },
    (_, i) => (Math.sin(hash + i) + 1) / 2
  );
}

/**
 * Ensure a single skill embedding exists.
 */
export async function ensureSkillEmbedding(
  skill: string
): Promise<number[] | null> {
  const normalized = normalizeSkill(skill);

  if (!normalized) {
    return null;
  }

  const cached = localCache.get(normalized);
  if (cached) {
    return cached;
  }

  try {
    const { data, error } = await supabase
      .from(TABLES.SKILL_EMBEDDINGS)
      .select('embedding')
      .eq('skill_name', normalized)
      .maybeSingle<Pick<SkillEmbeddingRow, 'embedding'>>();

    if (error) {
      throw error;
    }

    if (data?.embedding) {
      localCache.set(normalized, data.embedding);
      return data.embedding;
    }

    const embedding = createMockEmbedding(normalized);

    if (!embedding) {
      return null;
    }

    const { error: upsertError } = await supabase
      .from(TABLES.SKILL_EMBEDDINGS)
      .upsert(
        {
          skill_name: normalized,
          embedding,
        },
        {
          onConflict: 'skill_name',
        }
      );

    if (upsertError) {
      throw upsertError;
    }

    localCache.set(normalized, embedding);
    return embedding;
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : 'Unknown embedding error';

    console.error('[EmbeddingService] ensureSkillEmbedding failed', {
      skill_name: normalized,
      error: message,
    });

    return null;
  }
}

/**
 * Ensure multiple embeddings exist in efficient batches.
 */
export async function ensureSkillEmbeddingsBatch(
  skills: string[] = []
): Promise<string[]> {
  if (!Array.isArray(skills) || skills.length === 0) {
    return [];
  }

  const uniqueSkills = [
    ...new Set(skills.map(normalizeSkill).filter(Boolean)),
  ];

  if (!uniqueSkills.length) {
    return [];
  }

  const { data, error } = await supabase
    .from(TABLES.SKILL_EMBEDDINGS)
    .select('skill_name, embedding')
    .in('skill_name', uniqueSkills);

  if (error) {
    console.error('[EmbeddingService] batch prefetch failed', {
      error: error.message,
    });
    return [];
  }

  const existingRows = (data ?? []) as SkillEmbeddingRow[];
  const existingSet = new Set<string>();

  for (const row of existingRows) {
    existingSet.add(row.skill_name);

    if (row.embedding) {
      localCache.set(row.skill_name, row.embedding);
    }
  }

  const missing = uniqueSkills.filter(
    (skill) => !existingSet.has(skill)
  );

  if (!missing.length) {
    return uniqueSkills;
  }

  console.info('[EmbeddingService] missing skills', {
    count: missing.length,
  });

  for (let i = 0; i < missing.length; i += DEFAULT_BATCH_SIZE) {
    const chunk = missing.slice(i, i + DEFAULT_BATCH_SIZE);

    await Promise.all(
      chunk.map((skill) => ensureSkillEmbedding(skill))
    );

    if (i + DEFAULT_BATCH_SIZE < missing.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return uniqueSkills;
}

/**
 * Backfill embeddings from opportunity signal skill arrays.
 */
export async function backfillAllSkillEmbeddings(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from(TABLES.CAREER_OPPORTUNITY_SIGNALS)
      .select('required_skills');

    if (error) {
      throw error;
    }

    const rows = (data ?? []) as OpportunitySignalRow[];

    if (!rows.length) {
      console.warn('[EmbeddingService] No skills found');
      return;
    }

    const allSkills: string[] = [];

    for (const row of rows) {
      if (Array.isArray(row.required_skills)) {
        allSkills.push(...row.required_skills);
      }
    }

    if (!allSkills.length) {
      console.warn(
        '[EmbeddingService] No valid required_skills arrays'
      );
      return;
    }

    await ensureSkillEmbeddingsBatch(allSkills);

    console.info('[EmbeddingService] backfill completed', {
      total_skills: allSkills.length,
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : 'Unknown backfill error';

    console.error('[EmbeddingService] backfill failed', {
      error: message,
    });
  }
}