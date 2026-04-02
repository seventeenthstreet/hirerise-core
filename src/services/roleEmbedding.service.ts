// ============================================================
// Role Embedding Service (TypeScript - Production Ready)
// ============================================================

import OpenAI from 'openai';
import { getSupabaseClient } from '../config/supabaseClient';

// 🔹 Supabase client (singleton)
const supabase = getSupabaseClient();

// 🔹 Role Insert Type (align with your DB schema)
export interface RoleInsert {
  name: string;
  normalized_name?: string;
  description?: string;
  level?: string;
  track?: string;
  job_family_id?: string;
  alternative_titles?: string[];
  agency: string;
  created_by: string;
}

// 🔹 OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// 🧠 Build embedding text (VERY IMPORTANT for semantic quality)
function buildEmbeddingText(payload: RoleInsert): string {
  return [
    `Role: ${payload.name}`,
    payload.normalized_name,
    payload.level ? `Level: ${payload.level}` : null,
    payload.track ? `Track: ${payload.track}` : null,
    payload.description,
    (payload.alternative_titles ?? []).join(' '),
  ]
    .filter(Boolean)
    .join(' ');
}

// ============================================================
// CREATE ROLE WITH EMBEDDING
// ============================================================
export async function createRoleWithEmbedding(payload: RoleInsert) {
  try {
    const text = buildEmbeddingText(payload);

    // 🔹 Generate embedding
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: [text],
    });

    const embedding = response.data[0].embedding;

    // 🔹 Insert into DB with embedding
    const { data, error } = await supabase
      .from('roles')
      .insert({
        ...payload,
        embedding,
        embedding_updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    return data;
  } catch (err) {
    console.error('⚠️ Embedding failed, fallback insert:', err);

    // 🔁 FAIL-SAFE: Insert without embedding so role is never lost
    const { data, error } = await supabase
      .from('roles')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    return data;
  }
}

// ============================================================
// UPDATE ROLE EMBEDDING (for edits)
// ============================================================
export async function updateRoleEmbedding(
  roleId: string,
  payload: RoleInsert
) {
  try {
    const text = buildEmbeddingText(payload);

    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: [text],
    });

    const embedding = response.data[0].embedding;

    const { data, error } = await supabase
      .from('roles')
      .update({
        embedding,
        embedding_updated_at: new Date().toISOString(),
      })
      .eq('id', roleId)
      .select()
      .single();

    if (error) throw error;

    return data;
  } catch (err) {
    console.error('❌ updateRoleEmbedding failed:', err);
    throw err;
  }
}