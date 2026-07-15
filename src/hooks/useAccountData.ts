'use client';

import { useEffect, useState, useRef } from 'react';
import type { PlanPresentationViewModel } from '@/lib/payments/plan-presentation';

// ── Response type from /api/account/settings ────────────────────────────

export interface AccountSettingsData {
  accountId: string;
  displayName: string;
  subscription: {
    tier: string;
    tierLabel: string;
    priceVariant: string;
    status: string;
    statusLabel: string;
    stripeCustomerId: string | null;
    activatedAt: string | null;
    trialEndsAt: string | null;
  };
  quota: {
    activeLocations: number;
    included: number;
    paid: number;
    overage: number;
  };
  billing: {
    basePriceCents: number;
    overagePriceCents: number;
    overageUnits: number;
    totalCents: number;
  };
  planPresentation: PlanPresentationViewModel;
  timeZone?: string | null;
}

export interface UseAccountData {
  data: AccountSettingsData | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useAccountData(): UseAccountData {
  const [data, setData] = useState<AccountSettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const fetchId = ++fetchIdRef.current;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/account/settings');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        const json: AccountSettingsData = await res.json();
        if (cancelled || fetchId !== fetchIdRef.current) return;
        setData(json);
      } catch (err) {
        if (!cancelled && fetchId === fetchIdRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to load account data');
        }
      } finally {
        if (!cancelled && fetchId === fetchIdRef.current) {
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function refetch() {
    // Increment fetchId to invalidate any in-flight request
    const newFetchId = ++fetchIdRef.current;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/account/settings');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        const json: AccountSettingsData = await res.json();
        if (cancelled || newFetchId !== fetchIdRef.current) return;
        setData(json);
      } catch (err) {
        if (!cancelled && newFetchId === fetchIdRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to load account data');
        }
      } finally {
        if (!cancelled && newFetchId === fetchIdRef.current) {
          setLoading(false);
        }
      }
    }
    load();
  }

  return { data, loading, error, refetch };
}
