'use client';

import { useState, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';

const CACHE_TTL = 1000 * 60 * 5; // 5 minutes

export function useRoleSearch(query, { agency = null, limit = 20 } = {}) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const cacheRef = useRef(new Map());
  const abortRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    const q = query?.trim();

    // 🚫 Guard: short or empty queries
    if (!q || q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }

    // ⏳ Debounce
    clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      const cacheKey = `${q}_${agency}_${limit}`;

      // 💾 Cache hit
      const cached = cacheRef.current.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        setResults(cached.data);
        return;
      }

      // 🛑 Cancel previous request
      if (abortRef.current) {
        abortRef.current.abort();
      }

      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      try {
        const { data, error } = await supabase.rpc(
          'search_roles_hybrid',
          {
            p_query: q,
            p_limit: limit,
            p_agency: agency,
          },
          {
            signal: controller.signal,
          }
        );

        if (error) throw error;

        // 💾 Store in cache
        cacheRef.current.set(cacheKey, {
          data,
          timestamp: Date.now(),
        });

        setResults(data || []);
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('[useRoleSearch]', err);
        setError(err.message || 'Search failed');
      } finally {
        setLoading(false);
      }
    }, 350); // ⚡ ideal debounce timing

    return () => clearTimeout(debounceRef.current);
  }, [query, agency, limit]);

  return {
    results,
    loading,
    error,
  };
}