'use client';

// src/components/dashboard/channels/OwnerMobileChannelWidget.tsx
//
// Shared owner-dashboard widget for the mobile approval channels (Telegram,
// WhatsApp). The two channels render the same enrollment state machine and
// differ only in presentation (label, icon, endpoints, and a few copy strings),
// captured by OwnerChannelPresentation. OwnerTelegramWidget / OwnerWhatsAppWidget
// are thin wrappers that supply their channel's presentation.
//
// Commit model: every action here applies immediately (no save bar). The
// consequential one — Disconnect — confirms through SettingsModal with the
// consequence spelled out, and both connect + disconnect confirm through the
// shared Console toast (UX audit S11/S13).

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useEnrollment } from '@/lib/notifications/channels/use-enrollment';
import type {
  EnrollmentSnapshot,
  EnrollmentState,
} from '@/lib/notifications/channels/enrollment-reducer';
import type { MobileChannel } from '@/lib/channels/mobile-enrollment';
import { SettingsModal } from '@/components/dashboard/settings/SettingsModal';
import { useToast } from '@/components/dashboard/shell/toast/ToastProvider';

export interface OwnerChannelInitialRow {
  channel: string;
  handle: string | null;
  status: string;
}

export interface OwnerChannelPresentation {
  channel: MobileChannel;
  /** Display name, e.g. "Telegram" / "WhatsApp". */
  label: string;
  /** Icon CSS class, e.g. "ch-tg" / "ch-wa". */
  iconClass: string;
  /** Icon glyph rendered inside the icon chip. */
  iconGlyph: string;
  /** Copy for the `idle` state. */
  idleText: string;
  /** Copy for the `unsubscribed` state (channel-specific recovery wording). */
  unsubscribedText: string;
  /** Alt text for the QR image. */
  qrAlt: string;
  /** Label for the deep-link button under the QR, e.g. "Open Telegram on this phone". */
  openOnPhoneLabel: string;
  endpoints: { start: string; cancel: string; disable: string; status: string };
}

/** What the owner is left with after disconnecting either mobile channel. */
export const DISCONNECT_CONSEQUENCE = "You'll get approval requests by email only.";

/**
 * Derives an EnrollmentSnapshot for SSR hydration from the server-loaded row.
 * Only `verified` rows produce a snapshot — other statuses still need a fresh
 * fetch to avoid stale-state risks (e.g. an expired pending token).
 */
