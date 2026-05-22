'use client';

import { useEnrollment } from '@/lib/notifications/channels/use-enrollment';
import type { EnrollmentSnapshot } from '@/lib/notifications/channels/enrollment-reducer';

interface InitialRow {
  channel: string;
  handle: string | null;
  status: string;
}

/**
 * Derives an EnrollmentSnapshot for SSR hydration from the server-loaded row.
 * Only `verified` rows produce a snapshot — other statuses still need a fresh
 * fetch to avoid stale-state risks (e.g. an expired pending token).
 */
function rowToInitialSnapshot(row: InitialRow | null): EnrollmentSnapshot | undefined {
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

export interface OwnerWhatsAppWidgetProps {
  /** Server-loaded enrollment row for SSR hydration. Verified rows skip the first fetch. */
  initialEnrollment?: InitialRow | null;
}

function maskHandle(handle: string | null): string {
  if (!handle || handle.length <= 4) return '•••';
  return `••• ${handle.slice(-4)}`;
}

export function OwnerWhatsAppWidget({ initialEnrollment }: OwnerWhatsAppWidgetProps = {}) {
  const { snapshot, actions, ttl } = useEnrollment({
    channel: 'whatsapp',
    endpoints: {
      start: '/api/dashboard/channels/whatsapp/start',
      cancel: '/api/dashboard/channels/whatsapp/cancel',
      disable: '/api/dashboard/channels/whatsapp/disable',
      status: '/api/dashboard/channels',
    },
    postBody: {},
    initialSnapshot: rowToInitialSnapshot(initialEnrollment ?? null),
  });

  const onDisconnect = async () => {
    if (!confirm('Disconnect WhatsApp from RepWorth?')) return;
    await actions.disable();
  };

  const isConnected = snapshot.state === 'verified';

  return (
    <div className={`channel-row${isConnected ? ' selected' : ''}`}>
      <div className="channel-icon ch-wa" aria-hidden>🟢</div>
      <div className="channel-meta">
        <div className="channel-name">WhatsApp</div>
        <div className="channel-handle">
          {snapshot.state === 'idle' && 'Get approval requests in WhatsApp.'}
          {snapshot.state === 'verified' && `Connected · ${maskHandle(snapshot.handle)}`}
          {snapshot.state === 'generating' && 'Generating link…'}
          {snapshot.state === 'awaiting_scan' && 'Scan the QR code below or open the link on your phone.'}
          {snapshot.state === 'disabled' && 'Disabled — reconnect to receive approvals.'}
          {snapshot.state === 'unsubscribed' && 'You opted out of WhatsApp — tap Reconnect to set it up again.'}
          {snapshot.state === 'expired' && 'QR expired.'}
          {snapshot.state === 'error' && (snapshot.errorMessage ?? 'Something went wrong.')}
        </div>

        {/* QR panel — expands inline below the handle text */}
        {snapshot.state === 'awaiting_scan' && snapshot.qrDataUrl && snapshot.deepLink && (
          <div style={{ marginTop: 12 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={snapshot.qrDataUrl} alt="WhatsApp QR" width={160} height={160} />
            <p style={{ marginTop: 6, wordBreak: 'break-all', fontSize: 12, color: 'var(--rw-blue-600)' }}>
              <a href={snapshot.deepLink} target="_blank" rel="noreferrer">{snapshot.deepLink}</a>
            </p>
            {ttl.secondsRemaining !== null && (
              <p style={{ marginTop: 4, fontSize: 11, color: 'var(--rw-app-text-muted)' }}>
                Expires in {Math.floor(ttl.secondsRemaining / 60)}m {ttl.secondsRemaining % 60}s
              </p>
            )}
          </div>
        )}
      </div>

      {/* Action button / status badge */}
      <div style={{ flexShrink: 0 }}>
        {snapshot.state === 'idle' && (
          <button onClick={actions.connect} className="btn btn-primary">Connect</button>
        )}
        {snapshot.state === 'generating' && (
          <span className="channel-status cs-soon">Working…</span>
        )}
        {snapshot.state === 'verified' && (
          <button onClick={onDisconnect} className="btn btn-secondary">Disconnect</button>
        )}
        {(snapshot.state === 'disabled' || snapshot.state === 'unsubscribed') && (
          <button onClick={actions.connect} className="btn btn-secondary">Reconnect</button>
        )}
        {snapshot.state === 'expired' && (
          <button onClick={actions.connect} className="btn btn-secondary">New link</button>
        )}
        {snapshot.state === 'awaiting_scan' && (
          <button onClick={actions.cancel} className="btn btn-secondary">Cancel</button>
        )}
        {snapshot.state === 'error' && (
          <button onClick={actions.dismissError} className="btn btn-secondary">Try again</button>
        )}
      </div>
    </div>
  );
}
