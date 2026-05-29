'use client';

import { useEnrollment } from '@/lib/notifications/channels/use-enrollment';

function maskChatId(chatId: string | null): string {
  if (!chatId || chatId.length <= 4) return '•••';
  return `••• ${chatId.slice(-4)}`;
}

export function TelegramEnrollmentWidget({ businessId }: { businessId: string }) {
  const { snapshot, actions, ttl } = useEnrollment({
    channel: 'telegram',
    endpoints: {
      start: '/api/admin/channels/telegram/start',
      cancel: '/api/admin/channels/telegram/cancel',
      disable: '/api/admin/channels/telegram/disable',
      status: `/api/admin/businesses/${businessId}/channels`,
    },
    postBody: { businessId },
  });

  const onDisable = async () => {
    if (!confirm('Disable Telegram notifications for this business?')) return;
    await actions.disable();
  };

  return (
    <div className="telegram-enrollment-widget border rounded-md p-4 bg-white">
      <h3 className="font-medium mb-2">Telegram</h3>
      {snapshot.state === 'idle' && (
        <button onClick={actions.connect} className="px-3 py-1.5 bg-blue-600 text-white rounded">Connect</button>
      )}
      {snapshot.state === 'generating' && <p>Generating link…</p>}
      {snapshot.state === 'awaiting_scan' && snapshot.qrDataUrl && snapshot.deepLink && (
        <div>
          <p className="text-sm mb-2">Scan the QR with Telegram or share this link. The owner taps Start to verify.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={snapshot.qrDataUrl} alt="Telegram deep link QR" width={256} height={256} />
          <p className="mt-2"><a href={snapshot.deepLink} target="_blank" rel="noreferrer" className="text-blue-600 underline break-all">{snapshot.deepLink}</a></p>
          {ttl.secondsRemaining !== null && (
            <p className="text-xs text-gray-500 mt-1">Expires in {Math.floor(ttl.secondsRemaining / 60)}m {ttl.secondsRemaining % 60}s</p>
          )}
          <button onClick={actions.cancel} className="mt-3 px-3 py-1 border rounded">Cancel</button>
          <button onClick={actions.refresh} className="mt-3 ml-2 px-3 py-1 border rounded">Refresh status</button>
        </div>
      )}
      {snapshot.state === 'verified' && (
        <div>
          <p className="text-sm text-green-700">✅ Connected — Telegram chat {maskChatId(snapshot.handle)}</p>
          <button onClick={onDisable} className="mt-2 px-3 py-1 border rounded text-red-600">Disable</button>
        </div>
      )}
      {snapshot.state === 'disabled' && (
        <div>
          <p className="text-sm text-gray-600">Disabled</p>
          <button onClick={actions.connect} className="mt-2 px-3 py-1 border rounded">Reconnect</button>
        </div>
      )}
      {snapshot.state === 'unsubscribed' && (
        <div>
          <p className="text-sm text-gray-600">Unsubscribed ({snapshot.unsubscribedReason ?? 'unknown'})</p>
          <button onClick={actions.connect} className="mt-2 px-3 py-1 border rounded">Re-enroll</button>
        </div>
      )}
      {snapshot.state === 'expired' && (
        <div>
          <p className="text-sm text-gray-600">Verification link expired.</p>
          <button onClick={actions.connect} className="mt-2 px-3 py-1 border rounded">Generate new link</button>
        </div>
      )}
      {snapshot.state === 'error' && (
        <div>
          <p className="text-sm text-red-600">{snapshot.errorMessage ?? 'Something went wrong.'}</p>
          <button onClick={actions.dismissError} className="mt-2 px-3 py-1 border rounded">Back</button>
        </div>
      )}
    </div>
  );
}
