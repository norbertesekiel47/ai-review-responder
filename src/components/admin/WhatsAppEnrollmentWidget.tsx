'use client';

import { useEnrollment } from '@/lib/notifications/channels/use-enrollment';

function maskPhone(phone: string | null): string {
  if (!phone) return '•••';
  if (phone.length <= 4) return phone;
  const hidden = Math.max(0, phone.length - 7);
  return phone.slice(0, 3) + '•'.repeat(hidden) + phone.slice(-4);
}

export function WhatsAppEnrollmentWidget({ businessId }: { businessId: string }) {
  const { snapshot, actions, ttl } = useEnrollment({
    channel: 'whatsapp',
    endpoints: {
      start: '/api/admin/channels/whatsapp/start',
      cancel: '/api/admin/channels/whatsapp/cancel',
      disable: '/api/admin/channels/whatsapp/disable',
      status: `/api/admin/businesses/${businessId}/channels`,
    },
    postBody: { businessId },
  });

  const onDisable = async () => {
    if (!confirm('Disable WhatsApp notifications for this business?')) return;
    await actions.disable();
  };

  return (
    <div className="whatsapp-enrollment-widget border rounded-md p-4 bg-white">
      <h3 className="font-medium mb-2">WhatsApp</h3>
      {snapshot.state === 'idle' && (
        <button onClick={actions.connect} className="px-3 py-1.5 bg-green-600 text-white rounded">Connect</button>
      )}
      {snapshot.state === 'generating' && <p>Generating link…</p>}
      {snapshot.state === 'awaiting_scan' && snapshot.qrDataUrl && snapshot.deepLink && (
        <div>
          <p className="text-sm mb-2">Scan the QR with WhatsApp or share this link. The owner sends the prefilled message to verify.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={snapshot.qrDataUrl} alt="WhatsApp deep link QR" width={256} height={256} />
          <p className="mt-2"><a href={snapshot.deepLink} target="_blank" rel="noreferrer" className="text-green-700 underline break-all">{snapshot.deepLink}</a></p>
          {ttl.secondsRemaining !== null && (
            <p className="text-xs text-gray-500 mt-1">Expires in {Math.floor(ttl.secondsRemaining / 60)}m {ttl.secondsRemaining % 60}s</p>
          )}
          <button onClick={actions.cancel} className="mt-3 px-3 py-1 border rounded">Cancel</button>
          <button onClick={actions.refresh} className="mt-3 ml-2 px-3 py-1 border rounded">Refresh status</button>
        </div>
      )}
      {snapshot.state === 'verified' && (
        <div>
          <p className="text-sm text-green-700">✅ Connected — WhatsApp {maskPhone(snapshot.handle)}</p>
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
          <p className="text-sm text-orange-600">Unsubscribed ({snapshot.unsubscribedReason ?? 'unknown'})</p>
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
