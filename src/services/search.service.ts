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

type RpcRoleRow = {
  role_id: string;
  role_name: string;
  seniority_level?: string | null;
  rank_score?: number | null;
  fts_score?: number | null;
  sim_score?: number | null;
  [key: string]: unknown;
};

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
const DEFAULT_THRESHOLD = 0.15;

const DEFAULT_WEIGHTS = {
  semantic: 0.7,
  keyword: 0.3,
} as const;

const RPCS = Object.freeze({
  SEARCH_ROLES_HYBRID: 'search_roles_hybrid',
});

function normalizeEnvelope(data: unknown): RpcEnvelope {
  if (!data) {
    return {
      success: false,
      error: 'Empty RPC response',
      code: 'EMPTY_RESPONSE',
    };
  }

  if (typeof data === 'string') {
    try {
      return JSON.parse(data) as RpcEnvelope;
    } catch {
      return {
        success: false,
        error: 'Invalid JSON RPC response',
        code: 'INVALID_JSON',
      };
    }
  }

  if (typeof data === 'object') {
    return data as RpcEnvelope;
  }

  return {
    success: false,
    error: 'Unexpected RPC response type',
    code: 'INVALID_RESPONSE_TYPE',
  };
}

/**
 * Hybrid semantic + keyword role search.
 * Stable against SQL signature drift + malformed jsonb envelopes.
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
    const { data, error } = await supabase.rpc(
      RPCS.SEARCH_ROLES_HYBRID,
      {
        p_query: normalizedQuery,
        p_agency: normalizedAgency,
        p_limit: safeLimit,
        p_threshold: DEFAULT_THRESHOLD,
        p_weights: DEFAULT_WEIGHTS,
      }
    );

    if (error) {
      throw new Error(
        `searchRoles RPC failed: ${error.message || 'Unknown database error'}`
      );
    }

    const envelope = normalizeEnvelope(data);

    if (!envelope.success) {
      throw new Error(
        `searchRoles RPC error: ${
          envelope.error ?? 'Unknown error'
        } (${envelope.code ?? 'NO_CODE'})`
      );
    }

    const roles = envelope.data?.roles;

    if (!Array.isArray(roles) || roles.length === 0) {
      return [];
    }

    return roles.map(
      (row: RpcRoleRow): SearchRolesResult => ({
        ...row,
        id: row.role_id,
        title: row.role_name,
        level: row.seniority_level ?? null,
        score: row.rank_score ?? null,
        keyword_score: row.fts_score ?? null,
        semantic_score: row.sim_score ?? null,
      })
    );
  } catch (error) {
    console.error('search.service.searchRoles failed', {
      limit: safeLimit,
      message:
        error instanceof Error
          ? error.message
          : String(error),
    });

    throw error;
  }
}