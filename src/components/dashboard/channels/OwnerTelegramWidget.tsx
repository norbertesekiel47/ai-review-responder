'use client';

import {
  OwnerMobileChannelWidget,
  type OwnerChannelInitialRow,
  type OwnerChannelPresentation,
  type OwnerMobileChannelWidgetProps,
} from './OwnerMobileChannelWidget';

const TELEGRAM_PRESENTATION: OwnerChannelPresentation = {
  channel: 'telegram',
  label: 'Telegram',
  iconClass: 'ch-tg',
  iconGlyph: '💬',
  idleText: 'Get approval requests in Telegram.',
  unsubscribedText: 'You blocked the bot. Start the bot in Telegram, then reconnect.',
  qrAlt: 'Telegram QR',
  openOnPhoneLabel: 'Open Telegram on this phone',
  endpoints: {
    start: '/api/dashboard/channels/telegram/start',
    cancel: '/api/dashboard/channels/telegram/cancel',
    disable: '/api/dashboard/channels/telegram/disable',
    status: '/api/dashboard/channels',
  },
};

export interface OwnerTelegramWidgetProps
  extends Pick<OwnerMobileChannelWidgetProps, 'blockedReason' | 'onStateChange'> {
  /** Server-loaded enrollment row for SSR hydration. Verified rows skip the first fetch. */
  initialEnrollment?: OwnerChannelInitialRow | null;
}

export function OwnerTelegramWidget({
  initialEnrollment,
  blockedReason,
  onStateChange,
}: OwnerTelegramWidgetProps = {}) {
  return (
    <OwnerMobileChannelWidget
      presentation={TELEGRAM_PRESENTATION}
      initialEnrollment={initialEnrollment}
      blockedReason={blockedReason}
      onStateChange={onStateChange}
    />
  );
}