function rowToInitialSnapshot(row: OwnerChannelInitialRow | null): EnrollmentSnapshot | undefined {
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

function maskHandle(handle: string | null): string {
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

export interface OwnerMobileChannelWidgetProps {
  presentation: OwnerChannelPresentation;
  /** Server-loaded enrollment row for SSR hydration. Verified rows skip the first fetch. */
  initialEnrollment?: OwnerChannelInitialRow | null;
  /**
   * When set, the Connect / Reconnect / New link action is disabled and this
   * sentence is rendered beside it. The parent derives it from the OTHER mobile
   * channel's state (one mobile channel per account — the server's 409 stays
   * as the backstop).
   */
  blockedReason?: string | null;
  /** Reports every enrollment-state change so the parent can derive `blockedReason` for the sibling. */
  onStateChange?: (state: EnrollmentState) => void;
}

export function OwnerMobileChannelWidget({
  presentation,
  initialEnrollment,
  blockedReason = null,
  onStateChange,
}: OwnerMobileChannelWidgetProps) {
  const { snapshot, actions, ttl } = useEnrollment({
    channel: presentation.channel,
    endpoints: presentation.endpoints,
    postBody: {},
    initialSnapshot: rowToInitialSnapshot(initialEnrollment ?? null),
  });
  const { toast } = useToast();
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    onStateChange?.(snapshot.state);
  }, [onStateChange, snapshot.state]);

  // Toast the two transitions the owner waits on: the QR scan landing
  // (awaiting_scan → verified) and the disconnect (verified → disabled). Both
  // are read off the reducer, not the action call, so a verification that
  // arrives via polling still gets its confirmation.
  const previousStateRef = useRef<EnrollmentState>(snapshot.state);
  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = snapshot.state;
    if (previous === snapshot.state) return;
    if (previous === 'awaiting_scan' && snapshot.state === 'verified') {
      toast({ tone: 'success', title: `${presentation.label} connected` });
    }
    if (previous === 'verified' && snapshot.state === 'disabled') {
      toast({
        tone: 'success',
        title: `${presentation.label} disconnected`,
        body: DISCONNECT_CONSEQUENCE,
      });
    }
  }, [presentation.label, snapshot.state, toast]);

  async function confirmDisconnect() {
    setDisconnecting(true);
    try {
      await actions.disable();
    } finally {
      setDisconnecting(false);
      setConfirmingDisconnect(false);
    }
  }

  const isConnected = snapshot.state === 'verified';
  const connectBlocked = blockedReason !== null && CONNECTABLE_STATES.has(snapshot.state);
  const blockedNoteId = `${presentation.channel}-connect-blocked`;

  const connectAction = (label: string, className: string) => (
    <button
      type="button"
      onClick={actions.connect}
      className={className}
      disabled={connectBlocked}
      aria-describedby={connectBlocked ? blockedNoteId : undefined}
    >
      {label}
    </button>
  );

  return (
    <div className={`channel-row${isConnected ? ' selected' : ''}`}>
      <div className={`channel-icon ${presentation.iconClass}`} aria-hidden>{presentation.iconGlyph}</div>
      <div className="channel-meta">
        <div className="channel-name">{presentation.label}</div>
        <div className="channel-handle">
          {snapshot.state === 'idle' && presentation.idleText}
          {snapshot.state === 'verified' && `Connected · ${maskHandle(snapshot.handle)}`}
          {snapshot.state === 'generating' && 'Generating link…'}
          {snapshot.state === 'awaiting_scan' && 'Scan the QR code below, or open the link on this phone.'}
          {snapshot.state === 'disabled' && 'Disconnected — reconnect to get approval requests here.'}
          {snapshot.state === 'unsubscribed' && presentation.unsubscribedText}
          {snapshot.state === 'expired' && 'This QR code expired. Ask for a new link to try again.'}
          {snapshot.state === 'error' && (snapshot.errorMessage ?? 'Something went wrong.')}
        </div>

        {connectBlocked && (
          <p id={blockedNoteId} className="channel-blocked-note">{blockedReason}</p>
        )}

        {/* QR panel — expands inline below the handle text */}
        {snapshot.state === 'awaiting_scan' && snapshot.qrDataUrl && snapshot.deepLink && (
          <div className="channel-qr">
            <Image src={snapshot.qrDataUrl} alt={presentation.qrAlt} width={160} height={160} unoptimized />
            <a
              href={snapshot.deepLink}
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary channel-qr-open"
            >
              {presentation.openOnPhoneLabel}
            </a>
            {ttl.secondsRemaining !== null && (
              <p className="channel-qr-ttl">
                Expires in {Math.floor(ttl.secondsRemaining / 60)}m {ttl.secondsRemaining % 60}s
              </p>
            )}
          </div>
        )}
      </div>

      {/* Action button / status badge */}
      <div className="channel-action">
        {snapshot.state === 'idle' && connectAction('Connect', 'btn btn-primary')}
        {snapshot.state === 'generating' && (
          <span className="channel-status cs-soon">Working…</span>
        )}
        {snapshot.state === 'verified' && (
          <button
            type="button"
            onClick={() => setConfirmingDisconnect(true)}
            className="btn btn-secondary"
          >
            Disconnect
          </button>
        )}
        {(snapshot.state === 'disabled' || snapshot.state === 'unsubscribed') &&
          connectAction('Reconnect', 'btn btn-secondary')}
        {snapshot.state === 'expired' && connectAction('New link', 'btn btn-secondary')}
        {snapshot.state === 'awaiting_scan' && (
          <button type="button" onClick={actions.cancel} className="btn btn-secondary">Cancel</button>
        )}
        {snapshot.state === 'error' && (
          <button type="button" onClick={actions.dismissError} className="btn btn-secondary">Try again</button>
        )}
      </div>

      {confirmingDisconnect && (
        <SettingsModal
          title={`Disconnect ${presentation.label}`}
          closeLabel="Keep this channel connected"
          onClose={() => setConfirmingDisconnect(false)}
        >
          <div className="set-section-title" style={{ marginBottom: 8 }}>
            Disconnect {presentation.label}?
          </div>
          <p className="settings-body-copy" style={{ marginBottom: 16 }}>
            {DISCONNECT_CONSEQUENCE} You can connect {presentation.label} again at any time.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConfirmingDisconnect(false)}
              disabled={disconnecting}
            >
              Keep connected
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() => void confirmDisconnect()}
              disabled={disconnecting}
            >
              {disconnecting ? 'Disconnecting…' : `Disconnect ${presentation.label}`}
            </button>
          </div>
        </SettingsModal>
      )}
    </div>
  );
}
