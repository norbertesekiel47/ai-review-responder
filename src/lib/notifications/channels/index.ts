// src/lib/notifications/channels/index.ts
//
// Channel factory. Each channel implementation is imported lazily-safe
// (top-level imports are fine; the classes themselves don't call provider
// SDKs at construction time).

import type { NotificationChannel, ChannelId } from './types';

export { SmsRecipientUnsubscribedError } from './sms-channel';
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
import { SmsChannel } from './sms-channel';
import { TelegramChannel } from './telegram-channel';
import { WhatsAppChannel } from './whatsapp-channel';

export function getChannel(id: ChannelId): NotificationChannel {
  if (id === 'email') return new EmailChannel();
  if (id === 'sms') {
    if (process.env.CHANNELS_SMS_ENABLED !== 'true') {
      throw new Error('SMS channel disabled by CHANNELS_SMS_ENABLED env flag');
    }
    return new SmsChannel();
  }
  if (id === 'telegram') {
    if (process.env.CHANNELS_TELEGRAM_ENABLED !== 'true') {
      throw new Error('Telegram channel disabled by CHANNELS_TELEGRAM_ENABLED env flag');
    }
    return new TelegramChannel();
  }
  if (id === 'whatsapp') {
    if (process.env.CHANNELS_WHATSAPP_ENABLED !== 'true') {
      throw new Error('WhatsApp channel disabled by CHANNELS_WHATSAPP_ENABLED env flag');
    }
    return new WhatsAppChannel();
  }
  throw new Error(`Unknown channel "${id}"`);
}
