// ============================================================
// Backfill Embeddings Script (TypeScript - Production Ready)
// Provider: Google Gemini gemini-embedding-001 (FREE tier)
// Dimensions: 768 (vector(768) in Supabase)
// Run: npx tsx src/scripts/backfillEmbeddings.ts
// ============================================================
import 'dotenv/config';
import { getSupabaseClient } from '../config/supabaseClient';

// ============================================================
// CONFIG
// ============================================================
const BATCH_SIZE = 20;   // Gemini free tier: 1500 req/day, 20 is safe per batch
const DELAY_MS   = 500;  // 500ms between batches — stays well under rate limits

// ============================================================
// CLIENTS
// ============================================================
const supabase = getSupabaseClient();
console.log('[Supabase] Client initialized');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY in environment');
console.log('[Gemini] Client initialized');

// ============================================================
// HELPERS
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Build rich text for embedding — same fields as search_vector trigger
function buildEmbeddingText(role: {
  role_name:           string;
  normalized_name?:    string;
  seniority_level?:    string;
  track?:              string;
  role_family?:        string;
  description?:        string;
  alternative_titles?: string[];
}): string {
  return [
    `Role: ${role.role_name}`,
    role.normalized_name,
    role.seniority_level ? `Level: ${role.seniority_level}` : null,
    role.track           ? `Track: ${role.track}`           : null,
    role.role_family     ? `Family: ${role.role_family}`    : null,
    role.description,
    (role.alternative_titles ?? []).join(' '),
  ]
    .filter(Boolean)
    .join(' ');
}

// Embed a single text via native fetch — truncated to 768 dims
async function embedText(text: string): Promise<number[]> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: 768,  // truncate to 768 to match vector(768) column
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return data.embedding.values;
}

// ============================================================
// MAIN
// ============================================================
async function backfillEmbeddings(): Promise<void> {
  console.log('🔍 Fetching roles without embeddings...');

  const { data: roles, error } = await supabase
    .from('roles')
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
    .limit(5000);

  if (error) throw error;

  if (!roles || roles.length === 0) {
    console.log('✅ No roles need backfilling.');
    return;
  }

  console.log(`🚀 Backfilling ${roles.length} roles in batches of ${BATCH_SIZE}...\n`);

  let successCount = 0;

  for (let i = 0; i < roles.length; i += BATCH_SIZE) {
    const batch = roles.slice(i, i + BATCH_SIZE);

    for (const role of batch) {
      const text = buildEmbeddingText(role);
      let embedding: number[] | null = null;

      // Retry up to 3 times per role
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          embedding = await embedText(text);
          break;
        } catch (err: any) {
          console.warn(`  ⚠️  [${role.role_name}] Attempt ${attempt} failed: ${err?.message}`);
          if (attempt === 3) throw err;
          await sleep(1000 * attempt);
        }
      }

      if (!embedding) throw new Error(`Failed to embed role: ${role.role_name}`);

      // Use update (not upsert) to only touch embedding columns
      const { error: err } = await supabase
        .from('roles')
        .update({
          embedding:            embedding,
          embedding_updated_at: new Date().toISOString(),
        })
        .eq('role_id', role.role_id);

      if (err) throw err;

      successCount++;
      console.log(`✅ Backfilled ${successCount} / ${roles.length} — ${role.role_name}`);
    }

    // Delay between batches to respect rate limits
    if (i + BATCH_SIZE < roles.length) {
      await sleep(DELAY_MS);
    }
  }

  console.log('\n🎉 Backfill complete!');
  console.log(`   Model:      gemini-embedding-001`);
  console.log(`   Dimensions: 768`);
  console.log(`   Roles:      ${successCount}`);
}

// ============================================================
// RUN
// ============================================================
backfillEmbeddings().catch((err) => {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
});