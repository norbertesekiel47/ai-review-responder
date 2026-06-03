'use client';

import {
  OwnerMobileChannelWidget,
  type OwnerChannelInitialRow,
  type OwnerChannelPresentation,
} from './OwnerMobileChannelWidget';

const WHATSAPP_PRESENTATION: OwnerChannelPresentation = {
  channel: 'whatsapp',
  label: 'WhatsApp',
  iconClass: 'ch-wa',
  iconGlyph: '🟢',
  idleText: 'Get approval requests in WhatsApp.',
  unsubscribedText: 'You opted out of WhatsApp — tap Reconnect to set it up again.',
  qrAlt: 'WhatsApp QR',
  disconnectConfirm: 'Disconnect WhatsApp from RepWorth?',
  endpoints: {
    start: '/api/dashboard/channels/whatsapp/start',
    cancel: '/api/dashboard/channels/whatsapp/cancel',
    disable: '/api/dashboard/channels/whatsapp/disable',
    status: '/api/dashboard/channels',
  },
};

export interface OwnerWhatsAppWidgetProps {
  /** Server-loaded enrollment row for SSR hydration. Verified rows skip the first fetch. */
  initialEnrollment?: OwnerChannelInitialRow | null;
}

export function OwnerWhatsAppWidget({ initialEnrollment }: OwnerWhatsAppWidgetProps = {}) {
  return (
    <OwnerMobileChannelWidget
      presentation={WHATSAPP_PRESENTATION}
      initialEnrollment={initialEnrollment}
    />
  );
}
