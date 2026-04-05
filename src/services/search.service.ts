import { getSupabaseClient } from '../config/supabaseClient';

type SearchRolesResult = {
  id: string;
  title: string;
  level?: string | null;
  score?: number | null;
  semantic_score?: number | null;
  keyword_score?: number | null;
  [key: string]: unknown;
};

// Raw shape returned inside data.roles[] by the RPC
type RpcRoleRow = {
  role_id: string;
  role_name: string;
  seniority_level?: string | null;
  rank_score?: number | null;
  fts_score?: number | null;
  sim_score?: number | null;
  [key: string]: unknown;
};

// Envelope returned by search_roles_hybrid (RETURNS jsonb)
type RpcEnvelope = {
  success: boolean;
  error?: string;
  code?: string;
  data?: {
    roles: RpcRoleRow[];
    total: number;
    query: string;
    returned: number;
  };
};

const DEFAULT_LIMIT = 20;

/**
 * Hybrid semantic + keyword role search.
 * Calls search_roles_hybrid RPC which returns a jsonb envelope:
 *   { success, data: { roles: [...], total, query, returned } }
 * Remaps raw RPC columns → SearchRolesResult shape.
 */
export async function searchRoles(
  query: string,
  agency: string,
  limit: number = DEFAULT_LIMIT
): Promise<SearchRolesResult[]> {
  const normalizedQuery = query?.trim();
  const normalizedAgency = agency?.trim();

  if (!normalizedQuery) {
    throw new Error('searchRoles: query is required');
  }

  if (!normalizedAgency) {
    throw new Error('searchRoles: agency is required');
  }

  const safeLimit = Number.isFinite(limit)
    ? Math.min(Math.max(limit, 1), 100)
    : DEFAULT_LIMIT;

  const supabase = getSupabaseClient();

  try {
    const { data, error } = await supabase.rpc('search_roles_hybrid', {
      p_query: normalizedQuery,
      p_agency: normalizedAgency,
      p_limit: safeLimit,
    });

    if (error) {
      throw new Error(
        `searchRoles RPC failed: ${error.message || 'Unknown database error'}`
      );
    }

    // RPC returns a single jsonb envelope, not a row array
    const envelope = data as RpcEnvelope;

    if (!envelope?.success) {
      throw new Error(
        `searchRoles RPC error: ${envelope?.error ?? 'Unknown error'} (${envelope?.code ?? 'NO_CODE'})`
      );
    }

    const roles = envelope?.data?.roles;

    if (!Array.isArray(roles)) {
      return [];
    }

    // Remap RPC column names → stable SearchRolesResult shape
    return roles.map((row: RpcRoleRow): SearchRolesResult => ({
      id: row.role_id,
      title: row.role_name,
      level: row.seniority_level ?? null,
      score: row.rank_score ?? null,
      keyword_score: row.fts_score ?? null,
      semantic_score: row.sim_score ?? null,
      // Preserve extra fields for forward compatibility
      ...row,
    }));
  } catch (error) {
    console.error('search.service.searchRoles failed', {
      query: normalizedQuery,
      agency: normalizedAgency,
      limit: safeLimit,
      error,
    });

    throw error;
  }
}