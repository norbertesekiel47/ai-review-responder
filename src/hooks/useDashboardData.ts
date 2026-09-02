'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardData, AggregateDashboardData } from '@/lib/dashboard/types';
import {
  type DashboardWindow,
  DEFAULT_DASHBOARD_WINDOW,
} from '@/lib/kpi/types';
import type { LocationScope } from '@/contexts/LocationContext';

export type DashboardOrAggregate = DashboardData | AggregateDashboardData;

export interface ScopeFallbackInfo {
  reason: 'location_archived' | 'location_not_found';
  fallbackLocationId: string;
}

export interface UseDashboardDataResult {
  data: DashboardOrAggregate | null;
  error: string | null;
  /**
   * True only while NO data exists for the requested scope/window — the first
   * fetch, or the fetch right after a scope/window change. A background
   * refresh of data already on screen never flips this (stale-while-revalidate,
   * UX audit D1): consumers render their skeleton only when `data` is null.
   */
  loading: boolean;
  /** True while a refresh is in flight over data already on screen. */
  refreshing: boolean;
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
  /** #403: analytics time-range window. Defaults to {@link DEFAULT_DASHBOARD_WINDOW}
   *  (30-day KPIs + 8-week trend). Threaded into the fetch URL and the cache key
   *  so two windows never collide; changing it triggers a refetch. */
  window?: DashboardWindow;
}

/**
 * Build the fetch URL with the scope + window query params. The default window
 * is omitted so the default URL stays `/api/dashboard[?scope=…]` (keeps the
 * browser cache distinct per window without changing the default request).
 */
function buildDashboardUrl(
  scope: LocationScope | null,
  window: DashboardWindow,
): string {
  const params = new URLSearchParams();
  if (scope !== null) params.set('scope', scope === 'all' ? 'all' : scope);
  if (window !== DEFAULT_DASHBOARD_WINDOW) params.set('window', window);
  const queryString = params.toString();
  return queryString ? `/api/dashboard?${queryString}` : '/api/dashboard';
}

/** Extract the API error message from a non-OK response (best-effort). */
async function readResponseError(res: Response): Promise<string> {
  const body: { error?: string } = await res.json().catch(() => ({}));
  return body.error ?? `Request failed (${res.status})`;
}

/** VAL-DASH-029: read the scopeFallback indicator from a dashboard payload. */
function extractScopeFallback(json: DashboardOrAggregate): ScopeFallbackInfo | null {
  if (json && typeof json === 'object' && 'scopeFallback' in json) {
    return (json as unknown as Record<string, unknown>).scopeFallback as ScopeFallbackInfo;
  }
  return null;
}

type DashboardLoad =
  | { ok: true; data: DashboardOrAggregate; fallback: ScopeFallbackInfo | null }
  | { ok: false; error: string };

/**
 * One round trip for a (scope, window): the payload plus its scopeFallback
 * indicator, or the owner-facing error line (the API's message for a non-OK
 * response, a generic one for anything else). Never throws.
 */
