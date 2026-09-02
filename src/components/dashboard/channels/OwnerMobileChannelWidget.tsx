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
// consequential one — Disconnect — confirms through ConfirmDialog with the
// consequence spelled out, and both connect + disconnect confirm through the
// shared Console toast (UX audit S11/S13).
//
// The per-state copy, the transition toasts and the SSR snapshot derivation are
// pure functions in OwnerMobileChannelWidget.helpers.ts; this file composes them
// with the QR panel and the per-state action control.

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useEnrollment } from '@/lib/notifications/channels/use-enrollment';
import type {
  EnrollmentSnapshot,
  EnrollmentState,
} from '@/lib/notifications/channels/enrollment-reducer';
import type { MobileChannel } from '@/lib/channels/mobile-enrollment';
import { ConfirmDialog } from '@/components/dashboard/settings/ConfirmDialog';
import { useToast } from '@/components/dashboard/shell/toast/ToastProvider';
import {
  DISCONNECT_CONSEQUENCE,
  channelHandleText,
  enrollmentTransitionToast,
  formatQrTtl,
  isConnectableState,
  rowToInitialSnapshot,
} from './OwnerMobileChannelWidget.helpers';

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

/**
 * Toasts the two transitions the owner waits on. Both are read off the reducer,
 * not the action call, so a verification that arrives via polling still gets
 * its confirmation.
 */
function useEnrollmentTransitionToast(state: EnrollmentState, label: string): void {
  const { toast } = useToast();
  const previousStateRef = useRef<EnrollmentState>(state);
  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = state;
    const notice = enrollmentTransitionToast(previous, state, label);
    if (notice) toast(notice);
  }, [label, state, toast]);
}

/** QR panel — expands inline below the handle text while a scan is awaited. */
function ChannelQrPanel({
  snapshot,
  presentation,
  secondsRemaining,
}: {
  snapshot: EnrollmentSnapshot;
  presentation: Pick<OwnerChannelPresentation, 'qrAlt' | 'openOnPhoneLabel'>;
  secondsRemaining: number | null;
}) {
  if (snapshot.state !== 'awaiting_scan' || !snapshot.qrDataUrl || !snapshot.deepLink) return null;
  return (
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
      {secondsRemaining !== null && (
        <p className="channel-qr-ttl">Expires in {formatQrTtl(secondsRemaining)}</p>
      )}
    </div>
  );
}

type EnrollmentActions = ReturnType<typeof useEnrollment>['actions'];

/** The one action control (or status badge) each enrollment state offers. */
function ChannelAction({
  state,
  actions,
  connectBlocked,
  blockedNoteId,
  onDisconnect,
}: {
  state: EnrollmentState;
  actions: EnrollmentActions;
  connectBlocked: boolean;
  blockedNoteId: string;
  onDisconnect: () => void;
}) {
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

  switch (state) {
    case 'idle':
      return connectAction('Connect', 'btn btn-primary');
    case 'generating':
      return <span className="channel-status cs-soon">Working…</span>;
    case 'verified':
      return (
        <button type="button" onClick={onDisconnect} className="btn btn-secondary">
          Disconnect
        </button>
      );
    case 'disabled':
    case 'unsubscribed':
      return connectAction('Reconnect', 'btn btn-secondary');
    case 'expired':
      return connectAction('New link', 'btn btn-secondary');
    case 'awaiting_scan':
      return <button type="button" onClick={actions.cancel} className="btn btn-secondary">Cancel</button>;
    case 'error':
      return <button type="button" onClick={actions.dismissError} className="btn btn-secondary">Try again</button>;
    default:
      return null;
  }
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
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    onStateChange?.(snapshot.state);
  }, [onStateChange, snapshot.state]);

  useEnrollmentTransitionToast(snapshot.state, presentation.label);

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
  const connectBlocked = blockedReason !== null && isConnectableState(snapshot.state);
  const blockedNoteId = `${presentation.channel}-connect-blocked`;

  return (
    <div className={`channel-row${isConnected ? ' selected' : ''}`}>
      <div className={`channel-icon ${presentation.iconClass}`} aria-hidden>{presentation.iconGlyph}</div>
      <div className="channel-meta">
        <div className="channel-name">{presentation.label}</div>
        <div className="channel-handle">{channelHandleText(snapshot, presentation)}</div>

        {connectBlocked && (
          <p id={blockedNoteId} className="channel-blocked-note">{blockedReason}</p>
        )}

        <ChannelQrPanel
          snapshot={snapshot}
          presentation={presentation}
          secondsRemaining={ttl.secondsRemaining}
        />
      </div>

      <div className="channel-action">
        <ChannelAction
          state={snapshot.state}
          actions={actions}
          connectBlocked={connectBlocked}
          blockedNoteId={blockedNoteId}
          onDisconnect={() => setConfirmingDisconnect(true)}
        />
      </div>

      {confirmingDisconnect && (
        <ConfirmDialog
          title={`Disconnect ${presentation.label}`}
          closeLabel="Keep this channel connected"
          heading={`Disconnect ${presentation.label}?`}
          body={`${DISCONNECT_CONSEQUENCE} You can connect ${presentation.label} again at any time.`}
          cancelLabel="Keep connected"
          confirmLabel={disconnecting ? 'Disconnecting…' : `Disconnect ${presentation.label}`}
          busy={disconnecting}
          onCancel={() => setConfirmingDisconnect(false)}
          onConfirm={() => void confirmDisconnect()}
        />
      )}
    </div>
  );
}
