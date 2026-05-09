'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardData, AggregateDashboardData } from '@/lib/dashboard/types';
import type { LocationScope } from '@/contexts/LocationContext';

export type DashboardOrAggregate = DashboardData | AggregateDashboardData;

export interface UseDashboardDataResult {
  data: DashboardOrAggregate | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Fetches dashboard data from the API, scoped to the given location or aggregate.
 *
 * VAL-DASH-017: useDashboardData('all') fetches /api/dashboard?scope=all
 * VAL-DASH-018: useDashboardData(locationId) fetches /api/dashboard?scope=<locationId>
 *
 * When scope is null, fetches the default (user's current location from server).
 * When scope changes, clears stale data and re-fetches.
 */
export function useDashboardData(scope: LocationScope | null = null): UseDashboardDataResult {
  const [data, setData] = useState<DashboardOrAggregate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Sequence id: increments on every refresh() call. Responses that resolve
  // with a stale id are discarded so a slow request can't overwrite fresher
  // data (e.g. auto-refresh tick fires while a manual refresh is still
  // in flight, or vice versa).
  const reqIdRef = useRef(0);
  // Cancel-on-unmount guard so we don't setState after the component
  // tree that owns this hook has gone away.
  const unmountedRef = useRef(false);
  // Track the scope for the current fetch to avoid stale responses
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const refresh = useCallback(async () => {
    const myReqId = ++reqIdRef.current;
    setError(null);
    setLoading(true);
    try {
      // Build URL with scope query parameter
      let url = '/api/dashboard';
      if (scopeRef.current !== null) {
        const param = scopeRef.current === 'all' ? 'all' : scopeRef.current;
        url = `/api/dashboard?scope=${encodeURIComponent(param)}`;
      }
      const res = await fetch(url);
      if (myReqId !== reqIdRef.current || unmountedRef.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const json: DashboardOrAggregate = await res.json();
      if (myReqId !== reqIdRef.current || unmountedRef.current) return;
      setData(json);
      setLoading(false);
    } catch (err) {
      if (myReqId !== reqIdRef.current || unmountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      setLoading(false);
    }
  }, []);

  // Re-fetch when scope changes
  useEffect(() => {
    unmountedRef.current = false;
    setData(null); // Clear stale data from previous scope (VAL-DASH-025)
    refresh();
    return () => {
      unmountedRef.current = true;
    };
  }, [scope, refresh]);

  return { data, error, loading, refresh };
}
