'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelEnrollmentRow, DetailData } from '../types';

export interface UseBusinessDetailResult {
  data: DetailData | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  enrollments: ChannelEnrollmentRow[];
  invalidate: () => void;
  clearBounceFlag: () => Promise<void>;
}

export function useBusinessDetail(businessId: string): UseBusinessDetailResult {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery<DetailData>({
    queryKey: ['admin-business', businessId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/businesses/${businessId}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<DetailData>;
    },
  });

  const { data: channelsData } = useQuery<{ enrollments: ChannelEnrollmentRow[] }>({
    queryKey: ['admin-business-channels', businessId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/businesses/${businessId}/channels`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ enrollments: ChannelEnrollmentRow[] }>;
    },
  });
  const enrollments = channelsData?.enrollments ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-business', businessId] });
    // Owner-email edits upsert channel_enrollments inside the PATCH txn; the
    // Channels table must refresh to show the new handle.
    void queryClient.invalidateQueries({ queryKey: ['admin-business-channels', businessId] });
  };

  const clearBounceFlag = async () => {
    if (!confirm('Clear the bounce flag? Only do this after verifying the address is valid.')) return;
    const res = await fetch(`/api/admin/businesses/${businessId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerEmailBounced: false }),
    });
    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ['admin-business', businessId] });
    } else {
      alert('Failed to clear flag. See console.');
    }
  };

  return { data, isLoading, isError, error, enrollments, invalidate, clearBounceFlag };
}
