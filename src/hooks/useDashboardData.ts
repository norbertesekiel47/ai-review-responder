'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DashboardData } from '@/lib/dashboard/types';

export interface UseDashboardDataResult {
  data: DashboardData | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useDashboardData(): UseDashboardDataResult {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const json: DashboardData = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, error, refresh };
}