async function loadDashboard(
  scope: LocationScope | null,
  window: DashboardWindow,
): Promise<DashboardLoad> {
  try {
    const res = await fetch(buildDashboardUrl(scope, window));
    if (!res.ok) {
      throw new Error(await readResponseError(res));
    }
    const data = (await res.json()) as DashboardOrAggregate;
    return { ok: true, data, fallback: extractScopeFallback(data) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to load dashboard' };
  }
}

interface DataState {
  scope: LocationScope | null;
  window: DashboardWindow;
  data: DashboardOrAggregate | null;
  fallback: ScopeFallbackInfo | null;
}

/** Whether committed data was fetched for exactly this (scope, window). */
function isForRequest(
  state: DataState,
  scope: LocationScope | null,
  window: DashboardWindow,
): boolean {
  return state.scope === scope && state.window === window;
}

/**
 * What the consumer may see for the requested (scope, window): the committed
 * data and fallback when they were fetched for it, otherwise nothing — stale
 * data from a previous scope OR window is never surfaced (VAL-DASH-025).
 */
function visibleFor(
  state: DataState,
  scope: LocationScope | null,
  window: DashboardWindow,
): Pick<UseDashboardDataResult, 'data' | 'scopeFallback'> {
  if (!isForRequest(state, scope, window)) return { data: null, scopeFallback: null };
  return { data: state.data, scopeFallback: state.fallback };
}

/**
 * Fetches dashboard data from the API, scoped to the given location or aggregate.
 *
 * VAL-DASH-017: useDashboardData('all') fetches /api/dashboard?scope=all
 * VAL-DASH-018: useDashboardData(locationId) fetches /api/dashboard?scope=<locationId>
 *
 * When scope is null, fetches the default (user's current location from server).
 * When scope changes, clears stale data and re-fetches.
 *
 * Stale-while-revalidate (UX audit D1): a `refresh()` over data that is already
 * on screen for the same scope/window keeps that data in place and reports
 * `refreshing` instead of `loading`, so the 60 s auto-refresh and the
 * post-action refetch never unmount the list an owner is working in.
 */
export function useDashboardData(
  scope: LocationScope | null = null,
  options: UseDashboardDataOptions = {},
): UseDashboardDataResult {
  // #403: the requested analytics window (default = today's 30-day / 8-week
  // behavior). Part of the cache key below so a window change never reads stale
  // data fetched for a different window.
  const dashboardWindow = options.window ?? DEFAULT_DASHBOARD_WINDOW;
  // Data is keyed by the (scope, window) it was fetched for. Stale data from a
  // previous scope OR window is never returned (derived below), so we don't reset
  // state in an effect when either changes (VAL-DASH-025) — the derivation handles it.
  const [dataState, setDataState] = useState<DataState>({
    scope,
    window: dashboardWindow,
    data: null,
    fallback: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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
  // Track the window for the current fetch (#403) — same stale-response guard.
  const windowRef = useRef(dashboardWindow);
  // Latest committed data, so the stable refresh() can tell a background
  // refresh (data on screen → `refreshing`) from a first load (→ `loading`).
  const dataStateRef = useRef(dataState);
  // Stable ref to options.onScopeFallback to avoid re-triggering effects
  const onFallbackRef = useRef(options.onScopeFallback);
  // Keep refs current so the stable refresh() (deps []) reads the latest values.
  // Assigned in an effect (not during render) per react-hooks/refs, and declared
  // before the fetch effect below so the refs are fresh when a scope or window
  // change triggers refresh().
  useEffect(() => {
    scopeRef.current = scope;
    windowRef.current = dashboardWindow;
    dataStateRef.current = dataState;
    onFallbackRef.current = options.onScopeFallback;
  });

  const refresh = useCallback(async () => {
    const myReqId = ++reqIdRef.current;
    const fetchScope = scopeRef.current;
    const fetchWindow = windowRef.current;
    const current = dataStateRef.current;
    const hasDataOnScreen =
      current.data !== null && isForRequest(current, fetchScope, fetchWindow);
    setError(null);
    if (hasDataOnScreen) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    const result = await loadDashboard(fetchScope, fetchWindow);
    // Discard a response whose request was superseded or whose owner unmounted.
    if (myReqId !== reqIdRef.current || unmountedRef.current) return;
    if (result.ok) {
      if (result.fallback) onFallbackRef.current?.(result.fallback);
      setDataState({ scope: fetchScope, window: fetchWindow, data: result.data, fallback: result.fallback });
    } else {
      setError(result.error);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Re-fetch when scope OR window changes. No synchronous state reset here —
  // `data` and `scopeFallback` are derived from `dataState.scope`/`.window`
  // below, so a change makes them read as null immediately without an extra
  // setState.
  useEffect(() => {
    unmountedRef.current = false;
    // Fetch on mount / scope / window change. refresh() synchronously sets
    // loading=true before its first await — the intended network subscription,
    // not a derivable value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    return () => {
      unmountedRef.current = true;
    };
  }, [scope, dashboardWindow, refresh]);

  return { ...visibleFor(dataState, scope, dashboardWindow), error, loading, refreshing, refresh };
}
