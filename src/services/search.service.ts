import { getSupabaseClient } from '../config/supabaseClient';
import { embedQuery } from './embedding.service';

const supabase = getSupabaseClient();

export async function searchRoles(query: string, agency: string) {
  const queryEmbedding = await embedQuery(query);

  const { data, error } = await supabase.rpc('search_roles_hybrid', {
    p_query: query,
    p_query_embedding: queryEmbedding,
    p_agency: agency,
    p_limit: 20,
  });

  if (error) throw error;

  return data;
}