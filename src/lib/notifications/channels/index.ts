// src/lib/notifications/channels/index.ts
//
// Channel factory. Each channel implementation is imported lazily-safe
// (top-level imports are fine; the classes themselves don't call provider
// SDKs at construction time). Subsequent phases add Telegram / WhatsApp
// cases here.

import type { NotificationChannel, ChannelId } from './types';

export { EmailChannel } from './email-channel';
export { SmsChannel, SmsRecipientUnsubscribedError } from './sms-channel';
export { TelegramChannel } from './telegram-channel';
export {
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
  TelegramRateLimitError,
  TelegramApiError,
} from './telegram-client';
export type { NotificationChannel, ChannelId, SendApprovalParams, SendApprovalResult } from './types';

import { EmailChannel } from './email-channel';
import { SmsChannel } from './sms-channel';
import { TelegramChannel } from './telegram-channel';

const NOT_YET_IMPLEMENTED: ReadonlySet<ChannelId> = new Set(['whatsapp']);

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
  if (NOT_YET_IMPLEMENTED.has(id)) {
    throw new Error(`Channel "${id}" not yet implemented — scheduled for a later phase`);
  }
  throw new Error(`Unknown channel "${id}"`);
}
