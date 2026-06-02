'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardData, AggregateDashboardData } from '@/lib/dashboard/types';
import type { LocationScope } from '@/contexts/LocationContext';

export type DashboardOrAggregate = DashboardData | AggregateDashboardData;

export interface ScopeFallbackInfo {
  reason: 'location_archived' | 'location_not_found';
  fallbackLocationId: string;
}

export interface UseDashboardDataResult {
  data: DashboardOrAggregate | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** VAL-DASH-029: Set when the API fell back to primary because the requested
   *  location was archived or not found. The consumer should update the
   *  LocationContext switcher to reflect the fallback. */
  scopeFallback: ScopeFallbackInfo | null;
}

export interface UseDashboardDataOptions {
  /** Called when the API returns a scopeFallback indicator (VAL-DASH-029).
   *  The consumer can use this to update the LocationContext switcher. */
  onScopeFallback?: (fallback: ScopeFallbackInfo) => void;
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
export function useDashboardData(
  scope: LocationScope | null = null,
  options: UseDashboardDataOptions = {},
): UseDashboardDataResult {
  // Data is keyed by the scope it was fetched for. Stale data from a previous
  // scope is never returned (derived below), so we don't reset state in an
  // effect when `scope` changes (VAL-DASH-025) — the derivation handles it.
  const [dataState, setDataState] = useState<{
    scope: LocationScope | null;
    data: DashboardOrAggregate | null;
    fallback: ScopeFallbackInfo | null;
  }>({ scope, data: null, fallback: null });
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
  // Stable ref to options.onScopeFallback to avoid re-triggering effects
  const onFallbackRef = useRef(options.onScopeFallback);
  onFallbackRef.current = options.onScopeFallback;

  const refresh = useCallback(async () => {
    const myReqId = ++reqIdRef.current;
    const fetchScope = scopeRef.current;
    setError(null);
    setLoading(true);
    try {
      // Build URL with scope query parameter
      let url = '/api/dashboard';
      if (fetchScope !== null) {
        const param = fetchScope === 'all' ? 'all' : fetchScope;
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

      // VAL-DASH-029: Check for scopeFallback indicator in the response
      let fallback: ScopeFallbackInfo | null = null;
      if (json && typeof json === 'object' && 'scopeFallback' in json) {
        fallback = (json as unknown as Record<string, unknown>).scopeFallback as ScopeFallbackInfo;
        onFallbackRef.current?.(fallback);
      }

      setDataState({ scope: fetchScope, data: json, fallback });
      setLoading(false);
    } catch (err) {
      if (myReqId !== reqIdRef.current || unmountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      setLoading(false);
    }
  }, []);

  // Re-fetch when scope changes. No synchronous state reset here — `data` and
  // `scopeFallback` are derived from `dataState.scope` below, so a scope change
  // makes them read as null immediately without an extra setState.
  useEffect(() => {
    unmountedRef.current = false;
    refresh();
    return () => {
      unmountedRef.current = true;
    };
  }, [scope, refresh]);

  // Stale data from a previous scope is never surfaced (VAL-DASH-025).
  const data = dataState.scope === scope ? dataState.data : null;
  const scopeFallback = dataState.scope === scope ? dataState.fallback : null;

  return { data, error, loading, refresh, scopeFallback };
}
