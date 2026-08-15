'use client';

import { useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelEnrollmentRow, DetailData, ResendInviteState } from '../types';

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
  /** POSTs the resend-invite action; the server owns every eligibility rule. */
  resendInvite: () => Promise<void>;
  resendInviteState: ResendInviteState;
}

type ResendInviteAction =
  | { type: 'start' }
  | { type: 'success'; message: string }
  | { type: 'error'; error: string };

const initialResendInviteState: ResendInviteState = {
  submitting: false,
  message: null,
  error: null,
};

function resendInviteReducer(
  state: ResendInviteState,
  action: ResendInviteAction,
): ResendInviteState {
  switch (action.type) {
    case 'start':
      return { submitting: true, message: null, error: null };
    case 'success':
      return { submitting: false, message: action.message, error: null };
    case 'error':
      return { submitting: false, message: null, error: action.error };
  }
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
  const router = useRouter();
  const [resendInviteState, dispatchResend] = useReducer(
    resendInviteReducer,
    initialResendInviteState,
  );

  const { data, isLoading, isError, error } = useQuery<DetailData>({
    queryKey: ['admin-business', businessId],
    staleTime: 30_000,
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
    staleTime: 30_000,
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
    // The page <h1> and description are server-rendered from business.name /
    // .category, which ProfileEditor can edit. Invalidating the react-query
    // cache alone leaves the chrome showing the pre-edit name until a reload.
    router.refresh();
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

  // Resend invite (plan step 9 / T7). No confirm() dialog: the action is
  // idempotent-ish from the admin's point of view (worst case one duplicate
  // email), the route caps it per business, and a modal that blocks the whole
  // tab is a worse guard than a disabled button. Every eligibility rule —
  // pending_payment AND provider-confirmed never-signed-in — is enforced
  // server-side; this only renders whatever the server decided.
  const resendInvite = async () => {
    dispatchResend({ type: 'start' });
    try {
      const res = await fetch(`/api/admin/businesses/${businessId}/resend-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        ownerEmailRedacted?: string;
      };
      if (!res.ok) {
        dispatchResend({ type: 'error', error: json.error ?? `HTTP ${res.status}` });
        return;
      }
      dispatchResend({
        type: 'success',
        message: json.ownerEmailRedacted
          ? `Invite re-sent to ${json.ownerEmailRedacted}.`
          : 'Invite re-sent.',
      });
    } catch (err) {
      console.error('[useBusinessDetail] resendInvite threw:', err);
      dispatchResend({
        type: 'error',
        error: 'Failed to resend the invite. Check your network connection and try again.',
      });
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
    resendInvite,
    resendInviteState,
  };
}
