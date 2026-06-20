'use client';

import { useCallback, useEffect, useState } from 'react';

export interface ActiveOffboarding {
  id: string;
  mode: string;
  status: string;
  accessEndsAt?: string | Date | null;
}

export interface OffboardingStatus {
  enabled: boolean;
  activeOffboarding: ActiveOffboarding | null;
}

export interface UseOffboardingStatus {
  status: OffboardingStatus | null;
  loadError: string | null;
  setStatus: (next: OffboardingStatus) => void;
  refetch: () => void;
}

export function useOffboardingStatus(): UseOffboardingStatus {
  const [status, setStatus] = useState<OffboardingStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      const res = await fetch('/api/account/offboarding/status');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? body.error ?? 'Unable to load cancellation status');
      }
      const body = (await res.json()) as OffboardingStatus;
      if (!signal?.cancelled) setStatus(body);
    } catch (err) {
      if (!signal?.cancelled) {
        setLoadError(err instanceof Error ? err.message : 'Unable to load cancellation status');
      }
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; setState is guarded by the cancelled flag
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  return { status, loadError, setStatus, refetch: () => void load() };
}
