'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelEnrollmentRow, DetailData } from '../types';

export interface UseBusinessDetailResult {
  data: DetailData | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  enrollments: ChannelEnrollmentRow[];
  /** True while either the detail or the channels query is in flight. */
  channelsLoading: boolean;
  /** True if the channels-only query failed (separate from the main detail query). */
  channelsError: boolean;
  invalidate: () => void;
  clearBounceFlag: () => Promise<void>;
}

export interface UseBusinessDetailOptions {
  /**
   * Server-rendered first paint (spec §4). The detail server page fetches both
   * reads and hands them down, so the page renders with data instead of a
   * spinner and these queries start `isLoading: false`.
   */
  initialDetail?: DetailData;
  initialChannels?: ChannelEnrollmentRow[];
}

export function useBusinessDetail(
  businessId: string,
  { initialDetail, initialChannels }: UseBusinessDetailOptions = {},
): UseBusinessDetailResult {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery<DetailData>({
    queryKey: ['admin-business', businessId],
    initialData: initialDetail,
    queryFn: async () => {
      const res = await fetch(`/api/admin/businesses/${businessId}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<DetailData>;
    },
  });

  // The channels query is rendered in a separate panel, so we expose its
  // load/error state independently from the main detail query rather than
  // silently coercing failures to an empty enrollments array. ChannelsPanel
  // can display "couldn't load channels" without affecting the rest of the
  // page; previously a 500 from /channels was indistinguishable from "no
  // enrollments yet".
  const {
    data: channelsData,
    isLoading: channelsLoading,
    isError: channelsError,
  } = useQuery<{ enrollments: ChannelEnrollmentRow[] }>({
    queryKey: ['admin-business-channels', businessId],
    initialData: initialChannels ? { enrollments: initialChannels } : undefined,
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
    try {
      const res = await fetch(`/api/admin/businesses/${businessId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerEmailBounced: false }),
      });
      if (res.ok) {
        void queryClient.invalidateQueries({ queryKey: ['admin-business', businessId] });
        return;
      }
      const json = await res.json().catch(() => ({}));
      const msg = (json as { error?: string }).error ?? `HTTP ${res.status}`;
      console.error('[useBusinessDetail] clearBounceFlag failed:', msg);
      alert(`Failed to clear flag: ${msg}`);
    } catch (err) {
      console.error('[useBusinessDetail] clearBounceFlag threw:', err);
      alert('Failed to clear flag. Check your network connection and try again.');
    }
  };

  return {
    data,
    isLoading,
    isError,
    error,
    enrollments,
    channelsLoading,
    channelsError,
    invalidate,
    clearBounceFlag,
  };
}
