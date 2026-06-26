// src/lib/notifications/channels/index.ts
//
// Channel factory. Each channel implementation is imported lazily-safe
// (top-level imports are fine; the classes themselves don't call provider
// SDKs at construction time).

import type { NotificationChannel, ChannelId } from './types';

export { TelegramChannel } from './telegram-channel';
export {
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
} from './telegram-client';
export {
  WhatsAppRecipientBlockedError,
  WhatsAppInvalidRecipientError,
  WhatsAppTemplateConfigError,
  WhatsAppSessionWindowError,
  WhatsAppRateLimitError,
  WhatsAppTimeoutError,
} from './whatsapp-client';
export type { NotificationChannel, ChannelId } from './types';

import { EmailChannel } from './email-channel';
import { TelegramChannel } from './telegram-channel';
import { WhatsAppChannel } from './whatsapp-channel';
import { channelsTelegramEnabled, channelsWhatsappEnabled } from './flags';

export function getChannel(id: ChannelId): NotificationChannel {
  if (id === 'email') return new EmailChannel();
  if (id === 'telegram') {
    if (!channelsTelegramEnabled()) {
      throw new Error('Telegram channel disabled by CHANNELS_TELEGRAM_ENABLED env flag');
    }
    return new TelegramChannel();
  }
  if (id === 'whatsapp') {
    if (!channelsWhatsappEnabled()) {
      throw new Error('WhatsApp channel disabled by CHANNELS_WHATSAPP_ENABLED env flag');
    }
    return new WhatsAppChannel();
  }
  throw new Error(`Unknown channel "${id}"`);
}
