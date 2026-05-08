'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardData } from '@/lib/dashboard/types';

export interface UseDashboardDataResult {
  data: DashboardData | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useDashboardData(): UseDashboardDataResult {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Sequence id: increments on every refresh() call. Responses that resolve
  // with a stale id are discarded so a slow request can't overwrite fresher
  // data (e.g. auto-refresh tick fires while a manual refresh is still
  // in flight, or vice versa).
  const reqIdRef = useRef(0);
  // Cancel-on-unmount guard so we don't setState after the component
  // tree that owns this hook has gone away.
  const unmountedRef = useRef(false);

  const refresh = useCallback(async () => {
    const myReqId = ++reqIdRef.current;
    setError(null);
    try {
      const res = await fetch('/api/dashboard');
      if (myReqId !== reqIdRef.current || unmountedRef.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const json: DashboardData = await res.json();
      if (myReqId !== reqIdRef.current || unmountedRef.current) return;
      setData(json);
    } catch (err) {
      if (myReqId !== reqIdRef.current || unmountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    }
  }, []);

  useEffect(() => {
    refresh();
    return () => {
      unmountedRef.current = true;
    };
  }, [refresh]);

  return { data, error, refresh };
}
