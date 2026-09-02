'use client';

// src/components/admin/AdminEnrollmentWidget.tsx
//
// Shared admin enrollment widget for the mobile approval channels (Telegram,
// WhatsApp). Both render the same enrollment state machine against the admin
// channel endpoints and differ only in presentation (label, colors, copy, and
// the handle-masking function). TelegramEnrollmentWidget / WhatsAppEnrollmentWidget
// are thin wrappers supplying their channel's AdminEnrollmentPresentation.

import Image from 'next/image';
import { useState } from 'react';
import { useEnrollment } from '@/lib/notifications/channels/use-enrollment';
import type { MobileChannel } from '@/lib/channels/mobile-enrollment';

export interface AdminEnrollmentPresentation {
  channel: MobileChannel;
  /** Display name, e.g. "Telegram" / "WhatsApp". */
  label: string;
  /** Root container class (preserves the existing per-channel hook class). */
  containerClass: string;
  /** Tailwind classes for the idle Connect button. */
  connectButtonClass: string;
  /** Tailwind classes for the deep-link anchor. */
  linkClass: string;
  /** Copy under the QR in the awaiting_scan state. */
  awaitingScanCopy: string;
  /** Alt text for the QR image. */
  qrAlt: string;
  /** Verified-state label, e.g. "Telegram chat" / "WhatsApp", shown before the masked handle. */
  verifiedLabel: string;
  /** Consequence copy shown in the inline confirm before disabling. */
  disableConfirm: string;
  /** Channel-specific masking of the verified handle. */
  maskHandle: (handle: string | null) => string;
}

export function AdminEnrollmentWidget({
  presentation,
  businessId,
}: {
  presentation: AdminEnrollmentPresentation;
  businessId: string;
}) {
  const { snapshot, actions, ttl } = useEnrollment({
    channel: presentation.channel,
    endpoints: {
      start: `/api/admin/channels/${presentation.channel}/start`,
      cancel: `/api/admin/channels/${presentation.channel}/cancel`,
      disable: `/api/admin/channels/${presentation.channel}/disable`,
      status: `/api/admin/businesses/${businessId}/channels`,
    },
    postBody: { businessId },
  });

  // Disable cuts the owner's approval channel, so it arms an inline confirm
  // (consequence stated, then the act) rather than a native confirm() the
  // operator clicks through by reflex.
  const [disableArmed, setDisableArmed] = useState(false);
  const onDisable = async () => {
    setDisableArmed(false);
    await actions.disable();
  };

  return (
    <div className={`${presentation.containerClass} border rounded-md p-4 bg-white`}>
      <h3 className="font-medium mb-2">{presentation.label}</h3>
      {snapshot.state === 'idle' && (
        <button type="button" onClick={actions.connect} className={presentation.connectButtonClass}>Connect</button>
      )}
      {snapshot.state === 'generating' && <p>Generating link…</p>}
      {snapshot.state === 'awaiting_scan' && snapshot.qrDataUrl && snapshot.deepLink && (
        <div>
          <p className="text-sm mb-2">{presentation.awaitingScanCopy}</p>
          <Image src={snapshot.qrDataUrl} alt={presentation.qrAlt} width={256} height={256} unoptimized />
          <p className="mt-2"><a href={snapshot.deepLink} target="_blank" rel="noreferrer" className={presentation.linkClass}>{snapshot.deepLink}</a></p>
          {ttl.secondsRemaining !== null && (
            <p className="text-xs text-gray-500 mt-1">Expires in {Math.floor(ttl.secondsRemaining / 60)}m {ttl.secondsRemaining % 60}s</p>
          )}
          <button type="button" onClick={actions.cancel} className="mt-3 px-3 py-1 border rounded">Cancel</button>
          <button type="button" onClick={actions.refresh} className="mt-3 ml-2 px-3 py-1 border rounded">Refresh status</button>
        </div>
      )}
      {snapshot.state === 'verified' && (
        <div>
          <p className="text-sm text-green-700">✅ Connected: {presentation.verifiedLabel} {presentation.maskHandle(snapshot.handle)}</p>
          {disableArmed ? (
            <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-3">
              <p className="text-sm text-gray-800">{presentation.disableConfirm}</p>
              <p className="mt-1 text-xs text-gray-600">
                The owner stops receiving {presentation.label} approval requests until it is reconnected.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => { void onDisable(); }}
                  className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-red-800"
                >
                  Disable {presentation.label}
                </button>
                <button
                  type="button"
                  onClick={() => setDisableArmed(false)}
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setDisableArmed(true)} className="mt-2 px-3 py-1 border rounded text-red-600">Disable</button>
          )}
        </div>
      )}
      {snapshot.state === 'disabled' && (
        <div>
          <p className="text-sm text-gray-600">Disabled</p>
          <button type="button" onClick={actions.connect} className="mt-2 px-3 py-1 border rounded">Reconnect</button>
        </div>
      )}
      {snapshot.state === 'unsubscribed' && (
        <div>
          <p className="text-sm text-gray-600">Unsubscribed ({snapshot.unsubscribedReason ?? 'unknown'})</p>
          <button type="button" onClick={actions.connect} className="mt-2 px-3 py-1 border rounded">Re-enroll</button>
        </div>
      )}
      {snapshot.state === 'expired' && (
        <div>
          <p className="text-sm text-gray-600">Verification link expired.</p>
          <button type="button" onClick={actions.connect} className="mt-2 px-3 py-1 border rounded">Generate new link</button>
        </div>
      )}
      {snapshot.state === 'error' && (
        <div>
          <p className="text-sm text-red-600">{snapshot.errorMessage ?? 'Something went wrong.'}</p>
          <button type="button" onClick={actions.dismissError} className="mt-2 px-3 py-1 border rounded">Back</button>
        </div>
      )}
    </div>
  );
}
