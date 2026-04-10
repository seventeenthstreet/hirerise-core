// ============================================================
// src/scripts/backfillEmbeddings.ts
// Production-Ready Supabase Embedding Backfill Script
// Provider: Google Gemini gemini-embedding-001
// Vector Size: 768
// Run: npx tsx src/scripts/backfillEmbeddings.ts
// ============================================================

import 'dotenv/config';
import { getSupabaseClient } from '../config/supabaseClient';

// ============================================================
// CONFIG
// ============================================================

const BATCH_SIZE = 20;
const DELAY_MS = 500;
const MAX_RETRIES = 3;
const EMBEDDING_DIMENSIONS = 768;
const REQUEST_TIMEOUT_MS = 30000;
const FETCH_LIMIT = 5000;

const TABLES = Object.freeze({
  ROLES: 'roles',
});

// ============================================================
// TYPES
// ============================================================

type RoleRow = {
  role_id: string;
  role_name: string;
  normalized_name?: string | null;
  seniority_level?: string | null;
  track?: string | null;
  role_family?: string | null;
  description?: string | null;
  alternative_titles?: string[] | null;
};

type GeminiEmbeddingResponse = {
  embedding?: {
    values?: number[];
  };
};

// ============================================================
// CLIENTS
// ============================================================

const supabase = getSupabaseClient();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error('Missing GEMINI_API_KEY in environment');
}

// ============================================================
// LOGGER
// ============================================================

const log = {
  info: (message: string) =>
    console.log(`[EmbeddingBackfill] ${message}`),
  warn: (message: string) =>
    console.warn(`[EmbeddingBackfill] ${message}`),
  error: (message: string, error?: unknown) =>
    console.error(`[EmbeddingBackfill] ${message}`, error),
};

// ============================================================
// HELPERS
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

function buildEmbeddingText(role: RoleRow): string {
  return [
    `Role: ${role.role_name}`,
    role.normalized_name || null,
    role.seniority_level
      ? `Level: ${role.seniority_level}`
      : null,
    role.track ? `Track: ${role.track}` : null,
    role.role_family
      ? `Family: ${role.role_family}`
      : null,
    role.description || null,
    role.alternative_titles?.join(' ') || null,
  ]
    .filter(Boolean)
    .join(' ');
}

async function embedText(text: string): Promise<number[]> {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'models/gemini-embedding-001',
          content: {
            parts: [{ text }],
          },
          taskType: 'RETRIEVAL_DOCUMENT',
          outputDimensionality:
            EMBEDDING_DIMENSIONS,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      throw new Error(
        `Gemini API error ${response.status}: ${errorText}`
      );
    }

    const data =
      (await response.json()) as GeminiEmbeddingResponse;

    const values = data.embedding?.values;

    if (
      !Array.isArray(values) ||
      values.length !== EMBEDDING_DIMENSIONS
    ) {
      throw new Error(
        `Invalid embedding response shape. Expected ${EMBEDDING_DIMENSIONS} dimensions.`
      );
    }

    return values;
  } finally {
    clearTimeout(timeout);
  }
}

async function embedWithRetry(
  role: RoleRow
): Promise<number[]> {
  const text = buildEmbeddingText(role);

  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      return await embedText(text);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown embedding error';

      log.warn(
        `[${role.role_name}] embedding attempt ${attempt}/${MAX_RETRIES} failed: ${message}`
      );

      if (attempt === MAX_RETRIES) {
        throw error;
      }

      await sleep(1000 * attempt);
    }
  }

  throw new Error(
    `Embedding failed for role ${role.role_name}`
  );
}

async function updateEmbedding(
  roleId: string,
  embedding: number[]
): Promise<void> {
  const { error } = await supabase
    .from(TABLES.ROLES)
    .update({
      embedding,
      embedding_updated_at:
        new Date().toISOString(),
    })
    .eq('role_id', roleId);

  if (error) {
    throw new Error(
      `Supabase update failed for role ${roleId}: ${error.message}`
    );
  }
}

async function processRole(
  role: RoleRow
): Promise<string> {
  const embedding = await embedWithRetry(role);
  await updateEmbedding(role.role_id, embedding);
  return role.role_name;
}

// ============================================================
// MAIN
// ============================================================

async function backfillEmbeddings(): Promise<void> {
  log.info('Fetching roles without embeddings...');

  const { data, error } = await supabase
    .from(TABLES.ROLES)
    .select(`
      role_id,
      role_name,
      normalized_name,
      description,
      seniority_level,
      track,
      role_family,
      alternative_titles
    `)
    .is('embedding', null)
    .eq('soft_deleted', false)
    .limit(FETCH_LIMIT);

  if (error) {
    throw new Error(
      `Supabase fetch failed: ${error.message}`
    );
  }

  const roles = (data ?? []) as RoleRow[];

  if (roles.length === 0) {
    log.info('No roles require embedding backfill.');
    return;
  }

  log.info(
    `Starting backfill for ${roles.length} roles...`
  );

  let successCount = 0;
  const batches = chunkArray(roles, BATCH_SIZE);

  for (
    let batchIndex = 0;
    batchIndex < batches.length;
    batchIndex++
  ) {
    const batch = batches[batchIndex];

    const results = await Promise.allSettled(
      batch.map(processRole)
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        successCount++;

        log.info(
          `Backfilled ${successCount}/${roles.length} — ${result.value}`
        );
      } else {
        log.error(
          'Role backfill failed',
          result.reason
        );
        throw result.reason;
      }
    }

    if (batchIndex < batches.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  log.info(
    `Backfill complete. Roles updated: ${successCount}`
  );
}

// ============================================================
// RUNNER
// ============================================================

void backfillEmbeddings()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    log.error('Backfill failed', error);
    process.exit(1);
  });