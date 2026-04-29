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
    handle: row.handle,
    deepLink: null,
    qrDataUrl: null,
    expiresAt: null,
    unsubscribedReason: null,
    errorMessage: null,
  };
}

export interface OwnerTelegramWidgetProps {
  /** Server-loaded enrollment row for SSR hydration. Verified rows skip the first fetch. */
  initialEnrollment?: InitialRow | null;
}

function maskChatId(chatId: string | null): string {
  if (!chatId || chatId.length <= 4) return '•••';
  return `••• ${chatId.slice(-4)}`;
}

export function OwnerTelegramWidget({ initialEnrollment }: OwnerTelegramWidgetProps = {}) {
  const { snapshot, actions, ttl } = useEnrollment({
    channel: 'telegram',
    endpoints: {
      start: '/api/dashboard/channels/telegram/start',
      cancel: '/api/dashboard/channels/telegram/cancel',
      disable: '/api/dashboard/channels/telegram/disable',
      status: '/api/dashboard/channels',
    },
    postBody: {},
    initialSnapshot: rowToInitialSnapshot(initialEnrollment ?? null),
  });

  const onDisconnect = async () => {
    if (!confirm('Disconnect Telegram from RepWorth?')) return;
    await actions.disable();
  };

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="text-2xl" aria-hidden>💬</div>
          <div>
            <div className="font-medium text-slate-100">Telegram</div>
            {snapshot.state === 'idle' && (
              <p className="text-sm text-slate-400">Get approval requests in Telegram.</p>
            )}
            {snapshot.state === 'verified' && (
              <p className="text-sm text-cyan-400">✓ Connected · {maskChatId(snapshot.handle)}</p>
            )}
            {snapshot.state === 'disabled' && (
              <p className="text-sm text-slate-400">Disabled — reconnect to receive approvals.</p>
            )}
            {snapshot.state === 'unsubscribed' && (
              <p className="text-sm text-amber-400">You blocked the bot — start the bot in Telegram, then reconnect.</p>
            )}
            {snapshot.state === 'expired' && (
              <p className="text-sm text-slate-400">QR expired.</p>
            )}
            {snapshot.state === 'error' && (
              <p className="text-sm text-red-400">{snapshot.errorMessage ?? 'Something went wrong.'}</p>
            )}
          </div>
        </div>
        <div>
          {snapshot.state === 'idle' && (
            <button onClick={actions.connect} className="rounded bg-cyan-500 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-cyan-400">Connect</button>
          )}
          {snapshot.state === 'generating' && (
            <span className="text-sm text-slate-400">Generating link…</span>
          )}
          {snapshot.state === 'verified' && (
            <button onClick={onDisconnect} className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">Disconnect</button>
          )}
          {snapshot.state === 'disabled' && (
            <button onClick={actions.connect} className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">Reconnect</button>
          )}
          {snapshot.state === 'unsubscribed' && (
            <button onClick={actions.connect} className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">Reconnect</button>
          )}
          {snapshot.state === 'expired' && (
            <button onClick={actions.connect} className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">Generate new link</button>
          )}
          {snapshot.state === 'error' && (
            <button onClick={actions.dismissError} className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">Try again</button>
          )}
        </div>
      </div>
      {snapshot.state === 'awaiting_scan' && snapshot.qrDataUrl && snapshot.deepLink && (
        <div className="mt-4 rounded-md border border-slate-700 bg-slate-950 p-4">
          <p className="text-sm text-slate-300 mb-3">Scan with Telegram, or open the link on your phone:</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={snapshot.qrDataUrl} alt="Telegram QR" width={200} height={200} className="mx-auto" />
          <p className="mt-3 break-all text-xs text-cyan-400">
            <a href={snapshot.deepLink} target="_blank" rel="noreferrer">{snapshot.deepLink}</a>
          </p>
          {ttl.secondsRemaining !== null && (
            <p className="mt-2 text-xs text-slate-500">
              Expires in {Math.floor(ttl.secondsRemaining / 60)}m {ttl.secondsRemaining % 60}s
            </p>
          )}
          <button onClick={actions.cancel} className="mt-3 rounded border border-slate-600 px-3 py-1 text-sm text-slate-200 hover:bg-slate-800">Cancel</button>
        </div>
      )}
    </div>
  );
}
