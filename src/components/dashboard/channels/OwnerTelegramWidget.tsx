'use client';

import {
  OwnerMobileChannelWidget,
  type OwnerChannelInitialRow,
  type OwnerChannelPresentation,
} from './OwnerMobileChannelWidget';

const TELEGRAM_PRESENTATION: OwnerChannelPresentation = {
  channel: 'telegram',
  label: 'Telegram',
  iconClass: 'ch-tg',
  iconGlyph: '💬',
  idleText: 'Get approval requests in Telegram.',
  unsubscribedText: 'You blocked the bot — start the bot in Telegram, then reconnect.',
  qrAlt: 'Telegram QR',
  disconnectConfirm: 'Disconnect Telegram from RepWorth?',
  endpoints: {
    start: '/api/dashboard/channels/telegram/start',
    cancel: '/api/dashboard/channels/telegram/cancel',
    disable: '/api/dashboard/channels/telegram/disable',
    status: '/api/dashboard/channels',
  },
};

export interface OwnerTelegramWidgetProps {
  /** Server-loaded enrollment row for SSR hydration. Verified rows skip the first fetch. */
  initialEnrollment?: OwnerChannelInitialRow | null;
}

export function OwnerTelegramWidget({ initialEnrollment }: OwnerTelegramWidgetProps = {}) {
  return (
    <OwnerMobileChannelWidget
      presentation={TELEGRAM_PRESENTATION}
      initialEnrollment={initialEnrollment}
    />
  );
}
