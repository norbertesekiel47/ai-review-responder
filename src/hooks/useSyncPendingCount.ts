'use client';

import { useEffect } from 'react';
import type { DashboardPayload } from '@/lib/dashboard/scope';
import { authoritativePendingCount } from '@/lib/dashboard/scope';
import { useSetPendingCount } from '@/contexts/PendingCountContext';

/**
 * Derives the pending-approval count from the shared /api/dashboard payload and
 * pushes it into PendingCountContext so the nav badge stays in sync. The single
 * owner of this derivation for every surface that reads the same payload.
 */
export function useSyncPendingCount(
  data: DashboardPayload | null,
  loading: boolean,
): number {
  const setPendingCount = useSetPendingCount();

  const pending = !loading ? authoritativePendingCount(data) : 0;

  useEffect(() => {
    setPendingCount(pending);
  }, [pending, setPendingCount]);

  return pending;
}
