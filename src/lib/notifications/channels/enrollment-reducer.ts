// src/lib/notifications/channels/enrollment-reducer.ts
//
// Pure state machine for QR/deep-link channel enrollment (Telegram, WhatsApp,
// future Discord/Slack). Used by `useEnrollment` (the React hook) which
// dispatches actions in response to fetch results and timer ticks.
//
// PURE: (state, action) => state. No I/O, no Date.now(), no array filtering.
// Every input is in the action. Tests run in node without jsdom.
//
// State transitions are documented in
// docs/superpowers/specs/2026-04-28-phase-4-owner-channel-dashboard-design.md §2.

export type EnrollmentState =
  | 'idle'
  | 'generating'
  | 'awaiting_scan'
  | 'verified'
  | 'disabled'
  | 'unsubscribed'
  | 'expired'
  | 'error';

export interface ChannelEnrollmentRow {
  channel: 'email' | 'sms' | 'telegram' | 'whatsapp';
  handle: string | null;
  status: 'verified' | 'pending_verification' | 'disabled' | 'unsubscribed';
  verified_at: string | null;
  disabled_at: string | null;
  unsubscribed_at: string | null;
  unsubscribed_reason: string | null;
  expires_at: string | null;
}

export interface EnrollmentSnapshot {
  state: EnrollmentState;
  handle: string | null;
  deepLink: string | null;
  qrDataUrl: string | null;
  expiresAt: number | null;       // epoch ms — easier to test than Date
  unsubscribedReason: string | null;
  errorMessage: string | null;
}

export type EnrollmentAction =
  | { type: 'CONNECT_REQUESTED' }
  | { type: 'CONNECT_SUCCEEDED'; deepLink: string; qrDataUrl: string; expiresAt: number }
  | { type: 'CONNECT_FAILED'; status: number; message: string }
  | { type: 'STATUS_FETCHED'; row: ChannelEnrollmentRow | null; nowMs: number }
  | { type: 'CANCEL_SUCCEEDED' }
  | { type: 'DISABLE_SUCCEEDED' }
  | { type: 'TICK'; nowMs: number }
  | { type: 'DISMISS_ERROR' };

export const initialEnrollment: EnrollmentSnapshot = {
  state: 'idle',
  handle: null,
  deepLink: null,
  qrDataUrl: null,
  expiresAt: null,
  unsubscribedReason: null,
  errorMessage: null,
};

function classifyConnectError(status: number, message: string): string {
  if (status === 401 || status === 403) return 'Session expired — please sign in again.';
  if (status === 404) return 'This channel is currently unavailable.';
  if (status === 503) return 'Service temporarily unavailable. Please try again.';
  if (status === 409) {
    if (message === 'already_verified') return 'Already connected.';
    return 'Disconnect your current channel before connecting another.';
  }
  return `Could not connect (${status}).`;
}

function rowToSnapshot(row: ChannelEnrollmentRow): EnrollmentSnapshot {
  if (row.status === 'verified') {
    return {
      ...initialEnrollment,
      state: 'verified',
      handle: row.handle,
    };
  }
  if (row.status === 'disabled') {
    return { ...initialEnrollment, state: 'disabled' };
  }
  if (row.status === 'unsubscribed') {
    return {
      ...initialEnrollment,
      state: 'unsubscribed',
      unsubscribedReason: row.unsubscribed_reason,
    };
  }
  // pending_verification — only reachable from non-awaiting_scan paths
  // (awaiting_scan + pending is a no-op upstream). Treat as idle since
  // we lack the deepLink/qrDataUrl to display the QR.
  return { ...initialEnrollment, state: 'idle' };
}

export function enrollmentReducer(
  state: EnrollmentSnapshot,
  action: EnrollmentAction,
): EnrollmentSnapshot {
  switch (action.type) {
    case 'CONNECT_REQUESTED':
      return { ...state, state: 'generating', errorMessage: null };

    case 'CONNECT_SUCCEEDED':
      return {
        ...state,
        state: 'awaiting_scan',
        deepLink: action.deepLink,
        qrDataUrl: action.qrDataUrl,
        expiresAt: action.expiresAt,
        errorMessage: null,
      };

    case 'CONNECT_FAILED':
      return {
        ...state,
        state: 'error',
        errorMessage: classifyConnectError(action.status, action.message),
      };

    case 'STATUS_FETCHED': {
      // `generating` is a transient state — wait for the explicit
      // CONNECT_SUCCEEDED / CONNECT_FAILED action.
      if (state.state === 'generating') return state;

      // `awaiting_scan` is the most subtle — see §2 transition table.
      if (state.state === 'awaiting_scan') {
        if (!action.row) return state;
        if (action.row.status === 'pending_verification') return state;
        // verified / disabled / unsubscribed → take row's state
        return rowToSnapshot(action.row);
      }

      // All other states: take the row authoritatively (or idle if no row).
      if (!action.row) return { ...initialEnrollment, state: 'idle' };
      return rowToSnapshot(action.row);
    }

    case 'CANCEL_SUCCEEDED':
      return {
        ...state,
        state: 'idle',
        deepLink: null,
        qrDataUrl: null,
        expiresAt: null,
        errorMessage: null,
      };

    case 'DISABLE_SUCCEEDED':
      return {
        ...state,
        state: 'disabled',
        handle: null,
        errorMessage: null,
      };

    case 'TICK': {
      if (state.state !== 'awaiting_scan') return state;
      if (state.expiresAt === null) return state;
      if (action.nowMs >= state.expiresAt) {
        return {
          ...state,
          state: 'expired',
          deepLink: null,
          qrDataUrl: null,
          expiresAt: null,
        };
      }
      return state;
    }

    case 'DISMISS_ERROR':
      return { ...state, state: 'idle', errorMessage: null };
  }
}
