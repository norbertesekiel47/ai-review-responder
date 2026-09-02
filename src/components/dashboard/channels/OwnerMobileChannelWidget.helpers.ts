// src/components/dashboard/channels/OwnerMobileChannelWidget.helpers.ts
//
// Pure, React-free pieces of the owner mobile-channel widget: the SSR snapshot
// derivation, handle masking, the per-state handle copy, the two transition
// toasts, and the QR TTL formatting. Kept out of the component so each can be
// unit-tested as a function and the component reads as composition.

import type {
  EnrollmentSnapshot,
  EnrollmentState,
} from '@/lib/notifications/channels/enrollment-reducer';
import type { ToastInput } from '@/components/dashboard/shell/toast/ToastProvider';

/** What the owner is left with after disconnecting either mobile channel. */
export const DISCONNECT_CONSEQUENCE = "You'll get approval requests by email only.";

/**
 * Derives an EnrollmentSnapshot for SSR hydration from the server-loaded row.
 * Only `verified` rows produce a snapshot — other statuses still need a fresh
 * fetch to avoid stale-state risks (e.g. an expired pending token).
 */
export function rowToInitialSnapshot(
  row: { handle: string | null; status: string } | null,
): EnrollmentSnapshot | undefined {
  if (!row || row.status !== 'verified') return undefined;
  return {
    state: 'verified',
    previousState: null,
    handle: row.handle,
    deepLink: null,
    qrDataUrl: null,
    expiresAt: null,
    unsubscribedReason: null,
    errorMessage: null,
  };
}

export function maskHandle(handle: string | null): string {
  if (!handle || handle.length <= 4) return '•••';
  return `••• ${handle.slice(-4)}`;
}

/** States from which the owner can start (or restart) a connection. */
const CONNECTABLE_STATES: ReadonlySet<EnrollmentState> = new Set<EnrollmentState>([
  'idle',
  'disabled',
  'unsubscribed',
  'expired',
]);

export function isConnectableState(state: EnrollmentState): boolean {
  return CONNECTABLE_STATES.has(state);
}

/** Copy that does not depend on the channel or the snapshot beyond its state. */
const STATIC_HANDLE_TEXT: Partial<Record<EnrollmentState, string>> = {
  generating: 'Generating link…',
  awaiting_scan: 'Scan the QR code below, or open the link on this phone.',
  disabled: 'Disconnected — reconnect to get approval requests here.',
  expired: 'This QR code expired. Ask for a new link to try again.',
};

/** The sentence under the channel name, for every enrollment state. */
export function channelHandleText(
  snapshot: Pick<EnrollmentSnapshot, 'state' | 'handle' | 'errorMessage'>,
  copy: { idleText: string; unsubscribedText: string },
): string {
  switch (snapshot.state) {
    case 'idle':
      return copy.idleText;
    case 'verified':
      return `Connected · ${maskHandle(snapshot.handle)}`;
    case 'unsubscribed':
      return copy.unsubscribedText;
    case 'error':
      return snapshot.errorMessage ?? 'Something went wrong.';
    default:
      return STATIC_HANDLE_TEXT[snapshot.state] ?? '';
  }
}

/**
 * The two transitions the owner waits on: the QR scan landing
 * (awaiting_scan → verified) and the disconnect (verified → disabled). Every
 * other transition — including no transition — is silent.
 */
export function enrollmentTransitionToast(
  previous: EnrollmentState,
  next: EnrollmentState,
  label: string,
): ToastInput | null {
  if (previous === 'awaiting_scan' && next === 'verified') {
    return { tone: 'success', title: `${label} connected` };
  }
  if (previous === 'verified' && next === 'disabled') {
    return { tone: 'success', title: `${label} disconnected`, body: DISCONNECT_CONSEQUENCE };
  }
  return null;
}

/** "2m 5s" — the QR panel's countdown. */
export function formatQrTtl(secondsRemaining: number): string {
  return `${Math.floor(secondsRemaining / 60)}m ${secondsRemaining % 60}s`;
}
