// ============================================================
// Role Embedding Service (TypeScript - Final Production Ready)
// Schema-accurate: aligned to public.roles + match_roles RPC
// ============================================================

import OpenAI from 'openai';
import { getSupabaseClient } from '../config/supabaseClient';

const supabase = getSupabaseClient();

// ----------------------------------------------------------------
// Similarity thresholds — tune based on user feedback at scale
// ----------------------------------------------------------------
export const SIMILARITY_THRESHOLDS = {
  STRONG: 0.85, // near-exact semantic match
  GOOD: 0.75,   // strong candidate
  WEAK: 0.65,   // broad match, may include noise
} as const;

const DEFAULT_MIN_SIMILARITY = SIMILARITY_THRESHOLDS.WEAK;
const DEFAULT_MATCH_COUNT = 10;

// ----------------------------------------------------------------
// Interfaces
// ----------------------------------------------------------------

export interface RoleInsert {
  role_name: string;
  normalized_name?: string | null;
  description?: string | null;
  seniority_level?: string | null;
  track?: string | null;
  job_family_id?: string | null;
  alternative_titles?: string[] | null;
  agency: string;
  created_by: string;
}

export interface RoleSearchOptions {
  matchCount?: number;
  minSimilarity?: number;
}

export interface RoleSearchResult {
  role_id: string;
  role_name: string | null;
  normalized_name: string | null;
  seniority_level: string | null;
  track: string | null;
  job_family_id: string | null;
  similarity: number;
}

type RoleRow = {
  role_id: string;
  role_name: string | null;
  normalized_name: string | null;
  embedding_updated_at: string | null;
};

// ----------------------------------------------------------------
// OpenAI client
// ----------------------------------------------------------------

const EMBEDDING_MODEL =
  process.env.ROLE_EMBEDDING_MODEL || 'text-embedding-3-small';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// ----------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------

/**
 * Build semantically rich embedding text from a role payload.
 */
function buildEmbeddingText(payload: RoleInsert): string {
  return [
    `Role: ${payload.role_name}`,
    payload.normalized_name ?? null,
    payload.seniority_level ? `Level: ${payload.seniority_level}` : null,
    payload.track ? `Track: ${payload.track}` : null,
    payload.description ?? null,
    ...(payload.alternative_titles ?? []),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Normalize free-text input before embedding.
 */
function normalizeQueryText(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

/**
 * Clamp similarity threshold to valid cosine range.
 */
function clampSimilarity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MIN_SIMILARITY;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Generate embedding vector from text via OpenAI.
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });

  const embedding = response.data?.[0]?.embedding;

  if (!embedding?.length) {
    throw new Error('Embedding generation returned empty vector');
  }

  return embedding;
}

// ----------------------------------------------------------------
// Public API
// ----------------------------------------------------------------

/**
 * Search for semantically similar roles using cosine similarity.
 *
 * Calls the match_roles RPC backed by the IVFFLAT pgvector index.
 */
export async function searchRoles(
  queryText: string,
  options: RoleSearchOptions = {}
): Promise<RoleSearchResult[]> {
  const matchCount = Number.isFinite(options.matchCount)
    ? Math.max(1, Number(options.matchCount))
    : DEFAULT_MATCH_COUNT;

  const minSimilarity = clampSimilarity(
    options.minSimilarity ?? DEFAULT_MIN_SIMILARITY
  );

  const normalizedQuery = normalizeQueryText(queryText);
  const queryEmbedding = await generateEmbedding(normalizedQuery);

  const { data, error } = await supabase.rpc('match_roles', {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    min_similarity: minSimilarity,
  });

  if (error) {
    throw new Error(`searchRoles failed: ${error.message}`);
  }

  return (data ?? []) as RoleSearchResult[];
}

/**
 * Create role with embedding.
 * Falls back to non-embedding insert ONLY if embedding generation fails.
 */
export async function createRoleWithEmbedding(
  payload: RoleInsert
): Promise<RoleRow> {
  const now = new Date().toISOString();

  let embedding: number[] | null = null;

  try {
    const text = buildEmbeddingText(payload);
    embedding = await generateEmbedding(text);
  } catch (error) {
    console.warn(
      '[role-embedding] Embedding generation failed, continuing without vector:',
      error
    );
  }

  const insertPayload = {
    ...payload,
    ...(embedding
      ? {
          embedding,
          embedding_updated_at: now,
        }
      : {}),
  };

  const { data, error } = await supabase
    .from('roles')
    .insert(insertPayload)
    .select('role_id, role_name, normalized_name, embedding_updated_at')
    .single();

  if (error) {
    throw new Error(`createRoleWithEmbedding failed: ${error.message}`);
  }

  return data as RoleRow;
}

/**
 * Update role fields + regenerate embedding if semantic fields changed.
 */
export async function updateRoleEmbedding(
  roleId: string,
  payload: Partial<RoleInsert>
): Promise<RoleRow> {
  const updatePayload: Record<string, unknown> = {
    ...payload,
  };

  const hasSemanticChanges =
    payload.role_name ||
    payload.normalized_name ||
    payload.description ||
    payload.seniority_level ||
    payload.track ||
    payload.alternative_titles;

  if (hasSemanticChanges) {
    const text = buildEmbeddingText(payload as RoleInsert);
    const embedding = await generateEmbedding(text);

    updatePayload.embedding = embedding;
    updatePayload.embedding_updated_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('roles')
    .update(updatePayload)
    .eq('role_id', roleId)
    .select('role_id, role_name, normalized_name, embedding_updated_at')
    .single();

  if (error) {
    throw new Error(`updateRoleEmbedding failed: ${error.message}`);
  }

  return data as RoleRow;
}