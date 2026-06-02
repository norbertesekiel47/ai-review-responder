'use client';

import { useQuery } from '@tanstack/react-query';

// ── Response type from /api/account/settings ────────────────────────────

export interface AccountSettingsData {
  accountId: string;
  displayName: string;
  subscription: {
    tier: string;
    tierLabel: string;
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
}

export interface UseAccountData {
  data: AccountSettingsData | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useAccountData(): UseAccountData {
  const query = useQuery<AccountSettingsData>({
    queryKey: ['account-settings'],
    queryFn: async () => {
      const res = await fetch('/api/account/settings');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      return res.json() as Promise<AccountSettingsData>;
    },
  });

  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: query.error ? query.error.message : null,
    refetch: () => {
      void query.refetch();
    },
  };
}
