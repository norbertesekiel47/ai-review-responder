'use client';

import {
  OwnerMobileChannelWidget,
  type OwnerChannelInitialRow,
  type OwnerChannelPresentation,
  type OwnerMobileChannelWidgetProps,
} from './OwnerMobileChannelWidget';

const WHATSAPP_PRESENTATION: OwnerChannelPresentation = {
  channel: 'whatsapp',
  label: 'WhatsApp',
  iconClass: 'ch-wa',
  iconGlyph: '🟢',
  idleText: 'Get approval requests in WhatsApp.',
  unsubscribedText: 'You opted out of WhatsApp. Tap Reconnect to set it up again.',
  qrAlt: 'WhatsApp QR',
  openOnPhoneLabel: 'Open WhatsApp on this phone',
  endpoints: {
    start: '/api/dashboard/channels/whatsapp/start',
    cancel: '/api/dashboard/channels/whatsapp/cancel',
    disable: '/api/dashboard/channels/whatsapp/disable',
    status: '/api/dashboard/channels',
  },
};

export interface OwnerWhatsAppWidgetProps
  extends Pick<OwnerMobileChannelWidgetProps, 'blockedReason' | 'onStateChange'> {
  /** Server-loaded enrollment row for SSR hydration. Verified rows skip the first fetch. */
  initialEnrollment?: OwnerChannelInitialRow | null;
}

export function OwnerWhatsAppWidget({
  initialEnrollment,
  blockedReason,
  onStateChange,
}: OwnerWhatsAppWidgetProps = {}) {
  return (
    <OwnerMobileChannelWidget
      presentation={WHATSAPP_PRESENTATION}
      initialEnrollment={initialEnrollment}
      blockedReason={blockedReason}
      onStateChange={onStateChange}
    />
  );
}
