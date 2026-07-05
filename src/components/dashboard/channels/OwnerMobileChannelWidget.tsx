'use client';

// src/components/dashboard/channels/OwnerMobileChannelWidget.tsx
//
// Shared owner-dashboard widget for the mobile approval channels (Telegram,
// WhatsApp). The two channels render the same enrollment state machine and
// differ only in presentation (label, icon, endpoints, and two copy strings),
// captured by OwnerChannelPresentation. OwnerTelegramWidget / OwnerWhatsAppWidget
// are thin wrappers that supply their channel's presentation.

import Image from 'next/image';
import { useEnrollment } from '@/lib/notifications/channels/use-enrollment';
import type { EnrollmentSnapshot } from '@/lib/notifications/channels/enrollment-reducer';
import type { MobileChannel } from '@/lib/channels/mobile-enrollment';

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
  /** confirm() prompt shown before disconnecting. */
  disconnectConfirm: string;
  endpoints: { start: string; cancel: string; disable: string; status: string };
}

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

export interface OwnerMobileChannelWidgetProps {
  presentation: OwnerChannelPresentation;
  /** Server-loaded enrollment row for SSR hydration. Verified rows skip the first fetch. */
  initialEnrollment?: OwnerChannelInitialRow | null;
}

export function OwnerMobileChannelWidget({
  presentation,
  initialEnrollment,
}: OwnerMobileChannelWidgetProps) {
  const { snapshot, actions, ttl } = useEnrollment({
    channel: presentation.channel,
    endpoints: presentation.endpoints,
    postBody: {},
    initialSnapshot: rowToInitialSnapshot(initialEnrollment ?? null),
  });

  const onDisconnect = async () => {
    if (!confirm(presentation.disconnectConfirm)) return;
    await actions.disable();
  };

  const isConnected = snapshot.state === 'verified';

  return (
    <div className={`channel-row${isConnected ? ' selected' : ''}`}>
      <div className={`channel-icon ${presentation.iconClass}`} aria-hidden>{presentation.iconGlyph}</div>
      <div className="channel-meta">
        <div className="channel-name">{presentation.label}</div>
        <div className="channel-handle">
          {snapshot.state === 'idle' && presentation.idleText}
          {snapshot.state === 'verified' && `Connected · ${maskHandle(snapshot.handle)}`}
          {snapshot.state === 'generating' && 'Generating link…'}
          {snapshot.state === 'awaiting_scan' && 'Scan the QR code below or open the link on your phone.'}
          {snapshot.state === 'disabled' && 'Disabled — reconnect to receive approvals.'}
          {snapshot.state === 'unsubscribed' && presentation.unsubscribedText}
          {snapshot.state === 'expired' && 'QR expired.'}
          {snapshot.state === 'error' && (snapshot.errorMessage ?? 'Something went wrong.')}
        </div>

        {/* QR panel — expands inline below the handle text */}
        {snapshot.state === 'awaiting_scan' && snapshot.qrDataUrl && snapshot.deepLink && (
          <div style={{ marginTop: 12 }}>
            <Image src={snapshot.qrDataUrl} alt={presentation.qrAlt} width={160} height={160} unoptimized />
            <p style={{ marginTop: 6, wordBreak: 'break-all', fontSize: 12, color: 'var(--rw-accent-600)' }}>
              <a href={snapshot.deepLink} target="_blank" rel="noreferrer">{snapshot.deepLink}</a>
            </p>
            {ttl.secondsRemaining !== null && (
              <p style={{ marginTop: 4, fontSize: 12, color: 'var(--rw-app-text-muted)' }}>
                Expires in {Math.floor(ttl.secondsRemaining / 60)}m {ttl.secondsRemaining % 60}s
              </p>
            )}
          </div>
        )}
      </div>

      {/* Action button / status badge */}
      <div style={{ flexShrink: 0 }}>
        {snapshot.state === 'idle' && (
          <button type="button" onClick={actions.connect} className="btn btn-primary">Connect</button>
        )}
        {snapshot.state === 'generating' && (
          <span className="channel-status cs-soon">Working…</span>
        )}
        {snapshot.state === 'verified' && (
          <button type="button" onClick={onDisconnect} className="btn btn-secondary">Disconnect</button>
        )}
        {(snapshot.state === 'disabled' || snapshot.state === 'unsubscribed') && (
          <button type="button" onClick={actions.connect} className="btn btn-secondary">Reconnect</button>
        )}
        {snapshot.state === 'expired' && (
          <button type="button" onClick={actions.connect} className="btn btn-secondary">New link</button>
        )}
        {snapshot.state === 'awaiting_scan' && (
          <button type="button" onClick={actions.cancel} className="btn btn-secondary">Cancel</button>
        )}
        {snapshot.state === 'error' && (
          <button type="button" onClick={actions.dismissError} className="btn btn-secondary">Try again</button>
        )}
      </div>
    </div>
  );
}
